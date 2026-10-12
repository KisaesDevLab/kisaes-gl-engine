-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Phase 13 part: Report Pack `tax-estimate` section (D15). Assembled
-- AFTER the snapshots part. Additive only. The pack worker has no request, so a run
-- records WHO asked and whether they passed the Tax Estimator gates (client 404,
-- TAX_ESTIMATOR_V1, tax_estimator resource, firm membership) when it was created; the
-- worker re-derives the firm scope from requested_by at render time (D1), so access
-- removed in between still drops the section. The portal grant
-- portal_contact_companies.tax_estimates_access ships in the Phase 3 part.
ALTER TABLE report_pack_runs ADD COLUMN IF NOT EXISTS requested_by UUID;
ALTER TABLE report_pack_runs ADD COLUMN IF NOT EXISTS allow_tax_estimate BOOLEAN NOT NULL DEFAULT FALSE;
