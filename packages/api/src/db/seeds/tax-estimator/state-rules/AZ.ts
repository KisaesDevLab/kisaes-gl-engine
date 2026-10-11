// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// AZ state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11).
// Every row cites the primary source it was read in; unverified rows say why. See
// features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const AZ_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'AZ', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Arizona Form 140ES 2025 Instructions ("Required Payments") (Arizona estimated income tax payments for individuals; flat 2.5% rate stated in 2025 instructions)',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'required_threshold', value: 0,
    citation: 'UNVERIFIED MAPPING: Arizona has no tax-due threshold. Arizona Form 140ES 2025 Instructions ("Required Payments") requires estimates only if Arizona gross income for the prior year AND the current year each exceed $75,000 ($150,000 married filing joint; $75,000 single/MFS/HOH). Key cannot express a gross-income test; 0 stored (always show estimates; penalty exposure only above the gross-income test).',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Arizona Form 140ES 2025 Instructions ("Required Payments"): payments plus withholding "must total either 90% of the tax due for the current year, or 100% of the tax due for the prior year"',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Arizona Form 140ES 2025 Instructions ("Required Payments"): 100% of prior-year tax, usable only if the prior-year Arizona return was required and filed',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'Arizona Form 140ES 2025 Instructions ("Required Payments"): no 110% or AGI-based prior-year variant stated (only 90% current or 100% prior)',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Arizona Form 140ES 2025 Instructions, due-date table (April 15, 2025; June 15 "Because June 15, 2025 falls on a weekend, you have until June 16"; September 15; January 15, 2026) and Note ("Saturday, Sunday, or legal holiday ... next business day")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Arizona Form 140ES 2025 Instructions ("Required Payments"), "When Should I Make My Estimated Payments?" ("you must make your payments in four equal installments")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'PARTLY UNVERIFIED: Arizona Form 140ES 2025 Instructions item 2 (farmer/fisherman "for federal purposes" makes one installment due January 15, 2026; no estimate required if the return is filed on or before March 1, 2026 and paid in full) read. The two-thirds ratio and 66 2/3% current-year percent are not stated by Arizona (it incorporates the federal IRC 6654(i) farmer definition) and are federal values. March 1, 2026 is a Sunday, so file_by is rolled to 2026-03-02 (seed convention; the state text says "March 1").',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Arizona Form 140ES 2025 Instructions ("The penalty is equal to the interest that would accrue on the underpayment ... cannot be more than 10%"); azdor.gov Interest Rates page (federal short-term rate + 3 points, set quarterly by Arizona)',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'penalty.rate', value: 0.07,
    citation: 'azdor.gov Interest Rates table (business/interest-rates): 7% for 1/1/2025-12/31/2025 and 7% for 1/1/2026-3/31/2026; Form 221 instructions. CAUTION: the rate is set quarterly (6% for 4/1/2026-6/30/2026), so days after March 31, 2026 accrue below 7%; penalty is capped at 10% of the underpayment.',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'Arizona Form 140 Booklet 2025, Credit for Taxes Paid to Another State ("Credit Form 309 is used to claim a tax credit on Form 140 for taxes paid to other states ...")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'nonresident_method', value: 'sourced_flat',
    citation: 'Arizona Form 140NR Booklet 2025: Arizona-source income taxed at the flat 2.5% rate (2025 Form 140ES instruction: "the tax rate for estimating your tax liability is 2.5%"); standard deduction prorated by the Arizona income ratio ("You must prorate the standard deduction").',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-02', '2025-07-04', '2025-08-14', '2025-09-01', '2025-09-17', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-02', '2026-07-03', '2026-07-04', '2026-08-14', '2026-09-07', '2026-09-17', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    citation: 'A.R.S. 1-301 (azleg.gov/ars/1/00301.htm) legal holidays and Sunday-to-Monday (except Native American Day, Navajo Code Talkers Day, Constitution Commemoration Day) / Saturday-to-Friday (New Year, Independence Day, Veterans Day, Christmas) rules; A.R.S. 1-303 next business day. Dates computed from the statute. Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'AZ', year: 2026, key: 'has_income_tax', value: true,
    citation: 'azdor.gov Individual Estimated Tax Payments page and Arizona Form 140ES 2026 Booklet ("Required Payments") (Arizona estimated income tax payments for individuals; flat 2.5% rate stated in 2025 instructions)',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'required_threshold', value: 0,
    citation: 'UNVERIFIED MAPPING: Arizona has no tax-due threshold. azdor.gov Individual Estimated Tax Payments page and Arizona Form 140ES 2026 Booklet ("Required Payments") requires estimates only if Arizona gross income for the prior year AND the current year each exceed $75,000 ($150,000 married filing joint; $75,000 single/MFS/HOH). Key cannot express a gross-income test; 0 stored (always show estimates; penalty exposure only above the gross-income test).',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'azdor.gov Individual Estimated Tax Payments page and Arizona Form 140ES 2026 Booklet ("Required Payments"): payments plus withholding "must total either 90% of the tax due for the current year, or 100% of the tax due for the prior year"',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'azdor.gov Individual Estimated Tax Payments page and Arizona Form 140ES 2026 Booklet ("Required Payments"): 100% of prior-year tax, usable only if the prior-year Arizona return was required and filed',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'azdor.gov Individual Estimated Tax Payments page and Arizona Form 140ES 2026 Booklet ("Required Payments"): no 110% or AGI-based prior-year variant stated (only 90% current or 100% prior)',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Arizona Form 140ES 2026 Booklet due-date table and azdor.gov Individual Estimated Tax Payments page (April 15, June 15, September 15, 2026 and January 15, 2027); next-business-day note',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'azdor.gov Individual Estimated Tax Payments page and Arizona Form 140ES 2026 Booklet ("Required Payments"), "When Should I Make My Estimated Payments?" ("you must make your payments in four equal installments")',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'PARTLY UNVERIFIED: Arizona Form 140ES 2026 Booklet item 2 (one installment due January 15, 2027; no payment required if the 2026 return is filed on or before March 1, 2027 and paid in full) read. Ratio 2/3 and 66 2/3% are the federal IRC 6654(i) values Arizona incorporates by reference, not stated by Arizona.',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'Arizona Form 140ES 2026 Booklet / Form 221 Instructions (penalty equals interest accruing on the underpayment, capped at 10%); azdor.gov Interest Rates page',
    status: 'verified',
  },
  {
    state: 'AZ', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: 'UNVERIFIED for TY2026: Arizona sets the rate quarterly; azdor.gov Interest Rates table shows 7% (Q1 2026), 6% (Q2 2026), 7% (Q3 2026); the Q4 2026 and 2027 rates were not published at research time. 0.07 is the latest observed rate.',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'UNVERIFIED for TY2026: Arizona Form 140 Booklet 2025, Credit for Taxes Paid to Another State ("Credit Form 309 is used to claim a tax credit on Form 140 for taxes paid to other states ...") - 2025 booklet; the 2026 booklet is not yet published',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'nonresident_method', value: 'sourced_flat',
    citation: 'UNVERIFIED for TY2026: Arizona Form 140NR Booklet 2025: Arizona-source income taxed at the flat 2.5% rate (2025 Form 140ES instruction: "the tax rate for estimating your tax liability is 2.5%"); standard deduction prorated by the Arizona income ratio ("You must prorate the standard deduction"). 2026 booklet not published; 2.5% rate per 2026 Form 140ES booklet worksheet.',
    status: 'unverified',
  },
  {
    state: 'AZ', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-02', '2026-07-03', '2026-07-04', '2026-08-14', '2026-09-07', '2026-09-17', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-02', '2027-07-04', '2027-07-05', '2027-08-14', '2027-09-06', '2027-09-17', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-25'],
    citation: 'A.R.S. 1-301 (azleg.gov/ars/1/00301.htm) legal holidays and observance rules; A.R.S. 1-303 next business day. Dates computed from the statute. Calendar years 2026-2027.',
    status: 'verified',
  },
];
