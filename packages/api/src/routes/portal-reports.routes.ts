// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/portal-reports.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 16 + 17 — Report Builder admin.

export const portalReportsRouter = Router();
portalReportsRouter.use(authenticate);
portalReportsRouter.use((req, _res, next) => {
  if (req.userType === 'client') throw AppError.notFound('Feature not available');
  if (req.userRole === 'readonly' && req.method !== 'GET') {
    throw AppError.forbidden('Read-only role cannot manage reports');
  }
  next();
});

// ── KPI library (stock + custom) ───────────────────────────────

portalReportsRouter.get('/kpis', async (req, res) => {
  const kpis = await svc.getCatalog(req.tenantId);
  res.json({ kpis });
});

const customKpiSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  name: z.string().min(1).max(200),
  category: z.string().max(40).optional(),
  format: z.enum(['currency', 'percent', 'ratio', 'days']),
  formula: z.unknown(),
  threshold: z.unknown().optional(),
});
const customKpiPatchSchema = customKpiSchema.partial();

portalReportsRouter.get('/custom-kpis', async (req, res) => {
  const list = await svc.listCustomKpis(req.tenantId);
  res.json({ kpis: list });
});

portalReportsRouter.post('/custom-kpis', validate(customKpiSchema), async (req, res) => {
  const result = await svc.createCustomKpi(req.tenantId, req.userId, req.body);
  res.status(201).json(result);
});

portalReportsRouter.put('/custom-kpis/:id', validate(customKpiPatchSchema), async (req, res) => {
  await svc.updateCustomKpi(req.tenantId, req.params['id']!, req.userId, req.body);
  res.json({ ok: true });
});

portalReportsRouter.delete('/custom-kpis/:id', async (req, res) => {
  await svc.deleteCustomKpi(req.tenantId, req.params['id']!, req.userId);
  res.json({ ok: true });
});

// ── Templates ───────────────────────────────────────────────────

const createTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  layout: z.array(z.unknown()).optional(),
  theme: z.record(z.unknown()).optional(),
  defaultPeriod: z.string().max(20).optional(),
  isPracticeTemplate: z.boolean().optional(),
});

portalReportsRouter.get('/templates', async (req, res) => {
  const list = await svc.listTemplates(req.tenantId);
  res.json({ templates: list });
});

portalReportsRouter.post('/templates', validate(createTemplateSchema), async (req, res) => {
  const result = await svc.createTemplate(req.tenantId, req.userId, req.body);
  res.status(201).json(result);
});

portalReportsRouter.put('/templates/:id', validate(createTemplateSchema.partial()), async (req, res) => {
  await svc.updateTemplate(req.tenantId, req.params['id']!, req.userId, req.body);
  res.json({ ok: true });
});

portalReportsRouter.delete('/templates/:id', async (req, res) => {
  await svc.deleteTemplate(req.tenantId, req.params['id']!, req.userId);
  res.json({ ok: true });
});

portalReportsRouter.post('/templates/import-stock', async (req, res) => {
  const result = await svc.importStockTemplates(req.tenantId, req.userId);
  res.json(result);
});

// ── Instances ───────────────────────────────────────────────────

const createInstanceSchema = z.object({
  templateId: z.string().uuid().nullable().optional(),
  companyId: z.string().uuid(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

portalReportsRouter.get('/instances', async (req, res) => {
  const companyId = req.query['companyId'] as string | undefined;
  const list = await svc.listInstances(req.tenantId, companyId);
  res.json({ instances: list });
});

portalReportsRouter.post('/instances', validate(createInstanceSchema), async (req, res) => {
  const result = await svc.createInstance(req.tenantId, req.userId, req.body);
  res.status(201).json(result);
});

portalReportsRouter.get('/instances/:id', async (req, res) => {
  const inst = await svc.getInstance(req.tenantId, req.params['id']!);
  res.json({ instance: inst });
});

const updateInstanceSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  templateId: z.string().uuid().nullable().optional(),
});

portalReportsRouter.put('/instances/:id', validate(updateInstanceSchema), async (req, res) => {
  await svc.updateInstance(req.tenantId, req.params['id']!, req.userId, req.body);
  res.json({ ok: true });
});

portalReportsRouter.delete('/instances/:id', async (req, res) => {
  const force = req.query['force'] === 'true';
  await svc.deleteInstance(req.tenantId, req.params['id']!, req.userId, force);
  res.json({ ok: true });
});

// Duplicate a published instance into a new draft (version+1) so
// the bookkeeper can revise without losing the published artifact.
portalReportsRouter.post('/instances/:id/duplicate', async (req, res) => {
  const result = await svc.duplicateInstance(req.tenantId, req.params['id']!, req.userId);
  res.status(201).json(result);
});

// Bookkeeper-side PDF download. Streams the stored artifact.
portalReportsRouter.get('/instances/:id/download', async (req, res) => {
  const result = await svc.downloadInstancePdf(req.tenantId, req.params['id']!);
  if (!result) {
    throw AppError.notFound('No published PDF available for this instance');
  }
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.send(result.buffer);
});

const generateSchema = z.object({ data: z.record(z.unknown()) });
portalReportsRouter.post('/instances/:id/generate', validate(generateSchema), async (req, res) => {
  await svc.generateInstance(req.tenantId, req.params['id']!, req.userId, req.body.data);
  res.json({ ok: true });
});

// Compute the data snapshot for the instance. Uses the real KPI
// evaluator against the company's books. Manual overrides set via
// /patch survive recompute.
portalReportsRouter.post('/instances/:id/compute', async (req, res) => {
  const result = await svc.computeInstancePlaceholder(req.tenantId, req.params['id']!, req.userId);
  res.json(result);
});

const patchSnapshotSchema = z.object({
  kpiOverrides: z.record(z.string()).optional(),
  aiSummary: z.string().max(20000).optional(),
  textOverrides: z.record(z.string()).optional(),
});

portalReportsRouter.patch(
  '/instances/:id/data',
  validate(patchSnapshotSchema),
  async (req, res) => {
    const result = await svc.patchSnapshot(req.tenantId, req.params['id']!, req.userId, req.body);
    res.json(result);
  },
);

const statusSchema = z.object({
  status: z.enum(['draft', 'review', 'published', 'archived']),
});
portalReportsRouter.post('/instances/:id/status', validate(statusSchema), async (req, res) => {
  const result = await svc.setStatus(req.tenantId, req.params['id']!, req.userId, req.body.status);
  res.json(result);
});

// ── Comments ────────────────────────────────────────────────────

const commentSchema = z.object({
  body: z.string().min(1).max(4000),
  blockRef: z.string().max(80).optional(),
});

portalReportsRouter.get('/instances/:id/comments', async (req, res) => {
  const list = await svc.listComments(req.tenantId, req.params['id']!);
  res.json({ comments: list });
});

portalReportsRouter.post('/instances/:id/comments', validate(commentSchema), async (req, res) => {
  const result = await svc.addComment(
    req.tenantId,
    req.params['id']!,
    req.userId,
    req.body.body,
    req.body.blockRef,
  );
  res.status(201).json(result);
});

// ── AI summary save ─────────────────────────────────────────────

const aiSummarySchema = z.object({
  text: z.string().min(1).max(20000),
  modelUsed: z.string().max(80).optional(),
  blockRef: z.string().max(80).optional(),
});
portalReportsRouter.post('/instances/:id/ai-summary', validate(aiSummarySchema), async (req, res) => {
  const result = await svc.saveAiSummary(
    req.tenantId,
    req.params['id']!,
    req.body.text,
    req.body.modelUsed,
    req.body.blockRef,
  );
  res.status(201).json(result);
});
