-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator: AI parameter check (OPEN-QUESTIONS Q48, Kurt 2026-10-13). Super admins ask
-- Claude (Anthropic web search / fetch limited to government domains) to confirm a federal
-- parameter or a state estimate rule against its source. Results are ADVISORY: they never
-- change a value or a status; "Apply AI value" writes an audited override that stays
-- unverified. Global reference data like tax_parameters (no tenant_id).
--
-- Additive only: two new tables. Numbered 0205 because feat/tax-est-dependents takes 0204;
-- renumber at merge if needed (D6).
CREATE TABLE IF NOT EXISTS tax_param_ai_check_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year INTEGER NOT NULL,
  -- single | federal | state | all
  scope VARCHAR(20) NOT NULL,
  state VARCHAR(2),
  key VARCHAR(120),
  -- [{ kind: 'federal_param' | 'state_rule', key, jurisdiction }], fixed when the run is created.
  targets JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- queued | running | completed | cancelled | failed
  status VARCHAR(20) NOT NULL DEFAULT 'queued',
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  error TEXT,
  model VARCHAR(100),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tax_param_ai_check_runs_year ON tax_param_ai_check_runs (tax_year, created_at DESC);

CREATE TABLE IF NOT EXISTS tax_param_ai_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES tax_param_ai_check_runs(id) ON DELETE SET NULL,
  -- federal_param | state_rule
  target_kind VARCHAR(20) NOT NULL,
  key VARCHAR(120) NOT NULL,
  -- 'US' for a federal parameter, else the state code
  jurisdiction VARCHAR(2) NOT NULL,
  tax_year INTEGER NOT NULL,
  -- The row's effective value when the check ran (drives the "stale" flag).
  stored_value_snapshot JSONB,
  -- matches | differs | unconfirmed | error (decided by the server, not the model)
  verdict VARCHAR(20) NOT NULL,
  found_value JSONB,
  quote TEXT,
  source_url TEXT,
  source_title TEXT,
  source_date TEXT,
  source_tax_year INTEGER,
  rationale TEXT,
  confidence VARCHAR(10),
  model VARCHAR(100),
  usage JSONB,
  error TEXT,
  -- model verdict, source kind, downgrade notes, retrieved URLs, allowed domains
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  applied_by UUID
);
CREATE INDEX IF NOT EXISTS idx_tax_param_ai_checks_row ON tax_param_ai_checks (tax_year, jurisdiction, key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tax_param_ai_checks_run ON tax_param_ai_checks (run_id);
