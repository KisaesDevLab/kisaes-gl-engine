// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/portal-question.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 10 — bookkeeper-side
// Question CRUD endpoints. Mounted at /api/v1/practice/portal/questions.

export const portalQuestionsRouter = Router();
portalQuestionsRouter.use(authenticate);

portalQuestionsRouter.use((req, _res, next) => {
  if (req.userType === 'client') {
    throw AppError.notFound('Feature not available');
  }
  if (req.userRole === 'readonly' && req.method !== 'GET') {
    throw AppError.forbidden('Read-only role cannot manage questions');
  }
  next();
});

const createSchema = z.object({
  companyId: z.string().uuid(),
  body: z.string().min(1).max(4000),
  transactionId: z.string().uuid().nullable().optional(),
  splitLineId: z.string().uuid().nullable().optional(),
  assignedContactId: z.string().uuid().nullable().optional(),
});

portalQuestionsRouter.get('/', async (req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const list = await svc.listForBookkeeper(req.tenantId, {
    status: (q['status'] as 'open' | 'viewed' | 'responded' | 'resolved' | 'unresolved' | 'all' | undefined),
    companyId: q['companyId'],
    assignedContactId: q['contactId'],
    transactionId: q['transactionId'],
    closePeriod: q['closePeriod'],
  });
  res.json({ questions: list });
});

portalQuestionsRouter.get('/pending-batches', async (req, res) => {
  const batches = await svc.listPendingBatches(req.tenantId);
  res.json({ batches });
});

portalQuestionsRouter.post('/pending-batches/mark-notified', async (req, res) => {
  const ids = (req.body?.questionIds ?? []) as unknown;
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) {
    throw AppError.badRequest('questionIds must be string[]');
  }
  await svc.markBatchNotified(req.tenantId, ids as string[]);
  res.json({ ok: true });
});

portalQuestionsRouter.get('/:id', async (req, res) => {
  const q = await svc.getQuestionForBookkeeper(req.tenantId, req.params['id']!);
  res.json({ question: q });
});

portalQuestionsRouter.post('/', validate(createSchema), async (req, res) => {
  const result = await svc.createQuestion(req.tenantId, req.userId, req.body);
  res.status(201).json(result);
});

const replySchema = z.object({ body: z.string().min(1).max(4000) });

portalQuestionsRouter.post('/:id/replies', validate(replySchema), async (req, res) => {
  const result = await svc.bookkeeperReply(req.tenantId, req.userId, req.params['id']!, req.body.body);
  res.status(201).json(result);
});

portalQuestionsRouter.post('/:id/resolve', async (req, res) => {
  await svc.resolveQuestion(req.tenantId, req.userId, req.params['id']!);
  res.json({ ok: true });
});

const followUpSchema = z.object({ body: z.string().min(1).max(4000) });
portalQuestionsRouter.post('/:id/follow-up', validate(followUpSchema), async (req, res) => {
  const result = await svc.bookkeeperFollowUp(req.tenantId, req.userId, req.params['id']!, req.body.body);
  res.status(201).json(result);
});

const bulkAskSchema = z.object({
  companyId: z.string().uuid(),
  body: z.string().min(1).max(4000),
  transactionIds: z.array(z.string().uuid()).min(1).max(200),
  assignedContactId: z.string().uuid().nullable().optional(),
});
portalQuestionsRouter.post('/bulk', validate(bulkAskSchema), async (req, res) => {
  const result = await svc.bulkAsk(req.tenantId, req.userId, req.body);
  res.status(201).json(result);
});

// ── Templates (11.2) ─────────────────────────────────────────────

const templateRouter = Router();

const createTemplateSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  companyId: z.string().uuid().nullable().optional(),
  variables: z.array(z.string()).optional(),
});
const updateTemplateSchema = createTemplateSchema.partial();

templateRouter.get('/', async (req, res) => {
  const companyId = req.query['companyId'] as string | undefined;
  const list = await svc.listTemplates(req.tenantId, companyId);
  res.json({ templates: list });
});
templateRouter.post('/', validate(createTemplateSchema), async (req, res) => {
  const result = await svc.createTemplate(req.tenantId, req.userId, req.body);
  res.status(201).json(result);
});
templateRouter.put('/:id', validate(updateTemplateSchema), async (req, res) => {
  await svc.updateTemplate(req.tenantId, req.params['id']!, req.userId, req.body);
  res.json({ ok: true });
});
templateRouter.delete('/:id', async (req, res) => {
  await svc.deleteTemplate(req.tenantId, req.params['id']!, req.userId);
  res.json({ ok: true });
});

portalQuestionsRouter.use('/templates', templateRouter);

// ── Recurring schedules (11.4) ──────────────────────────────────

const recurringRouter = Router();

const createRecurringSchema = z.object({
  companyId: z.string().uuid(),
  templateBody: z.string().min(1).max(4000),
  cadence: z.enum(['monthly', 'quarterly', 'custom']),
  dayOfPeriod: z.number().int().min(1).max(31),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

recurringRouter.get('/', async (req, res) => {
  const list = await svc.listRecurring(req.tenantId);
  res.json({ schedules: list });
});
recurringRouter.post('/', validate(createRecurringSchema), async (req, res) => {
  const result = await svc.createRecurring(req.tenantId, req.body);
  res.status(201).json(result);
});
recurringRouter.post('/:id/pause', async (req, res) => {
  await svc.pauseRecurring(req.tenantId, req.params['id']!, false);
  res.json({ ok: true });
});
recurringRouter.post('/:id/resume', async (req, res) => {
  await svc.pauseRecurring(req.tenantId, req.params['id']!, true);
  res.json({ ok: true });
});

portalQuestionsRouter.use('/recurring', recurringRouter);

// 12.2 — append client response to transaction memo.
portalQuestionsRouter.post('/:id/messages/:msgId/append-to-memo', async (req, res) => {
  const result = await svc.appendResponseToMemo(req.tenantId, req.userId, {
    questionId: req.params['id']!,
    messageId: req.params['msgId']!,
  });
  res.json(result);
});

// Cross-tenant orphan sweep (12.5) — admin-triggered for safety.
// The scheduler also runs this hourly per-tenant.
portalQuestionsRouter.post('/orphans/resolve', async (req, res) => {
  if (req.userRole !== 'owner') throw AppError.forbidden('Owner role required');
  const count = await svc.resolveOrphans(req.tenantId);
  res.json({ resolvedCount: count });
});
