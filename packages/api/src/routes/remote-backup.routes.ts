// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import * as remoteBackupService from '../services/remote-backup.service.js';
import { validatePassphraseStrength } from '../services/portable-encryption.service.js';

// Any field in `config` lands at whatever provider the user selected,
// so untyped input flowed straight to ssh2-sftp-client / axios WebDAV /
// AWS-SDK construction. Validate per-destination to reject obvious junk
// and keep credential fields consistently named.
const sftpConfigSchema = z.object({
  host: z.string().min(1).max(255),
  port: z.coerce.number().int().positive().max(65535).default(22),
  username: z.string().min(1).max(255),
  password: z.string().max(1024).optional(),
  privateKey: z.string().max(10_000).optional(),
  remotePath: z.string().max(1024).default('/'),
}).strict();

const webdavConfigSchema = z.object({
  url: z.string().url(),
  username: z.string().min(1).max(255),
  password: z.string().max(1024),
  remotePath: z.string().max(1024).default('/'),
}).strict();

const s3ConfigSchema = z.object({
  endpoint: z.string().url().optional(),
  region: z.string().max(50).default('us-east-1'),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().min(1).max(255),
  secretAccessKey: z.string().min(1).max(1024),
  prefix: z.string().max(1024).default(''),
  forcePathStyle: z.boolean().optional(),
}).strict();

const remoteBackupConfigSchema = z.object({
  enabled: z.boolean().default(false),
  destination: z.enum(['sftp', 'webdav', 's3']).default('sftp'),
  schedule: z.enum(['daily', 'weekly', 'monthly']).default('weekly'),
  retention_count: z.coerce.number().int().positive().max(1000).default(10),
  passphrase: z.string().optional(),
  sftp: sftpConfigSchema.optional(),
  webdav: webdavConfigSchema.optional(),
  s3: s3ConfigSchema.optional(),
});

const testConnectionSchema = z.object({
  destination: z.enum(['sftp', 'webdav', 's3']),
  sftp: sftpConfigSchema.optional(),
  webdav: webdavConfigSchema.optional(),
  s3: s3ConfigSchema.optional(),
});

export const remoteBackupRouter = Router();
remoteBackupRouter.use(authenticate);

// Get remote backup configuration
remoteBackupRouter.get('/config', async (req, res) => {
  const config = await remoteBackupService.getRemoteBackupConfig(req.tenantId);
  // Strip sensitive fields from the response
  if (config.config) {
    const sanitized = { ...config.config };
    // Remove passwords from displayed config
    if (sanitized['sftp'] && typeof sanitized['sftp'] === 'object') {
      const sftp = { ...(sanitized['sftp'] as Record<string, unknown>) };
      if (sftp['password']) sftp['password'] = '********';
      sanitized['sftp'] = sftp;
    }
    if (sanitized['webdav'] && typeof sanitized['webdav'] === 'object') {
      const webdav = { ...(sanitized['webdav'] as Record<string, unknown>) };
      if (webdav['password']) webdav['password'] = '********';
      sanitized['webdav'] = webdav;
    }
    config.config = sanitized;
  }
  res.json(config);
});

// Update remote backup configuration
remoteBackupRouter.put('/config', async (req, res) => {
  const input = remoteBackupConfigSchema.parse(req.body);

  if (input.enabled && input.passphrase) {
    const strength = validatePassphraseStrength(input.passphrase);
    if (!strength.valid) {
      res.status(400).json({ error: { message: strength.message } });
      return;
    }
  }

  // Hash the passphrase for later verification (not stored in plain text)
  const passphraseHash = input.passphrase
    ? crypto.createHash('sha256').update(input.passphrase).digest('hex')
    : undefined;

  const destConfig: Record<string, unknown> = {};
  if (input.sftp) destConfig['sftp'] = input.sftp;
  if (input.webdav) destConfig['webdav'] = input.webdav;
  if (input.s3) destConfig['s3'] = input.s3;

  await remoteBackupService.updateRemoteBackupConfig(
    req.tenantId,
    {
      enabled: input.enabled,
      destination: input.destination,
      schedule: input.schedule,
      retention_count: input.retention_count,
      config: destConfig,
      passphrase_hash: passphraseHash,
    },
    req.userId,
  );

  res.json({ success: true, message: 'Remote backup configuration updated' });
});

// Test connection to remote destination
remoteBackupRouter.post('/test', async (req, res) => {
  const input = testConnectionSchema.parse(req.body);
  const result = await remoteBackupService.testConnection(input as any);
  res.json(result);
});

// Trigger an immediate remote backup
remoteBackupRouter.post('/trigger', async (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase) {
    res.status(400).json({ error: { message: 'Passphrase is required to create a remote backup' } });
    return;
  }

  // Create the backup first
  const { createBackup } = await import('../services/backup.service.js');
  const backup = await createBackup(req.tenantId, passphrase, {}, req.userId);

  // Get remote config
  const config = await remoteBackupService.getRemoteBackupConfig(req.tenantId);
  if (!config.enabled || !config.config) {
    res.status(400).json({ error: { message: 'Remote backup is not configured' } });
    return;
  }

  // Upload
  const BACKUP_DIR = process.env['BACKUP_DIR'] || '/data/backups';
  const backupPath = `${BACKUP_DIR}/${req.tenantId}/${backup.fileName}`;
  const uploadResult = await remoteBackupService.uploadBackup(backupPath, config.config as any);

  // Record result
  await remoteBackupService.recordBackupResult(
    req.tenantId,
    uploadResult.success ? 'success' : 'failed',
    uploadResult.size,
  );

  // Apply retention
  if (uploadResult.success && config.config) {
    await remoteBackupService.applyRetention(
      config.config as any,
      (config as any).retention_count || 10,
    );
  }

  res.json({
    backup: backup,
    upload: uploadResult,
  });
});

// Get remote backup history
remoteBackupRouter.get('/history', async (req, res) => {
  const history = await remoteBackupService.getRemoteBackupHistory(req.tenantId);
  res.json({ history });
});
