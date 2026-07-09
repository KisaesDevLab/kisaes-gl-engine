// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Report Packs — bulk multi-report combined PDF.
//
// Mounted at /api/v1/reports alongside reportsRouter. Its sub-paths
// (/catalog, /packs*) don't collide with the report slugs, and this router
// keeps its own middleware chain so the guard is explicit.
//
// Permission note: the `reports` resource is declared writable:false in the
// shared permission catalog, so `can(perms,'reports','update'|'create'|
// 'delete')` can NEVER be satisfied (cap() limits reports to 'view'). Report
// packs perform no ledger mutation — they save config and render data the
// caller can already read — so every endpoint gates on reports:read.

import { Router } from 'express';
import { z } from 'zod';
import { reportPackItemOptionsSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { requirePermission } from '../middleware/permission.js';
import { expensiveOpLimiter } from '../middleware/expensive-op-limiter.js';
import { validate } from '../middleware/validate.js';
import * as packService from '../services/report-pack.service.js';
import { getReportPackQueueHealth } from '../services/extraction/queue.js';
import { REPORT_CATALOG } from '@kis-books/shared';

export const reportPacksRouter = Router();
reportPacksRouter.use(authenticate);
reportPacksRouter.use(companyContext);
reportPacksRouter.use(expensiveOpLimiter);

const readPerm = requirePermission('reports', 'read');

const packItemSchema = z.object({
  reportId: z.string().min(1),
  options: reportPackItemOptionsSchema.optional(),
});

const packBodySchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  periodPreset: z.enum(['this-month', 'last-month', 'qtd', 'last-quarter', 'ytd', 'last-year', 'custom']).optional(),
  customRangeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  customRangeEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  asOfMode: z.enum(['range-end', 'custom']).optional(),
  asOfCustom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  defaultBasis: z.enum(['accrual', 'cash']).optional(),
  defaultTagId: z.string().uuid().nullable().optional(),
  coverPage: z.boolean().optional(),
  toc: z.boolean().optional(),
  pageNumbers: z.boolean().optional(),
  pageFooter: z.string().max(500).nullable().optional(),
  filenameTemplate: z.string().max(255).optional(),
  onError: z.enum(['skip', 'fail']).optional(),
  items: z.array(packItemSchema).max(30),
});

const runBodySchema = z.object({
  rangeStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  rangeEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).default({});

// ─── Catalog ───
reportPacksRouter.get('/catalog', readPerm, (_req, res) => {
  res.json({ catalog: REPORT_CATALOG });
});

// ─── Pack CRUD ───
reportPacksRouter.get('/packs', readPerm, async (req, res) => {
  const packs = await packService.listPacks(req.tenantId, req.companyId);
  res.json({ packs });
});

reportPacksRouter.post('/packs', readPerm, validate(packBodySchema), async (req, res) => {
  const pack = await packService.createPack(req.tenantId, req.companyId, req.userId, req.body);
  res.status(201).json(pack);
});

// Background-worker health (declared before '/packs/:id' so it isn't captured
// as a pack id). Reports whether Redis + a report-pack worker are reachable;
// when they aren't, packs still generate inline in the API.
reportPacksRouter.get('/packs/worker-health', readPerm, async (_req, res) => {
  const health = await getReportPackQueueHealth();
  res.json(health);
});

reportPacksRouter.get('/packs/:id', readPerm, async (req, res) => {
  const pack = await packService.getPack(req.tenantId, req.params['id']!);
  res.json(pack);
});

reportPacksRouter.put('/packs/:id', readPerm, validate(packBodySchema), async (req, res) => {
  const pack = await packService.updatePack(req.tenantId, req.params['id']!, req.userId, req.body);
  res.json(pack);
});

reportPacksRouter.delete('/packs/:id', readPerm, async (req, res) => {
  await packService.softDeletePack(req.tenantId, req.params['id']!, req.userId);
  res.status(204).end();
});

reportPacksRouter.post('/packs/:id/duplicate', readPerm, async (req, res) => {
  const pack = await packService.duplicatePack(req.tenantId, req.params['id']!, req.userId);
  res.status(201).json(pack);
});

// ─── Runs ───
reportPacksRouter.post('/packs/:id/runs', readPerm, validate(runBodySchema), async (req, res) => {
  const run = await packService.createRun(req.tenantId, req.companyId, req.params['id']!, req.userId, req.body);
  res.status(202).json(run);
});

reportPacksRouter.get('/packs/runs/:runId', readPerm, async (req, res) => {
  const run = await packService.getRun(req.tenantId, req.params['runId']!);
  res.json(run);
});

reportPacksRouter.get('/packs/runs/:runId/pdf', readPerm, async (req, res) => {
  const { buffer, filename } = await packService.readRunArtifact(req.tenantId, req.params['runId']!);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});
