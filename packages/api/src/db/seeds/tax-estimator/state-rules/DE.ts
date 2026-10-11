// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// DE state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11; audited 2026-10-11:
// PIT-EST instructions 2025/2026, 30 Del. C. 533, 535, 551, 1111, 1121, 1169, 1170, 1 Del. C. 501 read).
// Every row cites the primary source it was read in; unverified rows say why. See
// features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const DE_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'DE', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 2 and Tax Computation Schedule (graduated Delaware income tax)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'required_threshold', value: 800,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 2 ("if the tax due in excess of withholding can reasonably be expected to exceed $800.00"); 30 Del. C. 1169(a)-(b) (declaration required "if the estimated tax can reasonably be expected to exceed $800"; estimated tax = tax less withholding credits). Statute says "exceed" (strictly more than $800); the key means "at least" - differs only at exactly $800.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 10(a) (installments at least 90 percent of the amount due on the return)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 10(b) (100% of the tax shown on the prior year\'s return)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 10(b) ("110% if the federal adjusted gross income for the previous tax year is in excess of $150,000 ($75,000 if married filing separate)"). MFS threshold not expressible. (Statute 30 Del. C. 535(b) defers to the IRC method; the 110% rule is stated in the Division of Revenue instructions.)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'installments.due_dates', value: ['2025-04-30', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 8 (equal installments on or before April 30, June 15, September 15, and January 15 of the following year; first installment April 30). 30 Del. C. 1170(a) (federal dates unless the Director sets others; Director set April 30 for the first installment). Roll: 30 Del. C. 551(d) (last day on Saturday, Sunday or Delaware legal holiday -> next succeeding day that is not). June 15, 2025 is a Sunday -> 2025-06-16.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 8 ("in equal installments") and Tax Computation Schedule quarterly payment (line total / 4)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 5 (at least two-thirds of gross income from farming/fishing: file a Declaration by January 15 and pay the entire estimated tax, or file the return and pay in full on or before March 1) and Instruction 10(a) (66 2/3% for farmers and fishermen). March 1, 2026 is a Sunday, so file_by is rolled to 2026-03-02 per 30 Del. C. 551(d) (seed convention; the instruction text says "March 1"). Statute has no separate farmer text; the rule is Division of Revenue instruction following IRC 6654(i).',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 10 (penalty of 1 1/2% per month or fraction thereof on the underpayment of any installment); 30 Del. C. 535(b) (addition "equal to 1 1/2% per month, or fraction thereof"; underpayment determined consistent with the Internal Revenue Code). Note 30 Del. C. 533(a) 0.5%/month interest expressly does not apply to estimated tax.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'penalty.rate', value: 0.18,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Instruction 10 ("A penalty of 1 1/2% per month or fraction thereof"). 30 Del. C. 535(b). Stored as 18% annual; actual accrual is 1.5% per month or fraction thereof (not daily).',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), Tax Computation Schedule line 8(b) ("credit for income tax paid to another state"); 30 Del. C. 1111(a) (resident credit for income tax imposed by another state or D.C. on income derived from sources there and also taxed by Delaware); part-year residents via 30 Del. C. 1125.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'nonresident_method', value: 'ratio',
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2025 (PIT-EST Instructions, Revised 10/03/24, revenuefiles.delaware.gov/2024/PIT_2024_Forms/PIT_Instructions/PIT-EST_2025-01_Instructions.pdf), "Special Note" ("a non-resident computes Delaware income tax as though all of your income is Delaware income. You then pay the percentage of a resident\'s tax represented by the percentage of Delaware income"); 30 Del. C. 1121 (resident-basis tax less personal credits, multiplied by modified Delaware source income / Delaware AGI). Denominator is Delaware AGI (federal AGI as modified by 1106), not raw federal AGI.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-11', '2025-11-27', '2025-11-28', '2025-12-25', '2026-01-01', '2026-01-19', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-11-03', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25'],
    citation: 'Delaware Code Title 1 section 501 (delcode.delaware.gov/title1/c005): New Year, MLK (3rd Mon Jan), Good Friday, Juneteenth, July 4, Labor Day, Veterans Day, Thanksgiving, Friday after Thanksgiving, Christmas, general election day (even years: 2026-11-03), with Sunday -> Monday and Saturday -> preceding Friday (501(b)); Memorial Day, last Monday in May (501(c)). Saturdays are legal holidays (501(a)(11)) and are covered by the weekend roll. Sussex County Return Day (501(a)(13), afternoon only, one county) omitted; the 2 OMB floating holidays (501(e)) are not dates. Dates computed. Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'DE', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 2 and Tax Computation Schedule (graduated Delaware income tax)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'required_threshold', value: 800,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 2 ("if the tax due in excess of withholding can reasonably be expected to exceed $800.00"); 30 Del. C. 1169(a)-(b) (declaration required "if the estimated tax can reasonably be expected to exceed $800"; estimated tax = tax less withholding credits). Statute says "exceed" (strictly more than $800); the key means "at least" - differs only at exactly $800.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 10(a) (installments at least 90 percent of the amount due on the return)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 10(b) (100% of the tax shown on the prior year\'s return)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 10(b) ("110% if the federal adjusted gross income for the previous tax year is in excess of $150,000 ($75,000 if married filing separate)"). MFS threshold not expressible. (Statute 30 Del. C. 535(b) defers to the IRC method; the 110% rule is stated in the Division of Revenue instructions.)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'installments.due_dates', value: ['2026-04-30', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 8 (equal installments on or before April 30, June 15, September 15, and January 15 of the following year; first installment April 30). 30 Del. C. 1170(a); roll per 30 Del. C. 551(d). All 2026 dates are business days (none is a 1 Del. C. 501 holiday).',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 8 ("in equal installments") and Tax Computation Schedule quarterly payment (line total / 4)',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 5 (at least two-thirds of gross income from farming/fishing: file a Declaration by January 15 and pay the entire estimated tax, or file the return and pay in full on or before March 1) and Instruction 10(a) (66 2/3% for farmers and fishermen). March 1, 2027 is a Monday. Statute (30 Del. C. 1169-1170, 535(b)) has no separate farmer text; the rule is Division of Revenue instruction following IRC 6654(i).',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 10 (penalty of 1 1/2% per month or fraction thereof on the underpayment of any installment); 30 Del. C. 535(b) (addition "equal to 1 1/2% per month, or fraction thereof"; underpayment determined consistent with the Internal Revenue Code). Note 30 Del. C. 533(a) 0.5%/month interest expressly does not apply to estimated tax.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'penalty.rate', value: 0.18,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Instruction 10 ("A penalty of 1 1/2% per month or fraction thereof"). 30 Del. C. 535(b). Stored as 18% annual; actual accrual is 1.5% per month or fraction thereof (not daily).',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), Tax Computation Schedule line 8(b) ("credit for income tax paid to another state"); 30 Del. C. 1111(a) (resident credit for income tax imposed by another state or D.C. on income derived from sources there and also taxed by Delaware); part-year residents via 30 Del. C. 1125.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'nonresident_method', value: 'ratio',
    citation: 'Delaware Declaration of Estimated Income Tax for Individuals 2026 (PIT-EST Instructions, Revised 11/10/25, revenuefiles.delaware.gov/2025/PITForms_Instructions/Instructions/PIT-EST_Instructions_2026-01.pdf), "Special Note" ("a non-resident computes Delaware income tax as though all of your income is Delaware income. You then pay the percentage of a resident\'s tax represented by the percentage of Delaware income"); 30 Del. C. 1121 (resident-basis tax less personal credits, multiplied by modified Delaware source income / Delaware AGI). Denominator is Delaware AGI (federal AGI as modified by 1106), not raw federal AGI.',
    status: 'verified',
  },
  {
    state: 'DE', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-11-03', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25', '2027-01-01', '2027-01-18', '2027-03-26', '2027-05-31', '2027-06-18', '2027-06-19', '2027-07-04', '2027-07-05', '2027-09-06', '2027-11-11', '2027-11-25', '2027-11-26', '2027-12-24', '2027-12-25', '2027-12-31'],
    citation: 'Delaware Code Title 1 section 501(a)-(c) (delcode.delaware.gov/title1/c005): same list as 2025 incl. Memorial Day (501(c)) and general election day 2026-11-03 (none in 2027). Sussex County Return Day (afternoon, one county) omitted. 2027-12-31 is the Friday observance of New Year\'s Day 2028 (a Saturday). Dates computed. Calendar years 2026-2027.',
    status: 'verified',
  },
];
