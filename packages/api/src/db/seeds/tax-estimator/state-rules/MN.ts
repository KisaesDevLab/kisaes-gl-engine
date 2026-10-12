// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// MN state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 4 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch4-sources.md. Rows marked 'unverified' say why in the citation.
export const MN_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------ 2025
  {
    state: 'MN', year: 2025, key: 'has_income_tax', value: true,
    citation: "Minn. Stat. 290.06 subd. 2c (rate schedules 5.35%, 6.8%, 7.85%, 9.85%); Minnesota Department of Revenue \"Estimated Tax Payments for Individuals\" page (read 2026-10-11, not year-specific)",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'required_threshold', value: 500,
    citation: "Minn. Stat. 289A.25 subd. 4 (no addition to tax if the tax shown on the return reduced by the credits allowable \"is less than $500\"); Minnesota Department of Revenue \"Estimated Tax Payments for Individuals\" page (last updated Jan. 7, 2026; read 2026-10-11) (\"You must pay estimated tax if you expect to owe $500 or more in Minnesota income tax after subtracting your withholding and refundable credits\")",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Minn. Stat. 289A.25 subd. 5(1) (\"90 percent of the tax shown on the return\"); Minnesota Department of Revenue \"Estimated Tax Payments for Individuals\" page (read 2026-10-11, not year-specific)",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Minn. Stat. 289A.25 subd. 5(2) (total tax liability on prior-year 12-month return); Minnesota Department of Revenue \"Estimated Tax Payments for Individuals\" page (read 2026-10-11, not year-specific) (\"100% of your prior year's total tax liability\"); nonresidents/part-year residents need at least $1 of prior-year Minnesota liability",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: "Minn. Stat. 289A.25 subd. 5(2) (if prior-year AGI \"exceeds $150,000\", substitute \"110 percent of the total tax liability\"; same $150,000 for all filing statuses; for a nonresident/part-year resident AGI means the Minnesota share under 290.06 subd. 2c(e)); DOR \"Estimated Tax Payments for Individuals\" page (\"110% if your federal adjusted gross income is more than $150,000\")",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Minn. Stat. 289A.25 subd. 3(b) (1st April 15, 2nd June 15, 3rd September 15, 4th January 15 of the following taxable year); DOR \"Estimated Tax Payments for Individuals\" page (\"If the due date falls on a Saturday, Sunday, or legal holiday, the Minnesota Department of Revenue must receive your payment by the next business day\"). June 15, 2025 is a Sunday -> June 16, 2025.",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Minn. Stat. 289A.25 subd. 5 (\"The amount of any installment required to be paid shall be 25 percent of the required annual payment\"); subd. 3(b) (four required installments)",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "Minn. Stat. 289A.25 subd. 10 (farmer or fisherman as defined in IRC 6654(i)(2): \"only one installment is required ... the due date of which is January 15 of the following taxable year\", required annual payment computed with \"66-2/3 percent\" for \"90 percent\", and subd. 9 applied with \"March 1\" for \"January 31\" - no addition if the return is filed and the tax paid in full by March 1); DOR \"Estimated Tax Payments for Individuals\" page (\"you only need to make one estimated payment on January 15 of the following year ... if you file your return and pay your tax by March 1\"). March 1, 2026 is a Sunday -> March 2, 2026 under the DOR next-business-day rule.",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "Minn. Stat. 289A.25 subd. 2(a) (addition to tax \"at the rate specified in section 270C.40\"); Minnesota Revenue \"Calculating Penalty and Interest\" page",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'penalty.rate', value: 0.08,
    citation: "Minn. Stat. 289A.25 subd. 2(a) (rate specified in 270C.40); Minn. Stat. 270C.40 subd. 4 (the amount in lieu of interest on an estimated-tax underpayment for a taxable year is the rate determined for the January 1 on which that taxable year begins, so ONE rate covers the whole TY2025 underpayment period, including days in 2026); DOR \"Calculating Penalty and Interest\" (\"The interest rate for 2025 is 8%\") and \"Penalties and Interest for Individuals\" table (2024-2025 8%).",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "Minn. Stat. 290.06 subd. 22 (credit for taxes paid to another state on income allocated or apportioned to Minnesota; credit = Minnesota tax x ratio of other-state-taxed income to federal AGI, limited by para. (d))",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "Minn. Stat. 290.06 subd. 2c(e) (individual not a Minnesota resident all year: tax liability after nonrefundable credits \"multiplied by a fraction\" whose numerator is Minnesota-source federal AGI and denominator is federal AGI)",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-31"],
    citation: "Minn. Stat. 645.44 subd. 5(a) (New Year's Day; MLK 3rd Mon Jan; Washington's and Lincoln's Birthday 3rd Mon Feb; Memorial Day; Juneteenth; July 4; Labor Day; Indigenous Peoples Day 2nd Mon Oct; Veterans Day; Thanksgiving; Christmas; Sunday holiday -> following Monday, Saturday holiday -> preceding Friday for Jan 1, June 19, July 4, Nov 11, Dec 25; executive branch also the Friday after Thanksgiving). Calendar 2025-2027 computed from the statute; Jan 1, 2028 (Saturday) -> Dec 31, 2027.",
    status: 'verified',
  },
  // ------------------------------------------------------------ 2026
  {
    state: 'MN', year: 2026, key: 'has_income_tax', value: true,
    citation: "Minn. Stat. 290.06 subd. 2c (rate schedules 5.35%, 6.8%, 7.85%, 9.85%); Minnesota Department of Revenue \"Estimated Tax Payments for Individuals\" page (read 2026-10-11, not year-specific)",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'required_threshold', value: 500,
    citation: "Minn. Stat. 289A.25 subd. 4 (no addition to tax if the tax shown on the return reduced by the credits allowable \"is less than $500\"); Minnesota Department of Revenue \"Estimated Tax Payments for Individuals\" page (last updated Jan. 7, 2026; read 2026-10-11) (\"You must pay estimated tax if you expect to owe $500 or more in Minnesota income tax after subtracting your withholding and refundable credits\")",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Minn. Stat. 289A.25 subd. 5(1) (\"90 percent of the tax shown on the return\"); Minnesota Department of Revenue \"Estimated Tax Payments for Individuals\" page (read 2026-10-11, not year-specific)",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Minn. Stat. 289A.25 subd. 5(2) (total tax liability on prior-year 12-month return); Minnesota Department of Revenue \"Estimated Tax Payments for Individuals\" page (read 2026-10-11, not year-specific) (\"100% of your prior year's total tax liability\"); nonresidents/part-year residents need at least $1 of prior-year Minnesota liability",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: "Minn. Stat. 289A.25 subd. 5(2) (if prior-year AGI \"exceeds $150,000\", substitute \"110 percent of the total tax liability\"; same $150,000 for all filing statuses; for a nonresident/part-year resident AGI means the Minnesota share under 290.06 subd. 2c(e)); DOR \"Estimated Tax Payments for Individuals\" page (\"110% if your federal adjusted gross income is more than $150,000\")",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Minn. Stat. 289A.25 subd. 3(b) (April 15, June 15, September 15, January 15 of the following taxable year); DOR \"Estimated Tax Payments for Individuals\" page (Saturday/Sunday/legal holiday -> next business day). No 2026-27 date is a weekend or Minn. Stat. 645.44 holiday.",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Minn. Stat. 289A.25 subd. 5 (\"The amount of any installment required to be paid shall be 25 percent of the required annual payment\"); subd. 3(b) (four required installments)",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Minn. Stat. 289A.25 subd. 10 (farmer or fisherman as defined in IRC 6654(i)(2): \"only one installment is required ... the due date of which is January 15 of the following taxable year\", required annual payment computed with \"66-2/3 percent\" for \"90 percent\", and subd. 9 applied with \"March 1\" for \"January 31\" - no addition if the return is filed and the tax paid in full by March 1); DOR \"Estimated Tax Payments for Individuals\" page (\"you only need to make one estimated payment on January 15 of the following year ... if you file your return and pay your tax by March 1\"). January 15, 2027 (Fri) and March 1, 2027 (Mon) need no roll.",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "Minn. Stat. 289A.25 subd. 2(a) (addition to tax \"at the rate specified in section 270C.40\"); Minnesota Revenue \"Calculating Penalty and Interest\" page",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: "Minn. Stat. 289A.25 subd. 2(a); Minn. Stat. 270C.40 subd. 4 (rate fixed for the January 1 on which the taxable year begins, so 7% applies to the whole TY2026 underpayment period, including days in 2027); DOR \"Calculating Penalty and Interest\" (\"For 2026, the rate is 7% (.07)\") and \"Penalties and Interest for Individuals\" table (2026 7%).",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "Minn. Stat. 290.06 subd. 22 (credit for taxes paid to another state on income allocated or apportioned to Minnesota; credit = Minnesota tax x ratio of other-state-taxed income to federal AGI, limited by para. (d))",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "Minn. Stat. 290.06 subd. 2c(e) (individual not a Minnesota resident all year: tax liability after nonrefundable credits \"multiplied by a fraction\" whose numerator is Minnesota-source federal AGI and denominator is federal AGI)",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-31"],
    citation: "Minn. Stat. 645.44 subd. 5(a) (New Year's Day; MLK 3rd Mon Jan; Washington's and Lincoln's Birthday 3rd Mon Feb; Memorial Day; Juneteenth; July 4; Labor Day; Indigenous Peoples Day 2nd Mon Oct; Veterans Day; Thanksgiving; Christmas; Sunday holiday -> following Monday, Saturday holiday -> preceding Friday for Jan 1, June 19, July 4, Nov 11, Dec 25; executive branch also the Friday after Thanksgiving). Calendar 2025-2027 computed from the statute; Jan 1, 2028 (Saturday) -> Dec 31, 2027.",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'MN', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'MN', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MN', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
