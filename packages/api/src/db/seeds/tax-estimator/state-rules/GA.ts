// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// GA state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11;
// re-audited against primary sources 2026-10-11). Every row cites the primary source it was read in;
// unverified rows say why. See features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const GA_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'GA', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Georgia Form 500-ES 2025 (Rev. 07/24/24) instructions, "Who Must File Estimated Tax" (each individual subject to Georgia income tax); Georgia IT-511 2025 Individual Income Tax Booklet (dor.georgia.gov/document/document/2025-it-511-individual-income-tax-booklet/download) (flat rate 5.19% for TY2025)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'required_threshold', value: 0,
    citation: 'MAPPING (unverified as a tax-due figure): Georgia has NO tax-due de minimis. Georgia Form 500-ES 2025 (Rev. 07/24/24) instructions "Who must file estimated tax" and Georgia IT-511 2025 Individual Income Tax Booklet (dor.georgia.gov/document/document/2025-it-511-individual-income-tax-booklet/download) p.14 "Estimated Tax" test GROSS INCOME: estimates are required if expected gross income exceeds (1) exemptions + (2) estimated deductions + (3) $1,000 of income not subject to withholding (O.C.G.A. 48-7-114(b) per law.onecle.com copy: more than $1,000 from sources other than wages). O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable) and the Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) contain no minimum-tax exception (unlike the federal $1,000 / other states\' $100-$500 tests). Stored 0 (any underpayment can draw the 9% addition) instead of the previous 1000, which wrongly suppressed estimates/penalty for taxpayers owing under $1,000 of tax. The $1,000 non-withheld-income test is not expressible in required_threshold.',
    status: 'unverified',
  },
  {
    state: 'GA', year: 2025, key: 'safe_harbor.current_pct', value: 0.7,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) line 5 ("Enter 70% of the Amount Shown on Line 3", Line 3 = tax less credits) and Instruction D Exception 2 (70 percent of annualized tax); O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(b)(1) (70 percent of the tax shown on the return)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) line 4 ("Enter 100% of the Immediately Preceding Year\'s Tax (return must be for a 12-month period)"); line 8 takes the lesser of lines 6 and 7; O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(b)(2) (100 percent of prior-year tax, 12-month year, return filed)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) and O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(b): no higher-AGI prior-year variant (100% prior or 70% current only)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Georgia Form 500-ES 2025 (Rev. 07/24/24) instructions, "Payment of Estimated Tax" (April 15, June 15, September 15, and the following January 15; "If the due date falls on a weekend or holiday, the tax shall be due on the next day that is not a weekend or holiday"); Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) Instruction B chart and "substitute the next regular workday". June 15, 2025 is a Sunday -> 2025-06-16.',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Georgia Form 500-ES 2025 (Rev. 07/24/24) instructions, "Payment of Estimated Tax" (equal installments; "Divide Line 15 by the number of quarters"); Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) lines 6-7 and Instruction B (four installments when requirement first met by March 31)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) Instruction G and farmer worksheet (gross income from farming/fishing at least two-thirds of annual gross income; file Form 500 and pay on or before March 1 -> exempt; otherwise penalty on 66 2/3% of Line 3 less amounts paid by January 15); Georgia Form 500-ES 2025 (Rev. 07/24/24) instructions (farmers may file return by March 1 and pay in full); O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(b)(1) (66 2/3 percent for farmers/fishermen). March 1, 2026 is a Sunday, so file_by is rolled to 2026-03-02 (seed convention; the state text says "March 1").',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) Instruction A (penalty of 9 percent a year on the unpaid amount); O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(a) (9 percent per annum). Distinct from the O.C.G.A. 48-2-40 prime+3% interest on late tax.',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'penalty.rate', value: 0.09,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) line 20 ("Penalty (9 percent a year on amount shown on Line 17 for the number of days shown on Line 19)"), form applies to tax years 2025 and later; Georgia IT-511 2025 Individual Income Tax Booklet (dor.georgia.gov/document/document/2025-it-511-individual-income-tax-booklet/download) ("Failure to File Estimated Tax Penalty - 9 percent per year for the period of underpayment"); O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(a)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'Georgia IT-511 2025 Individual Income Tax Booklet (dor.georgia.gov/document/document/2025-it-511-individual-income-tax-booklet/download) p.13 ("A credit for taxes paid to another state is allowed. See the worksheet on page 34") and "Other State\'s Tax Return" (other state\'s return must be enclosed); Form 500 Schedule 2 credit',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'nonresident_method', value: "sourced_flat",
    citation: "Georgia IT-511 2025 booklet (dor.georgia.gov, read 2026-10-12), Form 500 Schedule 3 instructions: \"LINE 13: Multiply Line 12 [deductions and exemptions] by the ratio on Line 9\"; \"LINE 14: Subtract Line 13 from Line 8, Column C [Georgia income]\" = Georgia taxable income, taxed directly. Georgia-source income less prorated deductions = sourced_flat, not a ratio of full-return tax (R5 M6).",
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-11-28', '2025-12-25', '2025-12-26', '2026-01-01', '2026-01-19', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25'],
    citation: 'Georgia.gov "Georgia State Holidays 2025" (georgia.gov/georgia-state-holidays-2025): New Year\'s Day; MLK Jan 20; Washington\'s Birthday "will be observed Friday, December 26"; State Holiday Good Friday April 18; Memorial Day May 26; Juneteenth June 19; Independence Day July 4; Labor Day Sept 1; Columbus Day Oct 13; Veterans Day Nov 11; Thanksgiving Nov 27; State Holiday Nov 28; Christmas Dec 25; State of Georgia Holiday Schedule (team.georgia.gov/all-articles/state-georgia-holiday-schedule, read 2026-10-11): 2026 and 2027 dates as printed (Good Friday state holiday April 3, 2026 / March 26, 2027; Independence Day observed July 3, 2026 / July 5, 2027; Washington\'s Birthday observed Dec 24, 2026 / Dec 23, 2027; Christmas observed Dec 24, 2027). Calendar years 2025-2026. (Correction: added Dec 26, 2025, Washington\'s Birthday observed.)',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'GA', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Georgia Form 500-ES 2026 (Rev. 05/12/25) instructions, "Who Must File Estimated Tax" (each individual subject to Georgia income tax); Georgia IT-511 2025 Individual Income Tax Booklet (dor.georgia.gov/document/document/2025-it-511-individual-income-tax-booklet/download) (flat rate 5.19% for TY2025)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'required_threshold', value: 0,
    citation: 'MAPPING (unverified as a tax-due figure): Georgia has NO tax-due de minimis. Georgia Form 500-ES 2026 (Rev. 05/12/25) instructions "Who must file estimated tax" and Georgia IT-511 2025 Individual Income Tax Booklet (dor.georgia.gov/document/document/2025-it-511-individual-income-tax-booklet/download) p.14 "Estimated Tax" test GROSS INCOME: estimates are required if expected gross income exceeds (1) exemptions + (2) estimated deductions + (3) $1,000 of income not subject to withholding (O.C.G.A. 48-7-114(b) per law.onecle.com copy: more than $1,000 from sources other than wages). O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable) and the Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) contain no minimum-tax exception (unlike the federal $1,000 / other states\' $100-$500 tests). Stored 0 (any underpayment can draw the 9% addition) instead of the previous 1000, which wrongly suppressed estimates/penalty for taxpayers owing under $1,000 of tax. The $1,000 non-withheld-income test is not expressible in required_threshold.',
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'safe_harbor.current_pct', value: 0.7,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) line 5 ("Enter 70% of the Amount Shown on Line 3", Line 3 = tax less credits) and Instruction D Exception 2 (70 percent of annualized tax); O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(b)(1) (70 percent of the tax shown on the return)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) line 4 ("Enter 100% of the Immediately Preceding Year\'s Tax (return must be for a 12-month period)"); line 8 takes the lesser of lines 6 and 7; O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(b)(2) (100 percent of prior-year tax, 12-month year, return filed)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) and O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(b): no higher-AGI prior-year variant (100% prior or 70% current only)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Georgia Form 500-ES 2026 (Rev. 05/12/25) instructions, "Payment of Estimated Tax" (April 15, June 15, September 15, and the following January 15; "If the due date falls on a weekend or holiday, the tax shall be due on the next day that is not a weekend or holiday"); Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) Instruction B chart and "substitute the next regular workday".',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Georgia Form 500-ES 2026 (Rev. 05/12/25) instructions, "Payment of Estimated Tax" (equal installments; "Divide Line 15 by the number of quarters"); Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) lines 6-7 and Instruction B (four installments when requirement first met by March 31)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) Instruction G and farmer worksheet (gross income from farming/fishing at least two-thirds of annual gross income; file Form 500 and pay on or before March 1 -> exempt; otherwise penalty on 66 2/3% of Line 3 less amounts paid by January 15); Georgia Form 500-ES 2026 (Rev. 05/12/25) instructions (farmers may file return by March 1 and pay in full); O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(b)(1) (66 2/3 percent for farmers/fishermen).',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) Instruction A (penalty of 9 percent a year on the unpaid amount); O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(a) (9 percent per annum). Distinct from the O.C.G.A. 48-2-40 prime+3% interest on late tax.',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'penalty.rate', value: 0.09,
    citation: 'Georgia Form 500 UET (Rev. 07/15/25, "For tax years 2025 and later", dor.georgia.gov/document/document/beginning-or-after-january-1-2025-500-uet-underpayment-estimated-tax-individuals/download) line 20 ("Penalty (9 percent a year on amount shown on Line 17 for the number of days shown on Line 19)"), form applies to tax years 2025 and later; Georgia IT-511 2025 Individual Income Tax Booklet (dor.georgia.gov/document/document/2025-it-511-individual-income-tax-booklet/download) ("Failure to File Estimated Tax Penalty - 9 percent per year for the period of underpayment"); O.C.G.A. 48-7-120 (text read via law.onecle.com copy, last modified 2016; official code not reachable)(a)',
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'UNVERIFIED for TY2026: Georgia IT-511 2025 Individual Income Tax Booklet (dor.georgia.gov/document/document/2025-it-511-individual-income-tax-booklet/download) p.13 and Other State\'s Tax Credit Worksheet; the TY2026 booklet is not yet published.',
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'nonresident_method', value: "sourced_flat",
    citation: "Georgia IT-511 2025 booklet (dor.georgia.gov, read 2026-10-12), Form 500 Schedule 3 instructions: \"LINE 13: Multiply Line 12 [deductions and exemptions] by the ratio on Line 9\"; \"LINE 14: Subtract Line 13 from Line 8, Column C [Georgia income]\" = Georgia taxable income, taxed directly. Georgia-source income less prorated deductions = sourced_flat, not a ratio of full-return tax (R5 M6). 2026 booklet not yet published.",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-24', '2026-12-25', '2027-01-01', '2027-01-18', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-11-26', '2027-12-23', '2027-12-24'],
    citation: 'State of Georgia Holiday Schedule (team.georgia.gov/all-articles/state-georgia-holiday-schedule, read 2026-10-11): 2026 and 2027 dates as printed (Good Friday state holiday April 3, 2026 / March 26, 2027; Independence Day observed July 3, 2026 / July 5, 2027; Washington\'s Birthday observed Dec 24, 2026 / Dec 23, 2027; Christmas observed Dec 24, 2027). Calendar years 2026-2027.',
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'GA', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'GA', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'GA', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
