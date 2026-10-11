-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Phase 5 part: annual settings, scenarios, adjustments, state rows,
-- firm settings (MODULE.md D1, D4, D9, D10). Assembled AFTER taxpayers.sql.
-- Additive only.

-- One row per taxpayer per tax year. Prior-year tax and AGI are tax return
-- information (D9): AES text columns named *_encrypted so the credential
-- re-encryption sweep enrols them. Jsonb money values are plain numbers; per-person
-- maps are keyed by role ('primary' | 'spouse').
CREATE TABLE IF NOT EXISTS tax_est_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  prior_year_tax_encrypted TEXT,
  prior_year_agi_encrypted TEXT,
  prior_year_twelve_months BOOLEAN NOT NULL DEFAULT TRUE,
  prior_year_filed BOOLEAN NOT NULL DEFAULT TRUE,
  -- NULL = taxpayer override, else firm default.
  safe_harbor_rule VARCHAR(20)
    CHECK (safe_harbor_rule IS NULL OR safe_harbor_rule IN ('prior_year', 'lesser_of', 'current_year')),
  rate_mode VARCHAR(10) NOT NULL DEFAULT 'brackets' CHECK (rate_mode IN ('brackets', 'effective')),
  effective_rate_override NUMERIC(7,6) CHECK (effective_rate_override IS NULL OR (effective_rate_override >= 0 AND effective_rate_override <= 1)),
  deduction_mode VARCHAR(10) NOT NULL DEFAULT 'auto' CHECK (deduction_mode IN ('auto', 'standard', 'itemized')),
  itemized JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(itemized) = 'object'),
  sch1a JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(sch1a) = 'object'),
  credits_nonrefundable NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (credits_nonrefundable >= 0),
  credits_refundable NUMERIC(19,4) NOT NULL DEFAULT 0 CHECK (credits_refundable >= 0),
  hsa_coverage JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(hsa_coverage) = 'object'),
  withholding JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(withholding) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_years_taxpayer_year UNIQUE (taxpayer_id, tax_year)
);

CREATE TABLE IF NOT EXISTS tax_est_scenarios (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  name VARCHAR(120) NOT NULL,
  is_base BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_scenario_id UUID REFERENCES tax_est_scenarios(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_est_scenarios_taxpayer_year ON tax_est_scenarios (taxpayer_id, tax_year);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_est_scenarios_one_base
  ON tax_est_scenarios (taxpayer_id, tax_year) WHERE is_base;

-- firm_id NULL = shipped catalog (read-only); else a firm custom type.
CREATE TABLE IF NOT EXISTS tax_est_adjustment_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID,
  -- Stable machine code for shipped rows (the engine keys off flags, not names).
  code VARCHAR(40),
  name VARCHAR(120) NOT NULL,
  -- income adds to income; deduction reduces it; addback adds back a non-deductible share (meals).
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('income', 'deduction', 'addback')),
  affects_se BOOLEAN NOT NULL DEFAULT FALSE,
  affects_qbi BOOLEAN NOT NULL DEFAULT FALSE,
  is_capital_gain_lt BOOLEAN NOT NULL DEFAULT FALSE,
  is_capital_gain_st BOOLEAN NOT NULL DEFAULT FALSE,
  is_qualified_dividend BOOLEAN NOT NULL DEFAULT FALSE,
  is_reit_dividend BOOLEAN NOT NULL DEFAULT FALSE,
  is_ptp BOOLEAN NOT NULL DEFAULT FALSE,
  is_1231 BOOLEAN NOT NULL DEFAULT FALSE,
  is_above_the_line BOOLEAN NOT NULL DEFAULT FALSE,
  non_recurring BOOLEAN NOT NULL DEFAULT FALSE,
  default_pct NUMERIC(7,4) CHECK (default_pct IS NULL OR (default_pct >= 0 AND default_pct <= 100)),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_est_adjustment_types_name
  ON tax_est_adjustment_types ((COALESCE(firm_id, '00000000-0000-0000-0000-000000000000'::uuid)), lower(name));
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_est_adjustment_types_code
  ON tax_est_adjustment_types (code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tax_est_adjustment_types_firm ON tax_est_adjustment_types (firm_id);

CREATE TABLE IF NOT EXISTS tax_est_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES tax_est_scenarios(id) ON DELETE CASCADE,
  adjustment_type_id UUID NOT NULL REFERENCES tax_est_adjustment_types(id) ON DELETE RESTRICT,
  person_id UUID REFERENCES tax_est_persons(id) ON DELETE SET NULL,
  link_id UUID REFERENCES tax_est_links(id) ON DELETE SET NULL,
  label VARCHAR(200) NOT NULL DEFAULT '',
  -- NULL only for a GL-linked adjustment: remaining months use the actuals run-rate.
  amount NUMERIC(19,4),
  -- Overrides the type's default_pct (e.g. meals 50).
  pct NUMERIC(7,4) CHECK (pct IS NULL OR (pct >= 0 AND pct <= 100)),
  cadence VARCHAR(10) NOT NULL CHECK (cadence IN ('monthly', 'quarterly', 'annual', 'one_time')),
  start_month SMALLINT NOT NULL DEFAULT 1 CHECK (start_month BETWEEN 1 AND 12),
  end_month SMALLINT NOT NULL DEFAULT 12 CHECK (end_month BETWEEN 1 AND 12),
  gl_linked BOOLEAN NOT NULL DEFAULT FALSE,
  tenant_id UUID,
  company_id UUID,
  account_id UUID,
  non_recurring BOOLEAN NOT NULL DEFAULT FALSE,
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_tax_est_adjustments_months CHECK (start_month <= end_month),
  CONSTRAINT chk_tax_est_adjustments_amount CHECK (amount IS NOT NULL OR gl_linked),
  CONSTRAINT chk_tax_est_adjustments_gl CHECK (
    (gl_linked AND tenant_id IS NOT NULL AND company_id IS NOT NULL AND account_id IS NOT NULL)
    OR (NOT gl_linked AND tenant_id IS NULL AND company_id IS NULL AND account_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_tax_est_adjustments_scenario ON tax_est_adjustments (scenario_id);

CREATE TABLE IF NOT EXISTS tax_est_state_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id UUID NOT NULL REFERENCES tax_est_scenarios(id) ON DELETE CASCADE,
  residency VARCHAR(12) NOT NULL CHECK (residency IN ('resident', 'nonresident')),
  state CHAR(2) NOT NULL,
  effective_rate NUMERIC(7,6) NOT NULL CHECK (effective_rate >= 0 AND effective_rate <= 0.2),
  base VARCHAR(16) NOT NULL DEFAULT 'federal_agi' CHECK (base IN ('federal_agi', 'federal_taxable', 'custom')),
  custom_base NUMERIC(19,4),
  -- NULL + sourced_manual=false means "derive from entity state x share" (engine phase).
  sourced_income NUMERIC(19,4),
  sourced_manual BOOLEAN NOT NULL DEFAULT FALSE,
  credit_override NUMERIC(19,4),
  memo TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_state_rows_state UNIQUE (scenario_id, state)
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_est_state_rows_one_resident
  ON tax_est_state_rows (scenario_id) WHERE residency = 'resident';

CREATE TABLE IF NOT EXISTS tax_est_firm_settings (
  firm_id UUID PRIMARY KEY,
  safe_harbor_default VARCHAR(20) NOT NULL DEFAULT 'lesser_of'
    CHECK (safe_harbor_default IN ('prior_year', 'lesser_of', 'current_year')),
  -- NULL = the shipped default disclaimer text.
  disclaimer_text TEXT,
  portal_shows VARCHAR(10) NOT NULL DEFAULT 'live' CHECK (portal_shows IN ('live', 'snapshot')),
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Shipped adjustment-type catalog (firm_id NULL). ON CONFLICT DO NOTHING keeps reruns idempotent.
INSERT INTO tax_est_adjustment_types
  (code, name, kind, affects_se, affects_qbi, is_capital_gain_lt, is_capital_gain_st, is_qualified_dividend,
   is_reit_dividend, is_ptp, is_1231, is_above_the_line, non_recurring, default_pct)
VALUES
  ('owner_health_insurance', 'Owner health insurance', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, NULL),
  ('sep_solo_401k',          'SEP/solo 401k contribution', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, NULL),
  ('hsa_contribution',       'HSA contribution', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, NULL),
  ('meals',                  'Meals (50%)', 'addback', TRUE,  TRUE,  FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 50),
  ('depreciation_tax_vs_book', 'Depreciation (tax vs book)', 'deduction', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('capital_gain_lt',        'Capital gain long-term', 'income', FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  NULL),
  ('capital_gain_st',        'Capital gain short-term', 'income', FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  NULL),
  ('qualified_dividend',     'Qualified dividend', 'income', FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('reit_dividend',          'REIT dividend', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, FALSE, NULL),
  ('ptp_income',             'PTP income', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, NULL),
  ('sec_1231_gain',          '§1231 gain', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, TRUE,  NULL),
  ('interest_income',        'Interest income', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('other_income',           'Other income', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('other_deduction',        'Other deduction', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('vehicle_179',            'Vehicle purchase (§179)', 'deduction', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  NULL),
  ('retirement_catch_up',    'Retirement catch-up', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, NULL)
ON CONFLICT DO NOTHING;
