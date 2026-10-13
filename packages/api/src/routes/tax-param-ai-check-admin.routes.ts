// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// AI parameter check (Tax Estimator, OPEN-QUESTIONS Q48). Super-admin only, the same guard as
// /admin/tax-parameters and /admin/tax-state-rules: parameters are global reference data.
// Advisory: a check never changes a value; apply writes an audited, UNVERIFIED override.

import { Router } from 'express';
import {
  createAiCheckRunSchema, aiCheckRunIdParamsSchema, aiCheckIdParamsSchema, aiCheckRunsQuerySchema,
  aiCheckLatestQuerySchema, applyAiCheckSchema,
} from '@kis-books/shared';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import * as svc from '../services/tax-estimator/tax-param-ai-check.service.js';

export const taxParamAiCheckAdminRouter = Router();
taxParamAiCheckAdminRouter.use(authenticate);
taxParamAiCheckAdminRouter.use(requireSuperAdmin);

taxParamAiCheckAdminRouter.get('/availability', async (_req, res) => {
  res.json({ data: await svc.getAvailability() });
});

taxParamAiCheckAdminRouter.get('/latest', async (req, res) => {
  const { year, state } = aiCheckLatestQuerySchema.parse(req.query);
  res.json({ data: await svc.getLatest(year, state) });
});

taxParamAiCheckAdminRouter.get('/checks/:id', async (req, res) => {
  const { id } = aiCheckIdParamsSchema.parse(req.params);
  res.json({ data: await svc.getCheck(id) });
});

taxParamAiCheckAdminRouter.post('/checks/:id/apply', async (req, res) => {
  const { id } = aiCheckIdParamsSchema.parse(req.params);
  const body = applyAiCheckSchema.parse(req.body ?? {});
  res.json({ data: await svc.applyCheck(id, body.expectedValue, body.updateCitation, req.userId) });
});

taxParamAiCheckAdminRouter.get('/runs', async (req, res) => {
  const { year, limit } = aiCheckRunsQuerySchema.parse(req.query);
  res.json({ data: { runs: await svc.listRuns(year, limit) } });
});

taxParamAiCheckAdminRouter.post('/runs', async (req, res) => {
  const body = createAiCheckRunSchema.parse(req.body ?? {});
  res.status(202).json({ data: await svc.createRun(body, req.userId) });
});

taxParamAiCheckAdminRouter.get('/runs/:id', async (req, res) => {
  const { id } = aiCheckRunIdParamsSchema.parse(req.params);
  res.json({ data: await svc.getRun(id) });
});

taxParamAiCheckAdminRouter.post('/runs/:id/cancel', async (req, res) => {
  const { id } = aiCheckRunIdParamsSchema.parse(req.params);
  res.json({ data: await svc.cancelRun(id, req.userId) });
});
