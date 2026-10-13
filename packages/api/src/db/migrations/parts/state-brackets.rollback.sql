-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for Tax Estimator Q53 (0213). The code reading these columns must be rolled back with it.
-- Treatment rows using the two new values must be cleared before the narrower CHECK is restored.
UPDATE tax_est_account_treatments SET treatment = 'capital_gain_lt' WHERE treatment IN ('unrecaptured_1250', 'collectibles_gain');
ALTER TABLE IF EXISTS tax_est_account_treatments DROP CONSTRAINT IF EXISTS tax_est_account_treatments_treatment_check;
ALTER TABLE IF EXISTS tax_est_account_treatments ADD CONSTRAINT tax_est_account_treatments_treatment_check
  CHECK (treatment IS NULL OR treatment IN (
    'nondeductible_pct', 'owner_sehi', 'owner_retirement', 'owner_personal',
    'estimated_tax_payment', 'tax_depreciation_differs', 'w2_wages',
    'guaranteed_payment',
    'capital_gain_lt', 'capital_gain_st', 'section_1231', 'interest',
    'dividends_ordinary', 'dividends_qualified'));
ALTER TABLE IF EXISTS tax_est_years DROP COLUMN IF EXISTS collectibles_gain;
ALTER TABLE IF EXISTS tax_est_years DROP COLUMN IF EXISTS unrecaptured_1250_gain;
ALTER TABLE IF EXISTS tax_est_state_rows DROP COLUMN IF EXISTS nonresident_mode;
ALTER TABLE IF EXISTS tax_est_state_rows DROP COLUMN IF EXISTS rate_mode;
