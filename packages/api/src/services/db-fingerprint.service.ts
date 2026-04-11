import fs from 'fs';
import path from 'path';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { writeAtomicSync } from '../utils/atomic-write.js';
import { getSetting } from './admin.service.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';

/**
 * Lightweight DB fingerprint — written to /data/.db-fingerprint once per
 * hour. Supplementary integrity signal: if the sentinel and installation_id
 * check both pass but the row counts dropped from 12,450 to 0, something
 * has gone wrong that is worth alerting on even if it doesn't trip the
 * hard-block gates.
 *
 * Phase C scope (per plan):
 *   - Writer: runs hourly alongside the backup scheduler
 *   - Reader: used by scripts/verify-installation.ts for health reports
 *   - Plaintext JSON, not encrypted — this is a quick-check, not a
 *     security signal. The hard gates already live in the sentinel.
 *
 * If the file is missing, we return null rather than throwing — older
 * installations won't have one until the scheduler runs.
 */

export interface DbFingerprint {
  version: 1;
  updatedAt: string;
  installationId: string | null;
  tenantCount: number;
  userCount: number;
  transactionCount: number;
  lastTransactionId: string | null;
}

export function getFingerprintPath(): string {
  return path.join(process.env['DATA_DIR'] || '/data', '.db-fingerprint');
}

export function fingerprintExists(): boolean {
  return fs.existsSync(getFingerprintPath());
}

/** Query current DB state and produce a fingerprint snapshot. */
export async function captureFingerprint(): Promise<DbFingerprint> {
  const [tenantRow] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM tenants`)).rows as any[];
  const [userRow] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM users`)).rows as any[];
  const [txnRow] = (await db.execute(sql`SELECT COUNT(*) as cnt FROM transactions`)).rows as any[];
  const [lastTxnRow] = (
    await db.execute(sql`SELECT id FROM transactions ORDER BY created_at DESC LIMIT 1`)
  ).rows as any[];

  const installationId = await getSetting(SystemSettingsKeys.INSTALLATION_ID);

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    installationId,
    tenantCount: parseInt(tenantRow?.cnt ?? '0'),
    userCount: parseInt(userRow?.cnt ?? '0'),
    transactionCount: parseInt(txnRow?.cnt ?? '0'),
    lastTransactionId: lastTxnRow?.id ?? null,
  };
}

/** Capture + write atomically. Returns the snapshot that was written. */
export async function updateFingerprint(): Promise<DbFingerprint> {
  const snapshot = await captureFingerprint();
  writeAtomicSync(getFingerprintPath(), JSON.stringify(snapshot, null, 2), 0o600);
  return snapshot;
}

/** Read the last written fingerprint. Returns null if missing or malformed. */
export function readFingerprint(): DbFingerprint | null {
  if (!fingerprintExists()) return null;
  try {
    const raw = fs.readFileSync(getFingerprintPath(), 'utf8');
    const parsed = JSON.parse(raw) as DbFingerprint;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Compare a stored fingerprint to live DB state. Returns null if everything
 * looks consistent, or a string describing the divergence if something
 * looks wrong. The caller is responsible for acting on the result.
 */
export async function verifyFingerprint(): Promise<string | null> {
  const stored = readFingerprint();
  if (!stored) return null; // nothing to compare against
  const live = await captureFingerprint();

  if (stored.installationId && live.installationId && stored.installationId !== live.installationId) {
    return `installation_id changed since last fingerprint (${stored.installationId} → ${live.installationId})`;
  }

  // Material drops in counts are the important signal — a single new
  // transaction is fine, but going from 12,000 to 0 is suspicious.
  if (stored.transactionCount > 0 && live.transactionCount === 0) {
    return `transaction count dropped from ${stored.transactionCount} to 0`;
  }
  if (stored.tenantCount > 0 && live.tenantCount === 0) {
    return `tenant count dropped from ${stored.tenantCount} to 0`;
  }
  if (stored.userCount > 0 && live.userCount === 0) {
    return `user count dropped from ${stored.userCount} to 0`;
  }

  return null;
}

// Scheduler ----------------------------------------------------------

const UPDATE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 minutes after startup

/**
 * Start the hourly fingerprint updater. Called from the normal app startup
 * (index.ts) alongside the backup scheduler.
 */
export function startFingerprintScheduler(): void {
  console.log('[Fingerprint] scheduler registered — hourly updates');
  setTimeout(() => {
    updateFingerprint()
      .then((snap) => console.log(`[Fingerprint] initial snapshot: ${snap.tenantCount} tenants, ${snap.userCount} users, ${snap.transactionCount} transactions`))
      .catch((err) => console.error('[Fingerprint] initial error:', err.message));
  }, INITIAL_DELAY_MS);

  setInterval(() => {
    updateFingerprint().catch((err) => console.error('[Fingerprint] interval error:', err.message));
  }, UPDATE_INTERVAL_MS);
}
