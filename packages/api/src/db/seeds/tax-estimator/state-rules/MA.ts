// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// MA state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 4 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch4-sources.md. Rows marked 'unverified' say why in the citation.
export const MA_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------ 2025
  {
    state: 'MA', year: 2025, key: 'has_income_tax', value: true,
    citation: "G.L. c.62 5A (nonresident income taxed under section 4) and 6(a) (resident credit); Form 1-ES instructions (tax on Part A/B/C income at 5%, 8.5%, 12% and 4% surtax)",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'required_threshold', value: 400,
    citation: "G.L. c.62B s.13 (estimated payments required where the estimated tax, net of c.62 s.6 credits and withholding, \"is more than $400\"); c.62B s.14(d)(i) (no addition if tax less credits \"is less than $400\"); AP 241 s.241.1 (\"expect to owe more than $400\"); Form M-2210 (2025) Exceptions (\"Your 2025 tax due after credits and withholding is $400 or less\"). Exactly $400: no requirement under s.13 but s.14(d)(i) does not excuse it; key stores 400.",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'safe_harbor.current_pct', value: 0.8,
    citation: "G.L. c.62B s.14(c) (required annual payment = lesser of \"eighty per cent, or sixty-six and two-thirds per cent in the case of a farmer or fisherman\" of the tax shown on the return, or 100% of the preceding 12-month year's tax); Form M-2210 (2025) Part 1 line 4 (\"Enter 80% of line 3 or 66.67% of line 3 if you are a qualified farmer or fisherman\"); AP 241 s.241.4",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "G.L. c.62B s.14(c)(ii) (\"one hundred per cent of the tax shown on the return of the taxpayer for the preceding taxable year, provided the taxpayer filed a return for the preceding taxable year and such preceding year was a taxable year of twelve months\"); Form M-2210 (2025) Exceptions and line 5; AP 241 s.241.4 Exception 4",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI variant: G.L. c.62B s.14(c)(ii) uses 100% of the preceding year's tax with no income test; Form M-2210 (2025) line 5",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Form M-2210 (2025) -- April 15, June 15, September 15 and January 15 -- and \"Whenever a due date falls on a Saturday, Sunday or legal holiday, the filing and payment may be made on the next succeeding business day\"; G.L. c.4 9. June 15, 2025 is a Sunday -> June 16, 2025.",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "G.L. c.62B s.14(c) (\"four required installments ... The amount of any required installment shall be twenty-five per cent of the required annual payment\"); Form 1-ES (2026) worksheet note (25%, 33%, 50%, 100% cumulative); Form M-2210 (2025) line 8",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-03-02", "file_by": "2026-03-02"},
    citation: "G.L. c.62B s.14(c) (66 2/3% for a farmer or fisherman) and s.14(h) (no addition if a farmer or fisherman, gross income from farming or fishing at least two-thirds of total gross income for the year or the preceding year, files and pays in full \"on or before March first of the following taxable year\"); Form M-2210 (2025) Exceptions (\"filed and paid in full with your return by March 1, 2026\"); AP 241 s.241.4 Exception 2. Massachusetts has NO single January 15 farmer installment: the farmer otherwise owes four 25% installments of 66 2/3%; due_date = file_by = March 1. March 1, 2026 is a Sunday -> March 2, 2026 under G.L. c.4 s.9 (act or payment due on a Sunday or legal holiday may be performed on the next succeeding business day) and Form M-2210 (2025) General Information (\"Whenever a due date falls on a Saturday, Sunday or legal holiday, the payment may be made on the next succeeding business day\").",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "G.L. c.62B s.14(a) (addition to tax at the rate established under c.62C s.32, without daily compounding); TIR 26-5 (federal short-term rate plus four percentage points); AP 241 s.241.4",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'penalty.rate', value: 0.08,
    citation: "G.L. c.62B s.14(a) (addition at the c.62C s.32 rate \"but without daily compounding\"); TIR 26-5 (09/01/2026) table (\"2025 Entire year ... 8%\" underpayment); Form M-2210 (2025) lines 20-23 (8% for days through April 15, 2026); TIR 26-5 shows Q1 2026 also 8%, so one rate covers the whole TY2025 period.",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "G.L. c.62 6(a) (resident credit for taxes due another state, territory, possession or Canadian province on Massachusetts gross income, limited by the ratio of that income to total Massachusetts Part A/B/C income)",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'nonresident_method', value: "sourced_flat",
    citation: "G.L. c.62 5A(a)-(b) (nonresident's Part A/B/C taxable income \"derived from the Massachusetts gross income\" is taxed under section 4 at the flat Part rates; Massachusetts-source income determined by regulation). Massachusetts source income x flat rate (5%/8.5%/12% parts, 4% surtax over threshold).",
    status: 'verified',
  },
  {
    state: 'MA', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-21", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-20", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-19", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "G.L. c.4 7 Eighteenth (Jan 1, June 19, July 4, Nov 11, Dec 25 or the following day if Sunday; 3rd Mon Jan, 3rd Mon Feb, 3rd Mon Apr (Patriots' Day), last Mon May, 1st Mon Sep, 2nd Mon Oct, Thanksgiving). Suffolk County-only days (Evacuation Day, Bunker Hill Day) excluded. Saturday holidays not moved. Calendar 2025-2027 computed from the statute.",
    status: 'verified',
  },
  // ------------------------------------------------------------ 2026
  {
    state: 'MA', year: 2026, key: 'has_income_tax', value: true,
    citation: "G.L. c.62 5A (nonresident income taxed under section 4) and 6(a) (resident credit); Form 1-ES instructions (tax on Part A/B/C income at 5%, 8.5%, 12% and 4% surtax)",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'required_threshold', value: 400,
    citation: "G.L. c.62B s.13 (estimated payments required where the estimated tax, net of c.62 s.6 credits and withholding, \"is more than $400\"); c.62B s.14(d)(i) (no addition if tax less credits \"is less than $400\"); AP 241 s.241.1 (\"expect to owe more than $400\"); Form 1-ES (2026) (\"expect to owe more than $400\"; worksheet line 11 \"If less than $400 you are not required to make estimated payments\"). Exactly $400: no requirement under s.13 but s.14(d)(i) does not excuse it; key stores 400.",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'safe_harbor.current_pct', value: 0.8,
    citation: "G.L. c.62B s.14(c) (required annual payment = lesser of \"eighty per cent, or sixty-six and two-thirds per cent in the case of a farmer or fisherman\" of the tax shown on the return, or 100% of the preceding 12-month year's tax); Form M-2210 (2025) Part 1 line 4 (\"Enter 80% of line 3 or 66.67% of line 3 if you are a qualified farmer or fisherman\"); AP 241 s.241.4",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "G.L. c.62B s.14(c)(ii) (\"one hundred per cent of the tax shown on the return of the taxpayer for the preceding taxable year, provided the taxpayer filed a return for the preceding taxable year and such preceding year was a taxable year of twelve months\"); Form M-2210 (2025) Exceptions and line 5; AP 241 s.241.4 Exception 4",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI variant: G.L. c.62B s.14(c)(ii) uses 100% of the preceding year's tax with no income test; Form M-2210 (2025) line 5",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Form 1-ES (2026) -- April 15, June 15, September 15 and January 15 -- and \"Whenever a due date falls on a Saturday, Sunday or legal holiday, the filing and payment may be made on the next succeeding business day\"; G.L. c.4 9. No date is a weekend or c.4 7 legal holiday.",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "G.L. c.62B s.14(c) (\"four required installments ... The amount of any required installment shall be twenty-five per cent of the required annual payment\"); Form 1-ES (2026) worksheet note (25%, 33%, 50%, 100% cumulative); Form M-2210 (2025) line 8",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-03-01", "file_by": "2027-03-01"},
    citation: "G.L. c.62B s.14(c) (66 2/3% for a farmer or fisherman) and s.14(h) (file and pay in full \"on or before March first of the following taxable year\"; two-thirds gross-income test); AP 241 s.241.4 Exception 2 (\"on or before the first day of the third month of the following year\"). No single January 15 farmer installment in Massachusetts; due_date = file_by = March 1, 2027 (a Monday, no roll). Statutes read 2026-10-11 are current law for TY2026.",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "G.L. c.62B s.14(a) (addition to tax at the rate established under c.62C s.32, without daily compounding); TIR 26-5 (federal short-term rate plus four percentage points); AP 241 s.241.4",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'penalty.rate', value: 0.08,
    citation: "G.L. c.62B s.14(a) (c.62C s.32 rate = federal short-term rate + 4 points, simple for estimates); TIR 26-5 (09/01/2026) table: 2026 Q1 8%, Q2 7%, Q3 8%, Q4 8%. CAUTION: floats quarterly (single-rate key); 8% stored; Q2 2026 was 7%; Q1 2027 (through April 15, 2027) not yet announced.",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "G.L. c.62 6(a) (resident credit for taxes due another state, territory, possession or Canadian province on Massachusetts gross income, limited by the ratio of that income to total Massachusetts Part A/B/C income)",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'nonresident_method', value: "sourced_flat",
    citation: "G.L. c.62 5A(a)-(b) (nonresident's Part A/B/C taxable income \"derived from the Massachusetts gross income\" is taxed under section 4 at the flat Part rates; Massachusetts-source income determined by regulation). Massachusetts source income x flat rate (5%/8.5%/12% parts, 4% surtax over threshold).",
    status: 'verified',
  },
  {
    state: 'MA', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-21", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-20", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-19", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "G.L. c.4 7 Eighteenth (Jan 1, June 19, July 4, Nov 11, Dec 25 or the following day if Sunday; 3rd Mon Jan, 3rd Mon Feb, 3rd Mon Apr (Patriots' Day), last Mon May, 1st Mon Sep, 2nd Mon Oct, Thanksgiving). Suffolk County-only days (Evacuation Day, Bunker Hill Day) excluded. Saturday holidays not moved. Calendar 2025-2027 computed from the statute.",
    status: 'verified',
  },
];
