// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import {
  createDailySalesTemplateSchema,
  updateDailySalesTemplateSchema,
  duplicateDailySalesTemplateSchema,
  replaceDailySalesTemplateLinesSchema,
  createDailySalesEntrySchema,
  updateDailySalesEntrySchema,
  previewDailySalesEntrySchema,
  dailySalesEntriesFilterSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import * as service from '../services/daily-sales.service.js';
import { lockContextMiddleware } from '../services/lock-context.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';

export const dailySalesRouter = Router();
dailySalesRouter.use(authenticate);
dailySalesRouter.use(companyContext);
dailySalesRouter.use(requireResource('daily_sales'));

// Idempotency-Key (idempotency-v1, U-18) on entry create, post and void: the
// readers replay the entry as it is now when no stored response is left.
const keyedEntryCreate = idempotent({
  successStatus: 201,
  replay: async (req, entity) => ({ entry: await service.getEntry(req.tenantId, entity!.id, req.companyId) }),
});
const keyedEntryById = idempotent({
  successStatus: 200,
  replay: async (req) => ({ entry: await service.getEntry(req.tenantId, req.params['id']!, req.companyId) }),
});

// ── Templates ──
dailySalesRouter.get('/templates', async (req, res) => {
  res.json({ templates: await service.listTemplates(req.tenantId, req.companyId) });
});

dailySalesRouter.post('/templates', validate(createDailySalesTemplateSchema), async (req, res) => {
  const template = await service.createTemplate(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ template });
});

dailySalesRouter.get('/templates/:id', async (req, res) => {
  res.json({ template: await service.getTemplate(req.tenantId, req.params['id']!, req.companyId) });
});

dailySalesRouter.put('/templates/:id', validate(updateDailySalesTemplateSchema), async (req, res) => {
  res.json({ template: await service.updateTemplate(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId) });
});

dailySalesRouter.post('/templates/:id/duplicate', validate(duplicateDailySalesTemplateSchema), async (req, res) => {
  const template = await service.duplicateTemplate(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.status(201).json({ template });
});

dailySalesRouter.delete('/templates/:id', async (req, res) => {
  await service.deleteTemplate(req.tenantId, req.params['id']!, req.userId, req.companyId);
  res.json({ deleted: true });
});

dailySalesRouter.put('/templates/:id/lines', validate(replaceDailySalesTemplateLinesSchema), async (req, res) => {
  const template = await service.replaceTemplateLines(req.tenantId, req.params['id']!, req.body.lines, req.userId, req.companyId);
  res.json({ template });
});

// ── Entries ──
dailySalesRouter.get('/entries', async (req, res) => {
  const filters = dailySalesEntriesFilterSchema.parse(req.query);
  const { entries, total } = await service.listEntries(req.tenantId, filters, req.companyId);
  res.json({ entries, total });
});

dailySalesRouter.post('/entries', keyedEntryCreate, validate(createDailySalesEntrySchema), async (req, res) => {
  const entry = await service.createDraft(req.tenantId, req.body, req.userId, req.companyId);
  res.status(201).json({ entry });
});

dailySalesRouter.post('/entries/preview', validate(previewDailySalesEntrySchema), async (req, res) => {
  res.json(await service.previewEntry(req.tenantId, req.body, req.companyId));
});

dailySalesRouter.get('/entries/:id', async (req, res) => {
  res.json({ entry: await service.getEntry(req.tenantId, req.params['id']!, req.companyId) });
});

dailySalesRouter.put('/entries/:id', validate(updateDailySalesEntrySchema), async (req, res) => {
  res.json({ entry: await service.updateDraft(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId) });
});

// Posting and voiding check the closing date like every other posting
// (U-57): a closed-period date answers 423 TB_PERIOD_LOCKED, and
// `closingPassword` in the body (closing-password-v1) opens it; a wrong one
// is 403 CLOSING_PASSWORD_INVALID, rate limited (429).
const closingPasswordBodyDoc = z.object({
  closingPassword: z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed'),
});

dailySalesRouter.post('/entries/:id/post', keyedEntryById, closingPasswordLimiter, lockContextMiddleware, describe({
  summary: 'Post a daily-sales entry (closing date enforced; daily-sales-lock-v1)',
  body: closingPasswordBodyDoc,
}), async (req, res) => {
  res.json({ entry: await service.postEntry(req.tenantId, req.params['id']!, req.userId, req.companyId) });
});

dailySalesRouter.post('/entries/:id/void', keyedEntryById, closingPasswordLimiter, lockContextMiddleware, describe({
  summary: 'Void a posted daily-sales entry (closing date enforced; daily-sales-lock-v1)',
  body: closingPasswordBodyDoc,
}), async (req, res) => {
  res.json({ entry: await service.voidEntry(req.tenantId, req.params['id']!, req.userId, req.companyId) });
});

dailySalesRouter.delete('/entries/:id', async (req, res) => {
  await service.deleteEntry(req.tenantId, req.params['id']!, req.userId, req.companyId);
  res.json({ deleted: true });
});
