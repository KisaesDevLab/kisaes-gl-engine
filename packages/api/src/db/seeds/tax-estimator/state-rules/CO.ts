// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// CO state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11).
// Every row cites the primary source it was read in; unverified rows say why. See
// features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const CO_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'CO', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Colorado DR 0104EP 2025 Individual Estimated Income Tax Instructions (Colorado income tax at 4.4% of taxable income, worksheet line 2)',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'required_threshold', value: 1000,
    citation: 'Colorado DR 0104EP 2025 Individual Estimated Income Tax Instructions, "General Rule" ("you expect to owe more than $1,000 in net tax"); DR 0204 (09/25/25) Exception 2 "Statutory exemption $1,000.00". Test is strictly more than $1,000.',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'safe_harbor.current_pct', value: 0.7,
    citation: 'Colorado DR 0104EP 2025 Individual Estimated Income Tax Instructions, "Required Payments" (smaller of 70% of actual net Colorado tax liability, or prior-year amounts); DR 0204 (09/25/25) Part 2 line 4(b)',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Colorado DR 0104EP 2025 Individual Estimated Income Tax Instructions, "Required Payments" (100% of the preceding year\'s net Colorado tax if AGI was $150,000 or less, $75,000 or less if MFS; preceding year 12 months and a Colorado return filed)',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'Colorado DR 0104EP 2025 Individual Estimated Income Tax Instructions, "Required Payments" (110% of the preceding year\'s net tax); DR 0204 (09/25/25) Part 2 line 5(b) (preceding-year federal AGI over $150,000, over $75,000 if MFS, adds 10%). MFS $75,000 threshold not expressible.',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Colorado DR 0104EP 2025 payment table (April 15, June 15, September 15, January 15) and "Due Dates: If the due date falls on a weekend or legal holiday, payment will be due the next business day." June 15, 2025 is a Sunday -> 2025-06-16.',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Colorado DR 0204 (09/25/25) Part 3 line 7 ("Divide the amount on line 6 by four", columns April 15 / June 15 / Sept 15 / January 15); annualized alternative 17.5/35/52.5/70% (line 25) not representable',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.5, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'Colorado DR 0104EP 2025 (rev. 07/03/24), "Required Payments" ("If at least 2/3 of your income is from farming or fishing, 50% of the actual net Colorado tax liability") and "Penalties" (farmers/fishermen who file and remit full payment by March 1 excepted); DR 0204 (09/25/25) Exception Number 1 (2/3 of gross income for the current or prior year; file and pay by March 1), line 4(b) ("only enter 50%" if Exception 1 box checked), line 5(b) (no 10% high-AGI addition for farmers), line 7 and instructions Part 3 (single payment by January 15, column four only). 50% is Colorado-specific, NOT the federal 66 2/3%. March 1, 2026 is a Sunday, so file_by is rolled to 2026-03-02 (seed convention; the state text says "March 1").',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Colorado DR 0204 (09/25/25) lines 15 and 18: penalty computed as interest at state-set rates (12% for 2025 days, 11% for 2026 days)',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'penalty.rate', value: 0.12,
    citation: 'Colorado DR 0204 (09/25/25) line 15 (underpayment x 12% for days through the payment date or December 31, 2025) and line 18 (x 11% for days January 1 - April 15, 2026); Tax Topics: Penalties and Interest (Revised October 2025) table "Annual Interest Rates on Tax Underpayments" (2025 regular rate 12%, 2026 11%). CAUTION: single-rate key; days falling in 2026 accrue at 11%.',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'Colorado DR 0104 Booklet 2025, "Lines 27-34 Credit for Tax Paid to Another State" ("Colorado resident individuals may claim a credit for income tax accrued to another state")',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'nonresident_method', value: 'ratio',
    citation: 'Colorado DR 0104 Booklet 2025, "Part-Year Colorado Residents and Nonresidents" and DR 0104PN lines 34-36 (percentage of Colorado income to total income x tax from the tax table = "Apportioned tax")',
    status: 'verified',
  },
  {
    state: 'CO', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-06', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-05', '2026-11-11', '2026-11-26', '2026-12-25'],
    citation: 'UNVERIFIED for 2025 dates: the 2026 dates match the Colorado DOR "Colorado State Holidays" page (tax.colorado.gov/holidays, 2026 only: Cabrini Day Oct 5, Juneteenth Jun 19, Independence Day observed Fri Jul 3; Jul 4 itself not listed, harmless Saturday) and the Colorado Judicial Branch memo "Calendar Year 2026 Holiday Schedule" (Sept 2, 2025, coloradojudicial.gov/media/7751). No official 2025 list could be read (DPA/DHR 2025 schedule PDF and CDHS page returned 403); 2025 dates computed from the same pattern (Cabrini Day 1st Mon Oct = Oct 6, 2025). C.R.S. 24-11-101 not read. Calendar years 2025-2026.',
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'CO', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Colorado DR 0104EP 2026 Individual Estimated Income Tax Instructions (Colorado income tax at 4.4% of taxable income, worksheet line 2)',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'required_threshold', value: 1000,
    citation: 'Colorado DR 0104EP 2026 Individual Estimated Income Tax Instructions, "General Rule" ("you expect to owe more than $1,000 in net tax"); DR 0204 (09/25/25) Exception 2 "Statutory exemption $1,000.00". Test is strictly more than $1,000.',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'safe_harbor.current_pct', value: 0.7,
    citation: 'Colorado DR 0104EP 2026 Individual Estimated Income Tax Instructions, "Required Payments" (smaller of 70% of actual net Colorado tax liability, or prior-year amounts); DR 0204 (09/25/25) Part 2 line 4(b)',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Colorado DR 0104EP 2026 Individual Estimated Income Tax Instructions, "Required Payments" (100% of the preceding year\'s net Colorado tax if AGI was $150,000 or less, $75,000 or less if MFS; preceding year 12 months and a Colorado return filed)',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'Colorado DR 0104EP 2026 Individual Estimated Income Tax Instructions, "Required Payments" (110% of the preceding year\'s net tax); DR 0204 (09/25/25) Part 2 line 5(b) (preceding-year federal AGI over $150,000, over $75,000 if MFS, adds 10%). MFS $75,000 threshold not expressible.',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Colorado DR 0104EP 2026 payment table (April 15, June 15, September 15, January 15, 2027) and next-business-day rule',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Colorado DR 0204 (09/25/25) Part 3 line 7 ("Divide the amount on line 6 by four", columns April 15 / June 15 / Sept 15 / January 15); annualized alternative 17.5/35/52.5/70% (line 25) not representable',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.5, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'Colorado DR 0104EP 2026 (rev. 06/10/25), "Required Payments" ("If at least 2/3 of your income is from farming or fishing, 50% of the actual net Colorado tax liability") and "Penalties" (exception for farmers/fishermen who file and remit full payment by March 1); DR 0204 (09/25/25) Exception Number 1, lines 4(b), 5(b), 7 and instructions Part 3 (single payment by January 15). March 1, 2027 is a Monday (no roll). 50% is Colorado-specific, NOT the federal 66 2/3%.',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'Colorado DOR Tax Topics: Penalties and Interest (Revised October 2025), "Annual Interest Rates on Tax Underpayments" table (state-set calendar-year rates; cites C.R.S. 39-21-109 and 39-21-110.5); DR 0204 (09/25/25) lines 15/18 compute the estimated tax penalty as interest at the regular rate',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'penalty.rate', value: 0.11,
    citation: 'Colorado DOR Tax Topics: Penalties and Interest (Revised October 2025), table "Annual Interest Rates on Tax Underpayments": 2026 regular rate 11% (DR 0204 uses the regular rate). CAUTION: the 2027 rate (for TY2026 underpayment days in January-April 2027) and the 2026 DR 0204 form were not published at research time.',
    status: 'verified',
  },
  {
    state: 'CO', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'UNVERIFIED for TY2026: read in the Colorado DR 0104 Booklet 2025 ("Lines 27-34 Credit for Tax Paid to Another State") and DOR Individual Income Tax Guide; 2026 booklet not published.',
    status: 'unverified',
  },
  {
    state: 'CO', year: 2026, key: 'nonresident_method', value: 'ratio',
    citation: 'UNVERIFIED for TY2026: DR 0104PN lines 34-36 and DR 0104 Booklet 2025 (apportioned tax = table tax x Colorado percentage); 2026 booklet not published.',
    status: 'unverified',
  },
  {
    state: 'CO', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-05', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-05-31', '2027-06-18', '2027-06-19', '2027-07-04', '2027-07-05', '2027-09-06', '2027-10-04', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-25'],
    citation: 'UNVERIFIED for 2027 dates: 2026 dates match the Colorado DOR "Colorado State Holidays" page (tax.colorado.gov/holidays) and the Colorado Judicial Branch "Calendar Year 2026 Holiday Schedule" memo (coloradojudicial.gov/media/7751). 2027 dates computed from the 2026 pattern (Saturday holiday observed Friday: Juneteenth Jun 18, Christmas Dec 24; Sunday observed Monday: Jul 5); no official 2027 list read. C.R.S. 24-11-101 not read. Calendar years 2026-2027.',
    status: 'unverified',
  },
];
