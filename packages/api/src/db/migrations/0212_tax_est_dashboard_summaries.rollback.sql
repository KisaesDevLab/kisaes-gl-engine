-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator Q52 dashboard-summaries part (0212). The table is a derived
-- cache of live estimates (rebuilt by the next estimate); the code writing / reading it must be
-- rolled back with it.
DROP TABLE IF EXISTS tax_est_dashboard_summaries;
