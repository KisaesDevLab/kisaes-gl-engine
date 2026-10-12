// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// AR state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-mo-ar-sources.md. The CPA signs off AR (D12).
// Sources: DFA AR1000ES Estimated Tax Declaration Vouchers and Instructions 2025 (Instr. R 7/5/2024)
// and 2026 (Instr. R 10/14/2025); AR2210 (2025, R 6/6/2025) and AR2210 Instructions (R 7/5/2024,
// 6/27/2025); AR1000F/AR1000NR Instructions 2025; DFA Subject 105 "Estimated Tax" (rev. 2/24/2023);
// Act 1 of the 2026 First Extraordinary Session (HB1001, approved 5/6/26).
// The Arkansas Code text itself (Ark. Code §§26-51-907 ff., §1-5-101) could not be fetched
// (all public mirrors returned 403); the DFA forms and instructions above are relied on instead.
export const AR_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'AR', year: 2025, key: 'has_income_tax', value: true,
    citation: 'DFA AR1000ES 2025 tax rate schedule (2.0%-3.9%); AR1000F/AR1000NR Instructions 2025 (resident and nonresident returns)',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'required_threshold', value: 1000,
    citation: 'DFA AR1000ES 2025 worksheet line 8 (estimated tax = total tax - credits - AR withholding; "If $1,000 or more, file the Declaration Voucher. If less than $1,000 no Declaration Voucher is required"); AR2210 Instructions 1(a) ("$1,000 or more and income tax withholdings ... do not equal 90%"); DFA Subject 105. CAUTION at exactly $1,000: AR1000ES "Who must file" says "more than one thousand dollars ($1,000)" and AR2210 (2025) line 4 says stop if net tax less withholding "is $1,000 or less"; AR2210 Instr. exception: no penalty if tax shown on the return is less than $1,000.',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'AR2210 (2025) Part II line 2 ("Enter 90% (.90) of the amount shown on line 1" = 2025 net tax) and line 6 (smaller of line 2 or line 5); AR1000ES 2025 "Underestimate of Tax" ("not less than ninety percent (90%) of the amount actually due"); AR2210 Instructions 2(a)',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'AR2210 (2025) Part II line 5 ("2024 net tax") and line 6 ("Required annual payment. Enter the smaller of line 2 or line 5"); AR1000ES 2025 ("computed on the lesser of the current year\'s tax liability or the previous year\'s tax liability"); DFA Subject 105 ("100% of the taxes shown on your last year\'s tax return, if your last year\'s tax return covered all 12 months"). Related: AR2210 Instr. exception 3 (no prior-year liability, 12-month year, full-year resident -> no penalty).',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI rule: AR2210 (2025) Part II lines 5-6 use 100% of 2024 net tax with no AGI test; DFA Subject 105 states only 90% current / 100% prior',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'AR2210 (2025) Part III column dates 4-15-2025, 6-15-2025, 9-15-2025, 1-15-2026; AR2210 Instructions 1(c) (15th day of the 4th, 6th, 9th months and 1st month after year end); AR1000ES 2025 "Important Notice" (Saturday, Sunday or legal holiday -> timely if postmarked the next succeeding business day). June 15, 2025 is a Sunday -> June 16, 2025.',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'AR2210 (2025) line 7 ("Enter 1/4 (.25) of line 6 ... in each column"); AR1000ES 2025 worksheet ("Enter on voucher one-fourth (1/4) of line 8. (Make four (4) installments.)")',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.9, due_date: '2026-02-17', file_by: '2026-03-16' },
    citation: 'Ratio and dates VERIFIED: AR1000ES 2025 "Exception" and AR2210 Instructions exception 1 (farming income at least two-thirds of total gross income; declare and pay by the 15th day of the 2nd month after year end, or file the return and pay in full by the 15th day of the 3rd month). Feb 15, 2026 is a Sunday and Feb 16, 2026 is the AR/federal Presidents\' Day holiday -> Feb 17; Mar 15, 2026 is a Sunday -> Mar 16. UNVERIFIED: current_pct 0.9 - no AR source states a farmer-specific percentage (AR has no 66 2/3% rule); 0.9 is inferred from the general 90% rule (AR1000ES "Underestimate of Tax").',
    status: 'unverified',
  },
  {
    state: 'AR', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'AR1000ES 2025 "Underestimate of Tax" ("a penalty of ten percent (10%) per annum shall be added to the amount of the underestimate"); AR2210 Instructions 2(b); AR2210 (2025) line 16 (x .10) - a fixed state rate, not the federal §6621 rate',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'penalty.rate', value: 0.1,
    citation: 'AR2210 (2025) line 16 ("Underpayment from line 13 x Number of days from line 15 / 365 x .10"), line 15 (days to payment date or 4-15-2026, whichever is earlier); AR1000ES 2025 (10% per annum, assessed quarterly)',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'AR1000F/AR1000NR Instructions 2025, Line 36 (Form AR1000TC credits include "Other State Tax Credit")',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'nonresident_method', value: 'ratio',
    citation: 'AR1000F/AR1000NR Instructions 2025, Lines 38A-38D (AR1000NR: Arkansas AGI (col. C) / total AGI (cols. A+B) = Arkansas percentage of income, x net tax computed on all income = "Arkansas apportioned tax liability")',
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-12-24", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-12-24", "2026-12-25"],
    citation: "Arkansas OPM Policy 52 \"Holidays and Birthday Leave\" (eff. 5/22/2025; authority Ark. Code Ann. §§1-5-101-104; sas.arkansas.gov/wp-content/uploads/52-Holidays-and-Birthday-Leave-5.23.2025.pdf, read 2026-10-12): New Year's Day; MLK Day (3rd Mon Jan); George Washington's Birthday and Daisy Gatson Bates Day (3rd Mon Feb); Memorial Day (last Mon May); Independence Day; Labor Day (1st Mon Sep); Veterans Day (Nov 11); Thanksgiving (4th Thu Nov); Christmas Eve; Christmas Day; item 6: \"Holidays which occur on a Saturday will be observed on the preceding Friday. Holidays which occur on a Sunday will be observed on the following Monday.\" No Juneteenth; day after Thanksgiving only by Governor's proclamation. Dates recomputed 2026-10-12 and match (R5 m2). Calendar years 2025-2026.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'AR', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Act 1 of 2026 (1st Extraordinary Session, HB1001, approved 5/6/26) §1 amending Ark. Code §26-51-201(a)(4) (individual rates for tax years beginning on or after Jan. 1, 2026); DFA AR1000ES 2026',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'required_threshold', value: 1000,
    citation: 'DFA AR1000ES 2026 (Instr. R 10/14/2025) worksheet line 8 ("If $1,000 or more, file the Declaration Voucher. If less than $1,000 no Declaration Voucher is required"; estimated tax = tax - credits - AR withholding). CAUTION at exactly $1,000: the same form\'s "Who must file" text says "more than one thousand dollars ($1,000)".',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'DFA AR1000ES 2026 "Underestimate of Tax" ("not less than ninety percent (90%) of the amount actually due"; penalty if quarterly payments are not "at least ninety percent (90%) of the amount actually due"). 2026 AR2210 not yet published at research time; the 2025 AR2210 line 2 uses 90%.',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'DFA AR1000ES 2026 "Underestimate of Tax" ("The Underestimate Penalty is computed on the lesser of the current year\'s tax liability or the previous year\'s tax liability"); DFA Subject 105 (100% of last year\'s tax if a 12-month return)',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI rule: DFA AR1000ES 2026 refers only to "the previous year\'s tax liability" with no AGI test; DFA Subject 105; AR2210 (2025) lines 5-6',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'DFA AR1000ES 2026 worksheet (declaration dates April 15, June 15, September 15, 2026 and January 15, 2027) and holiday/weekend note; AR2210 Instructions 1(c). None of these dates is a weekend or AR holiday (Wed/Mon/Tue/Fri).',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'DFA AR1000ES 2026 worksheet ("If you first become liable to file a declaration on April 15, 2026: Enter on voucher one-fourth (1/4) of line 8. (Make four (4) installments.)")',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.9, due_date: '2027-02-16', file_by: '2027-03-15' },
    citation: 'Ratio and dates VERIFIED: DFA AR1000ES 2026 "Exception" (farming income at least two-thirds; pay by the 15th day of the 2nd month after year end, or file and pay in full by the 15th day of the 3rd month). Feb 15, 2027 is the 3rd Monday of February (AR/federal Presidents\' Day holiday) -> Feb 16, 2027; Mar 15, 2027 is a Monday. UNVERIFIED: current_pct 0.9 is inferred from the general 90% rule; no AR source states a farmer-specific percentage.',
    status: 'unverified',
  },
  {
    state: 'AR', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'DFA AR1000ES 2026 "Underestimate of Tax" (penalty of ten percent (10%) per annum, assessed on a quarterly basis) - fixed state rate',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'penalty.rate', value: 0.1,
    citation: 'DFA AR1000ES 2026 "Underestimate of Tax" ("a penalty of ten percent (10%) per annum shall be added to the amount of the underestimate"); AR2210 Instructions (R 6/27/2025) Part II (days / 365 x 10%)',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'AR1000F/AR1000NR Instructions 2025, Line 36 (AR1000TC "Other State Tax Credit"); no 2026 change found. 2026 return instructions not yet published at research time.',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'nonresident_method', value: 'ratio',
    citation: 'AR1000F/AR1000NR Instructions 2025, Lines 38A-38D (Arkansas percentage of income x net tax on all income). 2026 instructions not yet published at research time; method unchanged by Act 1 of 2026 (rates only).',
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'holidays', value: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-12-24", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-12-24"],
    citation: "Arkansas OPM Policy 52 \"Holidays and Birthday Leave\" (eff. 5/22/2025; authority Ark. Code Ann. §§1-5-101-104; sas.arkansas.gov/wp-content/uploads/52-Holidays-and-Birthday-Leave-5.23.2025.pdf, read 2026-10-12): New Year's Day; MLK Day (3rd Mon Jan); George Washington's Birthday and Daisy Gatson Bates Day (3rd Mon Feb); Memorial Day (last Mon May); Independence Day; Labor Day (1st Mon Sep); Veterans Day (Nov 11); Thanksgiving (4th Thu Nov); Christmas Eve; Christmas Day; item 6: \"Holidays which occur on a Saturday will be observed on the preceding Friday. Holidays which occur on a Sunday will be observed on the following Monday.\" No Juneteenth; day after Thanksgiving only by Governor's proclamation. Dates recomputed 2026-10-12 and match (R5 m2). Calendar years 2026-2027 (Dec 24, 2027 covers Christmas Eve and the Saturday Christmas).",
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'estimates_required', value: true,
    citation: "AR1000ES 2025 (\"Who must file\": individuals expecting estimated tax of more than $1,000 file a declaration; vouchers due April 15, June 15, September 15, January 15); AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Instr. 1(a),(c)",
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'threshold_comparison', value: "more_than",
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Part II line 4 (\"Subtract line 3 from line 1: (If the result is $1,000 or less, stop here. Do not complete this schedule.)\"); AR1000ES 2026 \"Who must file\" (\"more than one thousand dollars ($1,000)\"). The worksheet line 8 note says \"$1,000 or more\"; the penalty schedule and the filing requirement both use \"more than\".",
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'installments.q4_file_and_pay_date', value: "2026-02-02",
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Instructions Exception 2 (\"In lieu of filing the fourth (4th) quarter installment the taxpayer may file an income tax return and pay the tax on or before January 31 or on the last day of the first (1st) month after the close of the income year\"). Jan 31, 2026 is a Saturday -> Monday Feb 2, 2026 per the AR1000ES Important Notice (Saturday, Sunday or legal holiday -> next succeeding business day).",
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'return_due_date', value: "2026-04-15",
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Part III line 15 (days to the payment date \"or 4-15-2026, whichever is earlier\"). Note Reg. 1997-4 §1.26-18-208(6) also ends the period at return filing, which this key cannot express.",
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "Fixed statutory rate, not indexed: AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) line 16 (\"x .10\") and Instr. Part II (\"divided by 365, times ten percent (10%)\"); AR1000ES 2025 (\"a penalty of ten percent (10%) per annum\"). The single penalty.rate (0.10) applies to every day.",
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'penalty.method', value: "daily_simple",
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) line 16 (underpayment x days / 365 x .10) and Instructions \"Penalty computation example\" (61/365 X .10 X $250)",
    status: 'verified',
  },
  {
    state: 'AR', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Part II line 4: the penalty floor is the same $1,000 of net tax less Arkansas withholding as the declaration threshold (required_threshold, \"more than\" per threshold_comparison), so no separate value. Instructions note: \"No penalty shall be imposed ... if the tax shown on the return ... is less than $1,000\".",
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'estimates_required', value: true,
    citation: "AR1000ES 2026 (\"Who must file\": individuals expecting estimated tax of more than $1,000 file a declaration; vouchers due April 15, June 15, September 15, January 15); AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Instr. 1(a),(c)",
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'threshold_comparison', value: "more_than",
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Part II line 4 (\"Subtract line 3 from line 1: (If the result is $1,000 or less, stop here. Do not complete this schedule.)\"); AR1000ES 2026 \"Who must file\" (\"more than one thousand dollars ($1,000)\"). The worksheet line 8 note says \"$1,000 or more\"; the penalty schedule and the filing requirement both use \"more than\".",
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'installments.q4_file_and_pay_date', value: "2027-02-01",
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Instructions Exception 2 (file and pay by January 31 in lieu of the fourth installment). Jan 31, 2027 is a Sunday -> Monday Feb 1, 2027 per the AR1000ES 2026 Important Notice (next succeeding business day).",
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'return_due_date', value: "2027-04-15",
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Part III line 15 pattern (period ends on the 15th day of the 4th month after year end; 2025 form prints 4-15-2026). April 15, 2027 is a Thursday. 2026 AR2210 not yet published.",
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "Fixed statutory rate, not indexed: AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) line 16 (\"x .10\") and Instr. Part II (\"divided by 365, times ten percent (10%)\"); AR1000ES 2026 (\"a penalty of ten percent (10%) per annum\"). The single penalty.rate (0.10) applies to every day.",
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'penalty.method', value: "daily_simple",
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) line 16 (underpayment x days / 365 x .10) and Instructions \"Penalty computation example\" (61/365 X .10 X $250)",
    status: 'verified',
  },
  {
    state: 'AR', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "AR2210 (2025, R 6/6/2025) and AR2210 Instructions (dfa.arkansas.gov, read 2026-10-12) Part II line 4: the penalty floor is the same $1,000 of net tax less Arkansas withholding as the declaration threshold (required_threshold, \"more than\" per threshold_comparison), so no separate value. Instructions note: \"No penalty shall be imposed ... if the tax shown on the return ... is less than $1,000\".",
    status: 'verified',
  },
];
