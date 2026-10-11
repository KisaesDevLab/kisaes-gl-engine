-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
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
