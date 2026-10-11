// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// AL state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11).
// Every row cites the primary source it was read in; unverified rows say why. See
// features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const AL_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'AL', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Alabama Dept. of Revenue Form 40ES 2026 Instructions ("Who Must Pay Estimated Tax"); Form 2210AL (2025) Part I (Alabama income tax with $500 estimate threshold)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'required_threshold', value: 500,
    citation: 'Alabama Form 40 Booklet for TY2024 (24f40bk.pdf, Section 4 "Estimated Tax": "Every individual who reasonably expects to owe at least $500 in tax in 2025 is required to file and pay estimated tax"); Form 2210AL (2025) Part I line 6 ("If less than $500, stop; you do not owe a penalty")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Form 2210AL (2025) Part I line 4 ("Multiply line 3 by 90% (.90)"); Form 40 Booklet TY2024, "Underpayment Penalty" (90% of tax)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'UNVERIFIED for TY2025: the 2025 Form 40ES instructions could not be retrieved (25f40esinstr.pdf returns 404). Consistent evidence: Form 40 Booklet TY2024 ("100% of your 2023 tax"), Form 2210AL (2025) line 7 "maximum required annual payment based on prior year\'s tax", Form 40ES 2026 Instructions item 2b (100% of 2025 tax; 12-month return).',
    status: 'unverified',
  },
  {
    state: 'AL', year: 2025, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'UNVERIFIED for TY2025: 2025 Form 40ES instructions not retrievable. Form 2210AL instructions for TY2024 (24f2210al_inst.pdf: "If your AGI for 2024 was more than $150,000 ($75,000 if ... married filing separately), substitute 110% for 100%") and Form 40ES 2026 Instructions "Special Rule for Higher Income Taxpayers" both state it; MFS threshold is $75,000 (single value stored).',
    status: 'unverified',
  },
  {
    state: 'AL', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Form 2210AL (2025) Part III payment due dates 4/15/25, 6/15/25, 9/15/25, 1/15/26; weekend/holiday roll per Form 40ES 2026 Instructions "Payment of Estimated Tax" ("If the 15th falls on a Saturday, Sunday, or State holiday, the due date will then be considered the following business day"). June 15, 2025 is a Sunday -> 2025-06-16 (roll rule read in the 2026 instructions; applied to 2025).',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Form 2210AL (2025) Part III line 1 ("enter 25% (.25) of Part I, line 8 ... in each column")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'PARTLY UNVERIFIED: Form 2210AL (2025) Part IV (66 2/3% of 2025 tax, payments by January 15, 2026, farmers with at least two-thirds of 2024 or 2025 gross income from farming/fishing) read; the March 1 file-and-pay alternative was read only in Form 40 Booklet TY2024 ("total tax by March 1, 2025") and 2026 instructions ("March 1, 2027"). March 1, 2026 is a Sunday, so file_by is rolled to 2026-03-02 (seed convention; the state text says "March 1").',
    status: 'unverified',
  },
  {
    state: 'AL', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Form 2210AL (2025) Part III line 11 and Part IV line 13 apply a state-set rate ("x .07"); Alabama Code 40-2A-11 / 40-18-80 per Form 2210AL instructions',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'penalty.rate', value: 0.07,
    citation: 'Form 2210AL (2025) Part III line 11 ("Underpayment X No. of days on line 10 X .07 / 365", period April 16, 2025 - April 15, 2026) and Part IV line 13 ("X 0.07")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'UNVERIFIED for TY2025: read only in the Alabama Form 40 Booklet for TY2024, Form 40A eligibility ("You are not claiming credit for taxes paid to another state") and Form 40NR booklet (line "Taxes paid to another state"). Code of Alabama 40-18-21 not read.',
    status: 'unverified',
  },
  {
    state: 'AL', year: 2025, key: 'nonresident_method', value: 'other',
    citation: 'UNVERIFIED for TY2025: Form 40NR Booklet TY2024, "Page 2, Part III"/Part II: personal and dependent exemptions and itemized/standard deductions are prorated by the ratio of Alabama income to total income, then tax rates apply to Alabama taxable income - neither a ratio of the full return nor a flat rate. 2025/2026 booklets not read.',
    status: 'unverified',
  },
  {
    state: 'AL', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-28', '2025-05-26', '2025-06-02', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-11-28', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-27', '2026-05-25', '2026-06-01', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25'],
    citation: 'UNVERIFIED for 2025 dates: State of Alabama 2026 Official State Holidays (rsa-al.gov/about-rsa/holidays: "Holidays that fall on Sunday are observed on Monday; holidays that fall on Saturday are observed on Friday") read for 2026 only; 2025 and 2027 dates computed from the same pattern, no official 2025 or 2027 list retrieved. Mardi Gras (Mobile/Baldwin counties only) and Mrs. Rosa L. Parks Day (commemorative) omitted. Calendar years 2025-2026.',
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'AL', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Alabama Dept. of Revenue Form 40ES 2026 Instructions ("Who Must Pay Estimated Tax"); Form 2210AL (2025) Part I (Alabama income tax with $500 estimate threshold)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'required_threshold', value: 500,
    citation: 'Alabama Form 40ES 2026 Instructions, "General Rule" item 1 ("You expect to owe at least $500 in tax for 2026, after subtracting your withholding and credits"); "Penalties for Underpayment" ($500)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Alabama Form 40ES 2026 Instructions, "General Rule" item 2a ("90% of the tax to be shown on your 2026 tax return")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Alabama Form 40ES 2026 Instructions, "General Rule" item 2b ("100% of the tax shown on your 2025 tax return. Your 2025 tax return must cover all 12 months")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'Alabama Form 40ES 2026 Instructions, "Special Rule for Higher Income Taxpayers" (Alabama AGI for 2025 more than $150,000, or $75,000 if married filing separately, substitute 110% for 100%). MFS $75,000 threshold not expressible.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Alabama Form 40ES 2026 Instructions, "Payment of Estimated Tax" (April 15, 2026, June 15, 2026, September 15, 2026 and January 15, 2027; roll to next business day). 2026 dates fall on weekdays.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Alabama Form 40ES 2026 Instructions, "Payment of Estimated Tax" ("equal installments"); voucher table (1/4, 1/3, 1/2, all of line 11)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'Alabama Form 40ES 2026 Instructions, "Farmers" (at least 2/3 of gross income from farming; pay on or before January 15, 2027; file by March 1, 2027 and pay total tax -> no estimates); Form 2210AL (2025) Part IV line 4 uses 66 2/3% for the penalty test.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'Form 2210AL (2025) shows the penalty as a state-set annual rate; Alabama Code 40-2A-11 / 40-18-80 (per Form 2210AL instructions)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: 'UNVERIFIED for TY2026: the 2026 Form 2210AL is not published. 0.07 carried from Form 2210AL (2025) line 11; Alabama DOR notices cite a quarterly rate under Code 40-1-44 (6% for Q2 2026, 7% from July 2026, per Bloomberg Tax/DOR notice summaries), so the rate may differ.',
    status: 'unverified',
  },
  {
    state: 'AL', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'UNVERIFIED for TY2026: read only in the Alabama Form 40 Booklet for TY2024, Form 40A eligibility ("You are not claiming credit for taxes paid to another state") and Form 40NR booklet (line "Taxes paid to another state"). Code of Alabama 40-18-21 not read.',
    status: 'unverified',
  },
  {
    state: 'AL', year: 2026, key: 'nonresident_method', value: 'other',
    citation: 'UNVERIFIED for TY2026: Form 40NR Booklet TY2024, "Page 2, Part III"/Part II: personal and dependent exemptions and itemized/standard deductions are prorated by the ratio of Alabama income to total income, then tax rates apply to Alabama taxable income - neither a ratio of the full return nor a flat rate. 2025/2026 booklets not read.',
    status: 'unverified',
  },
  {
    state: 'AL', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-27', '2026-05-25', '2026-06-01', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-26', '2027-05-31', '2027-06-07', '2027-06-18', '2027-06-19', '2027-07-04', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-11-26', '2027-12-24', '2027-12-25'],
    citation: 'UNVERIFIED for 2027 dates: State of Alabama 2026 Official State Holidays (rsa-al.gov/about-rsa/holidays) read for 2026 (matches this list); 2027 dates computed from the same pattern (no official 2027 list retrieved). Mardi Gras and Parks Day omitted. Calendar years 2026-2027.',
    status: 'unverified',
  },
];
