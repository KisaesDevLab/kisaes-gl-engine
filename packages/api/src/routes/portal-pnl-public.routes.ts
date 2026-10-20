// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { portalAuthenticate } from '../middleware/portal-auth.js';
import { scopedCompanyId } from '../middleware/peer-auth.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/portal-pnl.service.js';

// Portal live Profit & Loss. Mounted at /api/portal/profit-loss.
// GET-only, so preview ("View as Client") is inherently read-only; the
// helper below just pins preview sessions to their company.

export const portalPnlPublicRouter = Router();
portalPnlPublicRouter.use(portalAuthenticate);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireCompanyId(req: import('express').Request): string {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const companyId = scopedCompanyId(req, req.query['companyId'] as string | undefined);
  if (!companyId || !UUID_RE.test(companyId)) throw AppError.badRequest('companyId required');
  const pc = req.portalContact;
  if (pc.isPreview && pc.previewCompanyId && pc.previewCompanyId !== companyId) {
    throw AppError.forbidden('Preview is scoped to one company');
  }
  return companyId;
}

function intParam(raw: unknown, name: string, def: number, max: number): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) throw AppError.badRequest(`Invalid ${name}`);
  return n;
}

// GET /api/portal/profit-loss?companyId&start_date&end_date
portalPnlPublicRouter.get('/', async (req, res) => {
  const companyId = requireCompanyId(req);
  const { tenantId, contactId } = req.portalContact!;
  await svc.assertProfitLossAccess(tenantId, contactId, companyId);
  const { startDate, endDate } = svc.validateRange(
    req.query['start_date'] as string | undefined,
    req.query['end_date'] as string | undefined,
  );
  res.json(await svc.getPortalProfitAndLoss(tenantId, companyId, startDate, endDate));
});

// GET /api/portal/profit-loss/accounts/:accountId/transactions
//     ?companyId&start_date&end_date&page&perPage
portalPnlPublicRouter.get('/accounts/:accountId/transactions', async (req, res) => {
  const companyId = requireCompanyId(req);
  const { tenantId, contactId } = req.portalContact!;
  await svc.assertProfitLossAccess(tenantId, contactId, companyId);
  const accountId = req.params['accountId']!;
  if (!UUID_RE.test(accountId)) throw AppError.badRequest('Invalid account id');
  const { startDate, endDate } = svc.validateRange(
    req.query['start_date'] as string | undefined,
    req.query['end_date'] as string | undefined,
  );
  res.json(await svc.getPortalAccountTransactions(
    tenantId, companyId, accountId, startDate, endDate,
    intParam(req.query['page'], 'page', 1, 100000),
    intParam(req.query['perPage'], 'perPage', 50, 200),
  ));
});
