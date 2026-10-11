// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// DE state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11).
// Every row cites the primary source it was read in; unverified rows say why. See
// features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const DE_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'DE', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 2 and Tax Computation Schedule (graduated Delaware income tax)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'required_threshold', value: 800,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 2 ("if the tax due in excess of withholding can reasonably be expected to exceed $800.00")',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 10(a) (installments at least 90 percent of the amount due on the return)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 10(b) (100% of the tax shown on the prior year\'s return)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 10(b) ("110% if the federal adjusted gross income for the previous tax year is in excess of $150,000 ($75,000 if married filing separate)"). MFS threshold not expressible.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'installments.due_dates', value: ['2025-04-30', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 8 (equal installments on or before April 30, June 15, September 15, and January 15 of the following year; first installment April 30). June 15, 2025 is a Sunday -> 2025-06-16 (weekend roll assumed; no roll text in the instructions).',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 8 ("in equal installments") and Tax Computation Schedule quarterly payment (line total / 4)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 5 (at least two-thirds of gross income from farming/fishing: file a Declaration by January 15 and pay the entire estimated tax, or file the return and pay in full on or before March 1) and Instruction 10(a) (66 2/3% for farmers and fishermen). March 1, 2026 is a Sunday, so file_by is rolled to 2026-03-02 (seed convention; the state text says "March 1").',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 10 (penalty of 1 1/2% per month or fraction thereof on the underpayment of any installment)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'penalty.rate', value: 0.18,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Instruction 10 ("A penalty of 1 1/2% per month or fraction thereof"). Stored as 18% annual; actual accrual is 1.5% per month or fraction thereof.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), Tax Computation Schedule line 8(b) ("credit for income tax paid to another state"); Delaware PIT-RES instructions Schedule I "Credit for Income Taxes Paid to Another State"',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'nonresident_method', value: 'ratio',
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, revenuefiles.delaware.gov/2024/.../PIT-EST_2025-01_Instructions.pdf), "Special Note" ("a non-resident computes Delaware income tax as though all of your income is Delaware income. You then pay the percentage of a resident\'s tax represented by the percentage of Delaware income")',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-04-18', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-11', '2025-11-27', '2025-11-28', '2025-12-25', '2026-01-01', '2026-01-19', '2026-04-03', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-11-03', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25'],
    citation: 'Delaware Code Title 1 section 501 (delcode.delaware.gov/title1/c005): New Year, MLK (3rd Mon Jan), Good Friday, Juneteenth, July 4, Labor Day, Veterans Day, Thanksgiving, Friday after Thanksgiving, Christmas, general election day (even years), with Sunday -> Monday and Saturday -> preceding Friday (501(b)). Sussex County Return Day (afternoon, one county) omitted. Dates computed. Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'DE', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 2 and Tax Computation Schedule (graduated Delaware income tax)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'required_threshold', value: 800,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 2 ("if the tax due in excess of withholding can reasonably be expected to exceed $800.00")',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 10(a) (installments at least 90 percent of the amount due on the return)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 10(b) (100% of the tax shown on the prior year\'s return)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 10(b) ("110% if the federal adjusted gross income for the previous tax year is in excess of $150,000 ($75,000 if married filing separate)"). MFS threshold not expressible.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'installments.due_dates', value: ['2026-04-30', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 8 (equal installments on or before April 30, June 15, September 15, and January 15 of the following year; first installment April 30). All 2026 dates are weekdays.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 8 ("in equal installments") and Tax Computation Schedule quarterly payment (line total / 4)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 5 (at least two-thirds of gross income from farming/fishing: file a Declaration by January 15 and pay the entire estimated tax, or file the return and pay in full on or before March 1) and Instruction 10(a) (66 2/3% for farmers and fishermen).',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 10 (penalty of 1 1/2% per month or fraction thereof on the underpayment of any installment)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'penalty.rate', value: 0.18,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Instruction 10 ("A penalty of 1 1/2% per month or fraction thereof"). Stored as 18% annual; actual accrual is 1.5% per month or fraction thereof.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), Tax Computation Schedule line 8(b) ("credit for income tax paid to another state"); Delaware PIT-RES instructions Schedule I "Credit for Income Taxes Paid to Another State"',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'nonresident_method', value: 'ratio',
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, rev. 11/10/25), "Special Note" ("a non-resident computes Delaware income tax as though all of your income is Delaware income. You then pay the percentage of a resident\'s tax represented by the percentage of Delaware income")',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-04-03', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-11-03', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25', '2027-01-01', '2027-01-18', '2027-03-26', '2027-06-18', '2027-06-19', '2027-07-04', '2027-07-05', '2027-09-06', '2027-11-11', '2027-11-25', '2027-11-26', '2027-12-24', '2027-12-25'],
    citation: 'Delaware Code Title 1 section 501(a)-(b) (delcode.delaware.gov/title1/c005). Sussex County Return Day omitted. Dates computed. Calendar years 2026-2027.',
    status: 'verified',
  },
];
