-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Q51 part: what the client portal shows (Kurt, 2026-10-13: "For portal view of
-- tax estimates, add options to define what is available to view such as calculation summary,
-- to show quarterly estimates, whether scenarios are available to view"; OPEN-QUESTIONS.md Q51).
-- Shipped as its OWN migration 0211_tax_est_portal_options (0209 / 0210 are taken by parallel
-- branches; renumber at merge if needed, D6). Additive only.
--
-- 1. One row per PORTAL CONTACT (applies to every taxpayer the contact can open). No row =
--    the defaults below = exactly the portal view before Q51 (installments + payments on,
--    calculation summary + PDF download off), so existing contacts are unchanged.
CREATE TABLE IF NOT EXISTS tax_est_portal_contact_options (
  portal_contact_id UUID PRIMARY KEY REFERENCES portal_contacts(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  calculation_summary BOOLEAN NOT NULL DEFAULT false,
  quarterly_estimates BOOLEAN NOT NULL DEFAULT true,
  payments_on_record BOOLEAN NOT NULL DEFAULT true,
  pdf_download BOOLEAN NOT NULL DEFAULT false,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_est_portal_contact_options_tenant ON tax_est_portal_contact_options (tenant_id);

-- 2. Scenarios staff share in the portal (Base is always shown while the portal is on;
--    existing what-if scenarios stay private).
ALTER TABLE tax_est_scenarios ADD COLUMN IF NOT EXISTS show_in_portal BOOLEAN NOT NULL DEFAULT false;
