// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax parameter administration (Tax Estimator Phase 1). Super-admin only:
// parameters are global reference data shared by every tenant, like
// /admin/tb and /admin/feature-flags.

import { Router } from 'express';
import {
  taxParameterYearParamsSchema, taxParameterKeyParamsSchema, setTaxParameterOverrideSchema,
  adoptShippedParametersSchema, taxParameterChangesQuerySchema,
} from '@kis-books/shared';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import * as svc from '../services/tax-estimator/tax-parameters.service.js';

export const taxParametersAdminRouter = Router();
taxParametersAdminRouter.use(authenticate);
taxParametersAdminRouter.use(requireSuperAdmin);

taxParametersAdminRouter.get('/years', async (_req, res) => {
  res.json({ data: await svc.getYears() });
});

taxParametersAdminRouter.get('/:year', async (req, res) => {
  const { year } = taxParameterYearParamsSchema.parse(req.params);
  res.json({ data: await svc.getParameters(year) });
});

taxParametersAdminRouter.put('/:year/:key', async (req, res) => {
  const { year, key } = taxParameterKeyParamsSchema.parse(req.params);
  const body = setTaxParameterOverrideSchema.parse(req.body);
  res.json({ data: await svc.setOverride(year, key, body.value, body.reason, req.userId) });
});

taxParametersAdminRouter.delete('/:year/:key', async (req, res) => {
  const { year, key } = taxParameterKeyParamsSchema.parse(req.params);
  await svc.revertOverride(year, key, req.userId);
  res.json({ data: { year, key, reverted: true } });
});

taxParametersAdminRouter.post('/:year/create-from-prior', async (req, res) => {
  const { year } = taxParameterYearParamsSchema.parse(req.params);
  res.status(201).json({ data: await svc.createYearFromPrior(year, req.userId) });
});

taxParametersAdminRouter.get('/:year/diff', async (req, res) => {
  const { year } = taxParameterYearParamsSchema.parse(req.params);
  res.json({ data: { rows: await svc.diffShippedVsProvisional(year) } });
});

taxParametersAdminRouter.post('/:year/adopt-shipped', async (req, res) => {
  const { year } = taxParameterYearParamsSchema.parse(req.params);
  const body = adoptShippedParametersSchema.parse(req.body ?? {});
  res.json({ data: await svc.adoptShipped(year, body.keys, req.userId) });
});

taxParametersAdminRouter.get('/:year/changes', async (req, res) => {
  taxParameterYearParamsSchema.parse(req.params);
  const { limit } = taxParameterChangesQuerySchema.parse(req.query);
  res.json({ data: { rows: await svc.listChanges(limit) } });
});
