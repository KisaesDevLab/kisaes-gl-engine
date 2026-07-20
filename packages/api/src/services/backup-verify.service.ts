// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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
import { verifyPartIntegrity } from './vmx-package.js';
import { getSetting } from './admin.service.js';
import { decrypt as decryptField } from '../utils/encryption.js';
import { recordSchedulerTick, incCounter } from '../utils/metrics.js';
import { log } from '../utils/logger.js';
import { withSchedulerLock } from '../utils/scheduler-lock.js';
import { recordVerifyOutcome } from './backup-run-log.service.js';

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
  /** full = decrypted + parsed; deep = inventory + entry hashes proven
   *  with the stored scheduled passphrase; header = envelope-only
   *  (no usable passphrase — e.g. a manually-passphrased backup). */
  depth: 'full' | 'header' | 'deep';
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

// The scheduled-backup passphrase, decrypted from settings. null when
// none is configured (or decryption fails) — verification then degrades
// to header-only for passphrase files.
async function scheduledPassphrase(): Promise<string | null> {
  try {
    const enc = await getSetting('backup_scheduled_passphrase');
    return enc ? decryptField(enc) : null;
  } catch {
    return null;
  }
}

async function verifyOneFile(
  tenantId: string,
  filePath: string,
  passphrase: string | null,
): Promise<BackupFileVerification> {
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
      // Header checks pass on a file truncated anywhere past byte 77 —
      // the GCM auth tag is only proven by decrypting. Scheduled
      // backups use the stored passphrase, so try the real proof; a
      // failure is ambiguous (manual backup with a different
      // passphrase vs corruption), so it degrades to header-ok with
      // the ambiguity recorded rather than a false alarm.
      if (passphrase) {
        try {
          smartDecrypt(buffer, passphrase);
          return { ...base, depth: 'full', ok: true };
        } catch {
          return {
            ...base, ok: true,
            metadata: { warning: 'header ok, but full decrypt failed with the scheduled passphrase — manually-passphrased backup or corruption past the header' },
          };
        }
      }
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

// Byte budget for hash-proving .vmx entry payloads per verify cycle.
const VMX_VERIFY_BYTE_BUDGET = Number(process.env['BACKUP_VERIFY_MAX_BYTES'] || 1024 * 1024 * 1024);

/**
 * Verify a multi-part .vmx series (or single .vmx): all parts named by
 * the partNNofMM suffix are present, each part's authenticated
 * inventory decrypts with the scheduled passphrase, entry payloads
 * hash-match up to the byte budget, and exactly one part carries the
 * series descriptor. Without a usable passphrase the parts' plaintext
 * ZIP structure is the best we can check (depth 'header').
 */
async function verifyVmxSeries(
  tenantId: string,
  partPaths: string[],
  passphrase: string | null,
): Promise<BackupFileVerification> {
  const first = partPaths[0]!;
  const fileName = path.basename(first).replace(/\.part\d+of\d+\.vmx$/, '.vmx');
  const sizeBytes = partPaths.reduce((n, p) => n + fs.statSync(p).size, 0);
  const base: BackupFileVerification = {
    tenantId, fileName, filePath: first, sizeBytes,
    method: 'passphrase', depth: passphrase ? 'deep' : 'header', ok: false,
  };

  try {
    // Completeness by filename contract: partNNofMM must yield MM
    // distinct parts. A lone .vmx with no suffix is a 1-of-1.
    const m = path.basename(first).match(/\.part(\d+)of(\d+)\.vmx$/);
    const expected = m ? parseInt(m[2]!, 10) : 1;
    if (partPaths.length !== expected) {
      return { ...base, ok: false, error: `series incomplete: ${partPaths.length} of ${expected} parts on disk` };
    }
    if (!passphrase) {
      return { ...base, ok: true, metadata: { warning: 'no scheduled passphrase stored — series completeness checked, content not proven' } };
    }

    let seriesParts = 0;
    let entriesChecked = 0;
    let bytesChecked = 0;
    let entriesTotal = 0;
    let budget = VMX_VERIFY_BYTE_BUDGET;
    for (const p of [...partPaths].sort()) {
      // eslint-disable-next-line no-await-in-loop -- sequential keeps peak memory at one entry.
      const r = await verifyPartIntegrity(p, passphrase, budget);
      if (r.hasSeries) seriesParts += 1;
      entriesChecked += r.entriesChecked;
      entriesTotal += r.entriesTotal;
      bytesChecked += r.bytesChecked;
      budget = Math.max(0, budget - r.bytesChecked);
    }
    if (expected > 1 && seriesParts !== 1) {
      return { ...base, ok: false, error: `expected exactly one series descriptor across the parts, found ${seriesParts}` };
    }
    return {
      ...base, ok: true,
      metadata: { parts: partPaths.length, entriesTotal, entriesChecked, bytesChecked },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Same ambiguity policy as the .vmb path: a decrypt failure can't
    // distinguish "this backup was made with a different passphrase"
    // (e.g. the operator rotated backup_scheduled_passphrase, or made
    // a manual backup) from corruption. Hard-failing here would alarm
    // on every verify cycle after a rotation until a new backup
    // becomes the newest settled unit. Structural completeness was
    // already proven above; record the ambiguity instead.
    if (msg.includes('Incorrect passphrase')) {
      return {
        ...base, depth: 'header', ok: true,
        metadata: { warning: 'series complete, but the stored scheduled passphrase does not decrypt it — rotated or manual passphrase, or corruption; content not proven' },
      };
    }
    return { ...base, ok: false, error: msg };
  }
}

const BACKUP_EXTS = ['.vmb', '.kbk', '.vmx'];

function collectBackupPaths(): Array<{ tenantId: string; filePath: string }> {
  const root = backupDir();
  if (!fs.existsSync(root)) return [];
  const isBackup = (f: string) => BACKUP_EXTS.some((ext) => f.endsWith(ext));
  const paths: Array<{ tenantId: string; filePath: string }> = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    // Tenant-scoped subfolders AND system-level backups at the root.
    if (entry.isDirectory()) {
      const tenantDir = path.join(root, entry.name);
      for (const f of fs.readdirSync(tenantDir)) {
        if (isBackup(f)) {
          paths.push({ tenantId: entry.name, filePath: path.join(tenantDir, f) });
        }
      }
    } else if (entry.isFile() && isBackup(entry.name)) {
      paths.push({ tenantId: SYSTEM_TENANT_ID, filePath: path.join(root, entry.name) });
    }
  }
  return paths;
}

// A backup UNIT is one restorable artifact: a single .vmb/.kbk/.vmx, or
// ALL the parts of one multi-part .vmx series. Grouping by the name
// with the .partNNofMM suffix stripped keeps a series together — the
// prior per-file logic never verified .vmx at all, which meant the
// primary DR artifact (the attachments-included system backup is
// always .vmx) was silently skipped every cycle.
function unitKeyOf(filePath: string): string {
  return path.basename(filePath).replace(/\.part\d+of\d+\.vmx$/, '.vmx');
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
  const passphrase = await scheduledPassphrase();

  // Group files into units, then keep the newest unit per tenant.
  const units = new Map<string, { tenantId: string; paths: string[]; mtime: number }>();
  for (const f of allFiles) {
    const key = `${f.tenantId} ${unitKeyOf(f.filePath)}`;
    const mtime = fs.statSync(f.filePath).mtimeMs;
    const u = units.get(key);
    if (u) {
      u.paths.push(f.filePath);
      u.mtime = Math.max(u.mtime, mtime);
    } else {
      units.set(key, { tenantId: f.tenantId, paths: [f.filePath], mtime });
    }
  }
  // Newest SETTLED unit per tenant: a unit whose newest file is less
  // than 10 minutes old may still be mid-write by the backup scheduler
  // (the verifier holds a different advisory lock), and verifying it
  // would false-alarm on an incomplete series. Prefer the newest unit
  // older than the settle window; fall back to the newest regardless
  // when it's the only one.
  const SETTLE_MS = 10 * 60 * 1000;
  const now = Date.now();
  const byTenant = new Map<string, Array<{ paths: string[]; mtime: number }>>();
  for (const u of units.values()) {
    const list = byTenant.get(u.tenantId) ?? [];
    list.push({ paths: u.paths, mtime: u.mtime });
    byTenant.set(u.tenantId, list);
  }
  const latestByTenant = new Map<string, { paths: string[]; mtime: number }>();
  for (const [tenantId, list] of byTenant.entries()) {
    list.sort((a, b) => b.mtime - a.mtime);
    const settled = list.find((u) => now - u.mtime > SETTLE_MS);
    latestByTenant.set(tenantId, settled ?? list[0]!);
  }

  const results: BackupFileVerification[] = [];
  for (const [tenantId, unit] of latestByTenant.entries()) {
    const isVmx = unit.paths[0]!.endsWith('.vmx');
    // eslint-disable-next-line no-await-in-loop -- verification is I/O-cheap and we want deterministic log order.
    const r = isVmx
      ? await verifyVmxSeries(tenantId, unit.paths, passphrase)
      : await verifyOneFile(tenantId, unit.paths[0]!, passphrase);
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
    // Stamp the outcome onto the backup_runs row that produced this
    // artifact (matched by base file name); unmatched results (backups
    // predating the run log) insert their own 'verify' row. Best-effort —
    // a log-write failure must not fail the verification cycle.
    await recordVerifyOutcome({
      // '_system' and test-fixture directory names are not tenant UUIDs —
      // those verifications are recorded system-wide (tenantId null).
      tenantId: UUID_RE.test(tenantId) ? tenantId : null,
      fileName: r.fileName,
      ok: r.ok,
      depth: r.depth,
      error: r.error,
      warning: typeof r.metadata?.['warning'] === 'string' ? (r.metadata['warning'] as string) : undefined,
      sizeBytes: r.sizeBytes,
    });
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
