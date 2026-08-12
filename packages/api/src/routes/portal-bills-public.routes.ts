// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { portalMarkBillsSchema } from '@kis-books/shared';
import { portalAuthenticate, refuseDuringPreview } from '../middleware/portal-auth.js';
import { AppError } from '../utils/errors.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as flags from '../services/feature-flags.service.js';
import * as billPay from '../services/portal-bill-pay.service.js';

// PORTAL_BILL_PAY_V1 — unpaid-bills list + mark-for-payment. Mounted at
// /api/portal/bills. Marking posts real GL transactions, so the POST is
// preview-refused and rate-limited on top of the flag + per-contact +
// per-company-config gates enforced in the service.

export const portalBillsPublicRouter = Router();
portalBillsPublicRouter.use(portalAuthenticate);

const markLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('portal-bills-mark'),
  message: { error: { message: 'Too many requests. Try again later.' } },
  // Same rationale as expensive-op-limiter.ts: the suite would trip the
  // limit itself, so bypass under NODE_ENV=test. Production unaffected.
  skip: () => process.env['NODE_ENV'] === 'test',
});

function requireCompanyId(req: import('express').Request, companyId: string | undefined): string {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  if (!companyId) throw AppError.badRequest('companyId required');
  const pc = req.portalContact;
  if (pc.isPreview && pc.previewCompanyId && pc.previewCompanyId !== companyId) {
    throw AppError.forbidden('Preview is scoped to one company');
  }
  return companyId;
}

// GET /api/portal/bills?companyId=
portalBillsPublicRouter.get('/', async (req, res) => {
  const companyId = requireCompanyId(req, req.query['companyId'] as string | undefined);
  const { tenantId, contactId } = req.portalContact!;

  const enabled = await flags.isEnabled(tenantId, 'PORTAL_BILL_PAY_V1');
  if (!enabled) {
    res.json({ featureEnabled: false, configured: false, bills: [], queuedPayments: [] });
    return;
  }

  const data = await billPay.listBillsForPortal({ tenantId, contactId, companyId });
  res.json({ featureEnabled: true, ...data });
});

// POST /api/portal/bills/mark  { companyId, billIds }
portalBillsPublicRouter.post('/mark', markLimiter, async (req, res) => {
  refuseDuringPreview(req);

  const parsed = portalMarkBillsSchema.safeParse(req.body);
  if (!parsed.success) {
    throw AppError.badRequest(parsed.error.issues[0]?.message ?? 'Invalid request');
  }
  const companyId = requireCompanyId(req, parsed.data.companyId);
  const { tenantId, contactId } = req.portalContact!;

  const enabled = await flags.isEnabled(tenantId, 'PORTAL_BILL_PAY_V1');
  if (!enabled) throw AppError.forbidden('Feature not enabled', 'FEATURE_DISABLED');

  const result = await billPay.markBillsForPayment(
    { tenantId, contactId, companyId },
    parsed.data.billIds,
  );
  res.json(result);
});
