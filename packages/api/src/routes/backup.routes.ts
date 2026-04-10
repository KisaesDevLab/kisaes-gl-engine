import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import * as backupService from '../services/backup.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

export const backupRouter = Router();
backupRouter.use(authenticate);

backupRouter.post('/create', async (req, res) => {
  const result = await backupService.createBackup(req.tenantId);
  res.status(201).json(result);
});

backupRouter.get('/history', async (req, res) => {
  const backups = await backupService.listBackups(req.tenantId);
  res.json({ backups });
});

backupRouter.get('/download/:fileName', async (req, res) => {
  const data = await backupService.downloadBackup(req.tenantId, req.params['fileName']!);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params['fileName']}"`);
  res.send(data);
});

backupRouter.delete('/:fileName', async (req, res) => {
  await backupService.deleteBackup(req.tenantId, req.params['fileName']!);
  res.json({ message: 'Backup deleted' });
});

backupRouter.post('/restore', upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: { message: 'No file uploaded' } }); return; }
  const result = await backupService.restoreFromBackup(req.tenantId, req.file.buffer);
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
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
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
