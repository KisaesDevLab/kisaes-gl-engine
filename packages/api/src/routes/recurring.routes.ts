// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import * as recurringService from '../services/recurring.service.js';

// Explicit field allowlists — the previous `{...req.body}` spread into
// .set() let a caller write tenantId/companyId/nextOccurrence/lastPostedAt/
// isActive directly (a schedule moved to another tenant would then post
// transactions there).
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const frequency = z.enum(['daily', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annually']);
const mode = z.enum(['auto', 'reminder']);
const createScheduleSchema = z.object({
  templateTransactionId: z.string().uuid(),
  name: z.string().trim().max(255).nullable().optional(),
  frequency,
  intervalValue: z.number().int().min(1).max(365).optional(),
  mode: mode.optional(),
  startDate: isoDate,
  endDate: isoDate.nullable().optional(),
}).strict();
const updateScheduleSchema = z.object({
  name: z.string().trim().max(255).nullable().optional(),
  frequency: frequency.optional(),
  intervalValue: z.number().int().min(1).max(365).optional(),
  mode: mode.optional(),
  startDate: isoDate.optional(),
  endDate: isoDate.nullable().optional(),
}).strict();

export const recurringRouter = Router();
recurringRouter.use(authenticate);
recurringRouter.use(requireResource('recurring'));

recurringRouter.get('/', async (req, res) => {
  const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
  const offset = req.query['offset'] ? Number(req.query['offset']) : undefined;
  const result = await recurringService.list(req.tenantId, { limit, offset });
  res.json({ schedules: result.data, total: result.total, limit: result.limit, offset: result.offset });
});

recurringRouter.post('/', validate(createScheduleSchema), async (req, res) => {
  const { templateTransactionId, ...schedule } = req.body;
  const sched = await recurringService.create(req.tenantId, templateTransactionId, schedule, req.userId);
  res.status(201).json({ schedule: sched });
});

recurringRouter.put('/:id', validate(updateScheduleSchema), async (req, res) => {
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

recurringRouter.post('/:id/archive', async (req, res) => {
  const schedule = await recurringService.archive(req.tenantId, req.params['id']!, req.userId);
  res.json({ schedule });
});

recurringRouter.post('/:id/unarchive', async (req, res) => {
  const schedule = await recurringService.unarchive(req.tenantId, req.params['id']!, req.userId);
  res.json({ schedule });
});
