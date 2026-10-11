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
