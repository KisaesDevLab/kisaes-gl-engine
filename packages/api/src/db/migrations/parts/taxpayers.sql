-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
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
