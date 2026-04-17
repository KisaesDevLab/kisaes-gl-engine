// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { validatePassphraseStrength } from '../services/portable-encryption.service.js';
import * as backupService from '../services/backup.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

// Vibe MyBooks backup files always start with the passphrase-format magic
// "VMBP" OR they are legacy server-key-encrypted (no magic, raw bytes with
// at least 32 bytes of IV + authTag header). Pre-flight the upload so an
// obviously-wrong file (e.g. someone dragged a JPEG in) is rejected with a
// 400 instead of blowing up inside the decryption path as a 500.
const VMBP_MAGIC = Buffer.from('VMBP', 'ascii');
const MIN_SERVER_KEY_SIZE = 32; // 16 IV + 16 authTag

function looksLikeBackup(buf: Buffer): boolean {
  if (buf.length >= VMBP_MAGIC.length && buf.subarray(0, VMBP_MAGIC.length).equals(VMBP_MAGIC)) {
    return true;
  }
  // Legacy server-key format has no header magic; the best we can do is
  // require the minimum envelope size plus reject anything that clearly
  // looks like a plain-text or document file.
  if (buf.length < MIN_SERVER_KEY_SIZE) return false;
  if (buf.subarray(0, 4).equals(Buffer.from('%PDF'))) return false;
  if (buf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return false; // zip/xlsx
  if (buf.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) return false; // jpeg
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return false; // png
  return true;
}

// Filenames may legitimately contain spaces or international characters;
// quote them per RFC 6266 so a stray `"` or newline in the path can't
// break the Content-Disposition header. Also substitute any control chars
// as a belt-and-braces defence — downloadBackup validates basename already
// but the remote download path only has the tail of a key we built.
function encodeContentDisposition(fileName: string, inline = false): string {
  const safe = fileName.replace(/[\x00-\x1f"\\]/g, '_');
  const encoded = encodeURIComponent(fileName);
  return `${inline ? 'inline' : 'attachment'}; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

export const backupRouter = Router();
backupRouter.use(authenticate);

// Create a passphrase-encrypted backup
backupRouter.post('/create', async (req, res) => {
  const { passphrase, include_attachments } = req.body;
  if (!passphrase || typeof passphrase !== 'string') {
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }

  const strength = validatePassphraseStrength(passphrase);
  if (!strength.valid) {
    res.status(400).json({ error: { message: strength.message } });
    return;
  }

  const result = await backupService.createBackup(
    req.tenantId,
    passphrase,
    { includeAttachments: include_attachments },
    req.userId,
  );
  res.status(201).json(result);
});

// Create a full system backup (super admin only)
backupRouter.post('/system', requireSuperAdmin, async (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase || typeof passphrase !== 'string') {
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }

  const strength = validatePassphraseStrength(passphrase);
  if (!strength.valid) {
    res.status(400).json({ error: { message: strength.message } });
    return;
  }

  const result = await backupService.createSystemBackup(passphrase, req.userId);
  res.status(201).json(result);
});

// List backups
backupRouter.get('/history', async (req, res) => {
  const backups = await backupService.listBackups(req.tenantId);
  res.json({ backups });
});

// Download a backup
backupRouter.get('/download/:fileName', async (req, res) => {
  const data = await backupService.downloadBackup(req.tenantId, req.params['fileName']!, req.userId);
  const fileName = req.params['fileName']!;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', encodeContentDisposition(fileName));
  res.send(data);
});

// Delete a backup
backupRouter.delete('/:fileName', async (req, res) => {
  await backupService.deleteBackup(req.tenantId, req.params['fileName']!, req.userId);
  res.json({ message: 'Backup deleted' });
});

// Validate/restore from backup (supports both passphrase and server-key formats)
backupRouter.post('/restore', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: { message: 'No file uploaded' } });
    return;
  }
  if (!looksLikeBackup(req.file.buffer)) {
    res.status(400).json({ error: { message: 'Uploaded file is not a Vibe MyBooks backup.' } });
    return;
  }
  const passphrase = req.body?.passphrase;
  const result = await backupService.restoreFromBackup(req.tenantId, req.file.buffer, passphrase, req.userId);
  res.json(result);
});

// Check passphrase strength (no side effects)
backupRouter.post('/passphrase-strength', (req, res) => {
  const { passphrase } = req.body;
  if (!passphrase || typeof passphrase !== 'string') {
    res.json({ valid: false, strength: 'weak', message: 'Passphrase is required' });
    return;
  }
  const result = validatePassphraseStrength(passphrase);
  res.json(result);
});

// ─── Remote Backup Endpoints ─────────────────────────────────────

backupRouter.get('/remote/history', async (_req, res) => {
  const entries = await backupService.listRemoteBackups();
  res.json({ backups: entries });
});

backupRouter.get('/remote/download/*', async (req, res) => {
  const key = (req.params as any)[0] as string;
  if (!key) { res.status(400).json({ error: { message: 'Key is required' } }); return; }
  try {
    const data = await backupService.downloadRemoteBackup(key);
    const fileName = key.split('/').pop() || 'backup.kbk';
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', encodeContentDisposition(fileName));
    res.send(data);
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

backupRouter.delete('/remote/*', async (req, res) => {
  const key = (req.params as any)[0] as string;
  if (!key) { res.status(400).json({ error: { message: 'Key is required' } }); return; }
  try {
    await backupService.deleteRemoteBackup(key);
    res.json({ message: 'Remote backup deleted' });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});

backupRouter.post('/remote/upload/:fileName', async (req, res) => {
  const fileName = req.params['fileName']!;
  try {
    const data = await backupService.downloadBackup(req.tenantId, fileName);
    const result = await backupService.uploadBackupToRemote(fileName, data, req.tenantId);
    if (result.success) {
      res.json({ message: 'Backup uploaded to remote storage' });
    } else {
      res.status(500).json({ error: { message: result.error || 'Upload failed' } });
    }
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message } });
  }
});
