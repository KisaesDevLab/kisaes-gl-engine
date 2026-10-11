-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0201_tax_estimator (phases append their DROPs here, children first).
DELETE FROM tenant_feature_flags WHERE flag_key = 'TAX_ESTIMATOR_V1';
DROP TABLE IF EXISTS tax_parameter_overrides;
DROP TABLE IF EXISTS tax_parameters;
