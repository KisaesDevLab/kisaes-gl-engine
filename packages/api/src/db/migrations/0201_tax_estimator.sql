-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator (TAX_ESTIMATOR_V1). ONE consolidated, additive migration for
-- the whole module (features/tax-estimator/MODULE.md D6): each phase appends
-- its tables below; the file is renumbered to the next free journal idx on
-- the day the feature branch merges to main. Flag seeded OFF for every tenant.

-- ── Phase 0: flag ───────────────────────────────────────────────────────
INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'TAX_ESTIMATOR_V1', FALSE FROM tenants t
ON CONFLICT DO NOTHING;

-- ── Phase 1: tax parameters (GLOBAL, platform-wide like tax_codes) ──────
-- tax_parameters = SHIPPED seed rows, re-synced from code at startup.
CREATE TABLE IF NOT EXISTS tax_parameters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year INTEGER NOT NULL,
  key VARCHAR(120) NOT NULL,
  value JSONB NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('verified', 'unverified', 'provisional')),
  citation TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_parameters_year_key UNIQUE (tax_year, key)
);
CREATE INDEX IF NOT EXISTS idx_tax_parameters_year ON tax_parameters (tax_year);

-- Super-admin overrides and provisional rows made by "create year from prior".
CREATE TABLE IF NOT EXISTS tax_parameter_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year INTEGER NOT NULL,
  key VARCHAR(120) NOT NULL,
  value JSONB NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('override', 'provisional')),
  reason TEXT NOT NULL,
  created_from_year INTEGER,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_parameter_overrides_year_key UNIQUE (tax_year, key)
);
CREATE INDEX IF NOT EXISTS idx_tax_parameter_overrides_year ON tax_parameter_overrides (tax_year);

-- ── Phase 2: state estimate rules (global) ───────────────────────────────────────────────
--
-- Phase 2: state estimate rules (GLOBAL, platform-wide). Part file assembled into
-- 0201_tax_estimator.sql by the orchestrator. Additive and idempotent.

-- Shipped seed rows, re-synced from code at startup.
CREATE TABLE IF NOT EXISTS state_estimate_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state CHAR(2) NOT NULL,
  tax_year INTEGER NOT NULL,
  key VARCHAR(80) NOT NULL,
  value JSONB NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('verified', 'unverified', 'provisional')),
  citation TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_state_estimate_rules_state_year_key UNIQUE (state, tax_year, key)
);
CREATE INDEX IF NOT EXISTS idx_state_estimate_rules_year ON state_estimate_rules (tax_year);

-- Super-admin overrides and provisional rows made by "create year from prior".
CREATE TABLE IF NOT EXISTS state_estimate_rule_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state CHAR(2) NOT NULL,
  tax_year INTEGER NOT NULL,
  key VARCHAR(80) NOT NULL,
  value JSONB NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('override', 'provisional')),
  citation TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  created_from_year INTEGER,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_state_estimate_rule_overrides_state_year_key UNIQUE (state, tax_year, key)
);
CREATE INDEX IF NOT EXISTS idx_state_estimate_rule_overrides_year ON state_estimate_rule_overrides (tax_year);

-- ── Phase 3: taxpayers, persons, links, portal access ───────────────────────────────────────────────
--
-- Tax Estimator Phase 3 part: firm-scoped taxpayers, persons, links (MODULE.md D1).
-- Assembled into 0201_tax_estimator.sql by the orchestrator. Additive only.

-- A Taxpayer belongs to a FIRM, never to a tenant. firm_id is intentionally
-- not a foreign key to tenants; links carry the tenant they point into.
CREATE TABLE IF NOT EXISTS tax_est_taxpayers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  filing_status VARCHAR(10) NOT NULL DEFAULT 'single'
    CHECK (filing_status IN ('single', 'mfj', 'mfs', 'hoh', 'qss')),
  resident_state CHAR(2),
  -- NULL = firm default.
  safe_harbor_override VARCHAR(20)
    CHECK (safe_harbor_override IS NULL OR safe_harbor_override IN ('prior_year', 'lesser_of', 'current_year')),
  portal_shows VARCHAR(10)
    CHECK (portal_shows IS NULL OR portal_shows IN ('live', 'snapshot')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_est_taxpayers_firm ON tax_est_taxpayers (firm_id);

CREATE TABLE IF NOT EXISTS tax_est_persons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CHECK (role IN ('primary', 'spouse')),
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(120) NOT NULL,
  date_of_birth DATE,
  is_blind BOOLEAN NOT NULL DEFAULT FALSE,
  -- 12 booleans, Jan..Dec: TRUE = the month is SEHI-eligible (NOT eligible for an employer plan).
  sehi_eligible_months JSONB NOT NULL
    DEFAULT '[true,true,true,true,true,true,true,true,true,true,true,true]'::jsonb
    CHECK (jsonb_typeof(sehi_eligible_months) = 'array' AND jsonb_array_length(sehi_eligible_months) = 12),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_persons_role UNIQUE (taxpayer_id, role)
);

CREATE TABLE IF NOT EXISTS tax_est_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES tax_est_persons(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  tenant_id UUID NOT NULL,
  company_id UUID NOT NULL,
  profit_pct NUMERIC(7,4),
  loss_pct NUMERIC(7,4),
  capital_pct NUMERIC(7,4),
  partner_se_status VARCHAR(20)
    CHECK (partner_se_status IS NULL OR partner_se_status IN ('general', 'limited', 'llc_member_manager')),
  partner_se_memo TEXT,
  is_officer BOOLEAN NOT NULL DEFAULT FALSE,
  activity_type VARCHAR(12) NOT NULL DEFAULT 'active'
    CHECK (activity_type IN ('active', 'passive', 'rental', 'investment')),
  active_participation BOOLEAN NOT NULL DEFAULT FALSE,
  qbi_eligible BOOLEAN,
  qbi_override_reason TEXT,
  allowed_loss_override NUMERIC(19,4),
  allowed_loss_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_links_person_company_year UNIQUE (person_id, tenant_id, company_id, tax_year)
);
CREATE INDEX IF NOT EXISTS idx_tax_est_links_taxpayer_year ON tax_est_links (taxpayer_id, tax_year);
CREATE INDEX IF NOT EXISTS idx_tax_est_links_company ON tax_est_links (tenant_id, company_id);

-- Portal contact <-> taxpayer mapping.
CREATE TABLE IF NOT EXISTS tax_est_taxpayer_contacts (
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  portal_contact_id UUID NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_taxpayer_contacts UNIQUE (taxpayer_id, portal_contact_id)
);
CREATE INDEX IF NOT EXISTS idx_tax_est_taxpayer_contacts_contact ON tax_est_taxpayer_contacts (portal_contact_id);

-- Per-contact portal grant, like financials_access (D5).
ALTER TABLE portal_contact_companies
  ADD COLUMN IF NOT EXISTS tax_estimates_access BOOLEAN NOT NULL DEFAULT FALSE;

-- ── Phase 4: entity settings, account treatments, transaction flags ───────────────────────────────────────────────
--
-- Tax Estimator Phase 4 part: entity tax setup (MODULE.md D3, D8).
-- Assembled into 0201_tax_estimator.sql by the orchestrator AFTER the Phase 3
-- taxpayers part (account treatments reference tax_est_taxpayers/persons).
-- Additive only. Every table is books-scoped: tenant_id + company_id, and
-- indexes lead with (tenant_id, company_id, ...).

-- Estimator-owned per-company tax fields. tax_entity_type is used only when
-- the company has no TB company_tax_profiles row (the profile wins, D3);
-- tax_method overrides companies.accounting_method.
CREATE TABLE IF NOT EXISTS tax_est_entity_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID NOT NULL,
  tax_entity_type VARCHAR(20)
    CHECK (tax_entity_type IS NULL OR tax_entity_type IN ('sch_c', 'sch_f', 's_corp', 'partnership', 'c_corp')),
  tax_method VARCHAR(10)
    CHECK (tax_method IS NULL OR tax_method IN ('cash', 'accrual')),
  is_sstb BOOLEAN NOT NULL DEFAULT FALSE,
  large_corporation BOOLEAN NOT NULL DEFAULT FALSE,
  -- NULL = derive from the gross-farming-income test.
  farmer_override BOOLEAN,
  rental_qbi_trade_or_business BOOLEAN NOT NULL DEFAULT FALSE,
  state_sourcing CHAR(2) CHECK (state_sourcing IS NULL OR state_sourcing ~ '^[A-Z]{2}$'),
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_entity_settings_company UNIQUE (tenant_id, company_id)
);

-- Per-entity, per-tax-year manual inputs (D8): QBI W-2 wage override (wins over
-- the books' w2_wages total when set) and UBIA (blank = UBIA limb not computed).
CREATE TABLE IF NOT EXISTS tax_est_entity_year_inputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID NOT NULL,
  tax_year INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  w2_wages_override NUMERIC(19,4) CHECK (w2_wages_override IS NULL OR w2_wages_override >= 0),
  w2_wages_override_reason TEXT,
  ubia NUMERIC(19,4) CHECK (ubia IS NULL OR ubia >= 0),
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_entity_year_inputs UNIQUE (tenant_id, company_id, tax_year),
  CONSTRAINT chk_tax_est_entity_year_inputs_reason
    CHECK (w2_wages_override IS NULL OR length(trim(coalesce(w2_wages_override_reason, ''))) > 0)
);

-- The estimator-only part of the tax-treatment map (D3). Character (ordinary /
-- rental / capital gain / ...) is NEVER stored here: it comes from TB
-- account_tax_assignments. One row per account: at most one treatment plus the
-- non_recurring flag (treatment NULL = a flag-only row).
CREATE TABLE IF NOT EXISTS tax_est_account_treatments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  treatment VARCHAR(30)
    CHECK (treatment IS NULL OR treatment IN (
      'nondeductible_pct', 'owner_sehi', 'owner_retirement', 'owner_personal',
      'estimated_tax_payment', 'tax_depreciation_differs', 'w2_wages')),
  -- Percent 0..100 (meals default 50). Required for nondeductible_pct only.
  pct NUMERIC(7,4) CHECK (pct IS NULL OR (pct >= 0 AND pct <= 100)),
  payment_taxpayer_id UUID REFERENCES tax_est_taxpayers(id) ON DELETE SET NULL,
  payment_person_id UUID REFERENCES tax_est_persons(id) ON DELETE SET NULL,
  -- 'federal' or a two-letter state / DC code.
  payment_jurisdiction VARCHAR(10)
    CHECK (payment_jurisdiction IS NULL OR payment_jurisdiction ~ '^(federal|[A-Z]{2})$'),
  non_recurring BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_account_treatments_account UNIQUE (tenant_id, company_id, account_id),
  -- CASE/COALESCE, not bare comparisons: a NULL treatment must not make the CHECK pass by NULL.
  CONSTRAINT chk_tax_est_account_treatments_pct
    CHECK (CASE WHEN treatment = 'nondeductible_pct' THEN pct IS NOT NULL ELSE pct IS NULL END),
  CONSTRAINT chk_tax_est_account_treatments_payment
    CHECK (COALESCE(treatment, '') = 'estimated_tax_payment'
      OR (payment_taxpayer_id IS NULL AND payment_person_id IS NULL AND payment_jurisdiction IS NULL)),
  CONSTRAINT chk_tax_est_account_treatments_nonempty
    CHECK (treatment IS NOT NULL OR non_recurring)
);
CREATE INDEX IF NOT EXISTS idx_tax_est_account_treatments_company
  ON tax_est_account_treatments (tenant_id, company_id, treatment);

-- Per-transaction non-recurring flag (D3). Side table: transactions is not altered.
CREATE TABLE IF NOT EXISTS tax_est_transaction_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  non_recurring BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_transaction_flags UNIQUE (tenant_id, transaction_id)
);

-- ── Phase 5: annual settings, scenarios, adjustments, state rows, firm settings ───────────────────────────────────────────────
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
