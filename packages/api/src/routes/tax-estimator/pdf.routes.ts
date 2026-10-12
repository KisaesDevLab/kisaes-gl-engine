// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { estimateParamsSchema, computeEstimateSchema } from '@kis-books/shared';
import { getScope } from '../../middleware/tax-estimator-scope.js';
import * as estimateService from '../../services/tax-estimator/estimate.service.js';
import * as taxpayersService from '../../services/tax-estimator/taxpayers.service.js';
import * as firmSettingsService from '../../services/tax-estimator/firm-settings.service.js';
import { renderEstimatePdf } from '../../services/tax-estimator/estimate-pdf.service.js';

// Standalone estimate PDF (Phase 11, D15). Mounted by tax-estimator.routes.ts AFTER its guard
// chain (session auth -> client 404 -> flag -> tax_estimator resource -> firm scope). It is a
// read (any firm role): the estimate is computed through the same scoped service as /estimate,
// so a taxpayer or scenario of another firm is a 404 and out-of-scope tenants are left out.
export const pdfRouter = Router();

const slugify = (s: string) => s.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'taxpayer';

pdfRouter.post('/taxpayers/:id/years/:taxYear/scenarios/:scenarioId/pdf', async (req, res) => {
  const { id, taxYear, scenarioId } = estimateParamsSchema.parse(req.params);
  const body = computeEstimateSchema.parse(req.body ?? {});
  const scope = getScope(req);
  const result = await estimateService.computeEstimate(scope, { taxpayerId: id, taxYear, scenarioId, throughMonth: body.throughMonth, refresh: body.refresh });
  const [detail, firm] = await Promise.all([taxpayersService.getTaxpayer(scope, id), firmSettingsService.getFirmSettings(scope)]);
  const bytes = await renderEstimatePdf(result, { taxpayerName: detail.taxpayer.displayName, disclaimer: firm.effectiveDisclaimerText });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="tax-estimate-${taxYear}-${slugify(detail.taxpayer.displayName)}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(bytes));
});
