// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { portalAuthenticate } from '../middleware/portal-auth.js';
import { AppError } from '../utils/errors.js';
import * as flags from '../services/feature-flags.service.js';
import * as banking from '../services/portal-banking.service.js';

// PORTAL_BANKING_V1 — read-only book balances + sanitized registers
// for checking/credit-card accounts. Mounted at /api/portal/banking.
// GET-only, so preview ("View as Client") is inherently read-only; the
// preview guard below just pins preview sessions to their company.

export const portalBankingPublicRouter = Router();
portalBankingPublicRouter.use(portalAuthenticate);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireCompanyId(req: import('express').Request): string {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const companyId = req.query['companyId'] as string | undefined;
  if (!companyId) throw AppError.badRequest('companyId required');
  const pc = req.portalContact;
  if (pc.isPreview && pc.previewCompanyId && pc.previewCompanyId !== companyId) {
    throw AppError.forbidden('Preview is scoped to one company');
  }
  return companyId;
}

function parsePositiveInt(raw: unknown, name: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw AppError.badRequest(`Invalid ${name}`);
  return n;
}

function parseDate(raw: unknown, name: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !DATE_RE.test(raw)) throw AppError.badRequest(`Invalid ${name}`);
  return raw;
}

// GET /api/portal/banking/accounts?companyId=
portalBankingPublicRouter.get('/accounts', async (req, res) => {
  const companyId = requireCompanyId(req);
  const { tenantId, contactId } = req.portalContact!;

  const enabled = await flags.isEnabled(tenantId, 'PORTAL_BANKING_V1');
  if (!enabled) {
    // Dashboard hides the section silently on featureEnabled:false.
    res.json({ featureEnabled: false, accounts: [] });
    return;
  }
  await banking.assertBankingAccess(tenantId, contactId, companyId);

  const accounts = await banking.listPortalBankAccounts(tenantId, companyId);
  res.json({
    featureEnabled: true,
    asOf: new Date().toISOString().split('T')[0],
    accounts,
  });
});

// GET /api/portal/banking/accounts/:accountId/register
//     ?companyId&startDate&endDate&search&page&perPage
portalBankingPublicRouter.get('/accounts/:accountId/register', async (req, res) => {
  const companyId = requireCompanyId(req);
  const { tenantId, contactId } = req.portalContact!;

  const enabled = await flags.isEnabled(tenantId, 'PORTAL_BANKING_V1');
  if (!enabled) throw AppError.forbidden('Feature not enabled', 'FEATURE_DISABLED');
  await banking.assertBankingAccess(tenantId, contactId, companyId);

  const search = req.query['search'] as string | undefined;
  const register = await banking.getPortalRegister(tenantId, companyId, req.params['accountId']!, {
    startDate: parseDate(req.query['startDate'], 'startDate'),
    endDate: parseDate(req.query['endDate'], 'endDate'),
    search: search && search.trim() !== '' ? search.trim() : undefined,
    page: parsePositiveInt(req.query['page'], 'page'),
    perPage: parsePositiveInt(req.query['perPage'], 'perPage'),
  });
  res.json({ featureEnabled: true, ...register });
});
