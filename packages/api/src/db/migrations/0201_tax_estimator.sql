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
      'estimated_tax_payment', 'tax_depreciation_differs', 'w2_wages',
      -- Partnership guaranteed payment to the partner in payment_person_id (R1 F1).
      'guaranteed_payment',
      -- Character treatments for income accounts the TB seed has no code for (R1 F6).
      'capital_gain_lt', 'capital_gain_st', 'section_1231', 'interest',
      'dividends_ordinary', 'dividends_qualified')),
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
  -- Jurisdiction: payments only. Person target (payment_taxpayer_id / payment_person_id):
  -- payments, guaranteed payments (the partner), owner SEHI / retirement (the
  -- S corp officer) and W-2 wages (officer wages). "GP needs a person" and
  -- "S corp owner items need a person" are enforced by the API, not here: the
  -- person FK is ON DELETE SET NULL, and a CHECK would block deleting a person.
  CONSTRAINT chk_tax_est_account_treatments_payment
    CHECK ((COALESCE(treatment, '') = 'estimated_tax_payment' OR payment_jurisdiction IS NULL)
      AND (COALESCE(treatment, '') IN ('estimated_tax_payment', 'guaranteed_payment', 'owner_sehi', 'owner_retirement', 'w2_wages')
        OR (payment_taxpayer_id IS NULL AND payment_person_id IS NULL))),
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

-- ── Phase 10b: estimate inputs, payment ledger, Schedule AI snapshots ───────────────────────────────────────────────
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

-- ── Phase 12: immutable estimate snapshots ───────────────────────────────────────────────
--
-- Tax Estimator Phase 12 part: immutable estimate snapshots (MODULE.md "Scenarios,
-- snapshots, standards"; TE_SNAPSHOT_IMMUTABLE). Assembled AFTER estimate.sql.
-- Additive only: one new firm-scoped table, its trigger function and trigger.
--
-- The payload (inputs, engine result, resolved federal parameters and state rules
-- with statuses, readiness, assumptions, disclaimer) contains prior-year tax / AGI
-- and figures derived from them: tax return information (D9, IRC §7216). It is
-- AES-256-GCM ciphertext in `*_encrypted` TEXT columns, which enrols it in the
-- credential re-encryption sweep (credential-reencrypt.service.ts). `*_sha256` is
-- the hash of the PLAINTEXT, checked on every read, so a re-encrypted payload still
-- verifies and a swapped one does not.
--
-- Immutability: the service has no update path, and the trigger below rejects any
-- UPDATE that changes a column other than the two ciphertext columns (the sweep
-- rewrites only those). scenario_id has NO foreign key on purpose: a snapshot
-- outlives its scenario, and an ON DELETE SET NULL action would be an UPDATE.
-- Rows go away only with their taxpayer (ON DELETE CASCADE).
CREATE TABLE IF NOT EXISTS tax_est_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID NOT NULL,
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL CHECK (tax_year BETWEEN 2000 AND 2100),
  scenario_id UUID NOT NULL,
  scenario_name VARCHAR(120) NOT NULL,
  reason VARCHAR(16) NOT NULL CHECK (reason IN ('finalize', 'vouchers', 'pdf', 'report_pack')),
  note TEXT,
  engine_version VARCHAR(40) NOT NULL,
  inputs_hash CHAR(64) NOT NULL,
  -- Books tenants whose companies the snapshot includes (D1: the view is refused to a
  -- caller who can no longer reach one of them).
  tenant_ids UUID[] NOT NULL DEFAULT '{}',
  payload_encrypted TEXT NOT NULL,
  payload_sha256 CHAR(64) NOT NULL,
  summary_encrypted TEXT NOT NULL,
  summary_sha256 CHAR(64) NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_est_snapshots_firm_taxpayer_year
  ON tax_est_snapshots (firm_id, taxpayer_id, tax_year, created_at DESC);

CREATE OR REPLACE FUNCTION tax_est_snapshots_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'payload_encrypted' - 'summary_encrypted')
     IS DISTINCT FROM (to_jsonb(OLD) - 'payload_encrypted' - 'summary_encrypted') THEN
    RAISE EXCEPTION 'TE_SNAPSHOT_IMMUTABLE: tax estimate snapshots cannot be changed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_tax_est_snapshots_immutable ON tax_est_snapshots;
CREATE TRIGGER trg_tax_est_snapshots_immutable
  BEFORE UPDATE ON tax_est_snapshots
  FOR EACH ROW EXECUTE FUNCTION tax_est_snapshots_immutable();

-- ── Phase 13: Report Pack tax-estimate section ───────────────────────────────────────────────
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

-- ── R7: in-app Verify (super-admin sign-off) ───────────────────────────────────────────────
--
-- Tax Estimator R7 part: in-app Verify (super-admin sign-off, UI-SPEC §04). Assembled
-- LAST. Additive only. A row is verified for its CURRENT value: the startup seed re-sync
-- keeps verified_* (and status verified) only while the shipped value is unchanged, and
-- a new override value clears them. Never set by seeds or migrations.
ALTER TABLE tax_parameters ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE tax_parameters ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE tax_parameters ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE tax_parameter_overrides ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE tax_parameter_overrides ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE tax_parameter_overrides ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE state_estimate_rules ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE state_estimate_rules ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE state_estimate_rules ADD COLUMN IF NOT EXISTS verification_note TEXT;
ALTER TABLE state_estimate_rule_overrides ADD COLUMN IF NOT EXISTS verified_by UUID;
ALTER TABLE state_estimate_rule_overrides ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE state_estimate_rule_overrides ADD COLUMN IF NOT EXISTS verification_note TEXT;
