-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 6 — Review Checks engine.
-- Six tables (registry, runs, findings, finding events,
-- suppressions, per-tenant param overrides) + seed of the 13
-- stock checks. All additive — no policy exception needed.

CREATE TABLE check_registry (
  check_key VARCHAR(80) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  handler_name VARCHAR(80) NOT NULL,
  default_severity VARCHAR(10) NOT NULL CHECK (default_severity IN ('low', 'med', 'high', 'critical')),
  default_params JSONB NOT NULL DEFAULT '{}',
  category VARCHAR(20) NOT NULL CHECK (category IN ('close', 'data', 'compliance')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE check_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  checks_executed INTEGER NOT NULL DEFAULT 0,
  findings_created INTEGER NOT NULL DEFAULT 0,
  truncated BOOLEAN NOT NULL DEFAULT FALSE,
  error TEXT
);
CREATE INDEX idx_check_runs_tenant ON check_runs (tenant_id, started_at DESC);

CREATE TABLE findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID,
  check_key VARCHAR(80) NOT NULL REFERENCES check_registry(check_key),
  transaction_id UUID,
  vendor_id UUID,
  severity VARCHAR(10) NOT NULL CHECK (severity IN ('low', 'med', 'high', 'critical')),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'in_review', 'resolved', 'ignored')),
  assigned_to UUID,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT
);
CREATE INDEX idx_findings_tenant_status ON findings (tenant_id, status);
CREATE INDEX idx_findings_tenant_check ON findings (tenant_id, check_key);
CREATE INDEX idx_findings_tenant_company ON findings (tenant_id, company_id);
CREATE INDEX idx_findings_open ON findings (tenant_id) WHERE status = 'open';

CREATE TABLE finding_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id UUID NOT NULL REFERENCES findings(id) ON DELETE CASCADE,
  from_status VARCHAR(20),
  to_status VARCHAR(20) NOT NULL,
  user_id UUID,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_finding_events_finding ON finding_events (finding_id, created_at);

CREATE TABLE check_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID,
  check_key VARCHAR(80) NOT NULL REFERENCES check_registry(check_key),
  match_pattern JSONB NOT NULL,
  reason TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX idx_suppressions_tenant_check ON check_suppressions (tenant_id, check_key);

CREATE TABLE check_params_overrides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID,
  check_key VARCHAR(80) NOT NULL REFERENCES check_registry(check_key),
  params JSONB NOT NULL
);
-- Drizzle uniqueIndex with nullable company_id — Postgres
-- treats NULLs as distinct, so we get one tenant-wide row +
-- one row per company without an additional partial-index dance.
CREATE UNIQUE INDEX uniq_check_params_overrides ON check_params_overrides (tenant_id, company_id, check_key);

-- Seed the 13 stock checks (build plan §6.2). Idempotent
-- via ON CONFLICT so a re-run of this migration is harmless;
-- the per-tenant data tables above stay untouched.
-- description column left NULL — registry name is
-- self-explanatory and detail belongs in the knowledge base.
INSERT INTO check_registry (check_key, name, handler_name, default_severity, default_params, category) VALUES
  ('parent_account_posting',                'Direct posting to parent account',     'parent_account_posting',                'med',  '{}'::JSONB,                            'data'),
  ('missing_attachment_above_threshold',    'Missing attachment',                   'missing_attachment_above_threshold',    'low',  '{"thresholdAmount":75}'::JSONB,        'compliance'),
  ('uncategorized_stale',                   'Uncategorized bank-feed items',         'uncategorized_stale',                   'med',  '{"olderThanDays":14}'::JSONB,          'close'),
  ('auto_posted_by_rule_sampling',          'Auto-posted by rule (sample)',          'auto_posted_by_rule_sampling',          'low',  '{"samplePercent":0.10}'::JSONB,        'data'),
  ('tag_inconsistency_vs_history',          'Tag inconsistent with vendor history',  'tag_inconsistency_vs_history',          'low',  '{}'::JSONB,                            'data'),
  ('transaction_above_materiality',         'Above materiality threshold',           'transaction_above_materiality',         'high', '{"thresholdAmount":10000}'::JSONB,     'close'),
  ('duplicate_candidate',                   'Possible duplicate transaction',        'duplicate_candidate',                   'high', '{"windowDays":7}'::JSONB,              'data'),
  ('round_dollar_above_threshold',          'Round-dollar amount',                   'round_dollar_above_threshold',          'low',  '{"thresholdAmount":500}'::JSONB,       'data'),
  ('weekend_holiday_posting',               'Weekend or holiday posting',            'weekend_holiday_posting',               'low',  '{}'::JSONB,                            'close'),
  ('negative_non_liability',                'Negative balance on non-liability',     'negative_non_liability',                'high', '{}'::JSONB,                            'data'),
  ('closed_period_posting',                 'Posting in a closed period',            'closed_period_posting',                 'critical', '{}'::JSONB,                       'close'),
  ('vendor_1099_threshold_no_w9',           '1099 vendor over threshold w/o W-9',    'vendor_1099_threshold_no_w9',           'med',  '{"thresholdAmount":600}'::JSONB,       'compliance'),
  ('missing_required_customer',             'Customer required but missing',         'missing_required_customer',             'med',  '{}'::JSONB,                            'data')
ON CONFLICT (check_key) DO NOTHING;
