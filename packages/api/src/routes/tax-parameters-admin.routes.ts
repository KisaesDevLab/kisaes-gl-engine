// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax parameter administration (Tax Estimator Phase 1). Super-admin only:
// parameters are global reference data shared by every tenant, like
// /admin/tb and /admin/feature-flags.

import { Router } from 'express';
import {
  taxParameterYearParamsSchema, taxParameterKeyParamsSchema, setTaxParameterOverrideSchema,
  adoptShippedParametersSchema, taxParameterChangesQuerySchema, verifyTaxParameterSchema, verifyAllTaxParametersSchema,
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

// R7 in-app Verify (Kurt's sign-off): marks the CURRENT value verified, records who / when /
// note and audits it. Changes nothing else; a verified row can still be overridden with a reason.
taxParametersAdminRouter.post('/:year/verify-all', async (req, res) => {
  const { year } = taxParameterYearParamsSchema.parse(req.params);
  const body = verifyAllTaxParametersSchema.parse(req.body ?? {});
  res.json({ data: await svc.verifyAllParameters(year, body.note, req.userId) });
});

taxParametersAdminRouter.post('/:year/:key/verify', async (req, res) => {
  const { year, key } = taxParameterKeyParamsSchema.parse(req.params);
  const body = verifyTaxParameterSchema.parse(req.body ?? {});
  res.json({ data: await svc.verifyParameter(year, key, body.note, req.userId) });
});
