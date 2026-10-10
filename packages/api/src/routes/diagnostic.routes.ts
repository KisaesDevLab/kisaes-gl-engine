// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import fs from 'fs';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  sentinelExists,
  readSentinelHeader,
  createSentinel,
  deleteSentinel,
  getSentinelPath,
  SentinelError,
} from '../services/sentinel.service.js';
import { ensureHostId, readHostId } from '../services/host-id.service.js';
import { getSetting, setSetting } from '../services/admin.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { withSetupLock, getInitializedMarkerPath, countTenantsAndUsers } from '../services/setup.service.js';
import { recoveryFileExists, readRecoveryFile } from '../services/env-recovery.service.js';
import { writeRestoreIntent, restoreIntentExists } from '../services/restore-intent.service.js';
import { sentinelAudit } from '../startup/sentinel-audit.js';
import type { ValidationResult } from '../startup/installation-validator.js';

interface DiagnosticUserRow {
  id: string;
  passwordHash: string;
  isSuperAdmin: boolean;
  email: string;
}

// Small in-memory limiter for the two credential-bearing endpoints below.
// The diagnostic app mounts no shared rate-limit store (no Redis, by
// design), so this mirrors env-missing-app's 10/min/IP bucket.
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function allowAttempt(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false;
  bucket.count += 1;
  return true;
}

/**
 * Diagnostic routes — the only HTTP endpoints mounted when the app is
 * started in blocked state by bootstrap.ts. NO auth middleware, NO db
 * middleware, NO setup routes. Intentionally kept tiny so the blocked-state
 * surface area is minimal.
 *
 * Routes:
 *   GET  /api/diagnostic/status
 *     Returns the cached validation result from the preflight run that
 *     decided to block, plus the (unencrypted) sentinel header if present.
 *     Used by the React DiagnosticRouter to pick which page to render.
 *
 *   POST /api/diagnostic/regenerate-sentinel
 *     Authenticates against the users table with bcrypt. On success,
 *     deletes the existing sentinel and writes a new one using the current
 *     DB installation_id. Used for Case 5 (wrong key / corrupt sentinel)
 *     recovery where the user still has valid admin credentials and a
 *     working ENCRYPTION_KEY.
 *
 *   POST /api/diagnostic/prepare-restore
 *     The same-host disaster-recovery path for DATABASE_RESET_DETECTED /
 *     ORPHANED_DATA: Postgres was lost but /data survived. The database is
 *     EMPTY, so no account can authenticate; the operator proves intent and
 *     ownership with the installation's recovery key instead (it decrypts
 *     /data/.env.recovery). On success the sentinel and the `.initialized`
 *     marker are set aside (copies kept), `.host-id` is KEPT so the restore
 *     is recognised as same-host, and `/data/.restore-intent` is written so
 *     preflight treats the next boot as a sanctioned fresh install whose
 *     wizard offers "Restore from backup".
 */
export function createDiagnosticRouter(cached: ValidationResult): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response) => {
    let header = null;
    if (sentinelExists()) {
      try {
        header = readSentinelHeader();
      } catch {
        // Leave header null — the caller's code already reflects the
        // corruption state.
      }
    }
    res.json({
      result: cached,
      sentinelHeader: header,
      hostId: readHostId(),
      // Lets the DATABASE_RESET_DETECTED page decide between the recovery-key
      // form (prepare-restore) and the manual filesystem instructions.
      recoveryFilePresent: recoveryFileExists(),
      restoreIntent: restoreIntentExists(),
    });
  });

  router.post('/regenerate-sentinel', async (req: Request, res: Response) => {
    const body = req.body as { email?: string; password?: string } | undefined;
    const email = body?.email?.toString().trim();
    const password = body?.password?.toString();

    if (!email || !password) {
      res.status(400).json({ error: { message: 'email and password required' } });
      return;
    }

    // Authenticate directly against users table. No session, no JWT — the
    // normal auth middleware isn't mounted in diagnostic mode because it
    // pulls in too many DB dependencies.
    let user: { id: string; passwordHash: string; isSuperAdmin: boolean; email: string } | null = null;
    try {
      const rows = await db.execute(sql`
        SELECT id, password_hash as "passwordHash", is_super_admin as "isSuperAdmin", email
        FROM users
        WHERE email = ${email}
        LIMIT 1
      `);
      const row = (rows.rows as unknown as DiagnosticUserRow[])[0];
      if (row) {
        user = { id: row.id, passwordHash: row.passwordHash, isSuperAdmin: row.isSuperAdmin, email: row.email };
      }
    } catch (err) {
      res.status(500).json({ error: { message: 'database unreachable — cannot authenticate' } });
      return;
    }

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      res.status(401).json({ error: { message: 'invalid credentials' } });
      return;
    }
    if (!user.isSuperAdmin) {
      res.status(403).json({ error: { message: 'super admin required' } });
      return;
    }

    const encryptionKey = process.env['ENCRYPTION_KEY'];
    const jwtSecret = process.env['JWT_SECRET'];
    const databaseUrl = process.env['DATABASE_URL'];
    if (!encryptionKey || !jwtSecret || !databaseUrl) {
      res.status(500).json({
        error: {
          message: 'ENCRYPTION_KEY, JWT_SECRET, and DATABASE_URL must all be set to regenerate the sentinel',
        },
      });
      return;
    }

    try {
      await withSetupLock(async () => {
        // Prefer the existing installation_id if present; otherwise generate a
        // fresh one (this happens if the DB also lost its row but somehow has
        // users — shouldn't normally occur, but the endpoint is used for
        // recovery so we lean toward "do something useful").
        let installationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);
        if (!installationId) {
          installationId = crypto.randomUUID();
          await setSetting(SystemSettingsKeys.INSTALLATION_ID, installationId);
        }

        const hostId = ensureHostId();
        deleteSentinel();
        createSentinel(
          {
            installationId,
            hostId,
            adminEmail: user!.email,
            appVersion: process.env['APP_VERSION'] || '0.1.0',
            databaseUrl,
            jwtSecret,
            tenantCountAtSetup: 1,
          },
          encryptionKey,
        );

        sentinelAudit('sentinel.regenerate', {
          source: 'diagnostic-endpoint',
          userEmail: user!.email,
          installationId,
          hostId,
        });
      });
    } catch (err) {
      const message = err instanceof SentinelError ? err.message : (err as Error).message;
      res.status(500).json({ error: { message: `sentinel regeneration failed: ${message}` } });
      return;
    }

    res.json({ success: true, message: 'Sentinel regenerated. Restart the container to reload.' });
  });

  router.post('/prepare-restore', async (req: Request, res: Response) => {
    const ip = (req.ip ?? req.socket.remoteAddress ?? 'unknown').toString();
    if (!allowAttempt(ip)) {
      res.status(429).json({ error: { message: 'too many attempts — wait a minute and retry' } });
      return;
    }
    const body = (req.body ?? {}) as { recoveryKey?: unknown; confirm?: unknown };
    const recoveryKey = typeof body.recoveryKey === 'string' ? body.recoveryKey.trim() : '';
    const confirm = typeof body.confirm === 'string' ? body.confirm.trim() : '';

    const code = cached.status === 'blocked' ? cached.code : null;
    if (code !== 'DATABASE_RESET_DETECTED' && code !== 'ORPHANED_DATA') {
      res.status(409).json({
        error: { message: `prepare-restore is only available in the DATABASE_RESET_DETECTED or ORPHANED_DATA state (current: ${code ?? cached.status})` },
      });
      return;
    }
    if (confirm !== 'RESTORE') {
      res.status(400).json({ error: { message: 'type RESTORE in the confirm field to continue' } });
      return;
    }

    // Ownership proof: the recovery key must decrypt /data/.env.recovery.
    // Without a recovery file there is nothing to verify against, so the
    // operator has to act on the filesystem (which is its own proof).
    if (!recoveryFileExists()) {
      res.status(409).json({
        error: {
          message:
            'No /data/.env.recovery file exists on this server, so the recovery key cannot be verified. ' +
            'Use the manual commands shown on this page instead.',
          code: 'NO_RECOVERY_FILE',
        },
      });
      return;
    }
    if (!recoveryKey) {
      res.status(400).json({ error: { message: 'recoveryKey required' } });
      return;
    }
    let previousInstallationId: string | null = null;
    try {
      const contents = readRecoveryFile(recoveryKey);
      previousInstallationId = contents?.installationId ?? null;
    } catch {
      res.status(401).json({ error: { message: 'recovery key did not decrypt the recovery file' } });
      return;
    }

    // Safety: the database must really be empty of accounts. If users exist
    // this is not a reset — it is a mismatch, and the regenerate-sentinel
    // form (super-admin login) is the right tool.
    try {
      const counts = await countTenantsAndUsers();
      if (counts.users > 0) {
        res.status(409).json({
          error: {
            message: `The database still holds ${counts.users} user account(s). This is not an empty database — ` +
              'use "Regenerate the sentinel" with a super-admin login instead of preparing a restore.',
          },
        });
        return;
      }
    } catch (err) {
      res.status(503).json({ error: { message: `database unreachable — cannot confirm it is empty: ${(err as Error).message}` } });
      return;
    }

    const stamp = Date.now();
    const setAside: string[] = [];
    try {
      const sentinelPath = getSentinelPath();
      if (sentinelExists()) {
        const copy = `${sentinelPath}.pre-restore-${stamp}`;
        fs.copyFileSync(sentinelPath, copy);
        setAside.push(copy);
        deleteSentinel();
      }
      const marker = getInitializedMarkerPath();
      if (fs.existsSync(marker)) {
        const copy = `${marker}.pre-restore-${stamp}`;
        fs.copyFileSync(marker, copy);
        setAside.push(copy);
        fs.unlinkSync(marker);
      }
      writeRestoreIntent({
        previousInstallationId,
        hostId: readHostId(),
        source: 'diagnostic-prepare-restore',
      });
    } catch (err) {
      res.status(500).json({
        error: { message: `could not prepare the volume for restore: ${(err as Error).message}. Check that /data is writable by the container (UID 1001).` },
      });
      return;
    }

    sentinelAudit('installation.restore_prepared', {
      source: 'diagnostic-endpoint',
      previousInstallationId,
      hostId: readHostId(),
      blockedCode: code,
      setAside,
    });

    res.json({
      success: true,
      message:
        'This server is ready to be restored. Restart the api container; the setup wizard will open — choose "Restore from backup" ' +
        '(or "New installation" to start over). Your existing files, host identity and recovery key are preserved.',
      setAside,
      restoreIntent: restoreIntentExists(),
    });
  });

  return router;
}
