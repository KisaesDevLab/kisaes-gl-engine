// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Portal bank-login repair, mounted at /api/portal/banking/connections
// (before the read-only banking router). Cookie auth, no JWT.
//
// Guard stack, in this order, on every route:
//   1. portalAuthenticate          (router level)
//   2. refuseDuringPreview         (router level, every non-GET — "View as
//                                   Client" must never mint a Link token)
//   3. requireCompanyId            pins a preview session to its company
//   4. PORTAL_BANKING_V1 flag      GET self-hides; writes are refused
//   5. assertBankRepairAccess      the per-contact grant + tenant join
//   6. item ∈ company              inside the service (the accounts walk)

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { portalAuthenticate, refuseDuringPreview } from '../middleware/portal-auth.js';
import { scopedCompanyId, portalLimiterKey } from '../middleware/peer-auth.js';
import { AppError } from '../utils/errors.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as flags from '../services/feature-flags.service.js';
import * as repair from '../services/portal-bank-repair.service.js';

export const portalBankRepairPublicRouter = Router();
portalBankRepairPublicRouter.use(portalAuthenticate);
portalBankRepairPublicRouter.use((req, _res, next) => {
  if (req.method !== 'GET') refuseDuringPreview(req);
  next();
});

// Plaid-touching writes: match the public repair-invite limiter (10/min).
const plaidLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('portal-bank-repair'),
  keyGenerator: portalLimiterKey,
  message: { error: { message: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' } },
  skip: () => process.env['NODE_ENV'] === 'test',
});

function requireCompanyId(req: import('express').Request): string {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const raw = (req.query['companyId'] ?? (req.body as Record<string, unknown> | undefined)?.['companyId']) as string | undefined;
  const companyId = z.string().uuid().safeParse(scopedCompanyId(req, raw));
  if (!companyId.success) throw AppError.badRequest('companyId required');
  const pc = req.portalContact;
  if (pc.isPreview && pc.previewCompanyId && pc.previewCompanyId !== companyId.data) {
    throw AppError.forbidden('Preview is scoped to one company');
  }
  return companyId.data;
}

const itemParam = z.string().uuid();

// GET /api/portal/banking/connections?companyId=
portalBankRepairPublicRouter.get('/', async (req, res) => {
  const companyId = requireCompanyId(req);
  const { tenantId, contactId } = req.portalContact!;
  if (!(await flags.isEnabled(tenantId, 'PORTAL_BANKING_V1'))) {
    res.json({ featureEnabled: false, connections: [] });
    return;
  }
  await repair.assertBankRepairAccess(tenantId, contactId, companyId);
  const connections = await repair.listCompanyConnections(tenantId, companyId);
  res.json({ featureEnabled: true, connections });
});

// POST /api/portal/banking/connections/:plaidItemId/link-token  { companyId }
portalBankRepairPublicRouter.post('/:plaidItemId/link-token', plaidLimiter, async (req, res) => {
  refuseDuringPreview(req);
  const companyId = requireCompanyId(req);
  const { tenantId, contactId } = req.portalContact!;
  if (!(await flags.isEnabled(tenantId, 'PORTAL_BANKING_V1'))) throw AppError.forbidden('Feature not enabled', 'FEATURE_DISABLED');
  await repair.assertBankRepairAccess(tenantId, contactId, companyId);
  const plaidItemId = itemParam.parse(req.params['plaidItemId']);
  res.json(await repair.createRepairLinkToken(tenantId, contactId, companyId, plaidItemId));
});

// POST /api/portal/banking/connections/:plaidItemId/repair-complete  { companyId }
portalBankRepairPublicRouter.post('/:plaidItemId/repair-complete', plaidLimiter, async (req, res) => {
  refuseDuringPreview(req);
  const companyId = requireCompanyId(req);
  const { tenantId, contactId } = req.portalContact!;
  if (!(await flags.isEnabled(tenantId, 'PORTAL_BANKING_V1'))) throw AppError.forbidden('Feature not enabled', 'FEATURE_DISABLED');
  await repair.assertBankRepairAccess(tenantId, contactId, companyId);
  const plaidItemId = itemParam.parse(req.params['plaidItemId']);
  res.json(await repair.completeRepair(tenantId, contactId, companyId, plaidItemId));
});
