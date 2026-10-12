// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Shipped adjustment-type catalog (firm_id NULL). The same statement lives in migration 0201
// (parts/years.sql); it is idempotent, and syncShippedSeeds() re-runs it at every start so the
// catalog self-heals if the rows are ever removed (e.g. a test or restore that truncates firms).
export const SHIPPED_ADJUSTMENT_TYPES_SQL = `
INSERT INTO tax_est_adjustment_types
  (code, name, kind, affects_se, affects_qbi, is_capital_gain_lt, is_capital_gain_st, is_qualified_dividend,
   is_reit_dividend, is_ptp, is_1231, is_above_the_line, non_recurring, default_pct)
VALUES
  ('owner_health_insurance', 'Owner health insurance', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, NULL),
  ('sep_solo_401k',          'SEP/solo 401k contribution', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, NULL),
  ('hsa_contribution',       'HSA contribution', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, NULL),
  ('meals',                  'Meals (50%)', 'addback', TRUE,  TRUE,  FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, 50),
  ('depreciation_tax_vs_book', 'Depreciation (tax vs book)', 'deduction', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('capital_gain_lt',        'Capital gain long-term', 'income', FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  NULL),
  ('capital_gain_st',        'Capital gain short-term', 'income', FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  NULL),
  ('qualified_dividend',     'Qualified dividend', 'income', FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('reit_dividend',          'REIT dividend', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, FALSE, NULL),
  ('ptp_income',             'PTP income', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, FALSE, FALSE, NULL),
  ('sec_1231_gain',          '§1231 gain', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, TRUE,  NULL),
  ('interest_income',        'Interest income', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('other_income',           'Other income', 'income', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('other_deduction',        'Other deduction', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, NULL),
  ('vehicle_179',            'Vehicle purchase (§179)', 'deduction', TRUE, TRUE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  NULL),
  ('retirement_catch_up',    'Retirement catch-up', 'deduction', FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE,  FALSE, NULL)
ON CONFLICT DO NOTHING;
`;
