// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/portal-reminders.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 13 — bookkeeper-side
// reminder admin. Mounted at /api/v1/practice/portal/reminders.

export const portalRemindersRouter = Router();
portalRemindersRouter.use(authenticate);

portalRemindersRouter.use((req, _res, next) => {
  if (req.userType === 'client') throw AppError.notFound('Feature not available');
  if (req.userRole === 'readonly' && req.method !== 'GET') {
    throw AppError.forbidden('Read-only role cannot manage reminders');
  }
  next();
});

const TRIGGER_TYPES = [
  'unanswered_question',
  'w9_pending',
  'doc_request',
  'recurring_non_transaction',
  'magic_link_expiring',
] as const;

const scheduleSchema = z.object({
  triggerType: z.enum(TRIGGER_TYPES),
  cadenceDays: z.array(z.number().int().min(1).max(365)).min(1).max(20),
  channelStrategy: z.enum(['email_only', 'sms_only', 'both', 'escalating']),
  quietHoursStart: z.number().int().min(0).max(23).optional(),
  quietHoursEnd: z.number().int().min(0).max(23).optional(),
  maxPerWeek: z.number().int().min(1).max(20).optional(),
  companyId: z.string().uuid().nullable().optional(),
  active: z.boolean().optional(),
});

portalRemindersRouter.get('/schedules', async (req, res) => {
  const list = await svc.listSchedules(req.tenantId);
  res.json({ schedules: list });
});

portalRemindersRouter.post('/schedules', validate(scheduleSchema), async (req, res) => {
  const result = await svc.createSchedule(req.tenantId, req.userId, req.body);
  res.status(201).json(result);
});

const togglePatchSchema = z.object({ active: z.boolean() });

portalRemindersRouter.patch(
  '/schedules/:id',
  validate(togglePatchSchema),
  async (req, res) => {
    await svc.setScheduleActive(
      req.tenantId,
      req.params['id']!,
      req.body.active,
      req.userId,
    );
    res.json({ ok: true });
  },
);

portalRemindersRouter.delete('/schedules/:id', async (req, res) => {
  await svc.deleteSchedule(req.tenantId, req.params['id']!, req.userId);
  res.json({ ok: true });
});

const templateSchema = z.object({
  triggerType: z.enum(TRIGGER_TYPES),
  channel: z.enum(['email', 'sms']),
  subject: z.string().max(255).nullable().optional(),
  body: z.string().min(1).max(8000),
});

portalRemindersRouter.get('/templates', async (req, res) => {
  const list = await svc.listTemplates(req.tenantId);
  res.json({ templates: list });
});

portalRemindersRouter.put('/templates', validate(templateSchema), async (req, res) => {
  const result = await svc.upsertTemplate(req.tenantId, req.userId, req.body);
  res.json(result);
});

portalRemindersRouter.get('/preview', async (req, res) => {
  const queue = await svc.previewQueue(req.tenantId);
  res.json({ queue });
});

portalRemindersRouter.get('/stats', async (req, res) => {
  const stats = await svc.openRateLast30Days(req.tenantId);
  res.json(stats);
});

// Manual fire (admin diagnostic). Production cadence runs via the
// worker scheduler tick. Scoped to the requesting tenant — must
// never trigger sends on behalf of other firms.
portalRemindersRouter.post('/dispatch', async (req, res) => {
  if (req.userRole !== 'owner') throw AppError.forbidden('Owner role required');
  const result = await svc.dispatch(req.tenantId);
  res.json(result);
});

const suppressSchema = z.object({
  contactId: z.string().uuid(),
  reason: z.string().min(1).max(30).default('MANUAL'),
  channel: z.enum(['email', 'sms']).optional(),
});

portalRemindersRouter.post('/suppressions', validate(suppressSchema), async (req, res) => {
  await svc.suppressForTenant(
    req.tenantId,
    req.userId,
    req.body.contactId,
    req.body.reason,
    req.body.channel,
  );
  res.status(201).json({ ok: true });
});

portalRemindersRouter.delete('/suppressions/:contactId', async (req, res) => {
  const removed = await svc.unsuppress(req.tenantId, req.params['contactId']!, req.userId);
  res.json({ removed });
});
