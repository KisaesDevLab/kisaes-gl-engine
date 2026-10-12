// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// CT state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11;
// audited 2026-10-11 against primary sources). Every row cites the primary source it was read in;
// unverified rows say why. See features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
// Sources read in the audit: C.G.S. 12-701(a) ("required annual payment"), 12-704, 12-722
// (cga.ct.gov/current/pub/chap_229.htm); C.G.S. 1-4 (cga.ct.gov/current/pub/chap_002.htm);
// Form CT-2210 (Rev. 12/25) for TY2025; Form CT-1040ES 2026 (Rev. 01/26); Form CT-1040NR/PY 2025;
// portal.ct.gov/about/legal-state-holidays. The 2025 Form CT-1040ES (Rev. 01/25) was not
// retrievable from portal.ct.gov during the audit, so TY2025 rows cite CT-2210 (Rev. 12/25) and statute.
export const CT_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'CT', year: 2025, key: 'has_income_tax', value: true,
    citation: 'C.G.S. 12-700(a) (tax imposed on Connecticut taxable income of residents, trusts and estates); Form CT-2210 (Rev. 12/25), Underpayment of Estimated Income Tax, for the 2025 taxable year',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'required_threshold', value: 1000,
    citation: 'C.G.S. 12-722(j)(1) (no addition to tax if the tax shown on the return reduced by tax withheld "is less than one thousand dollars"); Form CT-2210 (Rev. 12/25), "My Taxes Are Underpaid" (balance after withholding and PE Tax Credits "$1,000 or more") and Part 2 line 4 ("If the result is less than $1,000, stop here")',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'C.G.S. 12-701(a) definition of "Required annual payment" ((A) ninety per cent of the tax shown on the return for the taxable year); Form CT-2210 (Rev. 12/25), Part 2 line 2 ("Multiply Line 1 by 90%")',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'C.G.S. 12-701(a) "Required annual payment" ((B) one hundred per cent of the tax shown on the preceding year\'s return if that year was twelve months and a return was filed); Form CT-2210 (Rev. 12/25), "100% of the income tax shown on your 2024 Connecticut income tax return" and Part 2 lines 5-6. Note: a nonresident/part-year resident with CT-sourced income who did not file a 2024 return must use 90% of 2025 tax (CT-2210 Box E) - not expressible.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI rule: C.G.S. 12-701(a) "Required annual payment" is the lesser of 90% current or 100% prior with no income test (chapter 229 contains no 110% provision); Form CT-2210 (Rev. 12/25) Part 2 has no 110% line',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'C.G.S. 12-722(c) (15th day of the 4th, 6th and 9th months and of the 1st month of the next year); Form CT-2210 (Rev. 12/25) instructions "When Are My Payments Due?" (April 15, June 15, September 15, January 15; Saturday/Sunday/legal holiday -> next business day) and Schedule A worksheet periods. June 15, 2025 is a Sunday -> 2025-06-16.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'C.G.S. 12-722(d)(1) ("twenty-five per cent of the required annual payment"); Form CT-2210 (Rev. 12/25) Part 3 line 9 installment percentages .25/.50/.75/1.00 (cumulative)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'C.G.S. 12-722(m) (farmer/fisherman as defined in IRC 6654(i)(2): one installment due January 15 of the following year equal to the lesser of 66 2/3% current or 100% prior; no addition if return filed and paid in full on or before March 1); Form CT-2210 (Rev. 12/25) instructions "Special Rules for Farmers and Fishermen" (January 15, 2026; March 1, 2026). Ratio 2/3 is the IRC 6654(i)(2) gross-income test incorporated by reference. March 1, 2026 is a Sunday, so file_by is rolled to 2026-03-02 (seed convention; the state text says "March 1").',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'C.G.S. 12-722(a) (interest "at the rate of one per cent per month or fraction thereof" fixed by statute); Form CT-2210 (Rev. 12/25) instructions',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'penalty.rate', value: 0.12,
    citation: 'C.G.S. 12-722(a)-(b) (1% per month or fraction thereof from the installment due date to the earlier of the 15th day of the 4th month of the next year or payment); Form CT-2210 (Rev. 12/25) ("Interest ... at 1% per month or fraction of a month will continue to accrue until the earlier of April 15, 2026"). Stored as 12% annual; actual accrual is 1% per month or fraction of a month (not daily).',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'C.G.S. 12-704(a)(1) (credit to residents and part-year residents for income tax paid to another state, political subdivision or D.C.); Form CT-1040NR/PY 2025 line 11 and Schedule 2 "Credit for Income Taxes Paid to Qualifying Jurisdictions"',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'nonresident_method', value: 'ratio',
    citation: 'Form CT-1040NR/PY 2025 lines 5-10 (tax on the greater of CT AGI or CT-source income, line 8, multiplied by line 9 = CT-source income / Connecticut AGI, capped at 1.0000). Denominator is Connecticut AGI (federal AGI with CT modifications), not federal AGI.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-12', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-12', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    citation: 'C.G.S. 1-4 (New Year, MLK, Lincoln Day Feb 12, Washington\'s Birthday, Memorial Day, Juneteenth, July 4, Labor Day, Columbus Day, Veterans\' Day, Christmas, plus days appointed by the Governor/President; Sunday -> following Monday, Saturday -> preceding Friday); portal.ct.gov/about/legal-state-holidays (lists Good Friday and Thanksgiving). Dates computed from the rules. Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'CT', year: 2026, key: 'has_income_tax', value: true,
    citation: 'C.G.S. 12-700(a); Form CT-1040ES 2026 (Rev. 01/26), "Who Is Required to Make Estimated Payments" (Connecticut income tax)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'required_threshold', value: 1000,
    citation: 'C.G.S. 12-722(j)(1); Form CT-1040ES 2026 (Rev. 01/26), "Who Is Required to Make Estimated Payments" item 1 (Connecticut income tax after withholding and PE Tax Credit "is $1,000 or more") and Worksheet line 17 ("If less than $1,000, no estimated payment is required")',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'C.G.S. 12-701(a) "Required annual payment" (A); Form CT-1040ES 2026 (Rev. 01/26), "Your required annual payment is the lesser of: 90% of the income tax shown on your 2026 Connecticut income tax return ..." and Worksheet line 13',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'C.G.S. 12-701(a) "Required annual payment" (B); Form CT-1040ES 2026 (Rev. 01/26), "100% of the income tax shown on your 2025 Connecticut income tax return if you filed a 2025 Connecticut income tax return that covered a 12-month period" and Worksheet line 14. A nonresident/part-year resident without 2025 CT-sourced income must use 90% of 2026 tax - not expressible.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI rule: C.G.S. 12-701(a) "Required annual payment" has no income test and chapter 229 contains no 110% provision; Form CT-1040ES 2026 (Rev. 01/26) Worksheet lines 13-15 (lesser of 90% current or 100% prior)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'C.G.S. 12-722(c); Form CT-1040ES 2026 (Rev. 01/26), "When to File" (April 15, June 15, September 15, 2026, and January 15, 2027; Saturday/Sunday/legal holiday -> next business day). All four dates are business days.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'C.G.S. 12-722(d)(1) ("twenty-five per cent of the required annual payment"); Form CT-1040ES 2026 (Rev. 01/26), Worksheet line 18 "Installment amount" (x .25)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'C.G.S. 12-722(m) (one installment due January 15; lesser of 66 2/3% current or 100% prior; no addition if return filed and paid by March 1; IRC 6654(i)(2) definition); Form CT-1040ES 2026 (Rev. 01/26), Worksheet line 13 ("90% (66 2/3% for farmers and fishermen)") and "Interest" (farmer filing on or before March 1, 2027 and paying in full owes no underpayment interest). March 1, 2027 is a Monday.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'C.G.S. 12-722(a) (1% per month or fraction thereof, fixed by statute); Form CT-1040ES 2026 (Rev. 01/26), "Interest"',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'penalty.rate', value: 0.12,
    citation: 'C.G.S. 12-722(a)-(b); Form CT-1040ES 2026 (Rev. 01/26), "Interest" ("Interest at 1% per month or fraction of a month will be added to the tax due until the earlier of April 15, 2027, or the date on which the underpayment is paid"). Stored as 12% annual; actual accrual is 1% per month or fraction of a month (not daily).',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'C.G.S. 12-704(a)(1); Form CT-1040ES 2026 (Rev. 01/26), Worksheet line 7 "Credit for income taxes paid to qualifying jurisdictions" (residents and part-year residents; see Schedule 2 of Form CT-1040 / CT-1040NR/PY)',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'nonresident_method', value: 'ratio',
    citation: 'Form CT-1040ES 2026 (Rev. 01/26), Worksheet lines 3-6 and "Line 5: Apportionment Factor" (Connecticut-sourced income / Connecticut AGI, 0 to 1.0000, multiplied by tax on all income); same method as Form CT-1040NR/PY 2025 lines 8-10. Denominator is Connecticut AGI, not federal AGI.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-12', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-12', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-06-19', '2027-07-04', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-25', '2027-12-31'],
    citation: 'C.G.S. 1-4 (statutory list incl. Lincoln Day Feb 12; Sunday -> Monday, Saturday -> preceding Friday); portal.ct.gov/about/legal-state-holidays (Good Friday, Thanksgiving). Dates computed. 2027-12-31 is the Friday observance of New Year\'s Day 2028 (a Saturday). Calendar years 2026-2027.',
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'CT', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'CT', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'CT', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
