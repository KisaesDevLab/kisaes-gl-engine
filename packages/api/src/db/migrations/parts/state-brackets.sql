-- migration-policy: non-additive-exception
-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Q53 (Kurt, 2026-10-13: "Why have tax rate schedule for federal but not states?"):
-- state rows gain a rate mode (the state's rate schedule by default, or the existing effective rate as
-- an override) and a nonresident mode (the state's own method on the schedule by default, or sourced
-- income x effective rate); the year gains the unrecaptured section 1250 / collectibles gain inputs
-- (Q39 backlog), and two account treatments feed them from the books.
--
-- Existing state rows take rate_mode 'brackets': the entered effective_rate is KEPT as the stored
-- override value (not active) — Kurt can flip a row back to 'effective' (OPEN-QUESTIONS Q53).
-- The only non-additive statement re-creates the account-treatment CHECK with two more values
-- (DROP + ADD of the same constraint in this file; no data is touched).
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS rate_mode VARCHAR(12) NOT NULL DEFAULT 'brackets'
  CONSTRAINT chk_tax_est_state_rows_rate_mode CHECK (rate_mode IN ('brackets', 'effective'));
ALTER TABLE tax_est_state_rows ADD COLUMN IF NOT EXISTS nonresident_mode VARCHAR(12) NOT NULL DEFAULT 'ratio'
  CONSTRAINT chk_tax_est_state_rows_nonresident_mode CHECK (nonresident_mode IN ('ratio', 'sourced_rate'));

ALTER TABLE tax_est_years ADD COLUMN IF NOT EXISTS unrecaptured_1250_gain NUMERIC(19,4) NOT NULL DEFAULT 0
  CONSTRAINT chk_tax_est_years_unrecaptured_1250_gain CHECK (unrecaptured_1250_gain >= 0);
ALTER TABLE tax_est_years ADD COLUMN IF NOT EXISTS collectibles_gain NUMERIC(19,4) NOT NULL DEFAULT 0
  CONSTRAINT chk_tax_est_years_collectibles_gain CHECK (collectibles_gain >= 0);

ALTER TABLE tax_est_account_treatments DROP CONSTRAINT IF EXISTS tax_est_account_treatments_treatment_check;
ALTER TABLE tax_est_account_treatments ADD CONSTRAINT tax_est_account_treatments_treatment_check
  CHECK (treatment IS NULL OR treatment IN (
    'nondeductible_pct', 'owner_sehi', 'owner_retirement', 'owner_personal',
    'estimated_tax_payment', 'tax_depreciation_differs', 'w2_wages',
    'guaranteed_payment',
    'capital_gain_lt', 'capital_gain_st', 'section_1231', 'interest',
    'dividends_ordinary', 'dividends_qualified',
    'unrecaptured_1250', 'collectibles_gain'));
