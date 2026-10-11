// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// KY state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 3 research, 2026-10-11).
// Every row cites the primary source it was read in; see features/tax-estimator/docs/reviews/phase2-batch3-sources.md.
export const KY_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'KY', year: 2025, key: 'has_income_tax',
    value: true,
    citation: "Kentucky 2025 Form 740 packet instructions, revenue.ky.gov/Forms/740%20Packet%20Instructions.pdf ('For 2025, the tax rate for individual income tax is 4%'); KRS 141.020",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'required_threshold',
    value: 500,
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf 'General Rule' ('You expect to owe at least $500 in tax for 2025, after subtracting your withholding and refundable credits'; 'If the amount of estimated tax for the year is $500 or less, no payment is required'); 'Who must make payments' (may be required if more than $5,000 of income without Kentucky withholding)",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf General Rule 2(a) ('90% of the tax to be shown on your 2025 tax return'); worksheet line 13(a)",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf General Rule 2(b) ('100% of the tax shown on your 2024 tax return ... must cover all 12 months'); worksheet line 13(b)",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: {"threshold": 150000, "pct": 1.1},
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf Special Rules ('If your Kentucky adjusted gross income for 2024 was more than $150,000 ($75,000 if your filing status for 2025 is married filing separately), substitute 110% for 100% ... This rule does not apply to farmers'); worksheet line 13(b). Threshold is KENTUCKY AGI; the MFS $75,000 threshold and the farmer exclusion are not expressible.",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf 'When to pay' and due-date table (April 15, 2025; June 16, 2025; September 15, 2025; January 15, 2026). June 15, 2025 was a Sunday; the instructions themselves print June 16.",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf due-date table ('Number of Equal Installments' 4/3/2/1) and worksheet line 14",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-01"},
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf Special Rules ('If at least two-thirds of your gross income for 2024 or 2025 is from farming, substitute 66 2/3% for 90%'; 'Pay all of your estimated tax by January 15, 2026' or 'File your 2025 Form 740 or Form 740-NP by March 1, 2026, and pay the total tax due'). file_by stored as stated (March 1, 2026 is a Sunday).",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf 'Penalty for untimely estimated payment' ('calculated using the rate provided by KRS 131.183'); Kentucky 2025 Form 740-NP packet instructions, revenue.ky.gov/Forms/740-NP%20Packet%20Instructions%20(2025).pdf Form 2210-K instructions line 21 ('The annual percentage rate is established by the Department of Revenue for each calendar year')",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'penalty.rate',
    value: 0.1,
    citation: "Kentucky 2025 Form 740-NP packet instructions, revenue.ky.gov/Forms/740-NP%20Packet%20Instructions%20(2025).pdf Form 2210-K instructions line 21 ('The percentage rate for calendar years 2025 is 10 percent'); Kentucky DOR 'Tax Interest Rate Update for 01-01-25' (base 8%, unpaid-tax rate 10% under KRS 131.183(2)(a)2), revenue.ky.gov/News/Pages/Tax-Interest-Rate-Update-for-01-01-25.aspx. CAUTION: single-rate key; the part of a TY2025 underpayment running into calendar 2026 accrues at the 2026 rate (9%, Kentucky DOR 'Tax Interest Rate Update for 01-01-26' (base 7%, unpaid-tax rate 9%), revenue.ky.gov/News/Pages/Tax-Interest-Rate-Update-for-01-01-26.aspx).",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "Kentucky 2025 Form 740 packet instructions, revenue.ky.gov/Forms/740%20Packet%20Instructions.pdf Form 740 instructions Line 6, Credit for Tax Paid to Another State (credit limited to the lesser of Kentucky tax savings or tax paid to the other state); KRS 141.070",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "Kentucky 2025 Form 740-NP packet instructions, revenue.ky.gov/Forms/740-NP%20Packet%20Instructions%20(2025).pdf Form 740-NP lines 7-14: Kentucky AGI (Column B), standard deduction or itemized deductions x Kentucky percentage (line 7/12), 'Line 14 - Multiply line 13 by four percent (.04)'. Tax is the flat rate on Kentucky-source taxable income, not a ratio of full-return tax.",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'holidays',
    value: ["2025-01-20", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2025-12-26", "2026-01-01", "2026-01-02", "2026-01-19", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2026-12-31"],
    citation: "Kentucky Personnel Cabinet holiday lists: Personnel Memo 24-20 '2025 Holidays for State Personnel' (extranet.personnel.ky.gov/Personnel%20Memos/2024-20.pdf; cites KRS 18A.190, KRS 2.110, KRS 2.190, EO 2024-155) and the 2026 State Holidays list at extranet.personnel.ky.gov/Pages/Leave.aspx. Used as the proxy for 'holiday' (the 740-ES instructions state no weekend/holiday rule). Good Friday is a half day and is listed. Calendar years 2025-2026.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'KY', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Kentucky 2026 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-25)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2025).pdf worksheet (estimated net income x 3.5%); KRS 141.020",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'required_threshold',
    value: 500,
    citation: "Kentucky 2026 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-25)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2025).pdf 'General Rule' ('You expect to owe at least $500 in tax for 2026, after subtracting your withholding and refundable credits'; 'If the amount of estimated tax for the year is $500 or less, no payment is required')",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Kentucky 2026 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-25)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2025).pdf General Rule 2(a) ('90% of the tax to be shown on your 2026 tax return')",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Kentucky 2026 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-25)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2025).pdf General Rule 2(b) ('100% of the tax shown on your 2025 tax return ... must cover all 12 months')",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: {"threshold": 150000, "pct": 1.1},
    citation: "Kentucky 2026 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-25)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2025).pdf Special Rules ('Kentucky adjusted gross income for 2025 was more than $150,000 ($75,000 if your filing status for 2026 is married filing separately), substitute 110% for 100% ... This rule does not apply to farmers')",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Kentucky 2026 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-25)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2025).pdf 'When to pay' and due-date table (April 15, 2026; June 15, 2026; September 15, 2026; January 15, 2027). None falls on a weekend (Wed/Mon/Tue/Fri) or a listed state holiday.",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Kentucky 2026 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-25)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2025).pdf due-date table ('Number of Equal Installments' 4/3/2/1)",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Kentucky 2026 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-25)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2025).pdf Special Rules ('substitute 66 2/3% for 90%'; 'Pay all of your estimated tax by January 15, 2027' or 'File your 2026 Form 740 or Form 740-NP by March 1, 2027, and pay the total tax due')",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "Kentucky 2026 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-25)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2025).pdf 'Penalty for untimely estimated payment' ('calculated using the rate provided by KRS 131.183')",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'penalty.rate',
    value: 0.09,
    citation: "Kentucky DOR 'Tax Interest Rate Update for 01-01-26' (base 7%, unpaid-tax rate 9%), revenue.ky.gov/News/Pages/Tax-Interest-Rate-Update-for-01-01-26.aspx gives 9% for calendar 2026. The rate for calendar 2027 (days of a TY2026 underpayment after Dec. 31, 2026) is set by the Commissioner under KRS 131.183 and not yet published; the 2026 Form 2210-K is not yet published.",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "Verified for 2025 on the Kentucky 2025 Form 740 packet instructions, revenue.ky.gov/Forms/740%20Packet%20Instructions.pdf (Line 6; KRS 141.070); 2026 packet not yet published, carried forward",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2026, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "Verified for 2025 on Form 740-NP line 14 (four percent x Kentucky taxable income); 2026 Form 740-NP not yet published (2026 rate 3.5% per the 2026 estimated-tax worksheet), carried forward",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-02", "2026-01-19", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01"],
    citation: "Kentucky Personnel Cabinet holiday lists: Personnel Memo 24-20 '2025 Holidays for State Personnel' (extranet.personnel.ky.gov/Personnel%20Memos/2024-20.pdf; cites KRS 18A.190, KRS 2.110, KRS 2.190, EO 2024-155) and the 2026 State Holidays list at extranet.personnel.ky.gov/Pages/Leave.aspx. Used as the proxy for 'holiday' (the 740-ES instructions state no weekend/holiday rule). Good Friday is a half day and is listed. Calendar year 2026 plus Jan. 1, 2027 (listed in the 2026 schedule). The Personnel Cabinet had not published the 2027 holiday list; the TY2026 installment (Jan. 15, 2027, Friday) and farmer (Mar. 1, 2027, Monday) dates are not affected.",
    status: 'verified',
  },
];
