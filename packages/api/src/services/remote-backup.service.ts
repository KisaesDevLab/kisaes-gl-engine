import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { assertExternalUrlSafe } from '../utils/url-safety.js';


const BACKUP_DIR = process.env['BACKUP_DIR'] || '/data/backups';

interface SftpConfig {
  host: string;
  port: number;
  username: string;
  auth_method: 'password' | 'key';
  password?: string;
  remote_path: string;
}

interface WebDavConfig {
  url: string;
  username: string;
  password?: string;
}

interface EmailConfig {
  recipient: string;
  max_size_mb: number;
}

interface RemoteBackupConfig {
  destination: 'sftp' | 'webdav' | 'email';
  schedule: 'daily' | 'weekly' | 'monthly';
  retention_count: number;
  sftp?: SftpConfig;
  webdav?: WebDavConfig;
  email?: EmailConfig;
}

/**
 * Test connection to a remote backup destination.
 */
export async function testConnection(config: RemoteBackupConfig): Promise<{ success: boolean; message: string }> {
  switch (config.destination) {
    case 'sftp':
      return testSftpConnection(config.sftp!);
    case 'webdav':
      return testWebDavConnection(config.webdav!);
    case 'email':
      return testEmailConnection(config.email!);
    default:
      return { success: false, message: `Unknown destination: ${config.destination}` };
  }
}

async function testSftpConnection(config: SftpConfig): Promise<{ success: boolean; message: string }> {
  try {
    // Dynamic import — ssh2-sftp-client is an optional dependency
    const SftpClient = (await import('ssh2-sftp-client')).default;
    const sftp = new SftpClient();
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
    });
    // Verify remote path exists or create it
    const exists = await sftp.exists(config.remote_path);
    if (!exists) {
      await sftp.mkdir(config.remote_path, true);
    }
    await sftp.end();
    return { success: true, message: 'SFTP connection successful' };
  } catch (err) {
    return { success: false, message: `SFTP connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testWebDavConnection(config: WebDavConfig): Promise<{ success: boolean; message: string }> {
  try {
    assertExternalUrlSafe(config.url, 'WebDAV URL');
    const response = await fetch(config.url, {
      method: 'OPTIONS',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${config.username}:${config.password || ''}`).toString('base64'),
      },
    });
    if (response.ok || response.status === 200 || response.status === 207) {
      return { success: true, message: 'WebDAV connection successful' };
    }
    return { success: false, message: `WebDAV returned status ${response.status}` };
  } catch (err) {
    return { success: false, message: `WebDAV connection failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function testEmailConnection(config: EmailConfig): Promise<{ success: boolean; message: string }> {
  // Verify SMTP is configured
  const smtpHost = process.env['SMTP_HOST'];
  if (!smtpHost) {
    return { success: false, message: 'SMTP is not configured. Set SMTP_HOST in your environment.' };
  }

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: smtpHost,
      port: Number(process.env['SMTP_PORT'] || 587),
      auth: {
        user: process.env['SMTP_USER'],
        pass: process.env['SMTP_PASS'],
      },
    });
    await transporter.verify();
    return { success: true, message: `Email test passed. Backups will be sent to ${config.recipient}` };
  } catch (err) {
    return { success: false, message: `SMTP test failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

/**
 * Upload a backup file to a remote destination.
 */
export async function uploadBackup(
  backupFilePath: string,
  config: RemoteBackupConfig,
): Promise<{ success: boolean; message: string; size?: number }> {
  if (!fs.existsSync(backupFilePath)) {
    return { success: false, message: 'Backup file not found' };
  }

  const fileSize = fs.statSync(backupFilePath).size;
  const fileName = path.basename(backupFilePath);

  switch (config.destination) {
    case 'sftp':
      return uploadSftp(backupFilePath, fileName, config.sftp!);
    case 'webdav':
      return uploadWebDav(backupFilePath, fileName, config.webdav!);
    case 'email':
      return uploadEmail(backupFilePath, fileName, fileSize, config.email!);
    default:
      return { success: false, message: `Unknown destination: ${config.destination}` };
  }
}

async function uploadSftp(
  filePath: string,
  fileName: string,
  config: SftpConfig,
): Promise<{ success: boolean; message: string; size?: number }> {
  try {
    const SftpClient = (await import('ssh2-sftp-client')).default;
    const sftp = new SftpClient();
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
    });

    const remotePath = path.posix.join(config.remote_path, fileName);
    await sftp.put(filePath, remotePath);
    const size = fs.statSync(filePath).size;
    await sftp.end();

    return { success: true, message: `Uploaded to ${remotePath}`, size };
  } catch (err) {
    return { success: false, message: `SFTP upload failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function uploadWebDav(
  filePath: string,
  fileName: string,
  config: WebDavConfig,
): Promise<{ success: boolean; message: string; size?: number }> {
  try {
    assertExternalUrlSafe(config.url, 'WebDAV URL');
    const fileBuffer = fs.readFileSync(filePath);
    const uploadUrl = config.url.endsWith('/') ? config.url + fileName : config.url + '/' + fileName;

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${config.username}:${config.password || ''}`).toString('base64'),
        'Content-Type': 'application/octet-stream',
      },
      body: fileBuffer,
    });

    if (response.ok || response.status === 201 || response.status === 204) {
      return { success: true, message: `Uploaded to ${uploadUrl}`, size: fileBuffer.length };
    }
    return { success: false, message: `WebDAV upload failed: HTTP ${response.status}` };
  } catch (err) {
    return { success: false, message: `WebDAV upload failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

async function uploadEmail(
  filePath: string,
  fileName: string,
  fileSize: number,
  config: EmailConfig,
): Promise<{ success: boolean; message: string; size?: number }> {
  const maxSize = (config.max_size_mb || 25) * 1024 * 1024;
  if (fileSize > maxSize) {
    return {
      success: false,
      message: `Backup file (${Math.round(fileSize / 1024 / 1024)} MB) exceeds the ${config.max_size_mb} MB email limit. Use SFTP or WebDAV instead.`,
    };
  }

  try {
    const nodemailer = await import('nodemailer');
    const transporter = nodemailer.default.createTransport({
      host: process.env['SMTP_HOST'],
      port: Number(process.env['SMTP_PORT'] || 587),
      auth: {
        user: process.env['SMTP_USER'],
        pass: process.env['SMTP_PASS'],
      },
    });

    await transporter.sendMail({
      from: process.env['SMTP_FROM'] || 'noreply@example.com',
      to: config.recipient,
      subject: `Vibe MyBooks Backup — ${new Date().toISOString().substring(0, 10)}`,
      text: `Automated backup from Vibe MyBooks.\n\nFile: ${fileName}\nSize: ${Math.round(fileSize / 1024)} KB\nDate: ${new Date().toISOString()}\n\nThis backup is encrypted. You will need the backup passphrase to restore it.`,
      attachments: [
        {
          filename: fileName,
          path: filePath,
        },
      ],
    });

    return { success: true, message: `Backup emailed to ${config.recipient}`, size: fileSize };
  } catch (err) {
    return { success: false, message: `Email failed: ${err instanceof Error ? err.message : 'Unknown error'}` };
  }
}

/**
 * Apply retention policy: delete old remote backups beyond the keep count.
 * Only works for SFTP and WebDAV (can't delete sent emails).
 */
export async function applyRetention(
  config: RemoteBackupConfig,
  keepCount: number,
): Promise<{ deleted: number }> {
  if (config.destination === 'email') {
    return { deleted: 0 }; // Can't delete sent emails
  }

  if (config.destination === 'sftp' && config.sftp) {
    return applySftpRetention(config.sftp, keepCount);
  }

  if (config.destination === 'webdav' && config.webdav) {
    // WebDAV retention requires PROPFIND + DELETE — simplified for now
    return { deleted: 0 };
  }

  return { deleted: 0 };
}

async function applySftpRetention(config: SftpConfig, keepCount: number): Promise<{ deleted: number }> {
  try {
    const SftpClient = (await import('ssh2-sftp-client')).default;
    const sftp = new SftpClient();
    await sftp.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
    });

    const files = await sftp.list(config.remote_path);
    const backupFiles = files
      .filter((f) => f.name.endsWith('.vmb') || f.name.endsWith('.vmx'))
      .sort((a, b) => (b.modifyTime || 0) - (a.modifyTime || 0));

    let deleted = 0;
    if (backupFiles.length > keepCount) {
      const toDelete = backupFiles.slice(keepCount);
      for (const file of toDelete) {
        await sftp.delete(path.posix.join(config.remote_path, file.name));
        deleted++;
      }
    }

    await sftp.end();
    return { deleted };
  } catch {
    return { deleted: 0 };
  }
}

/**
 * Get remote backup configuration for a tenant.
 */
export async function getRemoteBackupConfig(tenantId: string): Promise<{
  enabled: boolean;
  destination?: string;
  schedule?: string;
  retention_count?: number;
  config?: Record<string, unknown>;
  last_at?: string;
  last_status?: string;
  last_size?: number;
}> {
  const result = await db.execute(sql`
    SELECT
      remote_backup_enabled,
      remote_backup_destination,
      remote_backup_config,
      remote_backup_schedule,
      remote_backup_last_at,
      remote_backup_last_status,
      remote_backup_last_size
    FROM companies
    WHERE tenant_id = ${tenantId}
    LIMIT 1
  `);

  if (!result.rows.length) {
    return { enabled: false };
  }

  const row = result.rows[0] as Record<string, unknown>;
  return {
    enabled: row['remote_backup_enabled'] === true,
    destination: row['remote_backup_destination'] as string | undefined,
    schedule: row['remote_backup_schedule'] as string | undefined,
    config: row['remote_backup_config'] as Record<string, unknown> | undefined,
    last_at: row['remote_backup_last_at'] as string | undefined,
    last_status: row['remote_backup_last_status'] as string | undefined,
    last_size: row['remote_backup_last_size'] as number | undefined,
  };
}

/**
 * Update remote backup configuration.
 */
export async function updateRemoteBackupConfig(
  tenantId: string,
  config: {
    enabled: boolean;
    destination: string;
    schedule: string;
    retention_count: number;
    config: Record<string, unknown>;
    passphrase_hash?: string;
  },
  userId?: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE companies
    SET
      remote_backup_enabled = ${config.enabled},
      remote_backup_destination = ${config.destination},
      remote_backup_config = ${JSON.stringify(config.config)},
      remote_backup_schedule = ${config.schedule},
      remote_backup_passphrase_hash = ${config.passphrase_hash || null},
      updated_at = NOW()
    WHERE tenant_id = ${tenantId}
  `);

  await auditLog(
    tenantId,
    'update',
    'remote_backup_config',
    tenantId,
    null,
    { enabled: config.enabled, destination: config.destination, schedule: config.schedule },
    userId,
  );
}

/**
 * Record a remote backup result.
 */
export async function recordBackupResult(
  tenantId: string,
  status: 'success' | 'failed',
  size?: number,
): Promise<void> {
  await db.execute(sql`
    UPDATE companies
    SET
      remote_backup_last_at = NOW(),
      remote_backup_last_status = ${status},
      remote_backup_last_size = ${size || null},
      updated_at = NOW()
    WHERE tenant_id = ${tenantId}
  `);
}

/**
 * Get remote backup history (from audit log).
 */
export async function getRemoteBackupHistory(
  tenantId: string,
  limit: number = 20,
): Promise<Array<{
  timestamp: string;
  status: string;
  size?: number;
  destination?: string;
  error?: string;
}>> {
  const result = await db.execute(sql`
    SELECT created_at, after_data
    FROM audit_log
    WHERE tenant_id = ${tenantId}
      AND entity_type = 'remote_backup'
      AND action IN ('create', 'update')
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  return (result.rows as { created_at: string; after_data: string | null }[]).map((row) => {
    const data = row.after_data ? JSON.parse(row.after_data) : {};
    return {
      timestamp: row.created_at,
      status: data.status || 'unknown',
      size: data.size,
      destination: data.destination,
      error: data.error,
    };
  });
}
