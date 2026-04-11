import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import {
  encryptWithPassphrase,
  smartDecrypt,
  generateChecksum,
} from './portable-encryption.service.js';
import { getSetting, setSetting } from './admin.service.js';
import { decrypt as decryptField } from '../utils/encryption.js';
import type { StorageProvider } from './storage/storage-provider.interface.js';

const BACKUP_DIR = process.env['BACKUP_DIR'] || '/data/backups';
const APP_VERSION = '0.3.0';

// Whitelist for backup filenames. Prevents path traversal via `../`,
// absolute paths, or shell metacharacters landing in `path.join`. Any
// filename passed to download/delete must match this regex exactly.
const BACKUP_FILENAME_RE = /^kis-books-backup-[A-Za-z0-9._-]+\.(kbk|vmb)$/;

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
 * Enumerate every table in the public schema that has a `tenant_id` column.
 */
async function getTenantScopedTables(): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT table_name
    FROM information_schema.columns
    WHERE column_name = 'tenant_id'
      AND table_schema = 'public'
      AND table_name NOT IN ('tenants', 'users', 'user_tenant_access')
    ORDER BY table_name
  `);
  return (res.rows as { table_name: string }[])
    .map((r) => r.table_name)
    .filter((n) => /^[a-z_][a-z0-9_]*$/.test(n));
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
): Promise<{ backupId: string; fileName: string; size: number }> {
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
export async function createSystemBackup(
  passphrase: string,
  userId?: string,
): Promise<{ backupId: string; fileName: string; size: number }> {
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

  // 4. Export per-tenant data
  const tables = await getTenantScopedTables();
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

  // 5. Export system config tables (non-tenant-scoped)
  const systemConfigTables = ['ai_config', 'system_settings'];
  const systemConfig: Record<string, unknown[]> = {};
  for (const tableName of systemConfigTables) {
    try {
      const result = await db.execute(sql`SELECT * FROM ${sql.identifier(tableName)}`);
      // Strip sensitive API keys from config
      systemConfig[tableName] = (result.rows as Record<string, unknown>[]).map((row) => {
        const clean = { ...row };
        for (const key of Object.keys(clean)) {
          if (key.includes('api_key') || key.includes('secret') || key === 'password') {
            delete clean[key];
          }
        }
        return clean;
      });
    } catch {
      // Table may not exist
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
    format: 'kis-books-system-v1',
    tenant_count: allTenants.length,
    user_count: allUsers.length,
    transaction_count: totalTransactions,
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
    system_config: systemConfig,
    tenant_data: tenantData,
    installation_files: installationFiles,
  };

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

  return { backupId, fileName, size: encrypted.length };
}

export async function listBackups(tenantId: string) {
  const dir = path.join(BACKUP_DIR, tenantId);
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.kbk') || f.endsWith('.vmb'))
    .sort()
    .reverse();
  return files.map((f) => {
    const stat = fs.statSync(path.join(dir, f));
    return {
      fileName: f,
      size: stat.size,
      createdAt: stat.mtime.toISOString(),
      format: f.endsWith('.vmb') ? 'portable' : 'legacy',
    };
  });
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
    const { data: decrypted, method } = smartDecrypt(fileBuffer, passphrase);
    const content = JSON.parse(decrypted.toString());
    const metadata = content.metadata ?? {};

    const validFormats = [
      'kis-books-backup-v1',
      'kis-books-backup-v2-tenant-scoped',
      'kis-books-backup-v3-portable',
      'kis-books-system-v1',
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
    default:
      return null;
  }
}

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
    const key = `backups/${tenantId}/${fileName}`;
    await provider.upload(key, data, {
      fileName,
      mimeType: 'application/octet-stream',
      sizeBytes: data.length,
    });

    const manifest = await getManifest();
    const tiers = computeBackupTiers(new Date(), manifest);
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
      if (!file.endsWith('.kbk') && !file.endsWith('.vmb')) continue;
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
  for (const entry of toDelete) {
    try {
      if (provider) await provider.delete(entry.key);
      deleted++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[Backup] Failed to purge remote backup ${entry.key}: ${msg}`);
    }
  }

  if (deleted > 0) {
    const deleteKeys = new Set(toDelete.map((e) => e.key));
    const updated = manifest.filter((e) => !deleteKeys.has(e.key));
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
