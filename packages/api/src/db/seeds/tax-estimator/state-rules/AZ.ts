// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// AZ state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11;
// re-audited against primary sources 2026-10-11). Every row cites the primary source it was read in;
// unverified rows say why. See features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
// Statutory frame: A.R.S. 43-581 (requirement, 90%/100%, four installments, $1,000 no-penalty floor),
// 42-1125(Q) (penalty = interest under 42-1123, capped at 10%), 42-1123 (federal short-term rate + 3).
export const AZ_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'AZ', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Arizona Form 140ES 2025 Instructions ("Required Payments"; "For tax year 2025 estimated tax payments, the tax rate for estimating your tax liability is 2.5%"); A.R.S. 43-581(A)',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'required_threshold', value: 1000,
    citation: 'PARTIAL MAPPING: A.R.S. 43-581(A) requires estimates only when Arizona gross income exceeds $75,000 ($150,000 joint) for BOTH the current and the preceding year (Form 140ES 2025 Instructions "Required Payments" table; Form 221 2025 Instructions "Am I Subject to the Penalty?"). A.R.S. 43-581(E)(2) bars penalty and interest when "Arizona income tax liability due on the taxpayer\'s return" (tax minus withholding and credits) is less than $1,000; Form 221 (2025) Instructions line 6 ("If less than $1,000, you do not owe the penalty"). $1,000 is the only tax-due figure Arizona uses, so it is stored here; the gross-income gate (an additional AND condition) cannot be expressed by this key.',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'A.R.S. 43-581(A) ("at least ninety percent of the tax due for the current taxable year"); Arizona Form 140ES 2025 Instructions ("How Much Should My Estimated Payments Total?"); Form 221 (2025) line 7 ("Multiply line 4 by 90% (.90)")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'A.R.S. 43-581(A) ("one hundred percent of the tax due for the preceding taxable year"); Arizona Form 140ES 2025 Instructions (100% of 2024 tax, usable only if a 2024 Arizona return was required and filed); Form 221 (2025) Instructions line 8',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'A.R.S. 43-581(A) states only 90% current or 100% preceding year, with no 110% or AGI-based variant; Form 221 (2025) Instructions lines 7-9 (smaller of 90% current or prior-year liability) likewise',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Arizona Form 140ES 2025 Instructions, due-date table (April 15, 2025; June 15, 2025 "Because June 15, 2025 falls on a weekend, you have until June 16" [form misprints 2024]; September 15, 2025; January 15, 2026) and Note ("Saturday, Sunday, or legal holiday ... next business day"); A.R.S. 43-581(A) (IRC due dates); A.R.S. 1-303',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'A.R.S. 43-581(A) ("paid in four installments"); Arizona Form 140ES 2025 Instructions ("you must make your payments in four equal installments"); Form 221 (2025) Instructions line 11 ("Divide the amount on line 9 by four (4)")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "Arizona Form 221 (2025) instructions (azdor.gov, read 2026-10-12): farmer or fisherman \"for federal purposes\" makes ONE installment due January 15, 2026, or no payment if the return is filed by March 1, 2026 and paid in full; required annual payment is 90% of 2025 tax (Line 7 \"Multiply the amount on line 4 by 90%\") or 100% of 2024 tax for everyone — Arizona has no reduced farmer percentage (R5 M3). A.R.S. 43-581. March 1, 2026 (Sunday) stored rolled to March 2. Ratio = federal two-thirds test.",
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'A.R.S. 43-581(E) and 42-1125(Q) (penalty equal to interest under 42-1123 "not exceeding ten percent of the amount not paid"); A.R.S. 42-1123(A) (federal short-term rate + 3 points, compounded annually); Form 221 (2025) Part B rate periods',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'penalty.rate', value: 0.07,
    citation: 'Form 221 (2025) lines 16, 19, 22 (Rate Periods One-Three: 7% for Apr-15-25 through Dec-31-25; Rate Period Four Jan-1-26 through Apr-15-26 "to be determined"); azdor.gov/business/interest-rates (7% for 1/1/2025-12/31/2025 and 1/1/2026-3/31/2026; 6% for 4/1/2026-6/30/2026). CAUTION: April 1-15, 2026 accrues at 6%; the penalty is capped at 10% of the underpayment and compounds on January 1.',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'A.R.S. 43-1071(A) (resident credit for net income taxes paid to another state on income sourced there, limited to the proportional Arizona tax); Arizona Form 140 Instructions 2025 ("Credit Form 309 is used to claim a tax credit on Form 140 for taxes paid to other states or country")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'nonresident_method', value: 'sourced_flat',
    citation: 'A.R.S. 43-1091(A) (nonresident Arizona gross income = Arizona-source portion of federal AGI), 43-1094(B) and 43-1095 (exemptions and standard/itemized deductions allowed in the Arizona-gross-income percentage); Arizona Form 140NR Instructions 2025 ("You must prorate the standard deduction"; Line 56 "Multiply line 55 by 2.5% (.025)").',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    citation: 'A.R.S. 1-301 (azleg.gov/ars/1/00301.htm): weekday holidays New Year, MLK/Civil Rights Day (3rd Mon Jan), Lincoln/Washington Presidents\' Day (3rd Mon Feb), Memorial Day, July 4, Labor Day, Columbus Day (2nd Mon Oct), Veterans\' Day, Thanksgiving (4th Thu Nov), Christmas; Sunday -> Monday (1-301(B)); New Year/July 4/Veterans/Christmas on Saturday -> preceding Friday (1-301(C)). Native American Day (June 2), Navajo Code Talkers Day (Aug 14) and Constitution Commemoration Day (Sept 17) are OMITTED because 1-301(D)-(F) observe them on a Sunday whenever the date is not a Sunday. A.R.S. 1-303 next business day. Dates computed from the statute. Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'AZ', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Arizona Form 140ES 2026 Booklet ("Required Payments"; worksheet line 19 "Multiply line 18 by 2.5% (.025)"); A.R.S. 43-581(A)',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'required_threshold', value: 1000,
    citation: 'PARTIAL MAPPING: A.R.S. 43-581(A) and Arizona Form 140ES 2026 Booklet ("Required Payments" table: Arizona gross income for 2025 greater than $75,000 AND for 2026 exceeds $75,000; $150,000 married filing joint) gate the requirement on gross income; A.R.S. 43-581(E)(2) bars penalty and interest when tax due on the return after withholding and credits is less than $1,000. $1,000 is the only tax-due figure Arizona uses, so it is stored here; the gross-income gate cannot be expressed by this key.',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'A.R.S. 43-581(A); Arizona Form 140ES 2026 Booklet ("must total either 90% of the tax due for 2026, or 100% of the tax due for 2025"; worksheet line 22 "Enter 90% (.90) of line 21")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'A.R.S. 43-581(A); Arizona Form 140ES 2026 Booklet (100% of 2025 tax, usable only if a 2025 Arizona return was required and filed; worksheet line 23)',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'A.R.S. 43-581(A) states only 90% current or 100% preceding year (no 110% or AGI-based variant); Arizona Form 140ES 2026 Booklet worksheet lines 22-24 likewise',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Arizona Form 140ES 2026 Booklet due-date table (April 15, June 15, September 15, 2026 and January 15, 2027) and next-business-day note; all four dates are business days',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'A.R.S. 43-581(A) ("paid in four installments"); Arizona Form 140ES 2026 Booklet ("you must make your payments in four equal installments")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Arizona Form 140ES 2026 / Form 221 pattern: farmer or fisherman for federal purposes makes one installment by January 15, 2027 or files and pays by March 1, 2027; percentage is the general 90% (Form 221 (2025) Line 7, read 2026-10-12) — no reduced farmer percentage (R5 M3). 2026 Form 221 not yet published.",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'A.R.S. 43-581(E), 42-1125(Q) (penalty equal to interest under 42-1123, capped at 10% of the amount not paid) and 42-1123(A) (federal short-term rate + 3 points, compounded annually); Arizona Form 140ES 2026 Booklet ("The penalty cannot be more than 10% of the underpayment")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: 'UNVERIFIED for the full TY2026 period: azdor.gov/business/interest-rates shows 6% for 4/1/2026-6/30/2026 and 7% for 7/1/2026-12/31/2026; the rate for 1/1/2027-4/15/2027 is not yet published. 0.07 is the rate for most of the published period. Penalty capped at 10% of the underpayment.',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'A.R.S. 43-1071(A) (current text: resident credit for net income taxes paid to another state on income sourced there; no sunset); Arizona Form 140 Instructions 2025 (Credit Form 309)',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'nonresident_method', value: 'sourced_flat',
    citation: 'A.R.S. 43-1091(A) (nonresident Arizona gross income = Arizona-source portion of federal AGI), 43-1094(B) and 43-1095 (exemptions and deductions prorated by the Arizona-gross-income percentage); 2.5% rate per Arizona Form 140ES 2026 Booklet worksheet line 19; method as in Form 140NR Instructions 2025 (2026 instructions not yet published).',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-07-04', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-25'],
    citation: 'A.R.S. 1-301 (azleg.gov/ars/1/00301.htm) weekday holidays and observance rules (Sunday -> Monday; New Year/July 4/Veterans/Christmas on Saturday -> Friday); Native American Day, Navajo Code Talkers Day and Constitution Commemoration Day omitted because 1-301(D)-(F) move their observance to a Sunday. A.R.S. 1-303 next business day. Dates computed from the statute. Calendar years 2026-2027.',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2025, key: 'penalty.min_balance_due', value: 1000,
    citation: "Arizona Form 221 (2025) instructions, azdor.gov, read 2026-10-12, Line 6: \"Subtract line 5 from line 4. If less than $1,000, you do not owe the penalty, stop here and do not file Form 221.\" The requirement itself is the two-year gross-income gate ($75,000 / $150,000 MFJ, Form 221 \"Am I Subject to the Penalty?\"), not this amount.",
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'penalty.min_balance_due', value: 1000,
    citation: "Arizona Form 221 (2025) Line 6 (\"If less than $1,000, you do not owe the penalty\"); 2026 Form 221 not yet published. A.R.S. 43-581(E)(2).",
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2025, key: 'requirement_gate', value: { kind: 'gross_income_both_years', threshold: 75000, threshold_mfj: 150000 },
    citation: 'A.R.S. 43-581(A) (estimated payments required only when Arizona gross income exceeds $75,000, or $150,000 for a married couple filing jointly, in BOTH the preceding and the current taxable year); Arizona Form 140ES 2025 Instructions "Required Payments" table; Form 221 (2025) Instructions "Am I Subject to the Penalty?" (same two-year test). Phase 8 D12b gate key (2026-10-12); the tax-due $1,000 stays in required_threshold / penalty.min_balance_due as the additional condition. Not yet CPA-verified.',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'requirement_gate', value: { kind: 'gross_income_both_years', threshold: 75000, threshold_mfj: 150000 },
    citation: 'A.R.S. 43-581(A); Arizona Form 140ES 2026 Booklet "Required Payments" table (Arizona gross income for 2025 greater than $75,000 AND for 2026 exceeds $75,000; $150,000 married filing joint). Phase 8 D12b gate key (2026-10-12); the tax-due $1,000 stays in required_threshold / penalty.min_balance_due as the additional condition. Not yet CPA-verified.',
    status: 'unverified',
  },
];
