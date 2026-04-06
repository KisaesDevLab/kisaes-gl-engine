import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as recurringService from '../services/recurring.service.js';

export const recurringRouter = Router();
recurringRouter.use(authenticate);

recurringRouter.get('/', async (req, res) => {
  const schedules = await recurringService.list(req.tenantId);
  res.json({ schedules });
});

recurringRouter.post('/', async (req, res) => {
  const { templateTransactionId, ...schedule } = req.body;
  const sched = await recurringService.create(req.tenantId, templateTransactionId, schedule);
  res.status(201).json({ schedule: sched });
});

recurringRouter.put('/:id', async (req, res) => {
  const sched = await recurringService.update(req.tenantId, req.params['id']!, req.body);
  res.json({ schedule: sched });
});

recurringRouter.delete('/:id', async (req, res) => {
  await recurringService.deactivate(req.tenantId, req.params['id']!);
  res.json({ message: 'Deactivated' });
});

recurringRouter.post('/:id/post-now', async (req, res) => {
  const txn = await recurringService.postNext(req.tenantId, req.params['id']!);
  res.status(201).json({ transaction: txn });
});
