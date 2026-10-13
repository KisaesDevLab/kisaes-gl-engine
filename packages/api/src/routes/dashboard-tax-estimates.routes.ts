// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q52 — company-dashboard cards (OPEN-QUESTIONS.md Q52), mounted under
// /api/v1/dashboard/tax-estimates by dashboard.routes.ts (authenticate + dashboard:read).
//
// Audience, decided server-side per request (services/tax-estimator/dashboard-cards.service.ts):
//   interactive session only (API keys / download tokens → hidden) and TAX_ESTIMATOR_V1 ON for
//   the ACTIVE tenant (the company's), then
//   staff — the Report Pack gate (`taxEstimateReportScope`: not a client user, `tax_estimator`
//           read, member of the firm managing this tenant, tenant inside their D1 scope);
//   owner — otherwise, the active-tenant role `owner` (portal-style data for the taxpayers they
//           personally are);
//   anyone else — `{ data: null }`, the same answer as "flag off" or "nothing linked".
import { Router, type Request } from 'express';
import { z } from 'zod';
import { companyContext } from '../middleware/company.js';
import { taxEstimateReportScope } from '../middleware/tax-estimator-scope.js';
import * as flags from '../services/feature-flags.service.js';
import * as cards from '../services/tax-estimator/dashboard-cards.service.js';
import type { FirmScope } from '../services/tax-estimator/firm-scope.service.js';
import { taxpayerNotFound } from '../services/tax-estimator/year-access.js';

export const dashboardTaxEstimatesRouter = Router();
dashboardTaxEstimatesRouter.use(companyContext);

type Audience = { kind: 'staff'; scope: FirmScope } | { kind: 'owner' } | null;

async function audience(req: Request): Promise<Audience> {
  if (req.authKind && req.authKind !== 'session') return null;
  if (!(await flags.isEnabled(req.tenantId, 'TAX_ESTIMATOR_V1'))) return null;
  const scope = await taxEstimateReportScope(req);
  if (scope) return { kind: 'staff', scope };
  if (req.userRole === 'owner') return { kind: 'owner' };
  return null;
}

// GET /api/v1/dashboard/tax-estimates — the cards for the active company, or null (hidden).
dashboardTaxEstimatesRouter.get('/', async (req, res) => {
  const who = await audience(req);
  if (!who) { res.json({ data: null }); return; }
  const data = who.kind === 'staff'
    ? await cards.companyCardsForStaff(who.scope, req.tenantId, req.companyId)
    : await cards.companyCardsForOwner(req.userId, req.tenantId, req.companyId);
  res.json({ data });
});

const refreshParams = z.object({ taxpayerId: z.string().uuid() });

// POST /api/v1/dashboard/tax-estimates/:taxpayerId/refresh — staff only: one live compute of the
// taxpayer's Base scenario (it must be linked to this company and visible to the caller), then
// its card. Everyone else gets the uniform taxpayer 404.
dashboardTaxEstimatesRouter.post('/:taxpayerId/refresh', async (req, res) => {
  const parsed = refreshParams.safeParse(req.params);
  const who = await audience(req);
  if (!parsed.success || !who || who.kind !== 'staff') throw taxpayerNotFound();
  res.json({ data: await cards.refreshCompanyCard(who.scope, req.tenantId, req.companyId, parsed.data.taxpayerId) });
});
