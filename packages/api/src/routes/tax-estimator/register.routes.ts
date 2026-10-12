// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { putRegisterTransactionFlagSchema, taxEstRegisterTxnParamsSchema } from '@kis-books/shared';
import { companyContext } from '../../middleware/company.js';
import { getScope, requireTaxEstimatorWrite } from '../../middleware/tax-estimator-scope.js';
import { resolvePackScope } from '../../services/tax-estimator/estimate-documents.service.js';
import * as registerFlags from '../../services/tax-estimator/register-flags.service.js';

// Register / transaction-detail non-recurring flag (R7-07 #2). Mounted by
// tax-estimator.routes.ts at /register AFTER its session / client-404 / flag / resource
// guards and BEFORE its membership-based scope: here the caller works inside a client
// tenant, so the firm is that tenant's managing firm and the tenant must be inside the
// caller's D1 scope (resolvePackScope — the Report Pack section's rule; anything else is
// 404). The company is the active one (X-Company-Id, validated by companyContext).
export const registerRouter = Router();
registerRouter.use(companyContext);
registerRouter.use(async (req, _res, next) => {
  req.taxEstimatorScope = await resolvePackScope(req.tenantId, req.userId, req.isSuperAdmin === true);
  req.firmId = req.taxEstimatorScope.firmId;
  req.firmRole = req.taxEstimatorScope.firmRole;
  next();
});

registerRouter.get('/flags', async (req, res) => {
  res.json({ data: await registerFlags.listCompanyFlags(getScope(req), req.tenantId, req.companyId) });
});

registerRouter.get('/transactions/:transactionId', async (req, res) => {
  const { transactionId } = taxEstRegisterTxnParamsSchema.parse(req.params);
  res.json({ data: await registerFlags.getTransactionFlag(getScope(req), req.tenantId, req.companyId, transactionId) });
});

registerRouter.put('/transactions/:transactionId', requireTaxEstimatorWrite, async (req, res) => {
  const { transactionId } = taxEstRegisterTxnParamsSchema.parse(req.params);
  const { nonRecurring } = putRegisterTransactionFlagSchema.parse(req.body);
  res.json({ data: await registerFlags.setTransactionFlag(getScope(req), req.tenantId, req.companyId, transactionId, nonRecurring, req.userId) });
});
