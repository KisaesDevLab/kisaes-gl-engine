// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { portalTaxEstimateQuerySchema, type PortalTaxEstimateListDTO } from '@kis-books/shared';
import { auditLog } from '../middleware/audit.js';
import { portalAuthenticate } from '../middleware/portal-auth.js';
import { scopedCompanyId } from '../middleware/peer-auth.js';
import { AppError } from '../utils/errors.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as flags from '../services/feature-flags.service.js';
import * as portalEstimates from '../services/tax-estimator/portal-estimates.service.js';
import { resolvePackScopeForUser } from '../services/tax-estimator/estimate-documents.service.js';

// Tax Estimator Phase 13 — read-only client-portal view (MODULE.md "Access", D5, D10;
// UI-SPEC §05). Mounted at /api/portal/tax-estimates. Portal cookie auth only:
//   - CLIENT_PORTAL_V1 and TAX_ESTIMATOR_V1 are checked on the CONTACT's tenant,
//   - the contact must hold portal_contact_companies.tax_estimates_access on a company
//     the taxpayer is linked to, and be mapped to the taxpayer
//     (services/tax-estimator/portal-estimates.service.ts owns the predicate),
//   - Vibe PM peer requests are refused (the peer contract does not include tax
//     estimates), and a "View as Client" preview stays pinned to its company.
//   - R4-02: a "View as Client" preview substitutes a STAFF initiator for the contact,
//     so the initiator must pass the same Tax Estimator gates as the staff side
//     (active, not a client user, the tax_estimator resource in the contact's tenant,
//     member of its managing firm or super admin, flag on, tenant in D1 scope —
//     resolvePackScopeForUser). Otherwise the preview sees featureEnabled:false / 404.
//   - Q51: per-contact options (tax_est_portal_contact_options) decide which sections the
//     detail carries; disabled sections are ABSENT from the JSON, the voucher PDF needs
//     quarterly_estimates, the portal-safe estimate PDF pdf_download, and a scenario the firm did
//     not share is the same 404.
// Every miss is a 404 (TE_PORTAL_FORBIDDEN) that does not say why. GET-only.

export const portalTaxEstimatesPublicRouter = Router();
portalTaxEstimatesPublicRouter.use(portalAuthenticate);

const uuid = z.string().uuid();
// Q51: ?scenarioId= picks a shared scenario (Base when absent). A malformed id is the uniform 404.
const querySchema = portalTaxEstimateQuerySchema;

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

function caller(req: Request): portalEstimates.PortalCaller & { year?: number; scenarioId?: string } {
  const pc = req.portalContact;
  if (!pc) throw AppError.unauthorized('No portal session');
  if (pc.viaPeer || req.peerLink) throw forbidden();
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) throw forbidden();
  const q = parsed.data;
  let companyId = scopedCompanyId(req, q.companyId) ?? null;
  if (pc.isPreview && pc.previewCompanyId) {
    // R4-07: the uniform 404, not a 403 that says why.
    if (companyId && companyId !== pc.previewCompanyId) throw forbidden();
    companyId = pc.previewCompanyId;
  }
  return { contactId: pc.contactId, tenantId: pc.tenantId, companyId, year: q.year, scenarioId: q.scenarioId };
}

/**
 * Flags on the contact's tenant AND, in a "View as Client" preview, the initiating staff
 * user passes the Tax Estimator gates there (R4-02). A preview without an initiator is refused.
 */
async function available(req: Request, tenantId: string): Promise<boolean> {
  if (!(await featureOn(tenantId))) return false;
  const pc = req.portalContact;
  if (!pc?.isPreview) return true;
  if (!pc.previewInitiatorId) return false;
  try {
    await resolvePackScopeForUser(tenantId, pc.previewInitiatorId);
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) return false;
    throw err;
  }
}

// GET /api/portal/tax-estimates?companyId= — the taxpayers this contact may open.
// featureEnabled:false (200) lets the dashboard hide its entry quietly.
portalTaxEstimatesPublicRouter.get('/', async (req, res) => {
  const c = caller(req);
  res.setHeader('Cache-Control', 'no-store');
  if (!(await available(req, c.tenantId))) {
    const body: PortalTaxEstimateListDTO = { featureEnabled: false, taxpayers: [] };
    res.json(body);
    return;
  }
  const body: PortalTaxEstimateListDTO = { featureEnabled: true, taxpayers: await portalEstimates.listForContact(c) };
  res.json(body);
});

// GET /api/portal/tax-estimates/:taxpayerId?year=&companyId=
portalTaxEstimatesPublicRouter.get('/:taxpayerId', computeLimiter, async (req, res) => {
  const c = caller(req);
  const taxpayerId = uuid.safeParse(req.params['taxpayerId']);
  if (!taxpayerId.success) throw forbidden();
  if (!(await available(req, c.tenantId))) throw forbidden();
  res.setHeader('Cache-Control', 'no-store');
  // Q51: the response carries only the sections this contact's options allow (a "View as
  // Client" preview runs as the previewed contact, so it shows that contact's options).
  res.json(await portalEstimates.getForContact(c, taxpayerId.data, c.year, {}, { scenarioId: c.scenarioId }));
});

// GET /api/portal/tax-estimates/:taxpayerId/vouchers.pdf?year=&companyId=
portalTaxEstimatesPublicRouter.get('/:taxpayerId/vouchers.pdf', computeLimiter, async (req, res) => {
  const c = caller(req);
  const taxpayerId = uuid.safeParse(req.params['taxpayerId']);
  if (!taxpayerId.success) throw forbidden();
  if (!(await available(req, c.tenantId))) throw forbidden();
  const r = await portalEstimates.resolveForContact(c, taxpayerId.data, c.year, {}, { scenarioId: c.scenarioId });
  // Q51: vouchers are part of the quarterly-estimates section.
  if (!r.full || !r.options.quarterlyEstimates) throw forbidden();
  const estimate = r.full;
  const bytes = await portalEstimates.renderVouchersPdf(estimate);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="estimated-tax-vouchers-${estimate.taxYear}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(bytes));
});

// GET /api/portal/tax-estimates/:taxpayerId/estimate.pdf?year=&companyId=&scenarioId=
// Q51: the PORTAL-SAFE estimate PDF, only when the contact's `pdf_download` option is on. It
// is rendered from the same option-filtered DTO the JSON carries (never the engine result), so
// it shows exactly what this contact may see. Every download is audited on the contact's
// tenant (tax_est_portal_pdf).
portalTaxEstimatesPublicRouter.get('/:taxpayerId/estimate.pdf', computeLimiter, async (req, res) => {
  const c = caller(req);
  const taxpayerId = uuid.safeParse(req.params['taxpayerId']);
  if (!taxpayerId.success) throw forbidden();
  if (!(await available(req, c.tenantId))) throw forbidden();
  const r = await portalEstimates.resolveForContact(c, taxpayerId.data, c.year, {}, { scenarioId: c.scenarioId });
  if (!r.options.pdfDownload || !r.result || !r.response.estimate) throw forbidden();
  const pdf = await portalEstimates.renderPortalSafePdf(r);
  const pc = req.portalContact!;
  await auditLog(c.tenantId, 'download', 'tax_est_portal_pdf', taxpayerId.data, null, {
    portalContactId: c.contactId, taxYear: r.result.taxYear, scenarioId: r.scenarioId, source: r.snapshot ? 'snapshot' : 'live',
    snapshotId: r.snapshot?.id ?? null, inputsHash: r.result.inputsHash, engineVersion: r.result.engineVersion, computedAt: r.result.computedAt,
    preview: pc.isPreview === true,
  }, pc.isPreview ? pc.previewInitiatorId : undefined);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename.replace(/["\\\r\n]/g, '')}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(pdf.bytes));
});
