// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q51 — per-portal-contact Tax Estimator view options (OPEN-QUESTIONS Q51). A PUT sends only
// the sections it changes; absent keys keep their stored value. Turning a section ON is a
// grant (Tax Estimator gates), OFF a revoke (any staff who manage the contact; Q41(7)).
import { z } from 'zod';

export const portalContactTaxOptionsSchema = z.object({
  calculationSummary: z.boolean().optional(),
  quarterlyEstimates: z.boolean().optional(),
  paymentsOnRecord: z.boolean().optional(),
  pdfDownload: z.boolean().optional(),
}).strict().refine((v) => Object.values(v).some((x) => x !== undefined), { message: 'Nothing to update' });
export type PortalContactTaxOptionsInput = z.infer<typeof portalContactTaxOptionsSchema>;

/** GET /api/portal/tax-estimates/:taxpayerId — Q51 adds an optional scenario pick. */
export const portalTaxEstimateQuerySchema = z.object({
  companyId: z.string().uuid().optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  scenarioId: z.string().uuid().optional(),
});
