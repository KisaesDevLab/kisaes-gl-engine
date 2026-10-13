-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Q44 part: dependents (Kurt, 2026-10-13: "the number of dependents by age
-- grouping"; OPEN-QUESTIONS.md Q44). Shipped as its OWN migration 0204_tax_est_dependents
-- because 0201-0203 are applied in production. Additive only.
--
-- 1. Dependents per taxpayer. Scoped exactly like tax_est_persons: through the taxpayer
--    (taxpayer_id -> tax_est_taxpayers.firm_id), ON DELETE CASCADE, read and written only
--    through the firm + D17/D18 visibility checks of the taxpayer. NO SSN is stored.
--    The engine computes ages at Dec 31 of the tax year from date_of_birth.
CREATE TABLE IF NOT EXISTS tax_est_dependents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  display_name VARCHAR(120) NOT NULL,
  date_of_birth DATE NOT NULL,
  relationship VARCHAR(20) NOT NULL DEFAULT 'other'
    CHECK (relationship IN ('son', 'daughter', 'stepchild', 'foster_child', 'grandchild', 'sibling', 'niece_nephew', 'parent', 'grandparent', 'other_relative', 'other')),
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('qualifying_child', 'qualifying_relative')),
  months_lived_with SMALLINT CHECK (months_lived_with IS NULL OR (months_lived_with BETWEEN 0 AND 12)),
  is_student BOOLEAN NOT NULL DEFAULT FALSE,
  is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  first_tax_year INTEGER,
  last_tax_year INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_tax_est_dependents_years CHECK (first_tax_year IS NULL OR last_tax_year IS NULL OR last_tax_year >= first_tax_year)
);
CREATE INDEX IF NOT EXISTS idx_tax_est_dependents_taxpayer ON tax_est_dependents (taxpayer_id);

-- 2. Child and dependent care expenses paid (Form 2441), per taxpayer-year, next to the
--    manual credits. Existing rows get 0 (no credit) — estimates are unchanged.
ALTER TABLE tax_est_years ADD COLUMN IF NOT EXISTS care_expenses NUMERIC(19,4) NOT NULL DEFAULT 0;
