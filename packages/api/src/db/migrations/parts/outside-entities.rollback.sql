-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the Tax Estimator Q45 outside-businesses part (0206). The code reading these must be
-- rolled back with it.
DROP TABLE IF EXISTS tax_est_outside_entity_years;
DROP TABLE IF EXISTS tax_est_outside_entities;
