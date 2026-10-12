// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// State estimate-rule administration (Tax Estimator Phase 2). Super-admin only:
// state rules are global reference data shared by every tenant.

import { Router } from 'express';
import {
  stateRuleYearParamsSchema, stateRuleStateParamsSchema, stateRuleKeyParamsSchema, setStateRuleOverrideSchema,
  adoptShippedStateRulesSchema, stateRuleChangesQuerySchema, verifyStateRuleSchema, verifyAllStateRulesSchema,
} from '@kis-books/shared';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import * as svc from '../services/tax-estimator/tax-state-rules.service.js';

export const taxStateRulesAdminRouter = Router();
taxStateRulesAdminRouter.use(authenticate);
taxStateRulesAdminRouter.use(requireSuperAdmin);

taxStateRulesAdminRouter.get('/:year/summary', async (req, res) => {
  const { year } = stateRuleYearParamsSchema.parse(req.params);
  res.json({ data: await svc.listSummaries(year) });
});

taxStateRulesAdminRouter.get('/:year/diff', async (req, res) => {
  const { year } = stateRuleYearParamsSchema.parse(req.params);
  res.json({ data: { rows: await svc.diffShippedVsProvisional(year) } });
});

taxStateRulesAdminRouter.get('/:year/changes', async (req, res) => {
  stateRuleYearParamsSchema.parse(req.params);
  const { limit } = stateRuleChangesQuerySchema.parse(req.query);
  res.json({ data: { rows: await svc.listChanges(limit) } });
});

taxStateRulesAdminRouter.post('/:year/create-from-prior', async (req, res) => {
  const { year } = stateRuleYearParamsSchema.parse(req.params);
  res.status(201).json({ data: await svc.createYearFromPrior(year, req.userId) });
});

taxStateRulesAdminRouter.post('/:year/adopt-shipped', async (req, res) => {
  const { year } = stateRuleYearParamsSchema.parse(req.params);
  const body = adoptShippedStateRulesSchema.parse(req.body ?? {});
  res.json({ data: await svc.adoptShipped(year, body.keys, req.userId) });
});

// R7 in-app Verify (Kurt's sign-off), per rule and per jurisdiction-year. Registered before
// the generic /:year/:state routes; changes only status + verified_*.
taxStateRulesAdminRouter.post('/:year/:state/verify-all', async (req, res) => {
  const { year, state } = stateRuleStateParamsSchema.parse(req.params);
  const body = verifyAllStateRulesSchema.parse(req.body ?? {});
  res.json({ data: await svc.verifyAllStateRules(year, state, body.note, req.userId) });
});

taxStateRulesAdminRouter.post('/:year/:state/:key/verify', async (req, res) => {
  const { year, state, key } = stateRuleKeyParamsSchema.parse(req.params);
  const body = verifyStateRuleSchema.parse(req.body ?? {});
  res.json({ data: await svc.verifyStateRule(year, state, key, body.note, req.userId) });
});

taxStateRulesAdminRouter.get('/:year/:state', async (req, res) => {
  const { year, state } = stateRuleStateParamsSchema.parse(req.params);
  res.json({ data: await svc.getStateRules(year, state) });
});

taxStateRulesAdminRouter.put('/:year/:state/:key', async (req, res) => {
  const { year, state, key } = stateRuleKeyParamsSchema.parse(req.params);
  const body = setStateRuleOverrideSchema.parse(req.body);
  res.json({ data: await svc.setOverride(year, state, key, body.value, body.reason, req.userId) });
});

taxStateRulesAdminRouter.delete('/:year/:state/:key', async (req, res) => {
  const { year, state, key } = stateRuleKeyParamsSchema.parse(req.params);
  await svc.revertOverride(year, state, key, req.userId);
  res.json({ data: { year, state, key, reverted: true } });
});
