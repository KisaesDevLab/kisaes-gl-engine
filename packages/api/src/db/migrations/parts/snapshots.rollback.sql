-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the Tax Estimator Phase 12 snapshots part (runs BEFORE the estimate part).
DROP TABLE IF EXISTS tax_est_snapshots;
DROP FUNCTION IF EXISTS tax_est_snapshots_immutable();
