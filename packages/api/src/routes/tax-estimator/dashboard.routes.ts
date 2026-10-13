// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q52 — firm-wide dashboard cards ("Vouchers due in the next 30 days",
// "Behind on payments"), shown on the Tax Estimator home (taxpayer list). Rides the staff
// router's full guard chain (session → client 404 → flag → tax_estimator permission → firm
// scope); every taxpayer passes `visibleTaxpayerFilter` (D17 / D18).
import { Router } from 'express';
import { yearParamsSchema } from '@kis-books/shared';
import { getScope } from '../../middleware/tax-estimator-scope.js';
import * as cards from '../../services/tax-estimator/dashboard-cards.service.js';

export const dashboardRouter = Router();

// GET /dashboard — `data` is null when the caller sees no active taxpayer (cards hidden).
dashboardRouter.get('/dashboard', async (req, res) => {
  res.json({ data: await cards.firmDashboard(getScope(req)) });
});

// POST /dashboard/taxpayers/:id/years/:taxYear/refresh — a live compute of the Base scenario
// (a read, like POST .../estimate: R3-07), which stores the summary the cards read.
dashboardRouter.post('/dashboard/taxpayers/:id/years/:taxYear/refresh', async (req, res) => {
  const { id, taxYear } = yearParamsSchema.parse(req.params);
  res.json({ data: await cards.refreshFirmCard(getScope(req), id, taxYear) });
});
