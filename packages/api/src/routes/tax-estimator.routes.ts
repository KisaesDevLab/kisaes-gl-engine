// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { authenticate, requireSessionAuth } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { requireFeatureFlag } from '../middleware/feature-flag.js';
import { resolveTaxEstimatorScope, getScope } from '../middleware/tax-estimator-scope.js';
import { AppError } from '../utils/errors.js';
import { taxpayersRouter } from './tax-estimator/taxpayers.routes.js';
import { entitiesRouter } from './tax-estimator/entities.routes.js';
import { taxParameterYearParamsSchema } from '@kis-books/shared';
import * as taxParametersService from '../services/tax-estimator/tax-parameters.service.js';

// Tax Estimator staff router (features/tax-estimator/MODULE.md).
//
// Guard order matters and is pinned by tax-estimator.routes.test.ts:
//   authenticate → session-only (API keys are single-tenant; this module
//   reads across tenants) → client user_type 404 (TB13 pattern) → flag →
//   resource permission → firm + allowed-tenant scope.
// The flag is evaluated on the caller's ACTIVE tenant like every other module,
// so enable TAX_ESTIMATOR_V1 on the firm's practice tenant(s).
export const taxEstimatorRouter = Router();
taxEstimatorRouter.use(authenticate);
taxEstimatorRouter.use(requireSessionAuth);
taxEstimatorRouter.use((req, _res, next) => {
  if (req.userType === 'client') {
    next(AppError.notFound('Feature not available'));
    return;
  }
  next();
});
taxEstimatorRouter.use(requireFeatureFlag('TAX_ESTIMATOR_V1'));
taxEstimatorRouter.use(requireResource('tax_estimator'));
taxEstimatorRouter.use(resolveTaxEstimatorScope);

// GET /scope — who am I acting as. Counts only; ids stay server-side.
taxEstimatorRouter.get('/scope', (req, res) => {
  const scope = getScope(req);
  res.json({
    data: { firmId: scope.firmId, firmRole: scope.firmRole, managedTenantCount: scope.allowedTenantIds.length },
  });
});

// GET /parameters/:year — effective federal parameters for a tax year (read-only
// for every firm member who passes the guard chain above).
taxEstimatorRouter.get('/parameters/:year', async (req, res) => {
  const { year } = taxParameterYearParamsSchema.parse(req.params);
  res.json({ data: await taxParametersService.getParameters(year) });
});

taxEstimatorRouter.use('/taxpayers', taxpayersRouter);
taxEstimatorRouter.use('/entities', entitiesRouter);
