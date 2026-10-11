// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// NE state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 4 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch4-sources.md. Rows marked 'unverified' say why in the citation.
export const NE_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------ 2025
  {
    state: 'NE', year: 2025, key: 'has_income_tax', value: true,
    citation: "Neb. Rev. Stat. 77-2715 (income tax on residents, nonresidents and partial-year residents); Form 1040N-ES (2025, \"2024/f_1040N-ES_2025.pdf\" booklet)",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'required_threshold', value: 500,
    citation: "Form 1040N-ES (2025, \"2024/f_1040N-ES_2025.pdf\" booklet) (\"Nebraska income tax after allowance of personal exemption credits ... expected to exceed withholding and other credits by $500 or more\"; worksheet line 18 \"less than $500\"); Form 2210N exceptions",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form 1040N-ES (2025, \"2024/f_1040N-ES_2025.pdf\" booklet) Penalty section item 1 (\"90% (66 2/3% for those engaged in farming, ranching, and fishing) of the income tax liability for the year\") and worksheet line 16a",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form 1040N-ES (2025, \"2024/f_1040N-ES_2025.pdf\" booklet) Penalty section item 2 (\"100% of the income tax shown on the Nebraska return for the full 12-month preceding tax year, if federal AGI was $150,000 or less\")",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: "Form 1040N-ES (2025, \"2024/f_1040N-ES_2025.pdf\" booklet) Penalty section item 3 and worksheet line 16b (\"110% ... if 2024 federal AGI was above $150,000 ($75,000 if your filing status ... is married, filing separately)\"). The $75,000 married-filing-separately threshold cannot be represented by this key.",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Form 1040N-ES (2025, \"2024/f_1040N-ES_2025.pdf\" booklet) \"When to Pay Your Estimated Income Tax\" (April 15, June 15, September 15, January 15; \"If the due date falls on a Saturday, Sunday, or legal holiday, taxpayers have until the next business day to make the payment\"). June 15, 2025 is a Sunday -> June 16, 2025.",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form 1040N-ES (2025, \"2024/f_1040N-ES_2025.pdf\" booklet) worksheet line 19 / voucher instructions (1/4, 1/2, 3/4, then full amount of line 18 cumulatively = equal quarters); Form 2210N (2025) line 10 (\"Enter 25% of line 8 in each column\")",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-01"},
    citation: "Form 1040N-ES (2025, \"2024/f_1040N-ES_2025.pdf\" booklet) \"Farmers and Ranchers\" (at least two-thirds of gross income \"for 2024 or 2025\" from farming, ranching or fishing; \"pay all of your estimated income tax on or before January 15, 2026 ... If you file your 2025 Nebraska Individual Income Tax Return, Form 1040N, on or before March 1, 2026, and pay the total income tax due at that time, you do not need to make any estimated income tax payments for 2025\"); 66 2/3% in the 90% test; 2025 Nebraska Individual Income Tax Booklet (\"on or before March 1, 2026 ... An extension of time cannot be used to extend the March 1 filing date\"); Form 2210N (2025) Special Rules For Farmers And Ranchers. March 1, 2026 is a Sunday; file_by stored AS PRINTED (not rolled): Nebraska's printed weekend/holiday rule covers installment payments and the April 15 return date only, and the booklet states the March 1, 2026 date without a roll (audit 2026-10-11). The either-year two-thirds test cannot be represented by this key.",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "Form 2210N (2025) lines 22a/33 (\"Penalty (8% per year ...)\") -- a fixed state rate, not the federal rate",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'penalty.rate', value: 0.08,
    citation: "Form 2210N (2025, final) line 22a (\"Penalty (8% per year on the line 19 amount for the number of days in 2025 on line 21)\") and line 33",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "Neb. Rev. Stat. 77-2730(1) (resident credit for income tax imposed by another state, subdivision or DC on income derived from sources therein)",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "Neb. Rev. Stat. 77-2715(3) (nonresident tax = resident liability on the same total income less the personal exemption credit, multiplied by Nebraska adjusted gross income / total federal adjusted gross income)",
    status: 'verified',
  },
  {
    state: 'NE', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-25", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-24", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-30", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-31"],
    citation: "Neb. Rev. Stat. 25-2221 (court/nonjudicial days: Jan 1; MLK 3rd Mon Jan; President's Day 3rd Mon Feb; Arbor Day last Fri April; Memorial Day; Juneteenth June 19; July 4; Labor Day; Indigenous Peoples'/Columbus Day 2nd Mon Oct; Nov 11; Thanksgiving; day after Thanksgiving; Dec 25; plus days declared by law or Governor's proclamation; Sunday -> following Monday, Saturday -> preceding Friday; federal observance date controls where different, except Veterans Day) and Neb. Rev. Stat. 84-1001(3)-(4) (state-employee paid holidays = all days enumerated in 25-2221 plus days proclaimed by the President or Governor, same Saturday/Sunday shifts), both read at nebraskalegislature.gov 2026-10-11. Form 1040N-ES rolls installments falling on a \"legal holiday\"; Neb. Rev. Stat. 77-2769(5) ties estimated-tax due dates to the federal dates. Ad-hoc gubernatorial/presidential closure days are not included. Calendar 2025-2027 computed; Jan 1, 2028 (Saturday) -> Dec 31, 2027.",
    status: 'verified',
  },
  // ------------------------------------------------------------ 2026
  {
    state: 'NE', year: 2026, key: 'has_income_tax', value: true,
    citation: "Neb. Rev. Stat. 77-2715 (income tax on residents, nonresidents and partial-year residents); Form 1040N-ES (2026 booklet, 1/2026)",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'required_threshold', value: 500,
    citation: "Form 1040N-ES (2026 booklet, 1/2026) (\"Nebraska income tax after allowance of personal exemption credits ... expected to exceed withholding and other credits by $500 or more\"; worksheet line 18 \"less than $500\"); Form 2210N exceptions",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form 1040N-ES (2026 booklet, 1/2026) Penalty section item 1 (\"90% (66 2/3% for those engaged in farming, ranching, and fishing) of the income tax liability for the year\") and worksheet line 16a",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form 1040N-ES (2026 booklet, 1/2026) Penalty section item 2 (\"100% of the income tax shown on the Nebraska return for the full 12-month preceding tax year, if federal AGI was $150,000 or less\")",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: "Form 1040N-ES (2026 booklet, 1/2026) Penalty section item 3 and worksheet line 16b (\"110% ... if 2025 federal AGI was above $150,000 ($75,000 if your filing status ... is married, filing separately)\"). The $75,000 married-filing-separately threshold cannot be represented by this key.",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Form 1040N-ES (2026 booklet, 1/2026) \"When to Pay Your Estimated Income Tax\" (April 15, June 15, September 15, January 15; \"If the due date falls on a Saturday, Sunday, or legal holiday, taxpayers have until the next business day to make the payment\"). No date is a weekend or holiday.",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form 1040N-ES (2026 booklet, 1/2026) worksheet line 19 / voucher instructions (1/4, 1/2, 3/4, then full amount of line 18 cumulatively = equal quarters); Form 2210N (2025) line 10 (\"Enter 25% of line 8 in each column\")",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Form 1040N-ES (2026 booklet, 1/2026) \"Farmers and Ranchers\" (at least two-thirds of gross income \"for 2025 or 2026\" from farming, ranching or fishing; \"pay all of your estimated income tax on or before January 15, 2027 ... If you file your 2026 Nebraska Individual Income Tax Return, Form 1040N, on or before March 1, 2027, and pay the total income tax due at that time, you do not need to make any estimated income tax payments for 2026\"); 66 2/3% in the 90% test (Penalty section item 1, worksheet line 16a). January 15, 2027 (Fri) and March 1, 2027 (Mon) need no roll. The either-year (current or prior) two-thirds test cannot be represented by this key.",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "Form 2210N (2025) lines 22a/33 (\"Penalty (8% per year ...)\") -- a fixed state rate, not the federal rate",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'penalty.rate', value: 0.08,
    citation: "Neb. Rev. Stat. 77-2790(3) (underpayment of estimated tax determined under federal law) and 77-2788(1) (interest at the rate in 45-104.02); Neb. Rev. Stat. 45-104.02(2) (rate redetermined every other year commencing January 1, 1993, i.e. odd years; changes only if it moves at least 2 points), so the rate in force for 2025 continues through 2026; Form 2210N (2025, final) line 22a (8% per year for days in 2025); DRAFT 2026 Form 2210N (as of 8/17/2026) line 22a (8% per year for days in 2026). CAUTION: a new rate may take effect January 1, 2027 for underpayment days in 2027. Audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "Neb. Rev. Stat. 77-2730(1) (resident credit for income tax imposed by another state, subdivision or DC on income derived from sources therein)",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "Neb. Rev. Stat. 77-2715(3) (nonresident tax = resident liability on the same total income less the personal exemption credit, multiplied by Nebraska adjusted gross income / total federal adjusted gross income)",
    status: 'verified',
  },
  {
    state: 'NE', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-25", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-24", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-30", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-31"],
    citation: "Neb. Rev. Stat. 25-2221 (court/nonjudicial days: Jan 1; MLK 3rd Mon Jan; President's Day 3rd Mon Feb; Arbor Day last Fri April; Memorial Day; Juneteenth June 19; July 4; Labor Day; Indigenous Peoples'/Columbus Day 2nd Mon Oct; Nov 11; Thanksgiving; day after Thanksgiving; Dec 25; plus days declared by law or Governor's proclamation; Sunday -> following Monday, Saturday -> preceding Friday; federal observance date controls where different, except Veterans Day) and Neb. Rev. Stat. 84-1001(3)-(4) (state-employee paid holidays = all days enumerated in 25-2221 plus days proclaimed by the President or Governor, same Saturday/Sunday shifts), both read at nebraskalegislature.gov 2026-10-11. Form 1040N-ES rolls installments falling on a \"legal holiday\"; Neb. Rev. Stat. 77-2769(5) ties estimated-tax due dates to the federal dates. Ad-hoc gubernatorial/presidential closure days are not included. Calendar 2025-2027 computed; Jan 1, 2028 (Saturday) -> Dec 31, 2027.",
    status: 'verified',
  },
];
