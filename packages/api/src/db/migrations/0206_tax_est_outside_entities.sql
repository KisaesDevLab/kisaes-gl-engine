-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Q45 part: businesses outside MyBooks (Kurt, 2026-10-13: "Also need the ability to
-- enter income/loss for entities not within the MyBooks system"; OPEN-QUESTIONS.md Q45). Shipped
-- as its OWN migration 0206_tax_est_outside_entities (0204 = dependents, 0205 = the AI parameter
-- check on another branch). Additive only: two new tables, nothing existing is altered.
--
-- 1. The persistent definition, per taxpayer. Scoped exactly like tax_est_links / tax_est_dependents:
--    through the taxpayer (taxpayer_id -> tax_est_taxpayers.firm_id), ON DELETE CASCADE, read and
--    written only through the firm + D17/D18 visibility checks of the taxpayer. The owner is a
--    person of the taxpayer (person_id, cascade like links).
CREATE TABLE IF NOT EXISTS tax_est_outside_entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  taxpayer_id UUID NOT NULL REFERENCES tax_est_taxpayers(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES tax_est_persons(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  entity_type VARCHAR(20) NOT NULL CHECK (entity_type IN ('sch_c', 'sch_f', 's_corp', 'partnership', 'c_corp')),
  profit_pct NUMERIC(7,4) CHECK (profit_pct IS NULL OR (profit_pct >= 0 AND profit_pct <= 100)),
  loss_pct NUMERIC(7,4) CHECK (loss_pct IS NULL OR (loss_pct >= 0 AND loss_pct <= 100)),
  partner_se_status VARCHAR(20) CHECK (partner_se_status IS NULL OR partner_se_status IN ('general', 'limited', 'llc_member_manager')),
  is_officer BOOLEAN NOT NULL DEFAULT FALSE,
  activity_type VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (activity_type IN ('active', 'passive', 'rental', 'investment')),
  active_participation BOOLEAN NOT NULL DEFAULT FALSE,
  qbi_eligible BOOLEAN,
  is_sstb BOOLEAN NOT NULL DEFAULT FALSE,
  rental_qbi_trade_or_business BOOLEAN NOT NULL DEFAULT FALSE,
  state_sourcing CHAR(2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_est_outside_entities_taxpayer ON tax_est_outside_entities (taxpayer_id);
CREATE INDEX IF NOT EXISTS idx_tax_est_outside_entities_person ON tax_est_outside_entities (person_id);

-- 2. The amounts, one row per business per tax year. Each year has its own entry mode
--    (full_year = used as entered; ytd = through_month, projected like a linked business) and
--    amount basis (entity_total = allocated by the owner's %; owner_share = already the owner's
--    share, e.g. a K-1). Money NUMERIC(19,4), profit-positive (a loss is negative).
CREATE TABLE IF NOT EXISTS tax_est_outside_entity_years (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outside_entity_id UUID NOT NULL REFERENCES tax_est_outside_entities(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  entry_mode VARCHAR(10) NOT NULL DEFAULT 'full_year' CHECK (entry_mode IN ('full_year', 'ytd')),
  amount_basis VARCHAR(12) NOT NULL DEFAULT 'owner_share' CHECK (amount_basis IN ('entity_total', 'owner_share')),
  through_month SMALLINT CHECK (through_month IS NULL OR (through_month BETWEEN 1 AND 12)),
  ordinary NUMERIC(19,4) NOT NULL DEFAULT 0,
  rental NUMERIC(19,4) NOT NULL DEFAULT 0,
  interest NUMERIC(19,4) NOT NULL DEFAULT 0,
  dividends_ordinary NUMERIC(19,4) NOT NULL DEFAULT 0,
  dividends_qualified NUMERIC(19,4) NOT NULL DEFAULT 0,
  capital_gain_st NUMERIC(19,4) NOT NULL DEFAULT 0,
  capital_gain_lt NUMERIC(19,4) NOT NULL DEFAULT 0,
  section_1231 NUMERIC(19,4) NOT NULL DEFAULT 0,
  guaranteed_payments NUMERIC(19,4) NOT NULL DEFAULT 0,
  officer_wages NUMERIC(19,4) NOT NULL DEFAULT 0,
  owner_sehi NUMERIC(19,4) NOT NULL DEFAULT 0,
  owner_retirement NUMERIC(19,4) NOT NULL DEFAULT 0,
  sehi_as_w2_wages NUMERIC(19,4) NOT NULL DEFAULT 0,
  w2_wages NUMERIC(19,4),
  ubia NUMERIC(19,4),
  include_sehi_in_w2_wages BOOLEAN NOT NULL DEFAULT FALSE,
  allowed_loss_override NUMERIC(19,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_tax_est_outside_entity_years UNIQUE (outside_entity_id, tax_year),
  CONSTRAINT chk_tax_est_outside_entity_years_ytd CHECK (entry_mode <> 'ytd' OR through_month IS NOT NULL)
);
