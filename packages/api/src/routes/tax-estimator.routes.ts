// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { authenticate, requireSessionAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permission.js';
import { requireFeatureFlag } from '../middleware/feature-flag.js';
import { resolveTaxEstimatorScope, getScope } from '../middleware/tax-estimator-scope.js';
import { AppError } from '../utils/errors.js';
import { taxpayersRouter } from './tax-estimator/taxpayers.routes.js';
import { entitiesRouter } from './tax-estimator/entities.routes.js';
import { stateRulesRouter } from './tax-estimator/state-rules.routes.js';
import { yearsRouter } from './tax-estimator/years.routes.js';
import { estimateRouter } from './tax-estimator/estimate.routes.js';
import { pdfRouter } from './tax-estimator/pdf.routes.js';
import { registerRouter } from './tax-estimator/register.routes.js';
import { taxParameterYearParamsSchema } from '@kis-books/shared';
import * as taxParametersService from '../services/tax-estimator/tax-parameters.service.js';

// Tax Estimator staff router (features/tax-estimator/MODULE.md).
//
// Guard order matters and is pinned by tax-estimator.routes.test.ts:
//   authenticate → session-only (API keys are single-tenant; this module
//   reads across tenants) → client user_type 404 (TB13 pattern) → flag →
//   resource permission (method-inferred; POST /estimate and /pdf are reads) → firm +
//   allowed-tenant scope.
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
// R3-07: the resource check infers read/write from the method EXCEPT for the two POSTs
// that are reads (compute an estimate, print the estimate PDF): a member whose
// active-tenant role is `readonly` may use them, like every GET. Mutations additionally
// pass requireTaxEstimatorWrite (firm role).
const READ_POSTS: readonly RegExp[] = [
  /^\/taxpayers\/[^/]+\/years\/[^/]+\/scenarios\/[^/]+\/(estimate|pdf)\/?$/,
];
const readGuard = requirePermission('tax_estimator', 'read');
const writeGuard = requirePermission('tax_estimator', 'update');
taxEstimatorRouter.use((req, res, next) => {
  const isRead = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
    || (req.method === 'POST' && READ_POSTS.some((re) => re.test(req.path)));
  return (isRead ? readGuard : writeGuard)(req, res, next);
});
// Register / transaction-detail flag: same guards as above, but the firm is the ACTIVE
// tenant's managing firm (the caller is working inside a client), so it resolves its own
// scope instead of the membership/X-Firm-Id one below.
taxEstimatorRouter.use('/register', registerRouter);
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
taxEstimatorRouter.use('/state-rules', stateRulesRouter);
taxEstimatorRouter.use('/', yearsRouter);
taxEstimatorRouter.use('/', estimateRouter);
taxEstimatorRouter.use('/', pdfRouter);
