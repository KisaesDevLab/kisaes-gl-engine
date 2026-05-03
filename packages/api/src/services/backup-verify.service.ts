// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Backup-verification service. Scheduled (BACKUP_VERIFY_INTERVAL_MS,
// default 30 days) and on-demand via /admin/backup-verify.
//
// For each backup file we either:
//
//   a) Fully decrypt + parse (server-key .kbk backups). This proves
//      the file is readable end-to-end: encryption key, AES-GCM auth
//      tag, and JSON parse all succeed.
//
//   b) Verify the passphrase-encrypted header envelope (.vmb). We
//      don't store the passphrase server-side by design, so we
//      cannot decrypt content automatically. Instead we check:
//        - file size >= header size
//        - magic bytes `VMBP` match
//        - version byte is supported
//      This catches truncation, corruption, or accidental overwrite —
//      i.e. the most common backup failure modes — without needing
//      the secret.
//
// Either way we write a `backup_verified` audit row with the outcome.
// A `backup_verify_failed` row gets emitted (and stays permanent in
// the audit table) when verification fails — operators should treat
// it as a call-to-action, not noise.

import fs from 'fs';
import path from 'path';
import { auditLog } from '../middleware/audit.js';
import { detectEncryptionMethod, smartDecrypt } from './portable-encryption.service.js';
import { recordSchedulerTick, incCounter } from '../utils/metrics.js';
import { log } from '../utils/logger.js';
import { withSchedulerLock } from '../utils/scheduler-lock.js';

function backupDir(): string {
  // Read lazily so tests can override via process.env.BACKUP_DIR
  // per-case, and operators can pivot the mount point without
  // restarting the API.
  return process.env['BACKUP_DIR'] || '/data/backups';
}
const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

// Magic bytes / header sizes duplicated here (not imported) so a
// schema tweak in portable-encryption.service doesn't silently land
// in verification output.
const PASSPHRASE_MAGIC = Buffer.from('VMBP', 'ascii');
const HEADER_SIZE = PASSPHRASE_MAGIC.length + 1 /* version */ + 32 /* salt */ + 12 /* iv */ + 16 /* authTag */;
const SUPPORTED_VERSIONS = new Set([1, 2]);

export interface BackupFileVerification {
  tenantId: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  method: 'passphrase' | 'server_key';
  /** full = decrypted + parsed JSON; header = envelope-only. */
  depth: 'full' | 'header';
  ok: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface VerifySummary {
  startedAt: string;
  durationMs: number;
  totalFiles: number;
  ok: number;
  failed: number;
  results: BackupFileVerification[];
}

function verifyPassphraseHeader(buf: Buffer): { ok: true } | { ok: false; error: string } {
  if (buf.length < HEADER_SIZE) {
    return { ok: false, error: `file smaller than header (${buf.length}B < ${HEADER_SIZE}B)` };
  }
  if (!buf.subarray(0, PASSPHRASE_MAGIC.length).equals(PASSPHRASE_MAGIC)) {
    return { ok: false, error: 'magic bytes mismatch (file may be corrupted or truncated)' };
  }
  const version = buf.readUInt8(PASSPHRASE_MAGIC.length);
  if (!SUPPORTED_VERSIONS.has(version)) {
    return { ok: false, error: `unsupported format version ${version}` };
  }
  return { ok: true };
}

async function verifyOneFile(tenantId: string, filePath: string): Promise<BackupFileVerification> {
  const fileName = path.basename(filePath);
  const stat = fs.statSync(filePath);
  const buffer = fs.readFileSync(filePath);
  const method = detectEncryptionMethod(buffer);

  const base: BackupFileVerification = {
    tenantId,
    fileName,
    filePath,
    sizeBytes: stat.size,
    method,
    depth: method === 'server_key' ? 'full' : 'header',
    ok: false,
  };

  try {
    if (method === 'passphrase') {
      const hdr = verifyPassphraseHeader(buffer);
      if (!hdr.ok) return { ...base, ok: false, error: hdr.error };
      return { ...base, ok: true };
    }

    // server_key path — full decrypt + parse.
    const { data } = smartDecrypt(buffer);
    const parsed = JSON.parse(data.toString()) as { metadata?: Record<string, unknown> };
    return { ...base, ok: true, metadata: parsed.metadata };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, ok: false, error: msg };
  }
}

function collectBackupPaths(): Array<{ tenantId: string; filePath: string }> {
  const root = backupDir();
  if (!fs.existsSync(root)) return [];
  const paths: Array<{ tenantId: string; filePath: string }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    // Tenant-scoped subfolders AND system-level backups at the root.
    if (entry.isDirectory()) {
      const tenantDir = path.join(root, entry.name);
      for (const f of fs.readdirSync(tenantDir)) {
        if (f.endsWith('.vmb') || f.endsWith('.kbk')) {
          paths.push({ tenantId: entry.name, filePath: path.join(tenantDir, f) });
        }
      }
    } else if (entry.isFile() && (entry.name.endsWith('.vmb') || entry.name.endsWith('.kbk'))) {
      paths.push({ tenantId: SYSTEM_TENANT_ID, filePath: path.join(root, entry.name) });
    }
  }
  return paths;
}

/**
 * Verify the most recent backup per tenant (plus the most recent
 * system backup if present). Picking the latest keeps verification
 * cost bounded on installations with hundreds of historical files.
 */
export async function verifyLatestBackups(): Promise<VerifySummary> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const allFiles = collectBackupPaths();

  // Group by tenantId, keep the newest file per tenant.
  const latestByTenant = new Map<string, string>();
  for (const f of allFiles) {
    const existing = latestByTenant.get(f.tenantId);
    if (!existing) {
      latestByTenant.set(f.tenantId, f.filePath);
      continue;
    }
    if (fs.statSync(f.filePath).mtimeMs > fs.statSync(existing).mtimeMs) {
      latestByTenant.set(f.tenantId, f.filePath);
    }
  }

  const results: BackupFileVerification[] = [];
  for (const [tenantId, filePath] of latestByTenant.entries()) {
    // eslint-disable-next-line no-await-in-loop -- verification is I/O-cheap and we want deterministic log order.
    const r = await verifyOneFile(tenantId, filePath);
    results.push(r);
    incCounter(
      'backup_verify_total',
      'Total backup verification attempts',
      { result: r.ok ? 'ok' : 'failed', depth: r.depth },
    );
    // Only route the audit entry to a tenant-scoped row when the
    // directory name is a valid UUID. Test fixtures and misnamed
    // directories roll up to the system tenant so the audit write
    // still succeeds.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const auditTenant = UUID_RE.test(tenantId) ? tenantId : SYSTEM_TENANT_ID;
    await auditLog(
      auditTenant,
      'update',
      r.ok ? 'backup_verified' : 'backup_verify_failed',
      null,
      null,
      {
        fileName: r.fileName,
        sizeBytes: r.sizeBytes,
        method: r.method,
        depth: r.depth,
        error: r.error,
      },
    ).catch((err) => {
      log.warn({ component: 'backup-verify', event: 'audit_write_failed', message: err instanceof Error ? err.message : String(err) });
    });
    if (r.ok) {
      log.info({ component: 'backup-verify', event: 'file_verified', tenantId, fileName: r.fileName, method: r.method, depth: r.depth });
    } else {
      log.error({ component: 'backup-verify', event: 'file_failed', tenantId, fileName: r.fileName, error: r.error });
    }
  }

  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  const durationMs = Date.now() - started;

  recordSchedulerTick('backup_verify', durationMs, failed === 0 ? 'ok' : 'error');
  log.info({ component: 'backup-verify', event: 'cycle_complete', durationMs, totalFiles: results.length, ok, failed });

  return { startedAt, durationMs, totalFiles: results.length, ok, failed, results };
}

const DEFAULT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
// Node.js setInterval/setTimeout silently truncates delays larger than
// 2^31-1 ms (~24.85 days) to 1ms. The 30-day default above exceeds
// that, so a raw `setInterval(cb, DEFAULT_INTERVAL_MS)` runaway-fires
// at ~1000 cycles/sec — flooding logs and starving the event loop
// (which is exactly how /health stops responding when nothing else is
// obviously broken). Sleep in MAX_TIMEOUT_MS chunks instead.
const MAX_TIMEOUT_MS = 2_147_483_647;

let verifyTimer: ReturnType<typeof setTimeout> | null = null;
let verifyStopped = false;

function intervalMs(): number {
  const raw = process.env['BACKUP_VERIFY_INTERVAL_MS'];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INTERVAL_MS;
}

// Sleep `delay` ms then call `fn`, in chunks ≤ MAX_TIMEOUT_MS so Node
// doesn't quietly downgrade the timer.
function scheduleAfter(delay: number, fn: () => void): void {
  if (verifyStopped) return;
  const chunk = Math.min(delay, MAX_TIMEOUT_MS);
  verifyTimer = setTimeout(() => {
    if (verifyStopped) return;
    if (delay > chunk) {
      scheduleAfter(delay - chunk, fn);
    } else {
      fn();
    }
  }, chunk);
  verifyTimer.unref?.();
}

// One verification cycle, then re-arm for the next at intervalMs().
// Chained via `.finally` so a failed/slow cycle never overlaps with
// the next — different from the prior setInterval which would have
// allowed overlap if a cycle ran longer than the interval.
function tickAndReschedule(): void {
  void withSchedulerLock('backup-verifier', verifyLatestBackups)
    .catch((err) => log.error({ component: 'backup-verifier', event: 'interval_error', message: err instanceof Error ? err.message : String(err) }))
    .finally(() => scheduleAfter(intervalMs(), tickAndReschedule));
}

/**
 * Start the backup verification scheduler. Safe to call twice — the
 * second call is a no-op while the first timer is still alive.
 */
export function startBackupVerifier(): void {
  if (verifyTimer) return;
  verifyStopped = false;
  // Delay the first tick by an hour to avoid competing with the
  // main backup scheduler's 5-minute warmup. The advisory lock
  // keeps us safe either way, but the sequencing is cleaner.
  scheduleAfter(60 * 60 * 1000, tickAndReschedule);
  log.info({ component: 'backup-verifier', event: 'started', intervalMs: intervalMs() });
}

export function stopBackupVerifier(): void {
  verifyStopped = true;
  if (verifyTimer) { clearTimeout(verifyTimer); verifyTimer = null; }
}

// Used by integration tests that need to reset state between runs.
export const __internal = {
  verifyOneFile,
  verifyPassphraseHeader,
};
