// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request } from 'express';
import {
  yearParamsSchema, estimateParamsSchema, paymentIdParamsSchema, computeEstimateSchema, createPaymentSchema, updatePaymentSchema,
  paymentsQuerySchema, captureSchAiSnapshotsSchema,
} from '@kis-books/shared';
import { getScope, requireTaxEstimatorWrite } from '../../middleware/tax-estimator-scope.js';
import * as estimateService from '../../services/tax-estimator/estimate.service.js';
import * as paymentsService from '../../services/tax-estimator/payments.service.js';
import * as schAiSnapshotsService from '../../services/tax-estimator/sch-ai-snapshots.service.js';

// Phase 10b router — live estimate, estimate (snapshot) readiness, payment ledger,
// Schedule AI period snapshots. Mounted by tax-estimator.routes.ts AFTER its guard chain
// (session auth → client 404 → flag → tax_estimator resource → firm scope). Every handler
// resolves the taxpayer / scenario / payment through the firm scope (404 across firms);
// mutations need requireTaxEstimatorWrite. Computing an estimate is a read (any firm role).
export const estimateRouter = Router();

const actor = (req: Request) => ({ tenantId: req.tenantId, userId: req.userId });

// ── estimate ──
estimateRouter.post('/taxpayers/:id/years/:taxYear/scenarios/:scenarioId/estimate', async (req, res) => {
  const { id, taxYear, scenarioId } = estimateParamsSchema.parse(req.params);
  const body = computeEstimateSchema.parse(req.body ?? {});
  res.json({ data: await estimateService.computeEstimate(getScope(req), { taxpayerId: id, taxYear, scenarioId, throughMonth: body.throughMonth, refresh: body.refresh }) });
});
estimateRouter.get('/taxpayers/:id/years/:taxYear/readiness', async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  res.json({ data: await estimateService.getEstimateReadiness(getScope(req), id, taxYear) });
});

// ── payment ledger ──
estimateRouter.get('/taxpayers/:id/years/:taxYear/payments', async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  const q = paymentsQuerySchema.parse(req.query);
  res.json({ data: await paymentsService.getPaymentLedger(getScope(req), id, taxYear, q.scenarioId ?? null, { limit: q.limit, offset: q.offset }) });
});
estimateRouter.post('/taxpayers/:id/years/:taxYear/payments', requireTaxEstimatorWrite, async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  const input = createPaymentSchema.parse(req.body);
  res.status(201).json({ data: await paymentsService.createPayment(getScope(req), actor(req), id, taxYear, input) });
});
estimateRouter.patch('/payments/:paymentId', requireTaxEstimatorWrite, async (req, res) => {
  const { paymentId } = paymentIdParamsSchema.parse(req.params);
  const input = updatePaymentSchema.parse(req.body);
  res.json({ data: await paymentsService.updatePayment(getScope(req), actor(req), paymentId, input) });
});
estimateRouter.delete('/payments/:paymentId', requireTaxEstimatorWrite, async (req, res) => {
  const { paymentId } = paymentIdParamsSchema.parse(req.params);
  await paymentsService.deletePayment(getScope(req), actor(req), paymentId);
  res.status(204).end();
});

// ── Schedule AI period snapshots ──
estimateRouter.get('/taxpayers/:id/years/:taxYear/sch-ai-snapshots', async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  const data = await schAiSnapshotsService.listSnapshots(getScope(req), id, taxYear);
  res.json({ data, total: data.length });
});
estimateRouter.post('/taxpayers/:id/years/:taxYear/sch-ai-snapshots', requireTaxEstimatorWrite, async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  const input = captureSchAiSnapshotsSchema.parse(req.body ?? {});
  res.json({ data: await schAiSnapshotsService.captureSnapshots(getScope(req), actor(req), id, taxYear, input) });
});
