// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// CT state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11).
// Every row cites the primary source it was read in; unverified rows say why. See
// features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const CT_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'CT', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), "Who Is Required to Make Estimated Payments" (Connecticut income tax)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'required_threshold', value: 1000,
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), "Who Is Required to Make Estimated Payments" item 1 (Connecticut income tax after withholding and PE Tax Credit "is $1,000 or more") and Worksheet line 17 ("If less than $1,000, no estimated payment is required")',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), "Your required annual payment is the lesser of 90% of the income tax shown on your 2025 Connecticut income tax return ..." and Worksheet line 13',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), "100% of the income tax shown on your 2024 Connecticut income tax return if you filed ... a 12-month period" and Worksheet line 14',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25): required annual payment is the lesser of 90% current or 100% prior with no higher-AGI 110% variant',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Connecticut Form CT-1040ES 2025, "When to File" (April 15, June 15, September 15, 2025 and January 15, 2026; Saturday/Sunday/legal holiday -> next business day). June 15, 2025 is a Sunday -> 2025-06-16.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), Worksheet line 18 "Installment amount ... 25"',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), Worksheet line 13 ("90% (66 2/3% for farmers and fishermen)") and "Interest" (farmer filing by March 1 and paying in full owes no underpayment interest); DRS Informational Publication 2021(2) Q&A 32 (farmers make one payment due January 15; IRC 6654(i)(2) definition). March 1, 2026 is a Sunday, so file_by is rolled to 2026-03-02 (seed convention; the state text says "March 1").',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), "Interest" (interest at 1% per month or fraction of a month, set by Connecticut statute)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'penalty.rate', value: 0.12,
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), "Interest" ("Interest at 1% per month or fraction of a month will be added to the tax due until the earlier of April 15 or the date the underpayment is paid"). Stored as 12% annual; actual accrual is 1% per month or fraction thereof.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), Worksheet line 7 "Credit for income taxes paid to qualifying jurisdictions" (residents and part-year residents)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'nonresident_method', value: 'ratio',
    citation: 'Connecticut Form CT-1040ES 2025 (Rev. 01/25), Worksheet line 5 "Apportionment Factor" (Connecticut-sourced income / Connecticut AGI, applied to income tax computed on all income, line 6)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-12', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-12', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    citation: 'Connecticut Official State Website "Legal State Holidays" (portal.ct.gov/about/legal-state-holidays) rules under C.G.S. 1-4 (Sunday -> following Monday, Saturday -> preceding Friday); Good Friday and Thanksgiving are governor-designated. Dates computed from the rules. Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'CT', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), "Who Is Required to Make Estimated Payments" (Connecticut income tax)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'required_threshold', value: 1000,
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), "Who Is Required to Make Estimated Payments" item 1 (Connecticut income tax after withholding and PE Tax Credit "is $1,000 or more") and Worksheet line 17 ("If less than $1,000, no estimated payment is required")',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), "Your required annual payment is the lesser of 90% of the income tax shown on your 2026 Connecticut income tax return ..." and Worksheet line 13',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), "100% of the income tax shown on your 2025 Connecticut income tax return if you filed ... a 12-month period" and Worksheet line 14',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26): required annual payment is the lesser of 90% current or 100% prior with no higher-AGI 110% variant',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), "When to File" (April 15, June 15, September 15, 2026 and January 15, 2027; next business day if weekend/legal holiday)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), Worksheet line 18 "Installment amount ... 25"',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), Worksheet line 13 ("90% (66 2/3% for farmers and fishermen)") and "Interest" (farmer filing by March 1 and paying in full owes no underpayment interest); DRS Informational Publication 2021(2) Q&A 32 (farmers make one payment due January 15; IRC 6654(i)(2) definition).',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), "Interest" (interest at 1% per month or fraction of a month, set by Connecticut statute)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'penalty.rate', value: 0.12,
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), "Interest" ("Interest at 1% per month or fraction of a month will be added to the tax due until the earlier of April 15 or the date the underpayment is paid"). Stored as 12% annual; actual accrual is 1% per month or fraction thereof.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), Worksheet line 7 "Credit for income taxes paid to qualifying jurisdictions" (residents and part-year residents)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'nonresident_method', value: 'ratio',
    citation: 'Connecticut Form CT-1040ES 2026 (Rev. 01/26), Worksheet line 5 "Apportionment Factor" (Connecticut-sourced income / Connecticut AGI, applied to income tax computed on all income, line 6)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-12', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-12', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-06-19', '2027-07-04', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-25'],
    citation: 'Connecticut Official State Website "Legal State Holidays" (portal.ct.gov/about/legal-state-holidays) rules under C.G.S. 1-4. Dates computed from the rules. Calendar years 2026-2027.',
    status: 'verified',
  },
];
