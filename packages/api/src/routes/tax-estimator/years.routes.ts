// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  taxpayerIdParamsSchema, yearParamsSchema, scenarioIdParamsSchema, adjustmentIdParamsSchema, adjustmentTypeIdParamsSchema,
  upsertYearSchema, createScenarioSchema, updateScenarioSchema, cloneScenarioSchema, createAdjustmentSchema, updateAdjustmentSchema,
  replaceStateRowsSchema, createAdjustmentTypeSchema, updateAdjustmentTypeSchema, listAdjustmentTypesQuerySchema,
  upsertFirmSettingsSchema,
} from '@kis-books/shared';
import { getScope, requireTaxEstimatorWrite } from '../../middleware/tax-estimator-scope.js';
import { listPageQuerySchema, pageOf } from './paging.js';
import * as yearsService from '../../services/tax-estimator/years.service.js';
import * as scenariosService from '../../services/tax-estimator/scenarios.service.js';
import * as adjustmentsService from '../../services/tax-estimator/adjustments.service.js';
import * as adjustmentTypesService from '../../services/tax-estimator/adjustment-types.service.js';
import * as stateRowsService from '../../services/tax-estimator/state-rows.service.js';
import * as firmSettingsService from '../../services/tax-estimator/firm-settings.service.js';

// Phase 5 router — annual settings, scenarios, adjustments, state rows, firm settings.
// Mounted by tax-estimator.routes.ts AFTER its guard chain. Every handler resolves the
// taxpayer/scenario/adjustment through the firm scope (404 across firms); mutations need
// requireTaxEstimatorWrite; the firm and tenant set are never read from the request.
export const yearsRouter = Router();

const actor = (req: Request) => ({ tenantId: req.tenantId, userId: req.userId });
const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── years ──
yearsRouter.get('/taxpayers/:id/years', async (req, res) => {
  const { id } = taxpayerIdParamsSchema.parse(req.params);
  res.json(pageOf(await yearsService.listYears(getScope(req), id), listPageQuerySchema.parse(req.query)));
});
yearsRouter.get('/taxpayers/:id/years/:taxYear', async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  res.json({ data: await yearsService.getYear(getScope(req), id, taxYear) });
});
yearsRouter.put('/taxpayers/:id/years/:taxYear', requireTaxEstimatorWrite, async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  const input = upsertYearSchema.parse(req.body);
  res.json({ data: await yearsService.upsertYear(getScope(req), actor(req), id, taxYear, input) });
});

// ── scenarios ──
yearsRouter.get('/taxpayers/:id/years/:taxYear/scenarios', async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  res.json(pageOf(await scenariosService.listScenarios(getScope(req), id, taxYear), listPageQuerySchema.parse(req.query)));
});
yearsRouter.post('/taxpayers/:id/years/:taxYear/scenarios', requireTaxEstimatorWrite, async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  const { name } = createScenarioSchema.parse(req.body);
  res.status(201).json({ data: await scenariosService.createScenario(getScope(req), actor(req), id, taxYear, name) });
});
yearsRouter.patch('/scenarios/:scenarioId', requireTaxEstimatorWrite, async (req, res) => {
  const { scenarioId } = scenarioIdParamsSchema.parse(req.params);
  const input = updateScenarioSchema.parse(req.body);
  res.json({ data: await scenariosService.updateScenario(getScope(req), actor(req), scenarioId, input) });
});
yearsRouter.delete('/scenarios/:scenarioId', requireTaxEstimatorWrite, async (req, res) => {
  const { scenarioId } = scenarioIdParamsSchema.parse(req.params);
  await scenariosService.deleteScenario(getScope(req), actor(req), scenarioId);
  res.status(204).end();
});
yearsRouter.post('/scenarios/:scenarioId/clone', requireTaxEstimatorWrite, async (req, res) => {
  const { scenarioId } = scenarioIdParamsSchema.parse(req.params);
  const { name } = cloneScenarioSchema.parse(req.body ?? {});
  res.status(201).json({ data: await scenariosService.cloneScenario(getScope(req), actor(req), scenarioId, name) });
});

// ── adjustments ──
yearsRouter.get('/scenarios/:scenarioId/adjustments', async (req, res) => {
  const { scenarioId } = scenarioIdParamsSchema.parse(req.params);
  const page = pageQuerySchema.parse(req.query);
  res.json(await adjustmentsService.listAdjustments(getScope(req), scenarioId, page));
});
yearsRouter.post('/scenarios/:scenarioId/adjustments', requireTaxEstimatorWrite, async (req, res) => {
  const { scenarioId } = scenarioIdParamsSchema.parse(req.params);
  const input = createAdjustmentSchema.parse(req.body);
  res.status(201).json({ data: await adjustmentsService.createAdjustment(getScope(req), actor(req), scenarioId, input) });
});
yearsRouter.patch('/adjustments/:adjustmentId', requireTaxEstimatorWrite, async (req, res) => {
  const { adjustmentId } = adjustmentIdParamsSchema.parse(req.params);
  const input = updateAdjustmentSchema.parse(req.body);
  res.json({ data: await adjustmentsService.updateAdjustment(getScope(req), actor(req), adjustmentId, input) });
});
yearsRouter.delete('/adjustments/:adjustmentId', requireTaxEstimatorWrite, async (req, res) => {
  const { adjustmentId } = adjustmentIdParamsSchema.parse(req.params);
  await adjustmentsService.deleteAdjustment(getScope(req), actor(req), adjustmentId);
  res.status(204).end();
});

// ── state rows ──
yearsRouter.get('/scenarios/:scenarioId/state-rows', async (req, res) => {
  const { scenarioId } = scenarioIdParamsSchema.parse(req.params);
  res.json(pageOf(await stateRowsService.listStateRows(getScope(req), scenarioId), listPageQuerySchema.parse(req.query)));
});
yearsRouter.put('/scenarios/:scenarioId/state-rows', requireTaxEstimatorWrite, async (req, res) => {
  const { scenarioId } = scenarioIdParamsSchema.parse(req.params);
  const input = replaceStateRowsSchema.parse(req.body);
  res.json({ data: await stateRowsService.replaceStateRows(getScope(req), actor(req), scenarioId, input) });
});

// ── adjustment types ──
yearsRouter.get('/adjustment-types', async (req, res) => {
  const { includeInactive } = listAdjustmentTypesQuerySchema.parse(req.query);
  res.json(pageOf(await adjustmentTypesService.listAdjustmentTypes(getScope(req), includeInactive), listPageQuerySchema.parse(req.query)));
});
yearsRouter.post('/adjustment-types', requireTaxEstimatorWrite, async (req, res) => {
  const input = createAdjustmentTypeSchema.parse(req.body);
  res.status(201).json({ data: await adjustmentTypesService.createAdjustmentType(getScope(req), actor(req), input) });
});
yearsRouter.patch('/adjustment-types/:typeId', requireTaxEstimatorWrite, async (req, res) => {
  const { typeId } = adjustmentTypeIdParamsSchema.parse(req.params);
  const input = updateAdjustmentTypeSchema.parse(req.body);
  res.json({ data: await adjustmentTypesService.updateAdjustmentType(getScope(req), actor(req), typeId, input) });
});
yearsRouter.delete('/adjustment-types/:typeId', requireTaxEstimatorWrite, async (req, res) => {
  const { typeId } = adjustmentTypeIdParamsSchema.parse(req.params);
  await adjustmentTypesService.deleteAdjustmentType(getScope(req), actor(req), typeId);
  res.status(204).end();
});

// ── firm settings ── (PUT: firm_admin only, enforced in the service)
yearsRouter.get('/firm-settings', async (req, res) => {
  res.json({ data: await firmSettingsService.getFirmSettings(getScope(req)) });
});
yearsRouter.put('/firm-settings', requireTaxEstimatorWrite, async (req, res) => {
  const input = upsertFirmSettingsSchema.parse(req.body);
  res.json({ data: await firmSettingsService.upsertFirmSettings(getScope(req), actor(req), input) });
});
