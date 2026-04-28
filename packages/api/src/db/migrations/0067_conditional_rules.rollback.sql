-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: ROLLBACK file for 0067_conditional_rules.sql. DROP +
-- DROP COLUMN are the point of a rollback. Not registered in
-- _journal.json; never auto-applied. Any persisted rules,
-- audit history, splits_config, and skip_ai flags are lost.

DROP VIEW IF EXISTS conditional_rule_stats;
DROP TABLE IF EXISTS conditional_rule_audit;
DROP TABLE IF EXISTS conditional_rules;
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS skip_ai;
ALTER TABLE bank_feed_items DROP COLUMN IF EXISTS splits_config;
