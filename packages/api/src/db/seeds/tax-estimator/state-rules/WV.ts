// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// WV state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 6 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch6-sources.md. The CPA signs off WV (D12).
// Sources: 2025 West Virginia Personal Income Tax Information and Instructions (IT-140 booklet,
// incl. IT-210 instructions); IT-140ESI (Sept 2023); TSD 365 (Rev. March 2026); W. Va. Code §2-2-1.
// The TY2026 IT-140 booklet is not yet published; audit 2026-10-11 re-verified the TY2026 rows against
// W. Va. Code 11-21-3/-20/-30/-55/-56, 11-10-18a and 2-2-1 (statute in force).
export const WV_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'WV', year: 2025, key: 'has_income_tax', value: true,
    citation: "2025 IT-140 booklet, tax rate schedules and IT-140ESI worksheet line 6 (West Virginia personal income tax)",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'required_threshold', value: 600,
    citation: "2025 IT-140 booklet, \"Credit for Estimated Tax\" (\"You must make quarterly estimated tax payments if your estimated tax liability (your estimated tax reduced by any state tax withheld from your income) is at least $600, unless that liability is less than ten percent (10%) of your estimated tax\"); IT-140ESI \"Who must make estimated tax payments?\". The 10%-of-estimated-tax carve-out is not expressible.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "2025 IT-140 booklet, \"Penalty for Underpayment of Estimated Tax\" (\"smaller of 90% of your current year tax liability; or 100% of your prior tax liability\") and IT-210 Part I line 6 (multiply line 3 by 90%)",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "2025 IT-140 booklet \"Penalty for Underpayment of Estimated Tax\" and IT-210 Part I lines 7-8 (smaller of line 6 or prior-year tax after credits). Zero-prior-year-tax exception (current-year tax under $5,000) not expressible.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: 2025 IT-140 booklet IT-210 Part I line 8 uses the smaller of 90% of current tax or 100% of prior tax with no income test",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "2025 IT-140 booklet, IT-210 Part IV Section A columns (April 15, June 15, September 15, January 15) with footnote \"The exact closing day of each quarter may shift to accommodate weekends or holidays\"; IT-140ESI (\"If the due date falls on Saturday, Sunday, or a legal holiday, the payment is due the next business day\"). June 15, 2025 is a Sunday -> June 16, 2025 (rolled by this file). Statute: W. Va. Code 11-21-56(a)(1) (April 15 / June 15 / September 15 / January 15) and 2-2-1(e) (a date falling on a Saturday, Sunday or legal holiday moves to the next day that is not), which supports the June 16, 2025 roll.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "2025 IT-140 booklet, IT-210 Part IV Section A line 1 (\"enter 1/4 of line 8 of PART I in each column\"); IT-140ESI (25% of prior-year tax by first installment)",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "2025 IT-140 booklet, \"Special Rules for Farmers\" (at least two-thirds of gross income from farming: one payment due January 15; 66 2/3% instead of 90%; no penalty if the return is filed and tax paid on or before the first day of March). March 1, 2026 is a Sunday -> file_by 2026-03-02 (MO convention). Ratio stored just under 2/3. Statute: W. Va. Code 11-21-55(e), 11-10-18a(j) (66 2/3%, January 15, March 1); March 1 roll per 2-2-1(e). current_pct stored 0.6666666667 (audit: was 0.6667).",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "2025 IT-140 booklet \"Penalties and Interest\" (rate fixed yearly at adjusted prime + 3 points); TSD 365 (Rev. March 2026); IT-210 Part IV line 11 daily rate",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'penalty.rate', value: 0.1225,
    citation: "TSD 365 (Rev. March 2026) interest table and 2025 IT-210 instructions: 12.25% for 1/1/2025-12/31/2025 (daily .000336). CAUTION: days of a TY2025 underpayment falling in 2026 accrue at 11.5% (daily .000315). Statute: W. Va. Code 11-21-55(e), 11-10-18a(j) (66 2/3%, January 15, March 1); March 1 roll per 2-2-1(e). current_pct stored 0.6666666667 (audit: was 0.6667). Statute: W. Va. Code 11-21-56(a)(1) (April 15 / June 15 / September 15 / January 15) and 2-2-1(e) (date falling on a Saturday, Sunday or legal holiday moves to the next day that is not), which supports the June 16, 2025 roll.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "2025 IT-140 booklet, Schedule E (\"Credit for Income Tax Paid to Another State\"); IT-140ESI worksheet line 7",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "2025 IT-140 booklet IT-210 line 8 instructions (\"multiply the tax figure by the ratio of your West Virginia income to your federal income\"); IT-140ESI worksheet line 6 (multiply by West Virginia source income / total federal income)",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-20", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-12", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-21", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24"
    ],
    citation: "W. Va. Code 2-2-1(a)-(b) (Jan 1; 3rd Mon Jan; 3rd Mon Feb; last Mon May; June 20 West Virginia Day; July 4; 1st Mon Sep; 2nd Mon Oct; Nov 11; Thanksgiving and the day after (Lincoln's Day); Dec 25; (13) \"Any day on which a general, primary or special election is held\"; (14) even-year general election day; Sunday holiday -> Monday, Saturday holiday -> preceding Friday, not applied to (13)-(15)); W. Va. Code 3-5-1 (primary \"on the second Tuesday in May\" in even years) -> AUDIT ADDED primary day May 12, 2026; general election Nov 3, 2026 (Tuesday after first Monday). Special-election and governor-proclaimed days (2-2-1(a)(15)) cannot be known in advance and are omitted. Calendar years 2025-2027. Dates computed from the statute (read 2026-10-11).",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'WV', year: 2026, key: 'has_income_tax', value: true,
    citation: "W. Va. Code 11-21-3(a) (tax \"imposed for each taxable year on the West Virginia taxable income of every individual\"); TSD 365 (Rev. March 2026) 2026 interest table. TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'required_threshold', value: 600,
    citation: "W. Va. Code 11-10-18a(e)(1) (no addition to tax \"if the tax shown on the return ... reduced by the credit allowable for withheld tax, is less than $600\"); 2025 IT-140 booklet \"Credit for Estimated Tax\" ($600). Not expressible: the declaration statute 11-21-55(a) is an income test (WV AGI other than withheld wages over $400 plus exemptions), and the zero-prior-year-tax exception for current-year tax under $5,000 (11-10-18a(e)(2)). TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "W. Va. Code 11-10-18a(b)(1) (\"ninety percent of the tax shown on the annual return ... divided by the number of installments\"). TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "W. Va. Code 11-10-18a(d)(1) (\"One hundred percent of the tax shown on the return of the taxpayer for the preceding taxable year\", 12-month year with a return showing liability); lesser-of with 18a(b). TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: W. Va. Code 11-10-18a(d)(1) uses 100% of prior-year tax with no income test. TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "W. Va. Code 11-21-55(d) (declaration by April 15) and 11-21-56(a)(1) (four equal installments: at filing, then June 15, September 15, January 15); W. Va. Code 2-2-1(e) (a date falling on a Saturday, Sunday, legal holiday or designated day off moves to the next day that is not). April 15 (Wed), June 15 (Mon), September 15 (Tue), 2026 and January 15, 2027 (Fri) need no roll. TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "W. Va. Code 11-21-56(a)(1) (\"four equal installments\"); 11-10-18a(b)(1) (required amount divided by the number of installments). TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "W. Va. Code 11-21-55(e) (farming WV AGI \"at least two thirds\" of total; declaration by January 15) and 11-10-18a(j) (one required installment due January 15 of the following year; \"sixty-six and two-thirds percent\" for \"ninety percent\"; no addition if the return is filed and paid by \"March 1\"); 2025 IT-140 booklet \"Special Rules for Farmers\". January 15, 2027 (Fri) and March 1, 2027 (Mon) need no roll. current_pct stored 0.6666666667 (audit: was 0.6667). TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "TSD 365 (Rev. March 2026) and 2025 IT-140 booklet \"Penalties and Interest\" (adjusted prime + 3 points, never below 8%)",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'penalty.rate', value: 0.115,
    citation: "TSD 365 (Rev. March 2026) interest table: 11.5% for 1/1/2026-12/31/2026 (daily .000315, 2025 IT-140 booklet IT-210 instructions). CAUTION: the calendar-2027 rate (set each December) governs 2027 days of a TY2026 underpayment and was not yet published.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "W. Va. Code 11-21-20(a)-(b) (resident credit for income tax paid to another state or DC on income derived there and taxed by WV, limited to the proportional WV tax); 2025 IT-140 booklet Schedule E. TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "W. Va. Code 11-21-30(a)(1)-(2) (tax computed as if a resident, then \"multiplied by a fraction the numerator of which is the taxpayer's West Virginia source income ... and the denominator of which is such taxpayer's federal adjusted gross income\"); 2025 IT-140 booklet / IT-140ESI worksheet line 6. TY2026 IT-140 booklet / IT-210 / IT-140ES still not published at audit (2026-10-11: tax.wv.gov forms pages list only /Documents/PIT/2025/ files); row verified against the statute in force, read 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-20", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-12", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-21", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24"
    ],
    citation: "W. Va. Code 2-2-1(a)-(b) (Jan 1; 3rd Mon Jan; 3rd Mon Feb; last Mon May; June 20 West Virginia Day; July 4; 1st Mon Sep; 2nd Mon Oct; Nov 11; Thanksgiving and the day after (Lincoln's Day); Dec 25; (13) \"Any day on which a general, primary or special election is held\"; (14) even-year general election day; Sunday holiday -> Monday, Saturday holiday -> preceding Friday, not applied to (13)-(15)); W. Va. Code 3-5-1 (primary \"on the second Tuesday in May\" in even years) -> AUDIT ADDED primary day May 12, 2026; general election Nov 3, 2026 (Tuesday after first Monday). Special-election and governor-proclaimed days (2-2-1(a)(15)) cannot be known in advance and are omitted. Calendar years 2025-2027. Dates computed from the statute (read 2026-10-11).",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'WV', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'WV', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'WV', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
