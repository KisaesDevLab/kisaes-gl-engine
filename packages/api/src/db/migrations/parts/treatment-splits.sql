-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Q50 part: owner splits on person-target treatments (Kurt, 2026-10-13: the
-- "Salaries - Officers" W-2 wages / >2% shareholder health / retirement / guaranteed payment /
-- estimated-tax payment accounts may be shared between the owners linked to the business, by %
-- or by fixed annual $; OPEN-QUESTIONS.md Q50). Shipped as its OWN migration
-- 0210_tax_est_treatment_splits (0209 is reserved by the entity-type override branch). Additive only.
--
-- No split rows = the treatment's single payment_person_id / payment_taxpayer_id takes 100%,
-- so every treatment saved before Q50 computes exactly as before (no data migration).
ALTER TABLE tax_est_account_treatments ADD COLUMN IF NOT EXISTS split_mode VARCHAR(10) NOT NULL DEFAULT 'pct'
  CONSTRAINT chk_tax_est_account_treatments_split_mode CHECK (split_mode IN ('pct', 'amount'));

CREATE TABLE IF NOT EXISTS tax_est_account_treatment_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  treatment_id UUID NOT NULL REFERENCES tax_est_account_treatments(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  company_id UUID NOT NULL,
  -- Like the treatment's own payment_* targets: a deleted taxpayer / person leaves the row
  -- (the provider warns TE_OWNER_PERSON_MISSING / TE_PAYMENT_ACCOUNT_UNASSIGNED).
  taxpayer_id UUID REFERENCES tax_est_taxpayers(id) ON DELETE SET NULL,
  person_id UUID REFERENCES tax_est_persons(id) ON DELETE SET NULL,
  pct NUMERIC(9,6) CHECK (pct IS NULL OR (pct > 0 AND pct <= 100)),
  amount NUMERIC(19,4) CHECK (amount IS NULL OR amount >= 0),
  tax_year INTEGER CHECK (tax_year IS NULL OR tax_year BETWEEN 2000 AND 2100),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- pct row XOR amount row (amount rows carry their tax year).
  CONSTRAINT chk_tax_est_treatment_splits_shape
    CHECK ((pct IS NOT NULL AND amount IS NULL AND tax_year IS NULL)
        OR (pct IS NULL AND amount IS NOT NULL AND tax_year IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tax_est_treatment_splits_treatment
  ON tax_est_account_treatment_splits (treatment_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_tax_est_treatment_splits_company
  ON tax_est_account_treatment_splits (tenant_id, company_id);
CREATE INDEX IF NOT EXISTS idx_tax_est_treatment_splits_taxpayer
  ON tax_est_account_treatment_splits (taxpayer_id);
