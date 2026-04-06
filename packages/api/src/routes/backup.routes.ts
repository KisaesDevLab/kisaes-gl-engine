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
