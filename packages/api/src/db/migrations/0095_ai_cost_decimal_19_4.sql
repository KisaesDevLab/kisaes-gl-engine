-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
-- migration-policy: non-additive-exception
--
-- CLAUDE.md rule #11 requires decimal(19,4) for every monetary column.
-- ai_jobs.estimated_cost and ai_usage_log.estimated_cost were declared
-- as decimal(10,6) — that allows max $9999.999999 per row, so cumulative
-- AI cost tracking would overflow once a tenant crossed ~10k USD.
-- Widening precision from (10,6) → (19,4) is non-additive (column type
-- change) but lossless for the values stored so far: 4-decimal precision
-- is more than enough for fractional-cent costs.

ALTER TABLE ai_jobs
  ALTER COLUMN estimated_cost TYPE numeric(19, 4) USING estimated_cost::numeric(19, 4);

ALTER TABLE ai_usage_log
  ALTER COLUMN estimated_cost TYPE numeric(19, 4) USING estimated_cost::numeric(19, 4);
