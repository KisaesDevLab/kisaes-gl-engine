// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// GA state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11).
// Every row cites the primary source it was read in; unverified rows say why. See
// features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const GA_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'GA', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Georgia Form 500-ES 2025 (Rev. 07/24/24) instructions, "Who Must File Estimated Tax" (each individual subject to Georgia income tax)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'required_threshold', value: 1000,
    citation: 'UNVERIFIED MAPPING: Georgia Form 500-ES 2025 (Rev. 07/24/24) instructions require estimates when gross income exceeds exemptions + estimated deductions + $1,000 of income not subject to withholding - an income-based test, not a tax-due threshold. $1,000 stored as the nearest representable figure.',
    status: 'unverified',
  },
  {
    state: 'GA', year: 2025, key: 'safe_harbor.current_pct', value: 0.7,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") line 5 ("Enter 70% of the Amount Shown on Line 3") and Instruction D Exception 2 (70 percent)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") line 4 ("Enter 100% of the Immediately Preceding Year\'s Tax (return must be for a 12-month period)"); line 8 takes the lesser of lines 6 and 7',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later"): no higher-AGI prior-year variant (100% prior or 70% current only)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Georgia Form 500-ES 2025 instructions, "Payment of Estimated Tax" (April 15, June 15, September 15, and the following January 15; "If the due date falls on a weekend or holiday, the tax shall be due on the next day that is not a weekend or holiday"). June 15, 2025 is a Sunday -> 2025-06-16.',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Georgia Form 500-ES 2025 (Rev. 07/24/24) instructions, "Payment of Estimated Tax" (equal installments; "Divide Line 15 by the number of quarters"); Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") Instruction F/Exception 2 (25% per installment)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") Instruction G and farmer worksheet (at least two-thirds of gross income from farming/fishing; 66 2/3% of tax; payments by January 15; file and pay by March 1 to avoid the penalty). March 1, 2026 is a Sunday, so file_by is rolled to 2026-03-02 (seed convention; the state text says "March 1").',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") Instruction A (penalty of 9 percent a year, state-set)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'penalty.rate', value: 0.09,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") line 20 ("Penalty (9 percent a year on amount shown on Line 17 ...)"); IT-511 2025 Booklet ("Failure to File Estimated Tax Penalty - 9 percent")',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'Georgia IT-511 2025 Individual Income Tax Booklet ("Other State\'s Tax Credit Worksheet", Form 500 Schedule 2 credit for taxes paid to another state; "No credit for taxes paid to another state will be allowed unless the other state\'s return is enclosed")',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'nonresident_method', value: 'sourced_flat',
    citation: 'Georgia IT-511 2025 Booklet, Form 500 Schedule 3 (part-year and nonresidents: Georgia taxable income computed from Georgia-source income with exemptions and deductions prorated by the Schedule 3 line 9 ratio, then the Georgia flat rate applied). Prorated-deduction mechanics are not captured by "sourced_flat".',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-11-28', '2025-12-25', '2026-01-01', '2026-01-19', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25'],
    citation: 'UNVERIFIED for 2025 dates: State of Georgia Holiday Schedule (team.georgia.gov/all-articles/state-georgia-holiday-schedule) lists only 2026 and 2027; 2026 dates are as printed there (including Good Friday April 3, the Friday after Thanksgiving, and Washington\'s Birthday observed Dec 24); 2025 dates computed from the same pattern (Good Friday April 18, 2025 assumed state holiday). Calendar years 2025-2026.',
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'GA', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Georgia Form 500-ES 2026 (Rev. 05/12/25) instructions, "Who Must File Estimated Tax" (each individual subject to Georgia income tax)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'required_threshold', value: 1000,
    citation: 'UNVERIFIED MAPPING: Georgia Form 500-ES 2026 (Rev. 05/12/25) instructions require estimates when gross income exceeds exemptions + estimated deductions + $1,000 of income not subject to withholding - an income-based test, not a tax-due threshold. $1,000 stored as the nearest representable figure.',
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'safe_harbor.current_pct', value: 0.7,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") line 5 ("Enter 70% of the Amount Shown on Line 3") and Instruction D Exception 2 (70 percent)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") line 4 ("Enter 100% of the Immediately Preceding Year\'s Tax (return must be for a 12-month period)"); line 8 takes the lesser of lines 6 and 7',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later"): no higher-AGI prior-year variant (100% prior or 70% current only)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Georgia Form 500-ES 2026 instructions, "Payment of Estimated Tax" (April 15, June 15, September 15, and the following January 15; next business day rule)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Georgia Form 500-ES 2026 (Rev. 05/12/25) instructions, "Payment of Estimated Tax" (equal installments; "Divide Line 15 by the number of quarters"); Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") Instruction F/Exception 2 (25% per installment)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") Instruction G and farmer worksheet (at least two-thirds of gross income from farming/fishing; 66 2/3% of tax; payments by January 15; file and pay by March 1 to avoid the penalty).',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") Instruction A (penalty of 9 percent a year, state-set)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'penalty.rate', value: 0.09,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later") line 20 ("Penalty (9 percent a year on amount shown on Line 17 ...)"); IT-511 2025 Booklet ("Failure to File Estimated Tax Penalty - 9 percent")',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'UNVERIFIED for TY2026: IT-511 2025 Booklet "Other State\'s Tax Credit Worksheet"; 2026 booklet not published.',
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'nonresident_method', value: 'sourced_flat',
    citation: 'UNVERIFIED for TY2026: Georgia IT-511 2025 Booklet, Form 500 Schedule 3 (Georgia-source income, prorated deductions, flat rate); 2026 booklet not published.',
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25', '2027-01-01', '2027-01-18', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-11-26', '2027-12-23', '2027-12-24'],
    citation: 'State of Georgia Holiday Schedule (team.georgia.gov/all-articles/state-georgia-holiday-schedule): 2026 and 2027 holidays as printed there (e.g. Good Friday April 3, 2026 and March 26, 2027; Independence Day observed July 3, 2026 and July 5, 2027; Washington\'s Birthday observed Dec 24, 2026 and Dec 23, 2027). Calendar years 2026-2027.',
    status: 'verified',
  },
];
