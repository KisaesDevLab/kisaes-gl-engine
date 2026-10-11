-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
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
