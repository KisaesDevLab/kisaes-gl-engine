// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// NJ state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research batch 5, 2026-10-11).
// Every row cites the document it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch5-sources.md. Rows marked 'unverified'
// state the reason in the citation. The CPA signs off NJ (D12).
export const NJ_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'NJ', year: 2025, key: 'has_income_tax', value: true,
    citation: 'N.J.S.A. 54A:2-1 (gross income tax; section not read directly). Rate tables 1.4%-10.75% in the 2026 Form NJ-1040-ES Instructions, Tables A and B; 2025 Form NJ-2210 line 1 ("2025 Tax (line 50, Form NJ-1040)")',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'required_threshold', value: 400,
    citation: '2025 Form NJ-2210 Part I line 3 ("If less than $400, do not complete the rest of this form"); GIT-8 (Jan 2026) "Interest on Underpayment of Tax" (total tax more than $400 after credits); 2026 Form NJ-1040-ES "Who Must File" ($400). Measured as tax (line 50) minus withholding and listed credits (NJ-2210 line 2).',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'safe_harbor.current_pct', value: 0.8,
    citation: 'Form NJ-2210 (2025) line 4a ("Multiply the amount on line 1 by .80 (80%)"); NJ-2210 Instructions "In General" (80% of 2025 tax liability); GIT-8 (Jan 2026) "Interest on Underpayment of Tax" (80% of this year\'s total tax). NJ differs from the 90% norm. The 2026 NJ-2210 is not yet published; GIT-8 states the rule generically.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Form NJ-2210 (2025) line 4b (2024 tax) and Exception 1 line 15 (25%/50%/75%/100% of 2024 tax); NJ-2210 Instructions: applies only if the 2024 return covered a full 12-month period; prior-year liability is zero if no return was required. Line 5 uses the LESSER of line 4a and 4b.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-income prior-year variant: NJ-2210 (2025) Instructions "In General" and Exception 1 use 100% of prior-year tax for all taxpayers; GIT-8 (Jan 2026) has none.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: '2025 Form NJ-2210 Part I column headings and Part II line 14 (April 15, 2025; June 16, 2025; Sept 15, 2025; Jan 15, 2026); 2025 Form NJ-1040-ES voucher 1 ("Due APRIL 15, 2025"). June 15, 2025 is a Sunday; the NJ-2210 prints June 16, 2025.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2025 Form NJ-2210 line 5 ("divide by four ... in each column"); 2025 NJ-1040-ES / GIT-8: pay in full by the first due date or in four equal installments.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-01-15"},
    citation: 'GIT-8 (Jan 2026) "Farmers" (farm income incl. oyster farming at least two-thirds of total estimated income: file NJ-1040-ES and pay estimated tax in full any time on or before Jan 15 of the following year); NJ-2210 (2025) line 4a ("Two-thirds for qualified farmers"). NJ states no separate earlier filing deadline, so file_by is set equal to due_date (mapping choice).',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: '2025 Form NJ-2210 Instructions "Calculating the Interest" Option 2 ("annual rate of 3% above the average predominant prime rate"); GIT-8 (Jan 2026) ("3% above the prime rate"); 2026 Form NJ-1040-ES "Interest" ("prime rate plus 3%, compounded annually").',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'penalty.rate', value: 0.1075,
    citation: '2025 Form NJ-2210 Instructions, Interest Rate Schedule: 4/16/25-1/15/26 = 10.75%; 1/16/26-4/15/26 = 10.00%. CAUTION: single-rate key; underpayment days from 1/16/26 accrue at 10.00%.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'credit_for_other_state', value: true,
    citation: '2025 Form NJ-2210 Exception II/III/IV worksheets ("Credit for Income Taxes Paid to Other Jurisdictions (line 44, 2025 NJ-1040)"); the credit exists on Form NJ-1040 line 44.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: '2025 Form NJ-2210NR line 5 ("Income Percentage (line 41, 2025 NJ-1040NR)") and Instructions (nonresident income percentage applied to tax computed on total income); worksheet line 8 "Percentage of income from New Jersey sources".',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-20", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-04", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-02", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-25"],
    citation: 'N.J.S.A. 36:1-1(a)-(d) (read in the Legislature\'s STATUTES-TEXT bulk file, pub.njleg.state.nj.us/statutes): New Year\'s Day; MLK Day (3rd Mon Jan); Washington\'s Birthday (3rd Mon Feb); Good Friday; Memorial Day; Juneteenth (3rd Friday in June); July 4; Labor Day; Columbus Day (2nd Mon Oct); Nov 11; Thanksgiving; Dec 25; any general election day (Tuesday after first Monday in Nov, held every year); a Sunday holiday moves to Monday (36:1-1(b)); a holiday falling on Saturday is observed on the preceding Friday, when public offices of the State are closed (N.J.S.A. 36:1-1.2; audit 2026-10-11 added 2026-07-03 and 2027-12-24, the Saturday dates are kept and are weekends anyway). Lincoln\'s Birthday (Feb 12) is listed but 36:1-1(d) says it is NOT a public holiday for State government business, so it is omitted. Calendar years 2025-2027; dates computed from the statute (Easter-based Good Friday computed). 36:1-1(c) applies the list to "the transaction of business in the public offices of this State"; the Division of Taxation\'s own roll rule is 2026 Form NJ-1040-ES Instructions "When to File" ("When any date falls on a Saturday, Sunday, or legal holiday, substitute the next regular workday").',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'NJ', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Graduated rate Tables A and B (1.4%-10.75%) in the 2026 Form NJ-1040-ES Instructions, "How to Calculate Your Estimated Tax"',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'required_threshold', value: 400,
    citation: '2026 Form NJ-1040-ES Instructions, "What is Estimated Tax"/"Who Must File" (expect to owe more than $400 when you file); GIT-8 (Jan 2026). NJ-2210 (2025) line 3 shows the test as "less than $400" = no penalty, i.e. $400 or more.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'safe_harbor.current_pct', value: 0.8,
    citation: 'GIT-8 (Jan 2026) "Interest on Underpayment of Tax": "the lesser of 80% of this year\'s total tax (66 2/3% for farmers) or 100% of last year\'s total tax". The 2026 Form NJ-2210 is not published until early 2027; 2025 Form NJ-2210 line 4a (80%) is the same rule.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'GIT-8 (Jan 2026): 100% of last year\'s total tax, no estimate due if no tax obligation on the prior-year return; NJ-2210 (2025) Instructions "Exception 1" (prior return must cover 12 months).',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-income prior-year variant: NJ-2210 (2025) Instructions "In General" and Exception 1 use 100% of prior-year tax for all taxpayers; GIT-8 (Jan 2026) has none.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: '2026 Form NJ-1040-ES Instructions, "When to File" (April 15, 2026, June 15, 2026, September 15, 2026, and January 15, 2027). None of these dates is a Saturday/Sunday or NJ holiday under N.J.S.A. 36:1-1.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2026 Form NJ-1040-ES Instructions "When to File"/"How to Pay": in full by the first installment or four equal installments; GIT-8 (Jan 2026).',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-01-15"},
    citation: '2026 Form NJ-1040-ES Instructions "Farmers" (at least two-thirds from farming: estimated tax paid in full on or before January 15, 2027); GIT-8 (Jan 2026) (66 2/3% requirement). NJ states no separate earlier filing deadline, so file_by is set equal to due_date (mapping choice).',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: '2025 Form NJ-2210 Instructions "Calculating the Interest" Option 2 ("annual rate of 3% above the average predominant prime rate"); GIT-8 (Jan 2026) ("3% above the prime rate"); 2026 Form NJ-1040-ES "Interest" ("prime rate plus 3%, compounded annually").',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'penalty.rate', value: 0.1,
    citation: 'TB-21(R) "Interest Rate Assessed on Tax Balances for 2026" (issued Dec 1, 2025): Jan 1-Dec 31, 2026 = Prime 7.00% + 3% = 10.00%, compounded annually; the Director redetermines for later quarters only if prime moves more than one point. 10.00% covers 4/16/26-12/31/26, the largest part of the TY2026 window; the calendar-2027 rate (1/1/27-4/15/27) is set Dec 1, 2026 and is unknown. Rule: 2026 Form NJ-1040-ES "Interest" (prime plus 3%). Audit 2026-10-11: upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'credit_for_other_state', value: true,
    citation: '2025 Form NJ-2210 Exception II/III/IV worksheets ("Credit for Income Taxes Paid to Other Jurisdictions (line 44, 2025 NJ-1040)"); the credit exists on Form NJ-1040 line 44.',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: '2025 Form NJ-2210NR line 5 ("Income Percentage (line 41, 2025 NJ-1040NR)") and Instructions (nonresident income percentage applied to tax computed on total income); worksheet line 8 "Percentage of income from New Jersey sources".',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-20", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-04", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-02", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-25"],
    citation: 'N.J.S.A. 36:1-1(a)-(d) (read in the Legislature\'s STATUTES-TEXT bulk file, pub.njleg.state.nj.us/statutes): New Year\'s Day; MLK Day (3rd Mon Jan); Washington\'s Birthday (3rd Mon Feb); Good Friday; Memorial Day; Juneteenth (3rd Friday in June); July 4; Labor Day; Columbus Day (2nd Mon Oct); Nov 11; Thanksgiving; Dec 25; any general election day (Tuesday after first Monday in Nov, held every year); a Sunday holiday moves to Monday (36:1-1(b)); a holiday falling on Saturday is observed on the preceding Friday, when public offices of the State are closed (N.J.S.A. 36:1-1.2; audit 2026-10-11 added 2026-07-03 and 2027-12-24, the Saturday dates are kept and are weekends anyway). Lincoln\'s Birthday (Feb 12) is listed but 36:1-1(d) says it is NOT a public holiday for State government business, so it is omitted. Calendar years 2025-2027; dates computed from the statute (Easter-based Good Friday computed). 36:1-1(c) applies the list to "the transaction of business in the public offices of this State"; the Division of Taxation\'s own roll rule is 2026 Form NJ-1040-ES Instructions "When to File" ("When any date falls on a Saturday, Sunday, or legal holiday, substitute the next regular workday").',
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'NJ', year: 2025, key: 'threshold_comparison', value: "more_than",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md m1/D2: the requirement and penalty tests read \"more than\" the dollar threshold); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2025, key: 'penalty.rate_schedule', value: [{"from": "2025-01-01", "to": "2025-12-31", "rate": 0.1075}, {"from": "2026-01-01", "to": "2026-12-31", "rate": 0.1}],
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md Part B2: calendar-year rate that changes on January 1); primary source not re-read in this task (agency page blocked or not reached). 10.75% for 2025 days, 10% for 2026 days.",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'NJ', year: 2026, key: 'threshold_comparison', value: "more_than",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md m1/D2: the requirement and penalty tests read \"more than\" the dollar threshold); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2026, key: 'penalty.rate_schedule', value: [{"from": "2026-01-01", "to": "2026-12-31", "rate": 0.1}],
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md Part B2: calendar-year rate); primary source not re-read in this task (agency page blocked or not reached). 10% for 2026 days; calendar-2027 rate not set.",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'NJ', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
