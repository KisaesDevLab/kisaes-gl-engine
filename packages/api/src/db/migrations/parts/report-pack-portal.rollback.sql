-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the Tax Estimator Phase 13 Report Pack part (runs BEFORE the snapshots part).
ALTER TABLE IF EXISTS report_pack_runs
  DROP COLUMN IF EXISTS allow_tax_estimate,
  DROP COLUMN IF EXISTS requested_by;
