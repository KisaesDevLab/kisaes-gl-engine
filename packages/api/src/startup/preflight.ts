// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import crypto from 'crypto';
import { db } from '../db/index.js';
import { env } from '../config/env.js';
import { applyMigrations, checkPendingMigrations, MIGRATIONS_FOLDER } from './migrations.js';
import {
  sentinelExists,
  readSentinelHeader,
  readSentinelPayload,
  createSentinel,
  deleteSentinel,
  SentinelError,
  type SentinelHeader,
  type SentinelPayload,
} from '../services/sentinel.service.js';
import { ensureHostId, readHostId } from '../services/host-id.service.js';
import { getSetting, setSetting } from '../services/admin.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { withSetupLock } from '../services/setup.service.js';
import {
  validateInstallation,
  type SentinelReadResult,
  type ValidationResult,
} from './installation-validator.js';
import { sentinelAudit } from './sentinel-audit.js';

/**
 * Preflight — runs migrations, gathers DB / sentinel / host-id state, calls
 * the pure validator, and either regenerates the sentinel (Case 3 / new-host
 * restore) or returns a cached ValidationResult so the caller can start the
 * diagnostic app instead of the normal app.
 *
 * Called by bootstrap.ts before anything else.
 */
export async function runPreflight(): Promise<ValidationResult> {
  // Step 1: migrations must run so `system_settings` is guaranteed to exist.
  // This is a no-op on an already-migrated DB.
  //
  // MIGRATIONS_AUTO=false (appliance mode) flips this to a check-only
  // path: if any migrations are pending we return a blocked status so
  // bootstrap.ts surfaces the diagnostic app, instead of auto-applying
  // schema changes the operator may not have approved yet.
  if (env.MIGRATIONS_AUTO) {
    console.log('[preflight] running migrations...');
    try {
      await applyMigrations(MIGRATIONS_FOLDER);
    } catch (err) {
      console.error('[preflight] migration failed:', err);
      return {
        status: 'blocked',
        code: 'UNKNOWN',
        details: `migration failed: ${(err as Error).message}`,
      };
    }
  } else {
    let status;
    try {
      status = await checkPendingMigrations(MIGRATIONS_FOLDER);
    } catch (err) {
      console.error('[preflight] failed to read migration status:', err);
      return {
        status: 'blocked',
        code: 'UNKNOWN',
        details: `cannot read migration status: ${(err as Error).message}`,
      };
    }
    if (status.pending) {
      const msg =
        `Schema migration pending (${status.applied}/${status.total} applied). ` +
        `MIGRATIONS_AUTO=false; run the migrations container before starting the server: ` +
        `\`npx tsx packages/api/src/migrate.ts\``;
      console.error(`[preflight] ${msg}`);
      // Return blocked rather than process.exit so bootstrap.ts can
      // surface the diagnostic app — same pattern as every other
      // installation-state failure. Compose's restart-on-failure
      // policy then loops, but the operator sees a useful error page
      // at /api/diagnostic instead of an opaque container restart.
      return { status: 'blocked', code: 'MIGRATIONS_PENDING', details: msg };
    }
    if (status.ahead) {
      const msg =
        `DB schema is AHEAD of this binary (${status.applied} applied, ` +
        `${status.total} expected). The operator likely rolled back the ` +
        `code without rolling back the DB. Either re-deploy a code version ` +
        `>= the DB's schema, or restore the DB from a snapshot taken before ` +
        `the code rollback.`;
      console.error(`[preflight] ${msg}`);
      return { status: 'blocked', code: 'DATABASE_AHEAD', details: msg };
    }
    console.log(`[preflight] migrations up to date (${status.applied}/${status.total})`);
  }

  // Step 2: gather the current DB installation_id.
  let dbInstallationId: string | null = null;
  try {
    dbInstallationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);
  } catch (err) {
    console.error('[preflight] failed to read installation_id:', err);
    return {
      status: 'blocked',
      code: 'UNKNOWN',
      details: `cannot read system_settings.installation_id: ${(err as Error).message}`,
    };
  }

  // Step 3: read host-id WITHOUT creating one. A missing host-id file is a
  // meaningful signal to the validator.
  const currentHostId = readHostId();

  // Step 4: read the sentinel, distinguishing corruption / decrypt-failure /
  // full-read.
  const sentinel = await readSentinelState();

  // Step 5: pure decision.
  const result = validateInstallation({
    dbInstallationId,
    currentHostId,
    sentinel,
  });

  // Step 6: side-effects based on the result.
  switch (result.status) {
    case 'ok':
      // Confirm host-id file exists (should always be true in this branch,
      // but ensureHostId is idempotent so it's safe to call).
      ensureHostId();
      console.log(`[preflight] installation verified (id=${result.installationId})`);
      return result;

    case 'fresh-install':
      // Don't create the host-id yet — the setup wizard will do that in
      // completeSetupSentinel so orphan detection can still catch a stale
      // host-id file if the wizard is never completed.
      console.log('[preflight] fresh installation — setup wizard will run');
      return result;

    case 'regenerate-sentinel': {
      // Regenerate the sentinel under the advisory lock (F12).
      const regenResult = await regenerateSentinel(result);
      if (regenResult.ok) {
        console.log(`[preflight] sentinel regenerated (reason=${result.reason})`);
        sentinelAudit('sentinel.regenerate', {
          reason: result.reason,
          installationId: result.dbInstallationId,
          previousHostId: result.previousHostId,
          source: 'preflight',
        });
        return { status: 'ok', installationId: result.dbInstallationId, hostId: regenResult.newHostId };
      }
      return {
        status: 'blocked',
        code: 'UNKNOWN',
        details: `sentinel regeneration failed: ${regenResult.error}`,
      };
    }

    case 'blocked':
      sentinelAudit(blockedEvent(result.code), {
        code: result.code,
        details: result.details,
        installationId: result.header?.installationId,
      });
      console.error(`[preflight] BLOCKED: ${result.code} — ${result.details}`);
      return result;

    default: {
      const _exhaustive: never = result;
      void _exhaustive;
      return { status: 'blocked', code: 'UNKNOWN', details: 'unreachable preflight branch' };
    }
  }
}

async function readSentinelState(): Promise<SentinelReadResult> {
  if (!sentinelExists()) return { kind: 'missing' };

  let header: SentinelHeader | null = null;
  try {
    header = readSentinelHeader();
  } catch (err) {
    if (err instanceof SentinelError) {
      const code = err.code === 'MAGIC_MISMATCH' ? 'MAGIC'
        : err.code === 'HEADER_CRC_FAILED' ? 'CRC'
        : err.code === 'TRUNCATED' ? 'TRUNCATED'
        : err.code === 'VERSION_UNSUPPORTED' ? 'VERSION'
        : 'CRC';
      return { kind: 'corrupt', code };
    }
    throw err;
  }
  if (!header) return { kind: 'missing' };

  // Try to decrypt.
  const encryptionKey = process.env['ENCRYPTION_KEY'];
  if (!encryptionKey) {
    // Phase A: env.ts has already crashed if this is missing. Defensive
    // fallback — treat as decrypt failed so the validator blocks cleanly.
    return { kind: 'decrypt-failed', header };
  }

  try {
    const payload = readSentinelPayload(encryptionKey);
    if (!payload) return { kind: 'missing' };
    return { kind: 'full', header, payload };
  } catch (err) {
    if (err instanceof SentinelError) {
      if (err.code === 'DECRYPT_FAILED' || err.code === 'CHECKSUM_FAILED') {
        return { kind: 'decrypt-failed', header };
      }
      return { kind: 'corrupt', code: 'CRC' };
    }
    throw err;
  }
}

interface RegenerateOutcome {
  ok: boolean;
  newHostId: string;
  error?: string;
}

async function regenerateSentinel(
  result: Extract<ValidationResult, { status: 'regenerate-sentinel' }>,
): Promise<RegenerateOutcome> {
  const encryptionKey = process.env['ENCRYPTION_KEY'];
  const jwtSecret = process.env['JWT_SECRET'];
  const databaseUrl = process.env['DATABASE_URL'];
  if (!encryptionKey || !jwtSecret || !databaseUrl) {
    return {
      ok: false,
      newHostId: '',
      error: 'ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must all be set',
    };
  }

  try {
    const hostId = await withSetupLock(async () => {
      // Pick up the admin email from the first super admin row. Best effort —
      // falls back to 'unknown' if nothing matches, since this path exists to
      // unblock startup, not to populate marketing metadata.
      let adminEmail = 'unknown';
      try {
        const rows = await db.execute(sql`
          SELECT email FROM users WHERE is_super_admin = true ORDER BY created_at ASC LIMIT 1
        `);
        const first = (rows.rows as any[])[0]?.email;
        if (first) adminEmail = first;
      } catch {
        /* leave as 'unknown' */
      }

      // Make sure installation_id is persisted. It should already be set —
      // we only reach regenerate when DB has an ID — but the recovery paths
      // write it defensively anyway.
      if (!(await getSetting(SystemSettingsKeys.INSTALLATION_ID))) {
        await setSetting(SystemSettingsKeys.INSTALLATION_ID, result.dbInstallationId);
      }

      const hostId = ensureHostId();
      deleteSentinel();
      createSentinel(
        {
          installationId: result.dbInstallationId,
          hostId,
          adminEmail,
          appVersion: process.env['APP_VERSION'] || '0.1.0',
          databaseUrl,
          jwtSecret,
          tenantCountAtSetup: 1,
        },
        encryptionKey,
      );
      return hostId;
    });
    return { ok: true, newHostId: hostId };
  } catch (err) {
    return { ok: false, newHostId: '', error: (err as Error).message };
  }
}

function blockedEvent(
  code: Extract<ValidationResult, { status: 'blocked' }>['code'],
): Parameters<typeof sentinelAudit>[0] {
  switch (code) {
    case 'DATABASE_RESET_DETECTED':
      return 'installation.database_reset_detected';
    case 'INSTALLATION_MISMATCH':
      return 'installation.mismatch_detected';
    case 'SENTINEL_CORRUPT':
      return 'installation.corrupt_sentinel_detected';
    case 'SENTINEL_DECRYPT_FAILED':
      return 'installation.decrypt_failed';
    case 'ORPHANED_DATA':
      return 'installation.orphaned_data_detected';
    case 'MIGRATIONS_PENDING':
      return 'installation.migrations_pending';
    case 'DATABASE_AHEAD':
      return 'installation.database_ahead_of_code';
    case 'UNKNOWN':
    default:
      return 'installation.mismatch_detected';
  }
}

// Reference `env` so the import is not tree-shaken. Preflight does not use
// env directly — the crash-on-missing behavior is the whole point — but we
// need env.ts to load before preflight runs so ENCRYPTION_KEY is validated.
void env;
