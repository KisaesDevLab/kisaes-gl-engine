-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- 3-tier rules plan, Phase 2 — recreate conditional_rule_stats
-- to expose effective_tier so the firm-admin UI can aggregate
-- fires/overrides per tier without joining back through the
-- (mutable) rules table.
--
-- Why non-additive: Postgres views are dropped + recreated
-- atomically; we can't ALTER VIEW to add a column. The view name
-- + grants are preserved so callers (statsForTenant in
-- conditional-rules.service) don't need to change yet.

DROP VIEW IF EXISTS conditional_rule_stats;

CREATE VIEW conditional_rule_stats AS
SELECT
  r.id AS rule_id,
  r.tenant_id,
  r.name,
  r.scope,
  r.owner_firm_id,
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
