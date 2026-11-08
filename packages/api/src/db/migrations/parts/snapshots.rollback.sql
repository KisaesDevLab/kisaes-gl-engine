-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator Phase 12 snapshots part (runs BEFORE the estimate part).
DROP TABLE IF EXISTS tax_est_snapshots;
DROP FUNCTION IF EXISTS tax_est_snapshots_immutable();
