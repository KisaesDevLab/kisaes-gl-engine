-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the Tax Estimator Q49 entity-type-override part (0209). The code reading the
-- column must be rolled back with it.
ALTER TABLE IF EXISTS tax_est_entity_year_inputs DROP COLUMN IF EXISTS entity_type_override;
