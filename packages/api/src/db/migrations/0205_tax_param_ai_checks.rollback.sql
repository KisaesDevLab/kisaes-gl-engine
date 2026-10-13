-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0205 (AI parameter check). Drops the check history; parameter values,
-- overrides and their audit rows (including applied AI values) are untouched.
DROP TABLE IF EXISTS tax_param_ai_checks;
DROP TABLE IF EXISTS tax_param_ai_check_runs;
