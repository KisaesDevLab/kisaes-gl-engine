-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Phase 10b part: the engine's remaining data inputs and the
-- estimate wiring (OPEN-QUESTIONS Q28, Q33, Q34). Assembled AFTER years.sql.
-- Additive only: new nullable / defaulted columns on Phase 5 tables and two new
-- firm-scoped tables. Every ADD COLUMN is IF NOT EXISTS so the part re-applies.

-- ── Year inputs (tax_est_years) ──────────────────────────────────────────
-- Per-person year inputs keyed by role ('primary' | 'spouse'), plain numbers:
--   { retirementPlanType: 'sep'|'solo_401k'|'simple'|'none', employeeDeferral,
--     w2Wages (outside W-2 box 1), w2SocialSecurityWages }   (Q28)
ALTER TABLE tax_est_years ADD COLUMN IF NOT EXISTS person_inputs JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(person_inputs) = 'object');
-- §469(i)(5): MFS spouses who lived apart ALL year (Q33).
ALTER TABLE tax_est_years ADD COLUMN IF NOT EXISTS mfs_lived_apart_all_year BOOLEAN NOT NULL DEFAULT FALSE;
-- Form 8960 Part II deductions allocable to net investment income; NULL = none (Q33).
ALTER TABLE tax_est_years ADD COLUMN IF NOT EXISTS nii_allocable_deductions NUMERIC(19,4)
  CHECK (nii_allocable_deductions IS NULL OR nii_allocable_deductions >= 0);
-- Farmer / fisherman gross-income test (§6654(i)) manual figures; a year (current |
-- prior) present here wins over the P&L provider's gross farming income (Q34):
--   { current: { primary: { farming, fishing, totalGross }, spouse: {...} }, prior: {...} }
ALTER TABLE tax_est_years ADD COLUMN IF NOT EXISTS farmer_gross JSONB NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(farmer_gross) = 'object');
ALTER TABLE tax_est_years ADD COLUMN IF NOT EXISTS is_fisherman BOOLEAN NOT NULL DEFAULT FALSE;

-- ── State-row gate inputs (tax_est_state_rows) ───────────────────────────
-- Income-based estimate-requirement gates (D12b) and the state voucher path (Q34).
-- NULL = not provided (the gate says so and flags "verify"); withholding NULL falls
-- back to tax_est_years.withholding.states[state].
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS withholding NUMERIC(19,4)
  CHECK (withholding IS NULL OR withholding >= 0);
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS other_credits NUMERIC(19,4)
  CHECK (other_credits IS NULL OR other_credits >= 0);
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS gross_income NUMERIC(19,4);
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS prior_year_gross_income NUMERIC(19,4);
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS non_withheld_income NUMERIC(19,4);
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS exemptions NUMERIC(19,4)
  CHECK (exemptions IS NULL OR exemptions >= 0);
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS state_deductions NUMERIC(19,4)
  CHECK (state_deductions IS NULL OR state_deductions >= 0);
-- Prior-year STATE tax and AGI are tax return information (D9): AES text columns
-- named *_encrypted so the credential re-encryption sweep enrols them.
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS prior_year_tax_encrypted TEXT;
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS prior_year_agi_encrypted TEXT;

-- ── Estimated-tax payment ledger ─────────────────────────────────────────
-- Manual entries, prior-year overpayments and pinned GL rows. Live GL payments
-- (accounts treated estimated_tax_payment) are read from the books on every
-- estimate and deduplicated against these rows by transaction id. Firm-scoped
-- (D1): firm_id + taxpayer; tenant_id names the books tenant of a GL row.
-- scenario_id NULL = the payment applies to every scenario of the year.
CREATE TABLE IF NOT EXISTS tax_est_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL,
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  scenario_id UUID REFERENCES tax_est_scenarios(id) ON DELETE CASCADE,
  jurisdiction VARCHAR(8) NOT NULL CHECK (jurisdiction = 'federal' OR jurisdiction ~ '^[A-Z]{2}$'),
  -- NULL only for a prior-year overpayment: credited on the prior return's original due date.
  payment_date DATE,
  amount NUMERIC(19,4) NOT NULL CHECK (amount > 0),
  source VARCHAR(24) NOT NULL CHECK (source IN ('gl', 'manual', 'prior_year_overpayment')),
  tenant_id UUID,
  transaction_id UUID,
  memo TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_tax_est_payments_date CHECK (payment_date IS NOT NULL OR source = 'prior_year_overpayment'),
  CONSTRAINT chk_tax_est_payments_gl CHECK (source <> 'gl' OR (transaction_id IS NOT NULL AND tenant_id IS NOT NULL)),
  CONSTRAINT chk_tax_est_payments_txn_tenant CHECK (transaction_id IS NULL OR tenant_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_tax_est_payments_firm_taxpayer_year ON tax_est_payments (firm_id, taxpayer_id, tax_year);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_est_payments_txn
  ON tax_est_payments (taxpayer_id, tax_year, (COALESCE(scenario_id, '00000000-0000-0000-0000-000000000000'::uuid)), transaction_id)
  WHERE transaction_id IS NOT NULL;

-- ── Schedule AI period snapshots ─────────────────────────────────────────
-- Actual tax-basis figures Jan 1 – period end (3/31, 5/31, 8/31) per linked entity,
-- captured from the P&L provider so a closed period's column does not move when
-- the books are edited later (Form 2210 Schedule AI, D7). `figures` holds the
-- engine entity figures without links (ytd/recurring by character, owner items,
-- guaranteed payments, officer wages, book depreciation, W-2 wages, months).
CREATE TABLE IF NOT EXISTS tax_est_sch_ai_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL,
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  period_index SMALLINT NOT NULL CHECK (period_index BETWEEN 0 AND 2),
  period_end DATE NOT NULL,
  tenant_id UUID NOT NULL,
  company_id UUID NOT NULL,
  through_month CHAR(7) NOT NULL,
  gl_version_stamp BIGINT NOT NULL DEFAULT 0,
  figures JSONB NOT NULL CHECK (jsonb_typeof(figures) = 'object'),
  captured_by UUID,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_sch_ai_snapshots UNIQUE (taxpayer_id, tax_year, period_index, tenant_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_tax_est_sch_ai_snapshots_firm ON tax_est_sch_ai_snapshots (firm_id, taxpayer_id, tax_year);
