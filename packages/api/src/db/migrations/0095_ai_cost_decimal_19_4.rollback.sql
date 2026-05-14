-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Rollback for 0095_ai_cost_decimal_19_4. Reverting (19,4) → (10,6) is
-- lossy if any row already exceeds $9999.999999 — in that case this
-- rollback will fail and the operator must truncate/redistribute the
-- offending rows by hand before retrying.

ALTER TABLE ai_jobs
  ALTER COLUMN estimated_cost TYPE numeric(10, 6) USING estimated_cost::numeric(10, 6);

ALTER TABLE ai_usage_log
  ALTER COLUMN estimated_cost TYPE numeric(10, 6) USING estimated_cost::numeric(10, 6);
