// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// MI state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 4 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch4-sources.md. Rows marked 'unverified' say why in the citation.
export const MI_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------ 2025
  {
    state: 'MI', year: 2025, key: 'has_income_tax', value: true,
    citation: "MI-1040ES (2025, Rev. 07-24) \"Who Must File Estimated Tax Payments\"; MI-2210 (2025) line 6 (2025 tax rate 4.25%)",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'required_threshold', value: 500,
    citation: "MCL 206.301(1) (installments required if annual tax \"can reasonably be expected to exceed the amount withheld ... and the credits allowed ... by more than $500.00\"); MI-1040ES (2025, Rev. 07-24) \"You must make estimated income tax payments if you expect to owe more than $500\"; MI-2210 (2025) (\"If the result is $500 or less, do not complete this form\"). Statutory test is MORE THAN $500 (exactly $500 is not required); key stores 500.",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "MI-1040ES (2025, Rev. 07-24) (\"90 percent of your total 2025 tax (qualified farmers, fishermen and seafarers use 66 and 2/3 percent)\"); MI-2210 (2025) line 6 (90%)",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "MI-1040ES (2025, Rev. 07-24) (\"100 percent of your 2024 tax\")",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: "MI-1040ES (2025, Rev. 07-24) (\"110 percent of your total 2024 tax if your 2024 adjusted gross income is more than $150,000 ($75,000 for married filing separately)\"). The $75,000 married-filing-separately threshold cannot be represented by this key.",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "MCL 206.301(1) (April 15, June 15, September 15 and January 15 of the following year); MI-1040ES (2025, Rev. 07-24) \"Payment Due Dates\" prints the rolled date: \"equal installments due on or before April 15, 2025, June 16, 2025, September 15, 2025, and January 15, 2026\"; MI-2210 (2025) Line 10 instructions (\"payments made after April 15 and through June 16, 2025\").",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "MCL 206.301(1) (\"each installment shall be equal to 1/4 the taxpayer's estimated tax\"); MI-1040ES (2025, Rev. 07-24) \"equal installments\"; MI-2210 (2025) instructions (\"four equal installments\")",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-01"},
    citation: "MCL 206.301(6) (a farmer or fisherman who files and pays federal tax under the IRC 6654 alternative schedule \"may file and pay the tax imposed by this part in the same manner\", i.e. one installment by January 15 or file and pay in full by the return date; seafarers included); MI-1040ES (2025, Rev. 07-24) (\"qualified farmers, fishermen and seafarers use 66 and 2/3 percent\"; two-thirds of gross income from farming, fishing or seafaring); MI-2210 (2025) \"Special Rules for Farmers, Fishermen, and Seafarers\" (gross income from farming/fishing/seafaring at least 2/3 of annual gross income for 2024 or 2025 AND MI-1040 filed and entire tax paid by March 1, 2026). file_by stored as printed (March 1, 2026, a Sunday): no Michigan weekend-roll text for this date was found, although Treasury itself rolled the Sunday June 15, 2025 installment to June 16.",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "MI-1040ES (2025, Rev. 07-24) (\"interest rate is 1 percent above the adjusted prime rate and is adjusted on January 1 and July 1\"); Revenue Administrative Bulletin 2026-10",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'penalty.rate', value: 0.0866,
    citation: "Superseded on covered days by penalty.rate_schedule (R5 M9). MCL 205.23(2) (deficiency in an estimated payment bears interest at 1 percentage point above the adjusted prime rate, reset January 1 and July 1); MI-2210 (2025) lines 19-21: Rate Period 1 9.47% (Apr 15-Jun 30, 2025); Period 2 8.66% (Jul 1-Dec 31, 2025); Period 3 8.48% (Jan 1-Jun 30, 2026); Revenue Administrative Bulletin 2026-10 rate table (same rates). CAUTION: three rates apply within one TY2025 underpayment; 8.66% (the period covering most installment-days) is stored. NOT EXPRESSIBLE: Michigan also adds a separate PENALTY of 10% of the underpaid installment (minimum $10) or 25% for not paying at all (minimum $25) per MI-2210 Part 3 / MI-1040ES; this key holds only the interest rate.",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "MCL 206.255(1),(3) (resident credit for income tax imposed by another state, its political subdivision, DC or a Canadian province on income also taxed by Michigan, limited to income taxed in both / taxable income x Michigan tax); MI-1040 2025 instruction book, Line 18 (worked example)",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'nonresident_method', value: "sourced_flat",
    citation: "MCL 206.110(2) (for a nonresident individual, taxable income is allocated to Michigan only to the extent earned in Michigan: personal services performed in Michigan, Michigan business activity, Michigan lottery/casino winnings); MI-1040 2025 instruction book, Schedule NR (Michigan-source income in Column B taxed at the flat 4.25% rate; exemptions prorated by Michigan-source / total income)",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-24", "2025-12-25", "2025-12-31", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2026-12-31"],
    citation: "Corrected per R5 review m5 (michigan.gov/som state holidays, Civil Service Commission Reg 5.08 — the previous list was New York's); not re-read in this task. The 2027 Michigan list is not published (only Jan 1, 2027 kept). Previous citation: MCL 435.101(1) (Jan 1; MLK 3rd Mon Jan; Feb 12; Washington's Birthday 3rd Mon Feb; Memorial Day; June 19; July 4; Labor Day; Columbus Day 2nd Mon Oct; Nov 11; Thanksgiving; Dec 25; Saturday afternoons are half-holidays). The statute has no Sunday-to-Monday shift. Calendar 2025-2027 computed from the statute.",
    status: 'unverified',
  },
  // ------------------------------------------------------------ 2026
  {
    state: 'MI', year: 2026, key: 'has_income_tax', value: true,
    citation: "MI-1040ES (2026) \"Who Must File Estimated Tax Payments\"; MI-2210 (2025) line 6 (2025 tax rate 4.25%)",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'required_threshold', value: 500,
    citation: "MCL 206.301(1) (\"by more than $500.00\"); MI-1040ES (2026, Rev. 04-25) \"You must make estimated income tax payments if you expect to owe more than $500 when you file your 2026 MI-1040 return\". Statutory test is MORE THAN $500; key stores 500.",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "MI-1040ES (2026) (\"90 percent of your total 2026 tax (qualified farmers, fishermen and seafarers use 66 and 2/3 percent)\"); MI-2210 (2025) line 6 (90%)",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "MI-1040ES (2026) (\"100 percent of your 2025 tax\")",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: "MI-1040ES (2026) (\"110 percent of your total 2025 tax if your 2025 adjusted gross income is more than $150,000 ($75,000 for married filing separately)\"). The $75,000 married-filing-separately threshold cannot be represented by this key.",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "MI-1040ES (2026) \"Payment Due Dates\" (\"equal installments due on or before April 15, 2026, June 15, 2026, September 15, 2026, and January 15, 2027\") and due-date table by income-change period; none of the dates is a weekend or MCL 435.101 holiday.",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "MCL 206.301(1) (\"each installment shall be equal to 1/4 the taxpayer's estimated tax\"); MI-1040ES (2026) \"equal installments\"; MI-2210 (2025) instructions (\"four equal installments\")",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "MI-1040ES (2026) \"Estimated Tax Payments for Farmers, Fishermen and Seafarers\" (\"File your first 2026 voucher on or before January 15, [2027] ... or File your 2026 MI-1040 return on or before March 1, 2027, and pay the entire tax with the return\") and \"90 percent ... 66 and 2/3 percent\"",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "MI-1040ES (2026) (\"interest rate is 1 percent above the adjusted prime rate and is adjusted on January 1 and July 1\"); Revenue Administrative Bulletin 2026-10",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'penalty.rate', value: 0.0785,
    citation: "Superseded on covered days by penalty.rate_schedule (R5 M9). MCL 205.23(2) (1 percentage point above the adjusted prime rate, reset January 1 and July 1); Revenue Administrative Bulletin 2026-10 (approved Sept. 30, 2026) table: Jan 1-Jun 30, 2026 8.48%; Jul 1-Dec 31, 2026 7.85%; Jan 1-Jun 30, 2027 7.77%. CAUTION: rate changes every six months; 7.85% (second half of 2026) stored as a single value. NOT EXPRESSIBLE: separate 10%/25% penalty on underpaid/unpaid installments (MI-1040ES (2026) \"Nonpayment, Late Payment, or Underpayment of Estimates\").",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "MCL 206.255(1),(3) (resident credit for income tax imposed by another state, its political subdivision, DC or a Canadian province on income also taxed by Michigan, limited to income taxed in both / taxable income x Michigan tax); statute read 2026-10-11 is current law for TY2026; MI-1040 2025 instruction book Line 18",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'nonresident_method', value: "sourced_flat",
    citation: "MCL 206.110(2) (for a nonresident individual, taxable income is allocated to Michigan only to the extent earned in Michigan: personal services performed in Michigan, Michigan business activity, Michigan lottery/casino winnings); MI-1040 2025 instruction book, Schedule NR (Michigan-source income in Column B taxed at the flat 4.25% rate; exemptions prorated by Michigan-source / total income); MCL 206.110 read 2026-10-11 is current law for TY2026 (2026 book not yet issued)",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'holidays', value: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01"],
    citation: "Corrected per R5 review m5 (michigan.gov/som state holidays, Civil Service Commission Reg 5.08 — the previous list was New York's); not re-read in this task. The 2027 Michigan list is not published (only Jan 1, 2027 kept). Previous citation: MCL 435.101(1) (Jan 1; MLK 3rd Mon Jan; Feb 12; Washington's Birthday 3rd Mon Feb; Memorial Day; June 19; July 4; Labor Day; Columbus Day 2nd Mon Oct; Nov 11; Thanksgiving; Dec 25; Saturday afternoons are half-holidays). The statute has no Sunday-to-Monday shift. Calendar 2025-2027 computed from the statute.",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'threshold_comparison', value: "more_than",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md m1/D2: the requirement and penalty tests read \"more than\" the dollar threshold); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2025, key: 'penalty.rate_schedule', value: [{"from": "2025-01-01", "to": "2025-06-30", "rate": 0.0947}, {"from": "2025-07-01", "to": "2025-12-31", "rate": 0.0866}, {"from": "2026-01-01", "to": "2026-06-30", "rate": 0.0848}],
    citation: "Michigan RAB 2026-10 (approved Sept. 30, 2026; michigan.gov/taxes, read 2026-10-12) rate table: Jan 1-Jun 30, 2025 9.47%; Jul 1-Dec 31, 2025 8.66%; Jan 1-Jun 30, 2026 8.48%; Jul 1-Dec 31, 2026 7.85%; Jan 1-Jun 30, 2027 7.77%. MCL 205.23(2) (1 point above adjusted prime, semiannual). The MI-2210 flat 10% (min $10) add-on is not representable (Q26).",
    status: 'verified',
  },
  {
    state: 'MI', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'threshold_comparison', value: "more_than",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md m1/D2: the requirement and penalty tests read \"more than\" the dollar threshold); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2026, key: 'penalty.rate_schedule', value: [{"from": "2026-01-01", "to": "2026-06-30", "rate": 0.0848}, {"from": "2026-07-01", "to": "2026-12-31", "rate": 0.0785}, {"from": "2027-01-01", "to": "2027-06-30", "rate": 0.0777}],
    citation: "Michigan RAB 2026-10 (approved Sept. 30, 2026; michigan.gov/taxes, read 2026-10-12) rate table: Jan 1-Jun 30, 2025 9.47%; Jul 1-Dec 31, 2025 8.66%; Jan 1-Jun 30, 2026 8.48%; Jul 1-Dec 31, 2026 7.85%; Jan 1-Jun 30, 2027 7.77%. MCL 205.23(2) (1 point above adjusted prime, semiannual). The MI-2210 flat 10% (min $10) add-on is not representable (Q26).",
    status: 'verified',
  },
  {
    state: 'MI', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MI', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
