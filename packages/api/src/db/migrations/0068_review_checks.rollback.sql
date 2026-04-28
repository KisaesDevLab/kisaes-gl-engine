-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: ROLLBACK file for 0068_review_checks.sql. DROP is the
-- point of a rollback. Not registered in _journal.json; never
-- auto-applied. Any persisted findings, runs, suppressions, and
-- per-tenant overrides are lost.

DROP TABLE IF EXISTS check_params_overrides;
DROP TABLE IF EXISTS check_suppressions;
DROP TABLE IF EXISTS finding_events;
DROP TABLE IF EXISTS findings;
DROP TABLE IF EXISTS check_runs;
DROP TABLE IF EXISTS check_registry;
