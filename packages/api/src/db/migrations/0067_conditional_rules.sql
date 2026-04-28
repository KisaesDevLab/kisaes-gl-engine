-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 4 — Conditional Rules
-- Engine. Two new tables (conditional_rules + per-fire audit) +
-- a stats view + two additive columns on bank_feed_items
-- (skip_ai, splits_config) so Phase-4 actions can stage work
-- the existing categorize/approve path consumes.
--
-- See phase-4-plan.md §D1 (splits via journal_lines, no separate
-- transaction_splits table) and §D3 (audit only fires, not every
-- evaluation).

CREATE TABLE conditional_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- null = tenant-wide; uuid = scoped to a single company.
  company_id UUID,
  name VARCHAR(255) NOT NULL,
  -- Lower number evaluates first.
  priority INTEGER NOT NULL DEFAULT 100,
  conditions JSONB NOT NULL,
  actions JSONB NOT NULL,
  continue_after_match BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cond_rules_tenant_active ON conditional_rules (tenant_id, active);
CREATE INDEX idx_cond_rules_tenant_priority ON conditional_rules (tenant_id, priority);

CREATE TABLE conditional_rule_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES conditional_rules(id) ON DELETE CASCADE,
  bank_feed_item_id UUID,
  transaction_id UUID,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actions_applied JSONB,
  was_overridden BOOLEAN NOT NULL DEFAULT FALSE,
  overridden_at TIMESTAMPTZ
);
CREATE INDEX idx_cra_tenant_rule ON conditional_rule_audit (tenant_id, rule_id, matched_at DESC);

-- Aggregate stats per rule. Drizzle's ORM surface doesn't model
-- views; the rules service queries this via raw SQL. The view is
-- recreated on every migration run (CREATE OR REPLACE) so any
-- future column additions to the underlying tables propagate.
CREATE OR REPLACE VIEW conditional_rule_stats AS
SELECT
  r.id AS rule_id,
  r.tenant_id,
  r.name,
  COUNT(a.id) AS fires_total,
  COUNT(a.id) FILTER (WHERE a.was_overridden) AS overrides,
  COUNT(a.id) FILTER (WHERE a.matched_at > now() - INTERVAL '30 days') AS fires_30d,
  COUNT(a.id) FILTER (WHERE a.matched_at > now() - INTERVAL '7 days')  AS fires_7d,
  MAX(a.matched_at) AS last_fired_at,
  CASE
    WHEN COUNT(a.id) > 0
    THEN ROUND((COUNT(a.id) FILTER (WHERE a.was_overridden))::NUMERIC / COUNT(a.id), 4)
    ELSE NULL
  END AS override_rate
FROM conditional_rules r
LEFT JOIN conditional_rule_audit a ON a.rule_id = r.id
GROUP BY r.id;

ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS skip_ai BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS splits_config JSONB;
