// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import crypto from 'crypto';
import { authenticate } from '../middleware/auth.js';
import * as remoteBackupService from '../services/remote-backup.service.js';
import { validatePassphraseStrength } from '../services/portable-encryption.service.js';

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
  const { enabled, destination, schedule, retention_count, passphrase, ...destConfig } = req.body;

  if (enabled && passphrase) {
    const strength = validatePassphraseStrength(passphrase);
    if (!strength.valid) {
      res.status(400).json({ error: { message: strength.message } });
      return;
    }
  }

  // Hash the passphrase for later verification (not stored in plain text)
  const passphraseHash = passphrase
    ? crypto.createHash('sha256').update(passphrase).digest('hex')
    : undefined;

  await remoteBackupService.updateRemoteBackupConfig(
    req.tenantId,
    {
      enabled: enabled ?? false,
      destination: destination || 'sftp',
      schedule: schedule || 'weekly',
      retention_count: retention_count || 10,
      config: destConfig,
      passphrase_hash: passphraseHash,
    },
    req.userId,
  );

  res.json({ success: true, message: 'Remote backup configuration updated' });
});

// Test connection to remote destination
remoteBackupRouter.post('/test', async (req, res) => {
  const result = await remoteBackupService.testConnection(req.body);
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
