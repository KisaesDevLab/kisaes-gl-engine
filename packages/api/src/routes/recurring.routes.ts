// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import * as recurringService from '../services/recurring.service.js';

export const recurringRouter = Router();
recurringRouter.use(authenticate);

recurringRouter.get('/', async (req, res) => {
  const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
  const offset = req.query['offset'] ? Number(req.query['offset']) : undefined;
  const result = await recurringService.list(req.tenantId, { limit, offset });
  res.json({ schedules: result.data, total: result.total, limit: result.limit, offset: result.offset });
});

recurringRouter.post('/', async (req, res) => {
  const { templateTransactionId, ...schedule } = req.body;
  const sched = await recurringService.create(req.tenantId, templateTransactionId, schedule, req.userId);
  res.status(201).json({ schedule: sched });
});

recurringRouter.put('/:id', async (req, res) => {
  const sched = await recurringService.update(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ schedule: sched });
});

recurringRouter.delete('/:id', async (req, res) => {
  await recurringService.deactivate(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Deactivated' });
});

recurringRouter.post('/:id/post-now', async (req, res) => {
  const txn = await recurringService.postNext(req.tenantId, req.params['id']!);
  res.status(201).json({ transaction: txn });
});
