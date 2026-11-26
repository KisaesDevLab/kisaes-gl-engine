// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { Router } from 'express';
import { portalAuthenticate } from '../middleware/portal-auth.js';
import { scopedCompanyId } from '../middleware/peer-auth.js';
import { AppError } from '../utils/errors.js';
import * as flags from '../services/feature-flags.service.js';
import * as svc from '../services/portal-pnl.service.js';

// Portal live Profit & Loss. Mounted at /api/portal/profit-loss.
// GET-only, so preview ("View as Client") is inherently read-only; the
// helper below just pins preview sessions to their company.

export const portalPnlPublicRouter = Router();
portalPnlPublicRouter.use(portalAuthenticate);

function requireCompanyId(req: import('express').Request): string {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const queried = req.query['companyId'];
  const companyId = svc.parseUuid(scopedCompanyId(req, typeof queried === 'string' ? queried : undefined));
  if (!companyId) throw AppError.badRequest('companyId required');
  const pc = req.portalContact;
  if (pc.isPreview && pc.previewCompanyId && pc.previewCompanyId !== companyId) {
    throw AppError.forbidden('Preview is scoped to one company');
  }
  return companyId;
}

function dateParam(raw: unknown): string | undefined {
  return typeof raw === 'string' ? raw : undefined;
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
  const { bankingAccess } = await svc.assertProfitLossAccess(tenantId, contactId, companyId);
  const { startDate, endDate } = svc.validateRange(
    dateParam(req.query['start_date']),
    dateParam(req.query['end_date']),
  );
  // The unposted bank feed memo is bank activity, so it is sent on the
  // same two conditions as the portal banking pages: the firm has portal
  // banking switched on, and this contact has banking access for the
  // company. P&L access alone does not carry it.
  const includeUnpostedBankFeed = bankingAccess && await flags.isEnabled(tenantId, 'PORTAL_BANKING_V1');
  res.json(await svc.getPortalProfitAndLoss(tenantId, companyId, startDate, endDate, {
    includeUnpostedBankFeed,
  }));
});

// GET /api/portal/profit-loss/accounts/:accountId/transactions
//     ?companyId&start_date&end_date&page&perPage
portalPnlPublicRouter.get('/accounts/:accountId/transactions', async (req, res) => {
  const companyId = requireCompanyId(req);
  const { tenantId, contactId } = req.portalContact!;
  await svc.assertProfitLossAccess(tenantId, contactId, companyId);
  const accountId = svc.parseUuid(req.params['accountId']);
  if (!accountId) throw AppError.badRequest('Invalid account id');
  const { startDate, endDate } = svc.validateRange(
    dateParam(req.query['start_date']),
    dateParam(req.query['end_date']),
  );
  res.json(await svc.getPortalAccountTransactions(
    tenantId, companyId, accountId, startDate, endDate,
    intParam(req.query['page'], 'page', 1, 100000),
    intParam(req.query['perPage'], 'perPage', 50, 200),
  ));
});
