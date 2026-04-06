import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as duplicateService from '../services/duplicate-detection.service.js';

export const duplicatesRouter = Router();
duplicatesRouter.use(authenticate);

duplicatesRouter.get('/', async (req, res) => {
  const startDate = (req.query['start_date'] as string) || (() => { const d = new Date(); d.setMonth(d.getMonth() - 3); return d.toISOString().split('T')[0]!; })();
  const endDate = (req.query['end_date'] as string) || new Date().toISOString().split('T')[0]!;
  const pairs = await duplicateService.scanDateRange(req.tenantId, startDate, endDate);
  res.json({ pairs, count: pairs.length });
});

duplicatesRouter.post('/scan', async (req, res) => {
  const pairs = await duplicateService.scanDateRange(req.tenantId, req.body.startDate, req.body.endDate);
  res.json({ pairs, count: pairs.length });
});

duplicatesRouter.get('/for-transaction/:id', async (req, res) => {
  const duplicates = await duplicateService.findDuplicates(req.tenantId, req.params['id']!);
  res.json({ duplicates });
});

duplicatesRouter.post('/:idA/dismiss/:idB', async (req, res) => {
  await duplicateService.dismissDuplicate(req.tenantId, req.params['idA']!, req.params['idB']!, req.userId);
  res.json({ message: 'Dismissed' });
});

duplicatesRouter.post('/merge', async (req, res) => {
  await duplicateService.mergeDuplicate(req.tenantId, req.body.keepId, req.body.voidId, req.userId);
  res.json({ message: 'Merged' });
});
