// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { PortalTaxEstimateListDTO } from '@kis-books/shared';
import { portalAuthenticate } from '../middleware/portal-auth.js';
import { scopedCompanyId } from '../middleware/peer-auth.js';
import { AppError } from '../utils/errors.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as flags from '../services/feature-flags.service.js';
import * as portalEstimates from '../services/tax-estimator/portal-estimates.service.js';

// Tax Estimator Phase 13 — read-only client-portal view (MODULE.md "Access", D5, D10;
// UI-SPEC §05). Mounted at /api/portal/tax-estimates. Portal cookie auth only:
//   - CLIENT_PORTAL_V1 and TAX_ESTIMATOR_V1 are checked on the CONTACT's tenant,
//   - the contact must hold portal_contact_companies.tax_estimates_access on a company
//     the taxpayer is linked to, and be mapped to the taxpayer
//     (services/tax-estimator/portal-estimates.service.ts owns the predicate),
//   - Vibe PM peer requests are refused (the peer contract does not include tax
//     estimates), and a "View as Client" preview stays pinned to its company.
// Every miss is a 404 (TE_PORTAL_FORBIDDEN) that does not say why. GET-only.

export const portalTaxEstimatesPublicRouter = Router();
portalTaxEstimatesPublicRouter.use(portalAuthenticate);

const uuid = z.string().uuid();
const querySchema = z.object({
  companyId: uuid.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

// Phase 13 follow-up: the detail and voucher endpoints compute a LIVE estimate (Redis-
// cached, but a cold compute reads every linked company's books). Per portal contact,
// 20 a minute — far above what the page needs (one per taxpayer / year switch).
export const PORTAL_TE_COMPUTE_PER_MINUTE = 20;
const computeLimiter = rateLimit({
  windowMs: 60_000,
  max: PORTAL_TE_COMPUTE_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('portal-tax-estimates'),
  keyGenerator: (req) => (req.portalContact ? `contact:${req.portalContact.contactId}` : `ip:${req.ip || 'unknown'}`),
  message: { error: { message: 'Too many requests. Try again in a minute.', code: 'RATE_LIMIT' } },
  // Off in tests like every portal limiter, unless a test opts in to exercise it.
  skip: () => process.env['NODE_ENV'] === 'test' && process.env['TE_PORTAL_RATE_LIMIT_TEST'] !== '1',
});

const forbidden = () => new AppError(404, 'Tax estimate not found', 'TE_PORTAL_FORBIDDEN');

async function featureOn(tenantId: string): Promise<boolean> {
  const [portal, te] = await Promise.all([
    flags.isEnabled(tenantId, 'CLIENT_PORTAL_V1'),
    flags.isEnabled(tenantId, 'TAX_ESTIMATOR_V1'),
  ]);
  return portal && te;
}

function caller(req: Request): portalEstimates.PortalCaller & { year?: number } {
  const pc = req.portalContact;
  if (!pc) throw AppError.unauthorized('No portal session');
  if (pc.viaPeer || req.peerLink) throw forbidden();
  const q = querySchema.parse(req.query);
  let companyId = scopedCompanyId(req, q.companyId) ?? null;
  if (pc.isPreview && pc.previewCompanyId) {
    if (companyId && companyId !== pc.previewCompanyId) throw AppError.forbidden('Preview is scoped to one company');
    companyId = pc.previewCompanyId;
  }
  return { contactId: pc.contactId, tenantId: pc.tenantId, companyId, year: q.year };
}

// GET /api/portal/tax-estimates?companyId= — the taxpayers this contact may open.
// featureEnabled:false (200) lets the dashboard hide its entry quietly.
portalTaxEstimatesPublicRouter.get('/', async (req, res) => {
  const c = caller(req);
  if (!(await featureOn(c.tenantId))) {
    const body: PortalTaxEstimateListDTO = { featureEnabled: false, taxpayers: [] };
    res.json(body);
    return;
  }
  const body: PortalTaxEstimateListDTO = { featureEnabled: true, taxpayers: await portalEstimates.listForContact(c) };
  res.setHeader('Cache-Control', 'no-store');
  res.json(body);
});

// GET /api/portal/tax-estimates/:taxpayerId?year=&companyId=
portalTaxEstimatesPublicRouter.get('/:taxpayerId', computeLimiter, async (req, res) => {
  const c = caller(req);
  const taxpayerId = uuid.safeParse(req.params['taxpayerId']);
  if (!taxpayerId.success) throw forbidden();
  if (!(await featureOn(c.tenantId))) throw forbidden();
  res.setHeader('Cache-Control', 'no-store');
  res.json(await portalEstimates.getForContact(c, taxpayerId.data, c.year));
});

// GET /api/portal/tax-estimates/:taxpayerId/vouchers.pdf?year=&companyId=
portalTaxEstimatesPublicRouter.get('/:taxpayerId/vouchers.pdf', computeLimiter, async (req, res) => {
  const c = caller(req);
  const taxpayerId = uuid.safeParse(req.params['taxpayerId']);
  if (!taxpayerId.success) throw forbidden();
  if (!(await featureOn(c.tenantId))) throw forbidden();
  const { estimate } = await portalEstimates.getForContact(c, taxpayerId.data, c.year);
  if (!estimate) throw forbidden();
  const bytes = await portalEstimates.renderVouchersPdf(estimate);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="estimated-tax-vouchers-${estimate.taxYear}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(bytes));
});
