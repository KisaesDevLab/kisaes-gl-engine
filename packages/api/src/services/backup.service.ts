// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { auditLog } from '../middleware/audit.js';
import {
  encryptWithPassphrase,
  smartDecrypt,
  generateChecksum,
} from './portable-encryption.service.js';
import { getSetting, setSetting } from './admin.service.js';
import { decrypt as decryptField } from '../utils/encryption.js';
import type { StorageProvider } from './storage/storage-provider.interface.js';
import { tenantStorageKey } from './storage/storage-keys.js';
import { getProviderForTenant } from './storage/storage-provider.factory.js';
import { writeTenantPackage, writeTenantPackageMulti, type PackageAttachment } from './vmx-package.js';
import { getSystemBackupTablePlan } from './backup-table-plan.js';
import { FILE_EXPORT_REGISTRY, encodeFileEntryId } from './backup-file-registry.js';

const BACKUP_DIR = process.env['BACKUP_DIR'] || '/data/backups';
const APP_VERSION = '0.3.0';

// Cap on total attachment bytes bundled into a system backup, so a very large
// attachment store can't produce a runaway archive. Attachments beyond the cap
// are skipped and recorded in the package manifest + audit log (never silently).
const MAX_SYSTEM_BACKUP_ATTACHMENT_BYTES =
  Number(process.env['BACKUP_MAX_ATTACHMENT_BYTES']) || 10 * 1024 * 1024 * 1024; // 10 GB

// Whitelist for backup filenames. Prevents path traversal via `../`,
// absolute paths, or shell metacharacters landing in `path.join`. Any
// filename passed to download/delete must match this regex exactly.
const BACKUP_FILENAME_RE = /^kis-books-backup-[A-Za-z0-9._-]+\.(kbk|vmb|vmx)$/;

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Legacy encrypt/decrypt for backward compatibility with old .kbk files
function legacyEncrypt(data: Buffer, key: string): Buffer {
  const iv = crypto.randomBytes(16);
  const keyHash = crypto.createHash('sha256').update(key).digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', keyHash, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]);
}

/**
 * Throw unless `fileName` matches the whitelist.
 */
function assertSafeFileName(fileName: string): void {
  if (!BACKUP_FILENAME_RE.test(fileName)) {
    throw AppError.badRequest('Invalid backup file name');
  }
  if (fileName !== path.basename(fileName)) {
    throw AppError.badRequest('Invalid backup file name');
  }
}

/**
 * Resolve the absolute path for a backup file and verify it stays
 * within the tenant's backup directory.
 */
function resolveBackupPath(tenantId: string, fileName: string): string {
  assertSafeFileName(fileName);
  const tenantDir = path.resolve(path.join(BACKUP_DIR, tenantId));
  const filePath = path.resolve(path.join(tenantDir, fileName));
  if (!filePath.startsWith(tenantDir + path.sep) && filePath !== tenantDir) {
    throw AppError.badRequest('Invalid backup file path');
  }
  return filePath;
}

/**
 * Enumerate every table in the public schema that has a `tenant_id` column,
 * minus the explicit ephemeral exclusions (see backup-table-plan.ts).
 */
async function getTenantScopedTables(): Promise<string[]> {
  return (await getSystemBackupTablePlan(db)).tenantScoped;
}

// ─── Bundle file source ──────────────────────────────────────────

interface BundleFileCounters {
  skipped: Array<{ id: string; table: string; reason: string }>;
  bundledBytes: number;
  bundledCount: number;
}

/**
 * Stream every file referenced by the dumped rows, across ALL registry
 * categories (attachments, extraction sources, portal receipts/Q&A files,
 * payroll import files, report PDFs) — one at a time, capped by total
 * bytes; skips recorded, never silent. attachments entries keep their
 * historical bare-id names so older restore code can still consume them;
 * other categories use `f:`-prefixed ids (see backup-file-registry.ts).
 */
async function* bundleFileSource(opts: {
  tenantIds: string[];
  tenantData: Record<string, Record<string, unknown[]>>;
  globalTables: Record<string, unknown[]>;
  counters: BundleFileCounters;
}): AsyncGenerator<PackageAttachment> {
  const { tenantIds, tenantData, globalTables, counters } = opts;
  const uploadDir = process.env['UPLOAD_DIR'] || '/data/uploads';
  const providerByTenant = new Map<string, StorageProvider>();
  const providerFor = async (tenantId: string): Promise<StorageProvider> => {
    let p = providerByTenant.get(tenantId);
    if (!p) {
      p = await getProviderForTenant(tenantId);
      providerByTenant.set(tenantId, p);
    }
    return p;
  };

  // Parent hop for tables without tenant_id (portal_question_attachments).
  const questionTenant = new Map<string, string>();
  for (const t of tenantIds) {
    for (const q of (tenantData[t]?.['portal_questions'] || []) as Record<string, unknown>[]) {
      questionTenant.set(q['id'] as string, t);
    }
  }

  const readLocal = (p: string): Buffer | null => {
    const candidates = [p, path.join(uploadDir, p.replace(/^\/uploads\//, '')), path.join(uploadDir, p)];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return fs.readFileSync(c);
      } catch { /* skip unreadable */ }
    }
    return null;
  };

  for (const entry of FILE_EXPORT_REGISTRY) {
    // Collect this category's rows with their owning tenant.
    const rowsWithTenant: Array<{ row: Record<string, unknown>; tenantId: string | null }> = [];
    if (entry.tenantColumn) {
      for (const t of tenantIds) {
        for (const row of (tenantData[t]?.[entry.table] || []) as Record<string, unknown>[]) {
          rowsWithTenant.push({ row, tenantId: t });
        }
      }
    } else if (entry.tenantVia) {
      for (const row of (globalTables[entry.table] || []) as Record<string, unknown>[]) {
        rowsWithTenant.push({ row, tenantId: questionTenant.get(row[entry.tenantVia.fkColumn] as string) ?? null });
      }
    }

    for (const { row, tenantId } of rowsWithTenant) {
      const rowId = row['id'] as string;
      if (entry.table === 'attachments') {
        // Historical dual scheme: local file_path first, provider fallback.
        const fp = (row['file_path'] as string | null) || null;
        const storageKey = (row['storage_key'] as string | null) || null;
        if (!fp && !storageKey) continue; // metadata-only row
        let buf: Buffer | null = fp ? readLocal(fp) : null;
        if (!buf && storageKey && tenantId) {
          try {
            buf = await (await providerFor(tenantId)).download(storageKey);
          } catch (err) {
            counters.skipped.push({ id: rowId, table: entry.table, reason: `download failed: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        if (!buf) {
          counters.skipped.push({ id: rowId, table: entry.table, reason: 'file not found' });
          continue;
        }
        if (counters.bundledBytes + buf.length > MAX_SYSTEM_BACKUP_ATTACHMENT_BYTES) {
          counters.skipped.push({ id: rowId, table: entry.table, reason: 'total size cap reached' });
          continue;
        }
        counters.bundledBytes += buf.length;
        counters.bundledCount += 1;
        yield { id: rowId, buffer: buf };
        continue;
      }

      for (const column of entry.columns) {
        const key = (row[column] as string | null) || null;
        if (!key) continue;
        const entryId = encodeFileEntryId(entry.table, rowId, column);
        let buf: Buffer | null = null;
        if (entry.source === 'localPath') {
          buf = readLocal(key);
          if (!buf) {
            counters.skipped.push({ id: entryId, table: entry.table, reason: 'file not found' });
            continue;
          }
        } else {
          if (!tenantId) {
            counters.skipped.push({ id: entryId, table: entry.table, reason: 'owning tenant not resolvable' });
            continue;
          }
          try {
            buf = await (await providerFor(tenantId)).download(key);
          } catch (err) {
            counters.skipped.push({ id: entryId, table: entry.table, reason: `download failed: ${err instanceof Error ? err.message : String(err)}` });
            continue;
          }
        }
        if (counters.bundledBytes + buf.length > MAX_SYSTEM_BACKUP_ATTACHMENT_BYTES) {
          counters.skipped.push({ id: entryId, table: entry.table, reason: 'total size cap reached' });
          continue;
        }
        counters.bundledBytes += buf.length;
        counters.bundledCount += 1;
        yield { id: entryId, buffer: buf };
      }
    }
  }
}

// ─── Local Backup Operations ─────────────────────────────────────

/**
 * Create a passphrase-encrypted per-tenant backup file (.vmb).
 *
 * Uses PBKDF2 + AES-256-GCM. The passphrase is not stored anywhere.
 */
export async function createBackup(
  tenantId: string,
  passphrase: string,
  options: { includeAttachments?: boolean } = {},
  userId?: string,
): Promise<{ backupId: string; fileName: string; size: number; warning?: string }> {
  // Validate tenantId is a UUID
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw AppError.badRequest('Invalid tenant id format');
  }

  const backupId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_DIR, tenantId);
  ensureDir(dir);

  // Dump tenant-scoped data
  const tables = await getTenantScopedTables();
  const dumpData: Record<string, unknown[]> = {};
  let totalRows = 0;
  for (const tableName of tables) {
    const result = await db.execute(
      sql`SELECT * FROM ${sql.identifier(tableName)} WHERE tenant_id = ${tenantId}`,
    );
    dumpData[tableName] = result.rows;
    totalRows += result.rows.length;
  }

  // Count transactions specifically
  const txnCount = (dumpData['transactions'] || []).length;

  const metadata = {
    backup_type: 'tenant' as const,
    version: '1.0.0',
    source_version: APP_VERSION,
    backupId,
    tenantId,
    created_at: new Date().toISOString(),
    encryption_method: 'passphrase_pbkdf2_aes256gcm' as const,
    format: 'kis-books-backup-v3-portable',
    tableCount: tables.length,
    rowCount: totalRows,
    transaction_count: txnCount,
    checksum: '', // filled below
  };

  const contentObj = { metadata, tables: dumpData };
  const contentBuffer = Buffer.from(JSON.stringify(contentObj));
  metadata.checksum = generateChecksum(contentBuffer);

  // With attachments: a streamed .vmx package (rows + files). The
  // includeAttachments option used to be accepted and silently ignored —
  // tenant backups never carried a single file.
  if (options.includeAttachments) {
    const fileName = `kis-books-backup-${timestamp}.vmx`;
    assertSafeFileName(fileName);
    const filePath = path.join(dir, fileName);
    const counters: BundleFileCounters = { skipped: [], bundledBytes: 0, bundledCount: 0 };
    const result = await writeTenantPackage(
      filePath,
      passphrase,
      { metadata, tables: dumpData },
      bundleFileSource({ tenantIds: [tenantId], tenantData: { [tenantId]: dumpData }, globalTables: {}, counters }),
      {
        backup_type: 'tenant',
        source_version: APP_VERSION,
        created_at: new Date().toISOString(),
        includes_attachments: true,
      },
    );
    if (counters.skipped.length > 0) {
      console.warn(`[Backup] Tenant backup ${fileName}: bundled ${counters.bundledCount} file(s), skipped ${counters.skipped.length}.`);
    }

    // Same remote-upload ceiling as system-backup parts: past it the file
    // stays local-only instead of readFileSync throwing (>2 GiB) or
    // buffering a multi-GB archive in RAM. The skip is SURFACED — in the
    // response and the audit log — so an operator with offsite backups
    // configured never silently loses replication.
    const REMOTE_UPLOAD_MAX = 500 * 1024 * 1024;
    const remoteSkipped = result.size > REMOTE_UPLOAD_MAX;
    if (!remoteSkipped) {
      const fileBuf = fs.readFileSync(filePath);
      uploadBackupToRemote(fileName, fileBuf, tenantId).catch((err) => {
        console.error('[Backup] Remote upload failed (non-fatal):', err.message);
      });
    } else {
      console.warn(`[Backup] Tenant package ${fileName} is ${result.size} bytes (> ${REMOTE_UPLOAD_MAX}); kept local only.`);
    }

    await auditLog(
      tenantId,
      'create',
      'backup',
      backupId,
      null,
      {
        fileName, size: result.size, tableCount: tables.length, rowCount: totalRows,
        format: 'v3-portable-vmx', filesBundled: counters.bundledCount, filesSkipped: counters.skipped.length,
        remoteUpload: remoteSkipped ? 'skipped_size_cap' : 'attempted',
      },
      userId,
    );

    return {
      backupId,
      fileName,
      size: result.size,
      ...(remoteSkipped
        ? { warning: 'Backup exceeds the 500 MB remote-replication ceiling and was kept local-only — download and store it offsite manually.' }
        : {}),
    };
  }

  // Re-serialize with checksum
  const finalContent = Buffer.from(JSON.stringify({ metadata, tables: dumpData }));

  const encrypted = encryptWithPassphrase(finalContent, passphrase);

  const fileName = `kis-books-backup-${timestamp}.vmb`;
  assertSafeFileName(fileName);
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, encrypted);

  // Upload to remote storage (fire-and-forget)
  uploadBackupToRemote(fileName, encrypted, tenantId).catch((err) => {
    console.error('[Backup] Remote upload failed (non-fatal):', err.message);
  });

  await auditLog(
    tenantId,
    'create',
    'backup',
    backupId,
    null,
    { fileName, size: encrypted.length, tableCount: tables.length, rowCount: totalRows, format: 'v3-portable' },
    userId,
  );

  return { backupId, fileName, size: encrypted.length };
}

/**
 * Create a full system backup (.vmb) — all tenants, users, and config.
 * For disaster recovery / cross-server restore.
 */
/** Per-part size budget for multi-part system backups. Defaults to 90 MB so
 *  every part clears the tightest common upload ceiling between an operator
 *  and an appliance (Cloudflare proxies request bodies up to 100 MB on most
 *  plans) with form-encoding headroom. Override via BACKUP_PART_MAX_MB. */
export function systemBackupPartMaxBytes(): number {
  const mb = Number(process.env['BACKUP_PART_MAX_MB'] || 90);
  return (Number.isFinite(mb) && mb >= 1 ? mb : 90) * 1024 * 1024;
}

export interface SystemBackupResult {
  backupId: string;
  /** First part's file name — kept for backward compatibility. */
  fileName: string;
  /** Total bytes across all parts. */
  size: number;
  partCount: number;
  files: Array<{ fileName: string; size: number; partIndex: number }>;
}

export async function createSystemBackup(
  passphrase: string,
  userId?: string,
  opts?: { includeAttachments?: boolean; partMaxBytes?: number },
): Promise<SystemBackupResult> {
  const backupId = crypto.randomUUID();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_DIR, '_system');
  ensureDir(dir);

  // 1. Export all tenants
  const tenantsResult = await db.execute(sql`SELECT * FROM tenants`);
  const allTenants = tenantsResult.rows;

  // 2. Export all users (with hashed passwords preserved)
  const usersResult = await db.execute(sql`SELECT * FROM users`);
  const allUsers = (usersResult.rows as Record<string, unknown>[]).map((u) => {
    const user = { ...u };
    return user;
  });

  // 3. Export user_tenant_access
  const utaResult = await db.execute(sql`SELECT * FROM user_tenant_access`);

  // 4. Export per-tenant data — every public table with a tenant_id column.
  const plan = await getSystemBackupTablePlan(db);
  const tables = plan.tenantScoped;
  const tenantData: Record<string, Record<string, unknown[]>> = {};

  for (const tenant of allTenants as { id: string }[]) {
    const tData: Record<string, unknown[]> = {};
    for (const tableName of tables) {
      const result = await db.execute(
        sql`SELECT * FROM ${sql.identifier(tableName)} WHERE tenant_id = ${tenant.id}`,
      );
      tData[tableName] = result.rows;
    }
    tenantData[tenant.id] = tData;
  }

  // 5. Export every remaining table whole: system/global tables (Plaid, SMS,
  // AI, firm integrations, OAuth grants, budget lines, …) plus the
  // tenant_id IS NULL rows of nullable-tenant tables (global bank rules,
  // system payroll templates). Rows go in VERBATIM — including *_encrypted
  // credential columns — because the bundle itself is passphrase-encrypted
  // (PBKDF2 + AES-256-GCM) and a DR restore without provider credentials is
  // not a restore. The old export stripped anything matching
  // api_key/secret/password and hardcoded a 2-table list, which is exactly
  // how Plaid/SMS/AI settings vanished from every disaster recovery.
  const globalTables: Record<string, unknown[]> = {};
  let globalRowCount = 0;
  for (const tableName of plan.global) {
    const result = await db.execute(sql`SELECT * FROM ${sql.identifier(tableName)}`);
    globalTables[tableName] = result.rows;
    globalRowCount += result.rows.length;
  }
  for (const tableName of plan.nullableTenant) {
    const result = await db.execute(
      sql`SELECT * FROM ${sql.identifier(tableName)} WHERE tenant_id IS NULL`,
    );
    if (result.rows.length > 0) {
      globalTables[tableName] = result.rows;
      globalRowCount += result.rows.length;
    }
  }

  // Count totals
  let totalTransactions = 0;
  for (const tId of Object.keys(tenantData)) {
    totalTransactions += (tenantData[tId]!['transactions'] || []).length;
  }

  const metadata = {
    backup_type: 'system' as const,
    version: '1.0.0',
    source_version: APP_VERSION,
    backupId,
    created_at: new Date().toISOString(),
    encryption_method: 'passphrase_pbkdf2_aes256gcm' as const,
    format: 'kis-books-system-v2',
    tenant_count: allTenants.length,
    user_count: allUsers.length,
    transaction_count: totalTransactions,
    global_table_count: Object.keys(globalTables).length,
    global_row_count: globalRowCount,
    checksum: '',
  };

  // Phase C: capture installation-integrity files inside the backup so a
  // restore to a NEW server can cleanly branch on host-id mismatch (see
  // /restore/execute in setup.routes.ts). These files are dotfiles under
  // /data so they don't flow through the regular attachment path.
  //
  // /data/.sentinel is already AES-256-GCM encrypted with this server's
  // ENCRYPTION_KEY. We embed it raw; on restore, the receiving server
  // (which may have a different ENCRYPTION_KEY) treats the restored
  // sentinel as advisory metadata and generates a fresh one using its own
  // key. /data/.host-id is a plaintext UUID — comparing it to the new
  // server's host-id is the signal for cross-host detection.
  //
  // /data/.env.recovery is also embedded so operators don't lose their
  // Phase B recovery capability after a restore. The file is already
  // encrypted with the operator's recovery key (not the ENCRYPTION_KEY),
  // so it can be carried between servers safely — the new operator will
  // need to know the original recovery key to decrypt it, which matches
  // the existing threat model.
  const dataDir = process.env['DATA_DIR'] || '/data';
  const installationFiles: { sentinel: string | null; hostId: string | null; envRecovery: string | null } = {
    sentinel: null,
    hostId: null,
    envRecovery: null,
  };
  try {
    const sp = path.join(dataDir, '.sentinel');
    if (fs.existsSync(sp)) installationFiles.sentinel = fs.readFileSync(sp).toString('base64');
  } catch { /* non-fatal */ }
  try {
    const hp = path.join(dataDir, '.host-id');
    if (fs.existsSync(hp)) installationFiles.hostId = fs.readFileSync(hp, 'utf8').trim();
  } catch { /* non-fatal */ }
  try {
    const rp = path.join(dataDir, '.env.recovery');
    if (fs.existsSync(rp)) installationFiles.envRecovery = fs.readFileSync(rp).toString('base64');
  } catch { /* non-fatal */ }

  const contentObj = {
    metadata,
    tenants: allTenants,
    users: allUsers,
    user_tenant_access: utaResult.rows,
    global_tables: globalTables,
    tenant_data: tenantData,
    installation_files: installationFiles,
  };

  // ─── Attachments-included path: a streamed, per-file-encrypted .vmx package
  // (ZIP) whose data.json.enc is the DB dump above and whose attachments/<id>
  // entries are the actual receipt/document files. This makes the system
  // backup genuinely restorable (rows + files) without base64-inflating every
  // blob into one JSON string. Files stream one at a time, capped by total
  // bytes; skips are recorded, never silent.
  if (opts?.includeAttachments) {
    metadata.checksum = generateChecksum(Buffer.from(JSON.stringify(contentObj)));
    const baseName = `kis-books-backup-${timestamp}`;

    const counters: BundleFileCounters = { skipped: [], bundledBytes: 0, bundledCount: 0 };
    const fileSource = bundleFileSource({
      tenantIds: (allTenants as { id: string }[]).map((t) => t.id),
      tenantData,
      globalTables,
      counters,
    });

    // Multi-part write: every part is an independently-valid encrypted .vmx
    // bounded by the part budget, so (a) a disaster-recovery restore can
    // upload each part through proxies that cap request bodies, and (b) each
    // part is small enough to ship off-site — a host loss never strands the
    // only restorable copy just because the bundle grew past a size cap.
    const partMaxBytes = opts.partMaxBytes ?? systemBackupPartMaxBytes();
    const multi = await writeTenantPackageMulti({
      outDir: dir,
      baseName,
      passphrase,
      backupId,
      data: { ...contentObj, metadata },
      attachments: fileSource,
      partMaxBytes,
      manifestMeta: {
        backup_type: 'system',
        source_version: APP_VERSION,
        created_at: new Date().toISOString(),
        tenant_count: allTenants.length,
        includes_attachments: true,
      },
    });
    for (const f of multi.files) assertSafeFileName(f.fileName);

    if (counters.skipped.length > 0) {
      console.warn(`[Backup] System backup ${baseName}: bundled ${counters.bundledCount} file(s) (${counters.bundledBytes} bytes), skipped ${counters.skipped.length}:`, counters.skipped.slice(0, 10));
    }

    // Ship every part off-site. Parts are bounded by partMaxBytes, so unlike
    // the previous monolithic .vmx there is no "too big to upload" case at
    // the default budget; the guard below only trips if an operator raises
    // BACKUP_PART_MAX_MB past the in-memory upload ceiling.
    const REMOTE_UPLOAD_MAX = 500 * 1024 * 1024;
    for (const f of multi.files) {
      if (f.size > REMOTE_UPLOAD_MAX) {
        console.warn(`[Backup] Part ${f.fileName} is ${f.size} bytes (> ${REMOTE_UPLOAD_MAX}); kept local only. Lower BACKUP_PART_MAX_MB to keep parts remotable.`);
        continue;
      }
      const fileBuf = fs.readFileSync(f.path);
      uploadBackupToRemote(f.fileName, fileBuf, '_system').catch((err) => {
        console.error(`[Backup] Remote upload of system backup part ${f.fileName} failed (non-fatal):`, err.message);
      });
    }

    const firstTenantId = (allTenants[0] as { id: string } | undefined)?.id || 'system';
    await auditLog(firstTenantId, 'create', 'system_backup', backupId, null, {
      fileName: multi.files[0]!.fileName, size: multi.totalSize, partCount: multi.partCount,
      files: multi.files.map((f) => f.fileName),
      tenantCount: allTenants.length, userCount: allUsers.length,
      transactionCount: totalTransactions,
      attachmentsBundled: counters.bundledCount, attachmentsSkipped: counters.skipped.length, attachmentBytes: counters.bundledBytes,
    }, userId);

    return {
      backupId,
      fileName: multi.files[0]!.fileName,
      size: multi.totalSize,
      partCount: multi.partCount,
      files: multi.files.map((f) => ({ fileName: f.fileName, size: f.size, partIndex: f.partIndex })),
    };
  }

  const contentBuffer = Buffer.from(JSON.stringify(contentObj));
  metadata.checksum = generateChecksum(contentBuffer);
  const finalContent = Buffer.from(JSON.stringify({
    ...contentObj,
    metadata,
  }));

  const encrypted = encryptWithPassphrase(finalContent, passphrase);

  const fileName = `kis-books-backup-${timestamp}.vmb`;
  assertSafeFileName(fileName);
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, encrypted);

  // Upload system backup to remote storage
  uploadBackupToRemote(fileName, encrypted, '_system').catch((err) => {
    console.error('[Backup] Remote upload of system backup failed (non-fatal):', err.message);
  });

  const firstTenantId = (allTenants[0] as { id: string } | undefined)?.id || 'system';
  await auditLog(
    firstTenantId,
    'create',
    'system_backup',
    backupId,
    null,
    {
      fileName,
      size: encrypted.length,
      tenantCount: allTenants.length,
      userCount: allUsers.length,
      transactionCount: totalTransactions,
    },
    userId,
  );

  return {
    backupId,
    fileName,
    size: encrypted.length,
    partCount: 1,
    files: [{ fileName, size: encrypted.length, partIndex: 1 }],
  };
}

export async function listBackups(tenantId: string) {
  const dir = path.join(BACKUP_DIR, tenantId);
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.kbk') || f.endsWith('.vmb') || f.endsWith('.vmx'))
    .sort()
    .reverse();
  return files.map((f) => {
    const stat = fs.statSync(path.join(dir, f));
    return {
      fileName: f,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      format: f.endsWith('.vmx') ? 'portable-package' : f.endsWith('.vmb') ? 'portable' : 'legacy',
    };
  });
}

// Read a just-created system (_system) backup so the DR-bundle endpoint can
// stream it directly. System backups live outside the tenant dirs, so the
// tenant-scoped downloadBackup can't reach them.
export async function readSystemBackup(fileName: string): Promise<Buffer> {
  return fs.readFileSync(resolveSystemBackupPath(fileName));
}

// Validated absolute path to a system backup file, so callers can STREAM it
// (an attachments-included .vmx can be large — reading it fully into memory to
// send would risk OOM).
export function resolveSystemBackupPath(fileName: string): string {
  assertSafeFileName(fileName);
  const base = path.resolve(path.join(BACKUP_DIR, '_system'));
  const filePath = path.resolve(path.join(base, fileName));
  if (!filePath.startsWith(base + path.sep)) throw AppError.badRequest('Invalid backup file path');
  if (!fs.existsSync(filePath)) throw AppError.notFound('System backup file not found');
  return filePath;
}

export async function downloadBackup(tenantId: string, fileName: string, userId?: string): Promise<Buffer> {
  const filePath = resolveBackupPath(tenantId, fileName);
  if (!fs.existsSync(filePath)) throw AppError.notFound('Backup file not found');
  const buffer = fs.readFileSync(filePath);
  await auditLog(tenantId, 'update', 'backup_downloaded', fileName, null, { fileName, size: buffer.length }, userId);
  return buffer;
}

export async function deleteBackup(tenantId: string, fileName: string, userId?: string) {
  const filePath = resolveBackupPath(tenantId, fileName);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  await auditLog(tenantId, 'delete', 'backup', fileName, { fileName }, null, userId);
}

/**
 * Validate and optionally restore a backup file.
 * Supports both passphrase-encrypted (new .vmb) and server-key encrypted (old .kbk) formats.
 */
export async function restoreFromBackup(
  tenantId: string,
  fileBuffer: Buffer,
  passphrase?: string,
  userId?: string,
): Promise<{
  success: boolean;
  validated: true;
  method: 'passphrase' | 'server_key';
  metadata: Record<string, unknown>;
  recommendation?: string;
  message: string;
}> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let content: any; // decrypted JSON payload — same shape the old JSON.parse path produced
    let method: 'passphrase' | 'server_key';
    const { isPackageFormat, readTenantPackage } = await import('./vmx-package.js');
    if (isPackageFormat(fileBuffer)) {
      // .vmx package (ZIP) — the format createBackup emits when attachments
      // are included and listBackups advertises. Validate by opening the
      // encrypted data entry; attachments are not extracted here.
      if (!passphrase) throw AppError.badRequest('Passphrase is required for .vmx packages');
      const pkg = await readTenantPackage(fileBuffer, passphrase);
      content = pkg.data;
      method = 'passphrase';
    } else {
      const out = smartDecrypt(fileBuffer, passphrase);
      method = out.method;
      // Reject implausibly large decrypted blobs before JSON.parse allocates
      // another copy. AES-GCM doesn't expand its input, so a file that
      // decrypts to >500MB was either produced by malformed tooling or a
      // future compressed format — either way we don't want to parse it.
      if (out.data.length > 500 * 1024 * 1024) {
        throw AppError.badRequest('Backup payload exceeds size limit');
      }
      content = JSON.parse(out.data.toString());
    }
    const metadata = content.metadata ?? {};

    const validFormats = [
      'kis-books-backup-v1',
      'kis-books-backup-v2-tenant-scoped',
      'kis-books-backup-v3-portable',
      'kis-books-system-v1',
      'kis-books-system-v2',
    ];

    if (metadata.format && !validFormats.includes(metadata.format)) {
      throw AppError.badRequest('Incompatible backup format');
    }

    if (metadata.backup_type !== 'system' && metadata.tenantId && metadata.tenantId !== tenantId) {
      throw AppError.forbidden('Backup file belongs to a different tenant');
    }

    await auditLog(
      tenantId,
      'update',
      'backup_restore_validated',
      metadata.backupId || 'unknown',
      null,
      {
        timestamp: metadata.created_at || metadata.timestamp,
        rowCount: metadata.rowCount,
        tableCount: metadata.tableCount,
        format: metadata.format,
        encryptionMethod: method,
      },
      userId,
    );

    const recommendation = method === 'server_key'
      ? 'This backup uses the old server-key encryption format. We recommend creating a new backup with a passphrase for better portability.'
      : undefined;

    return {
      success: false,
      validated: true,
      method,
      metadata: {
        format: metadata.format,
        backup_type: metadata.backup_type,
        created_at: metadata.created_at || metadata.timestamp,
        source_version: metadata.source_version || metadata.appVersion,
        rowCount: metadata.rowCount,
        tableCount: metadata.tableCount,
        transaction_count: metadata.transaction_count,
        tenant_count: metadata.tenant_count,
        user_count: metadata.user_count,
      },
      recommendation,
      message:
        `Backup validated: ${metadata.created_at || metadata.timestamp} ` +
        `(${metadata.rowCount ?? '?'} rows across ${metadata.tableCount ?? '?'} tables). ` +
        `Encryption: ${method === 'passphrase' ? 'passphrase (portable)' : 'server-key (legacy)'}. ` +
        `Row restoration is not yet implemented — this endpoint only verifies file integrity. ` +
        `To actually restore data you must restore the database from an operator-level backup.`,
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const msg = err instanceof Error ? err.message : 'Unknown error';
    if (msg.includes('Incorrect passphrase') || msg.includes('corrupted file')) {
      throw AppError.badRequest(msg);
    }
    throw AppError.badRequest('Invalid or corrupted backup file. ' + msg);
  }
}

// ─── Remote Storage Provider (system-level) ──────────────────────

async function getSystemRemoteProvider(): Promise<StorageProvider | null> {
  const provider = await getSetting('backup_remote_provider');
  if (!provider || provider === 'none') return null;

  const configStr = await getSetting('backup_remote_config');
  if (!configStr) return null;

  const config = JSON.parse(configStr) as Record<string, unknown>;

  switch (provider) {
    case 'dropbox': {
      const accessToken = config['access_token_encrypted'] ? decryptField(config['access_token_encrypted'] as string) : '';
      if (!accessToken) return null;
      const { DropboxProvider } = await import('./storage/dropbox.provider.js');
      return new DropboxProvider(accessToken, { root_folder: (config['root_folder'] as string) || '/Vibe MyBooks Backups' });
    }
    case 'google_drive': {
      const accessToken = config['access_token_encrypted'] ? decryptField(config['access_token_encrypted'] as string) : '';
      if (!accessToken) return null;
      const { GoogleDriveProvider } = await import('./storage/google-drive.provider.js');
      return new GoogleDriveProvider(accessToken, { folder_id: (config['folder_id'] as string) || 'root' });
    }
    case 'onedrive': {
      const accessToken = config['access_token_encrypted'] ? decryptField(config['access_token_encrypted'] as string) : '';
      if (!accessToken) return null;
      const { OneDriveProvider } = await import('./storage/onedrive.provider.js');
      return new OneDriveProvider(accessToken, { folder_id: (config['folder_id'] as string) || 'root', drive_id: (config['drive_id'] as string) || 'me' });
    }
    case 's3': {
      if (!config['bucket'] || !config['accessKeyId']) return null;
      const { S3Provider } = await import('./storage/s3.provider.js');
      return new S3Provider({
        bucket: config['bucket'] as string,
        region: config['region'] as string,
        endpoint: config['endpoint'] as string,
        accessKeyId: config['accessKeyId'] as string,
        secretAccessKey: config['secret_access_key_encrypted'] ? decryptField(config['secret_access_key_encrypted'] as string) : '',
        prefix: (config['prefix'] as string) || 'backups/',
      });
    }
    case 'b2': {
      if (!config['bucket'] || !config['keyId'] || !config['endpoint']) return null;
      const { B2Provider } = await import('./storage/b2.provider.js');
      return new B2Provider({
        bucket: config['bucket'] as string,
        endpoint: config['endpoint'] as string,
        keyId: config['keyId'] as string,
        applicationKey: config['application_key_encrypted'] ? decryptField(config['application_key_encrypted'] as string) : '',
        region: (config['region'] as string) || undefined,
        prefix: (config['prefix'] as string) || 'backups/',
      });
    }
    default:
      return null;
  }
}

// Exposed for tests — asserts provider construction (e.g. the 'b2'
// case) without any network calls. Not part of the public API.
export { getSystemRemoteProvider as __getSystemRemoteProviderForTests };

// ─── Remote Backup Manifest ──────────────────────────────────────

export interface BackupManifestEntry {
  key: string;
  fileName: string;
  size: number;
  uploadedAt: string;
  tenantId: string;
  tiers: string[];
}

async function getManifest(): Promise<BackupManifestEntry[]> {
  const raw = await getSetting('backup_remote_manifest');
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveManifest(manifest: BackupManifestEntry[]): Promise<void> {
  await setSetting('backup_remote_manifest', JSON.stringify(manifest));
}

// ─── GFS Tier Tagging ────────────────────────────────────────────

function computeBackupTiers(date: Date, existingManifest: BackupManifestEntry[]): string[] {
  const tiers: string[] = ['daily'];

  const dayOfWeek = date.getDay();
  const year = date.getFullYear();
  const month = date.getMonth();

  const isFirstThisWeek = dayOfWeek === 0 || !existingManifest.some((e) => {
    const d = new Date(e.uploadedAt);
    const diffDays = (date.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
    return diffDays < 7 && diffDays > 0 && e.tiers.includes('weekly');
  });
  if (isFirstThisWeek) tiers.push('weekly');

  const isFirstThisMonth = !existingManifest.some((e) => {
    const d = new Date(e.uploadedAt);
    return d.getFullYear() === year && d.getMonth() === month && e.tiers.includes('monthly');
  });
  if (isFirstThisMonth) tiers.push('monthly');

  const isFirstThisYear = !existingManifest.some((e) => {
    const d = new Date(e.uploadedAt);
    return d.getFullYear() === year && e.tiers.includes('yearly');
  });
  if (isFirstThisYear) tiers.push('yearly');

  return tiers;
}

// ─── Remote Backup Operations ────────────────────────────────────

export async function uploadBackupToRemote(
  fileName: string, data: Buffer, tenantId: string,
): Promise<{ success: boolean; error?: string }> {
  const provider = await getSystemRemoteProvider();
  if (!provider) return { success: false, error: 'No remote provider configured' };

  try {
    // Tenant-rooted key ('_system' for system backups). Old manifest
    // entries keep their legacy backups/{tenantId}/... keys — download,
    // delete, and GFS purge all operate on the key stored per entry.
    const key = tenantStorageKey(tenantId, 'backups', fileName);
    await provider.upload(key, data, {
      fileName,
      mimeType: 'application/octet-stream',
      sizeBytes: data.length,
    });

    const manifest = await getManifest();
    // Tiers are computed against THIS tenant's (or _system's) own uploads.
    // A global manifest let whichever backup uploaded first in a cycle claim
    // the weekly/monthly/yearly tiers for the whole installation — leaving
    // the system DR bundle (uploaded last) on the shortest 'daily' retention.
    const tiers = computeBackupTiers(new Date(), manifest.filter((e) => e.tenantId === tenantId));
    manifest.push({
      key,
      fileName,
      size: data.length,
      uploadedAt: new Date().toISOString(),
      tenantId,
      tiers,
    });
    await saveManifest(manifest);

    console.log(`[Backup] Remote upload OK: ${fileName} (tiers: ${tiers.join(', ')})`);
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[Backup] Remote upload failed: ${msg}`);
    return { success: false, error: msg };
  }
}

export async function listRemoteBackups(): Promise<BackupManifestEntry[]> {
  return getManifest();
}

export async function downloadRemoteBackup(key: string): Promise<Buffer> {
  const provider = await getSystemRemoteProvider();
  if (!provider) throw AppError.badRequest('No remote provider configured');
  return provider.download(key);
}

export async function deleteRemoteBackup(key: string): Promise<void> {
  const provider = await getSystemRemoteProvider();
  if (!provider) throw AppError.badRequest('No remote provider configured');

  await provider.delete(key);

  const manifest = await getManifest();
  const updated = manifest.filter((e) => e.key !== key);
  await saveManifest(updated);
}

// ─── Local Backup Purge (N days) ─────────────────────────────────

export async function purgeExpiredLocalBackups(retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;

  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let deleted = 0;

  if (!fs.existsSync(BACKUP_DIR)) return 0;

  for (const entry of fs.readdirSync(BACKUP_DIR)) {
    const tenantDir = path.join(BACKUP_DIR, entry);
    try {
      const stat = fs.statSync(tenantDir);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    for (const file of fs.readdirSync(tenantDir)) {
      // .vmx = attachments-included system packages — they're the largest
      // files in BACKUP_DIR and MUST be purged or the scheduler fills the
      // disk (one multi-GB package per cycle).
      if (!file.endsWith('.kbk') && !file.endsWith('.vmb') && !file.endsWith('.vmx')) continue;
      const filePath = path.join(tenantDir, file);
      try {
        const fstat = fs.statSync(filePath);
        if (fstat.mtimeMs < cutoff) {
          fs.unlinkSync(filePath);
          deleted++;
        }
      } catch { /* skip files we can't stat */ }
    }
  }

  return deleted;
}

// ─── Remote Backup Purge (GFS) ──────────────────────────────────

export interface GfsRetentionConfig {
  dailyDays: number;
  weeklyWeeks: number;
  monthlyMonths: number;
  yearlyYears: number;
}

export async function purgeExpiredRemoteBackups(config: GfsRetentionConfig): Promise<number> {
  const manifest = await getManifest();
  if (manifest.length === 0) return 0;

  if (config.dailyDays === 0 && config.weeklyWeeks === 0 &&
      config.monthlyMonths === 0 && config.yearlyYears === 0) return 0;

  const now = new Date();
  const toDelete: BackupManifestEntry[] = [];

  for (const entry of manifest) {
    const uploadDate = new Date(entry.uploadedAt);
    let shouldKeep = false;

    for (const tier of entry.tiers) {
      switch (tier) {
        case 'daily':
          if (config.dailyDays === 0) { shouldKeep = true; break; }
          if (diffDays(now, uploadDate) <= config.dailyDays) shouldKeep = true;
          break;
        case 'weekly':
          if (config.weeklyWeeks === 0) { shouldKeep = true; break; }
          if (diffDays(now, uploadDate) <= config.weeklyWeeks * 7) shouldKeep = true;
          break;
        case 'monthly':
          if (config.monthlyMonths === 0) { shouldKeep = true; break; }
          if (diffMonths(now, uploadDate) <= config.monthlyMonths) shouldKeep = true;
          break;
        case 'yearly':
          if (config.yearlyYears === 0) { shouldKeep = true; break; }
          if (diffYears(now, uploadDate) <= config.yearlyYears) shouldKeep = true;
          break;
      }
      if (shouldKeep) break;
    }

    if (!shouldKeep) toDelete.push(entry);
  }

  const provider = await getSystemRemoteProvider();
  let deleted = 0;
  // Track keys we ACTUALLY deleted, not the keys we intended to delete.
  // A provider.delete() that throws (now that OneDrive/Drive surface non-2xx)
  // must leave the manifest entry intact — otherwise a backup that still
  // exists remotely is dropped from tracking and silently orphaned.
  const deletedKeys = new Set<string>();
  for (const entry of toDelete) {
    try {
      if (provider) await provider.delete(entry.key);
      deletedKeys.add(entry.key);
      deleted++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      log.error({ component: 'backup', event: 'remote_purge_failed', key: entry.key, message: msg });
    }
  }

  if (deletedKeys.size > 0) {
    const updated = manifest.filter((e) => !deletedKeys.has(e.key));
    await saveManifest(updated);
  }

  return deleted;
}

function diffDays(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

function diffMonths(a: Date, b: Date): number {
  return (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
}

function diffYears(a: Date, b: Date): number {
  return a.getFullYear() - b.getFullYear();
}
