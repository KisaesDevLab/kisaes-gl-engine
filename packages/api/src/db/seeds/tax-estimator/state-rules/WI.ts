// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// WI state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 6 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch6-sources.md. The CPA signs off WI (D12).
// Sources: 2025 and 2026 Form 1-ES Instructions (revenue.wi.gov); 2025 Schedule U and Instructions;
// 2025 Form 1 and Form 1NPR Instructions; Wis. Stat. §995.20.
export const WI_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'WI', year: 2025, key: 'has_income_tax', value: true,
    citation: "2025 Form 1-ES Instructions, Tax Rate Schedules A-C (3.5%-7.65%)",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'required_threshold', value: 500,
    citation: "Wis. Stat. §71.09(11)(a) (no interest if tax shown on the return minus withholding is less than $500); 2025 Form 1-ES Instructions, \"Who Must Pay Estimated Tax\" (\"expect to owe, after subtracting your withholding and credits, at least $500 in tax for 2025\") and worksheet line 9 note ($500)",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "2025 Form 1-ES Instructions (\"smallest of (1) 90% of the tax shown on your 2025 income tax return ... (3) 90% ... annualizing\"); 2025 Schedule U Instructions (\"at least the smaller of 90% of your current year ... or 100% of your prior year\") and Schedule U line 4",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "2025 Form 1-ES Instructions (\"100% of the tax shown on your 2024 income tax return, assuming the return covered 12 months\"; not available to estates/trusts with 2025 taxable income of $20,000 or more); 2025 Schedule U Instructions Line 7",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: 2025 Form 1-ES Instructions and 2025 Schedule U Instructions use 100% of prior-year tax for all individuals",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "2025 Form 1-ES Instructions, \"When to Pay Your Estimated Tax\" (April 15, 2025, June 16, 2025, September 15, 2025, and January 15, 2026; weekend/legal-holiday -> next business day)",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "2025 Form 1-ES Instructions (\"four equal installments\"); worksheet line 10 (1/4 of line 9 in each column); Schedule U line 16 (line 8 divided by four)",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "Wis. Stat. §71.09(1)(a) (farmer or fisher: farming/fishing gross income at least two-thirds of total gross income for the taxable year or the preceding year), §71.09(3) (the estimated tax \"required by sub. (2)\" may be paid on or before the 15th day of the first month of the succeeding year), §71.09(4) (file by the first day of the 3rd month and pay in full satisfies all installments), §71.09(13)(a) (required amount = lower of 90% current / 100% prior - no 66 2/3% reduction); 2025 Form 1-ES Instructions item 3 (January 15, 2026 / file by March 2, 2026; March 1, 2026 is a Sunday); 2025 Schedule U Instructions Line 16 and exception code 04. current_pct 0.9 = the ordinary required annual payment.",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "Wis. Stat. §71.84(1) (underpayment of estimated tax by an individual: \"interest at the rate of 12 percent per year\" until the 15th day of the 4th month after year end or payment); 2025 Schedule U lines 13 and 27-28",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'penalty.rate', value: 0.12,
    citation: "Wis. Stat. §71.84(1) (\"interest at the rate of 12 percent per year on the amount of the underpayment\"); 2025 Schedule U lines 27-28 (\"Days ... x .12 / 365 x underpayment\") and Part II line 14 daily factor .0003287 (= 12%/365). Fixed statutory rate, so days in 2026 also accrue at 12%.",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "2025 Form 1 Instructions, Line 20 \"Credit for Net Tax Paid to Another State\" (Schedule OS)",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "2025 Form 1NPR Instructions, Lines 30-32 (line 32 \"Ratio of Your Wisconsin Income to Federal Income\" ... \"the tax will be later prorated based on the ratio of your Wisconsin income to federal income\"); 2025 Form 1-ES Instructions (nonresidents prorate brackets by the same ratio)",
    status: 'verified',
  },
  {
    state: 'WI', year: 2025, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-08-11", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"
    ],
    citation: "Wis. Stat. §995.20 (text read in audit 2026-10-11): Jan 1; 3rd Mon Jan; 3rd Mon Feb; last Mon May; June 19; July 4; 1st Mon Sep; 2nd Mon Oct; Nov 11; 4th Thu Nov; Dec 25; \"the day of holding the partisan primary election, and the day of holding the general election in November\"; \"Whenever any legal holiday falls on Sunday, the succeeding Monday shall be the legal holiday\" (Saturday holidays not moved). Partisan primary = 2nd Tuesday in August (Wis. Stat. §5.02(12s)) -> Aug 11, 2026 (added in audit); general election Nov 3, 2026. Calendar years 2025-2027. Dates computed from the statutes.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'WI', year: 2026, key: 'has_income_tax', value: true,
    citation: "2026 Form 1-ES Instructions, Tax Rate Schedules (3.5%-7.65%)",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'required_threshold', value: 500,
    citation: "Wis. Stat. §71.09(11)(a) ($500 after withholding); 2026 Form 1-ES Instructions, \"Who Must Pay Estimated Tax\" (\"at least $500 in tax for 2026\") and worksheet line 9 note",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "2026 Form 1-ES Instructions (\"smallest of (1) 90% of the tax shown on your 2026 income tax return ...\")",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "2026 Form 1-ES Instructions (\"(2) 100% of the tax shown on your 2025 income tax return, assuming the return covered 12 months\")",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule in the 2026 Form 1-ES Instructions",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "2026 Form 1-ES Instructions, \"When to Pay Your Estimated Tax\" (April 15, June 15, September 15, 2026, and January 15, 2027)",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "2026 Form 1-ES Instructions (\"four equal installments\"); worksheet line 10 (1/4 each)",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Wis. Stat. §71.09(1)(a), (3), (4) and (13)(a) (farmers pay the ordinary required amount - lower of 90% current / 100% prior - by January 15 of the following year, or file by the first day of the 3rd month and pay in full); 2026 Form 1-ES Instructions item 3 (January 15, 2027; file by March 1, 2027). Statute text read in audit 2026-10-11; upgraded from unverified.",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "Wis. Stat. §71.84(1) (statutory 12 percent per year, not the federal rate). Statute text read in audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'penalty.rate', value: 0.12,
    citation: "Wis. Stat. §71.84(1) (fixed statutory rate of 12 percent per year on estimated-tax underpayments by individuals). Statute text read in audit 2026-10-11; upgraded from unverified.",
    status: 'verified',
  },
  {
    state: 'WI', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "2025 Form 1 Instructions, Line 20 / Schedule OS; 2026 Form 1 instructions not yet published",
    status: 'unverified',
  },
  {
    state: 'WI', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "2025 Form 1NPR Instructions line 32 ratio of Wisconsin income to federal income; 2026 Form 1NPR instructions not yet published",
    status: 'unverified',
  },
  {
    state: 'WI', year: 2026, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-08-11", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"
    ],
    citation: "Wis. Stat. §995.20 and §5.02(12s) (see 2025 row; partisan primary Aug 11, 2026 added in audit 2026-10-11). Calendar years 2025-2027. Dates computed from the statutes.",
    status: 'verified',
  },
];
