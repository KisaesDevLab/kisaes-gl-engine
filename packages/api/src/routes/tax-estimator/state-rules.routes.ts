// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { stateRuleYearParamsSchema, stateRuleStateParamsSchema } from '@kis-books/shared';
import * as svc from '../../services/tax-estimator/tax-state-rules.service.js';

// Read-only state estimate rules for firm staff. Mounted under the guarded
// taxEstimatorRouter, so the whole guard chain (session, client 404, flag,
// resource, firm scope) is inherited; nothing here re-checks it.
export const stateRulesRouter = Router();

stateRulesRouter.get('/:year', async (req, res) => {
  const { year } = stateRuleYearParamsSchema.parse(req.params);
  res.json({ data: await svc.listSummaries(year) });
});

stateRulesRouter.get('/:year/:state', async (req, res) => {
  const { year, state } = stateRuleStateParamsSchema.parse(req.params);
  res.json({ data: await svc.getStateRules(year, state) });
});
