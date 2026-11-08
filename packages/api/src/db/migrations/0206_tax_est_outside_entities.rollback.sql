-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator Q45 outside-businesses part (0206). The code reading these must be
-- rolled back with it.
DROP TABLE IF EXISTS tax_est_outside_entity_years;
DROP TABLE IF EXISTS tax_est_outside_entities;
