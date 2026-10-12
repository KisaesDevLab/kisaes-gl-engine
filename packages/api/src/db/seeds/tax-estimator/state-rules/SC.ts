// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// SC state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 6 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch6-sources.md. The CPA signs off SC (D12).
// Sources: Form SC1040ES 2025 (Rev. 2/18/25) and 2026; Form SC2210 2025 (Rev. 12/02/25);
// SC Information Letter #26-15; 2025 SC1040 Individual Income Tax Packet; S.C. Code §53-5-10, §53-5-30.
export const SC_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'SC', year: 2025, key: 'has_income_tax', value: true,
    citation: "Form SC1040ES 2025 (Rev. 2/18/25) Estimated Tax Worksheet and Tax Computation Schedule (3% / 6.2% brackets); 2025 SC1040 Packet",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'required_threshold', value: 100,
    citation: "S.C. Code §12-6-3910(A)(1) and §12-54-55(1) (the IRC §6654(e)(1) small-amount provision is one hundred dollars); Form SC1040ES 2025 Instructions, Filing requirements (\"expect to owe an Income Tax liability of $100 or more\") and Worksheet line 10 (balance after withholding; \"If $100 or more, you must make Estimated Tax payments\"); Form SC2210 (2025) exception 2 (tax minus withholding less than $100)",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form SC1040ES 2025 Instructions, \"Penalty for failure to file and pay Estimated Tax\" (\"you do not pay at least 90% of the total tax due\"); Form SC2210 (2025) Part I line 4 (\"Multiply line 3 by 90%\")",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form SC1040ES 2025 Instructions (\"make timely Estimated Tax payments equal to 100% of the tax shown due on your SC1040 for the prior tax year ... 12-month year\"); Form SC2210 (2025) Part I line 7",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: "Form SC1040ES 2025 Instructions (\"If the adjusted gross income on your prior year SC1040 was more than $150,000, the 100% rule is adjusted to 110%\"); Form SC2210 (2025) Part I line 7. NOTE: SC2210 line 7 uses $75,000 for married filing separately - the key cannot express a filing-status threshold.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Form SC1040ES 2025 Instructions, Payment due dates (April 15, 2025; June 16, 2025; September 15, 2025; January 15, 2026 - June 15, 2025 was a Sunday). SC1040ES also lets a filer who files by February 2, 2026 and pays in full skip the January payment (not in the key set).",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form SC1040ES 2025 Instructions (\"due in four equal installments\"); Form SC2210 (2025) Part III line 9 (multiply line 8 by 25% in each column)",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "S.C. Code §12-6-3910(A) (estimated payments \"in accordance with Internal Revenue Code Sections 6654\") and §12-54-55(1) (penalty \"in the same manner as prescribed by ... Section 6654\"), so the IRC §6654(i) farmer rule applies: 66 2/3% in place of 90%, one installment January 15, or file and pay by March 1; Form SC2210 (2025) \"Farmers and fishermen\" (two-thirds (66.67%) of gross income for 2024 or 2025; file SC1040 and pay by March 1, \"If March 1 falls on a weekend, the due date is the next business day\"; otherwise \"complete the federal 2210F for South Carolina purposes\"); Form SC1040ES 2025 Exceptions (January 15, 2026 / March 2, 2026). March 1, 2026 is a Sunday -> 2026-03-02.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'penalty.rate_source', value: "federal",
    citation: "S.C. Code §12-54-55(1) (estimated-tax underpayment penalty for individuals determined \"in the same manner as prescribed by the provisions of Internal Revenue Code Section 6654\", small amount $100); §12-54-25(D) (rate on underpayments \"established by the department in the same manner and at the same time as the underpayment rate provided in Internal Revenue Code Sections 6621(a)(2) and 6622\"); SC Information Letter #26-15 (7% 01/01/25-03/31/26, 6% 04/01/26-06/30/26, 7% 07/01/26-09/30/26 = the federal quarterly underpayment rates; simple interest for estimated tax). Audit 2026-10-11 changed state -> federal.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'penalty.rate', value: null,
    citation: "Not applicable: rate source is federal (S.C. Code §12-54-25(D) ties the SC underpayment rate to IRC §6621(a)(2), set quarterly), so no state rate is stored. Form SC2210 (2025) Part III Section B applies .07 for all 2025 rate periods and SC Information Letter #26-15 lists 7% for 01/01/25-03/31/26, matching the federal rate. Audit 2026-10-11: was 0.07 (state).",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "2025 SC1040 Packet, residency FAQ (resident credit \"for taxes paid on income taxed by South Carolina and another state\" claimed on SC1040TC with a copy of the other state's return); Form SC1040ES 2025 Instructions (no penalty where underpayment results from personal service income taxed by another state)",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'nonresident_method', value: "other",
    citation: "S.C. Code §12-6-1720 (nonresident computes SC taxable income as a resident but includes only SC-source items; SC rates apply to that SC taxable income); 2025 SC1040 Packet residency FAQ and SC1040ES 2025 Instructions (nonresidents file SC1040 with Schedule NR, \"taxed only on income earned in South Carolina\", \"prorate your deductions\"). Neither a ratio of total tax nor a flat source tax, so 'other'.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-09", "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-24", "2025-12-25", "2025-12-26",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-11", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-10", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-27"
    ],
    citation: "S.C. Code §53-5-10 (Jan 1; 3rd Mon Jan; 3rd Mon Feb; May 10 Confederate Memorial Day; last Mon May; July 4; 1st Mon Sep; Nov 11; Thanksgiving and the day after; Dec 24, 25, 26) with §53-5-30 (holiday on a Saturday observed the preceding Friday; on a Sunday the following Monday). Calendar years 2025-2027. Dates computed from the statute; duplicate observed dates collapsed.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'SC', year: 2026, key: 'has_income_tax', value: true,
    citation: "Form SC1040ES 2026 Estimated Tax Worksheet; SCDOR notice on Act 110 (2026 two-bracket SC income tax)",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'required_threshold', value: 100,
    citation: "Form SC1040ES 2026 Instructions, Filing requirements ($100 or more) and Worksheet line 10",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form SC1040ES 2026 Instructions, \"Penalty for failure to file and pay Estimated Tax\" (at least 90% of the total tax due)",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form SC1040ES 2026 Instructions (100% of the tax shown due on the prior-year (2025) SC1040, 12-month year)",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: "Form SC1040ES 2026 Instructions (prior-year AGI more than $150,000 -> 110%). MFS $75,000 variant on Form SC2210 (2025) line 7 not expressible. Act 110 changes the 2026 tax base (SC AGI-based) but the 110% rule is stated unchanged on the 2026 SC1040ES.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Form SC1040ES 2026 Instructions, Payment due dates (April 15, June 15, September 15, 2026; January 15, 2027). None is a weekend or S.C. Code §53-5-10 holiday.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form SC1040ES 2026 Instructions (\"due in four equal installments\"); Worksheet line 11 (1/4, 1/2, 3/4 of line 10 for late starters)",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "S.C. Code §12-6-3910(A) and §12-54-55(1) (IRC §6654 adopted, incl. §6654(i) farmers: 66 2/3%, January 15, March 1); Form SC1040ES 2026 Exceptions (two-thirds (66.67%) of 2025 or 2026 gross income; pay all estimated tax by January 15, 2027 or file 2026 SC1040 and pay by March 1, 2027 - a Monday); Form SC2210 (2025) farmer instructions (federal 2210F for SC purposes).",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'penalty.rate_source', value: "federal",
    citation: "S.C. Code §12-54-55(1) (IRC §6654 manner) and §12-54-25(D) (rate set the same way and at the same time as the IRC §6621(a)(2) underpayment rate, i.e. quarterly); SC Information Letter #26-15. Audit 2026-10-11 changed state -> federal.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'penalty.rate', value: null,
    citation: "Not applicable: rate source is federal (S.C. Code §12-54-25(D), IRC §6621(a)(2) quarterly rate). SC Information Letter #26-15: 7% to 03/31/26, 6% Q2 2026, 7% Q3 2026 - identical to the federal quarterly rates, which the engine's federal quarterly table applies. Audit 2026-10-11: was 0.07 (state, unverified).",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "S.C. Code §12-6-3400(A) (resident credit for income taxes paid to another state on income from sources there taxed by both, limited to the lesser of SC tax x SC income taxed elsewhere / total modified federal income, or the other state's tax); claimed on SC1040TC. Statute text read in audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'nonresident_method', value: "other",
    citation: "S.C. Code §12-6-1720 (nonresident computes SC taxable income \"as a resident taxpayer\" but includes only SC-source items; SC rates then apply to that SC taxable income - neither a ratio of total tax nor a flat source rate, so 'other'); Form SC1040ES 2026 Instructions (nonresidents use SC1040 and Schedule NR). Statute text read in audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-09", "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-24", "2025-12-25", "2025-12-26",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-11", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-10", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-27"
    ],
    citation: "S.C. Code §53-5-10 and §53-5-30 (see 2025 row). Calendar years 2025-2027. Dates computed from the statute.",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'SC', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'SC', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'SC', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
