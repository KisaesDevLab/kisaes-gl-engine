-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Rollback for 0083 — restore the pre-Phase-2 view shape (no
-- scope / owner_firm_id columns). The view's pg_class oid
-- changes; any cached prepared statements naming the view will
-- need re-preparation, same as on the forward run.

DROP VIEW IF EXISTS conditional_rule_stats;

CREATE VIEW conditional_rule_stats AS
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
