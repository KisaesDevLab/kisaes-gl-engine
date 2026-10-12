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
    value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf Special Rules ('If at least two-thirds of your gross income for 2024 or 2025 is from farming, substitute 66 2/3% for 90%'; 'Pay all of your estimated tax by January 15, 2026' or 'File your 2025 Form 740 or Form 740-NP by March 1, 2026, and pay the total tax due'). file_by ROLLED: March 1, 2026 is a Sunday and the 2025 Form 2210-K instructions (in Kentucky 2025 Form 740 packet instructions, revenue.ky.gov/Forms/740%20Packet%20Instructions.pdf, Instructions for Form 2210-K, Part I Exceptions) state the farmer exception as 'paid the entire tax due by March 2, 2026'. Farmers are also exempt from the 110% high-AGI rule (not expressible).",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Kentucky 2025 Instructions for Filing Estimated Tax Vouchers (42A740-S4 (9-24)), revenue.ky.gov/Forms/740-ES%20Instructions%20(2024).pdf 'Penalty for untimely estimated payment' ('calculated using the rate provided by KRS 131.183'); Kentucky 2025 Form 740 packet instructions, revenue.ky.gov/Forms/740%20Packet%20Instructions.pdf Instructions for Form 2210-K: penalty is figured like interest on each underpayment for the number of days unpaid (Figuring the Penalty; Lines 19-21), at the annual rate established by the Department of Revenue for each calendar year. It is NOT a flat 10% addition.",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'penalty.rate',
    value: 0.1,
    citation: "Kentucky 2025 Form 740 packet instructions, revenue.ky.gov/Forms/740%20Packet%20Instructions.pdf Instructions for Form 2210-K, Line 21 ('The annual percentage rate is established by the Department of Revenue for each calendar year. The percentage rate for calendar year 2025 is 10 percent and 2026 is 9 percent. The penalty calculation for the required third installment payment may be calculated using two different rates'); same text in revenue.ky.gov/Forms/740-NP%20Packet%20Instructions%20(2025).pdf (which prints '2026 is ? percent'); Kentucky DOR 'Tax Interest Rate Update for 01-01-25' (KRS 131.183 tax interest rate 10%). CAUTION: single-rate key; days of a TY2025 underpayment falling in calendar 2026 (the Sept. 15 and Jan. 15 installments) accrue at 9%.",
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
    value: ["2025-01-01", "2025-01-20", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2025-12-26", "2026-01-01", "2026-01-02", "2026-01-19", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2026-12-31"],
    citation: "Kentucky Personnel Cabinet holiday lists (state office closures): Personnel Memo 24-20 '2025 Holidays for State Personnel' (extranet.personnel.ky.gov/Personnel%20Memos/2024-20.pdf; cites KRS 18A.190, KRS 2.110, KRS 2.190, EO 2024-155; Jan 20, 2025 through Jan 2, 2026) and the '2026 State Holidays' list at extranet.personnel.ky.gov/Pages/Leave.aspx. Jan 1, 2025 (New Year's Day) added from KRS 2.110(1) (apps.legislature.ky.gov/law/statutes/statute.aspx?id=46); it falls before the 2025 memo's range. Used as the proxy for 'holiday' (the 740-ES instructions state no weekend/holiday rule; the 2025 instructions themselves print the rolled June 16 date). KRS 2.110(1) also lists days on which offices 'may' close but do not (Jan 19 Robert E. Lee Day, Jan 30, Feb 12, 3rd Mon Feb, June 3, 2nd Mon Oct); these are not included. Good Friday is a half day and is listed. Calendar years 2025-2026.",
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
    value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
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
    citation: "Kentucky 2025 Form 740 packet instructions, revenue.ky.gov/Forms/740%20Packet%20Instructions.pdf Instructions for Form 2210-K, Line 21 ('The percentage rate for calendar year 2025 is 10 percent and 2026 is 9 percent'); Kentucky DOR 'Tax Interest Rate Update for 01-01-26' (tax interest rate 9% under KRS 131.183), revenue.ky.gov/News/Pages/Tax-Interest-Rate-Update-for-01-01-26.aspx; 2026 740-ES instructions 'Penalty for untimely estimated payment' (rate provided by KRS 131.183). CAUTION: single-rate key; days of a TY2026 underpayment falling in calendar 2027 (Jan. 15, 2027 installment onward) accrue at the 2027 rate, which the Department has not yet published.",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "KRS 141.070(1) (apps.legislature.ky.gov/law/statutes/statute.aspx?id=53502; effective March 31, 2023, no later amendment): a Kentucky resident liable for income tax to another state on income from sources outside Kentucky gets a credit for the tax paid, limited so Kentucky tax is not reduced below the tax computed with the other-state income ignored. Same rule on the Kentucky 2025 Form 740 packet instructions Line 6 (revenue.ky.gov/Forms/740%20Packet%20Instructions.pdf); 2026 packet not yet published. Note KRS 141.070(2): residents of reciprocal states are exempt from Kentucky tax on wages (not expressible).",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "KRS 141.020 (apps.legislature.ky.gov/law/statutes/statute.aspx?id=56339; effective June 27, 2025): subsection (4) a nonresident 'shall be taxable only upon the amount of income received ... from labor performed, business done, or from other activities in this state' (remainder nontaxable); subsection (2)(f) flat 3.5% of net income for taxable years beginning on or after January 1, 2026; subsection (3)(b) credits prorated by Kentucky AGI / federal AGI. Same mechanics on the 2025 Form 740-NP (lines 7-14: Kentucky AGI less ratio-prorated deductions x 4%); 2026 Form 740-NP not yet published.",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-02", "2026-01-19", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2026-12-31", "2027-01-01"],
    citation: "Kentucky Personnel Cabinet holiday lists: Personnel Memo 24-20 '2025 Holidays for State Personnel' (extranet.personnel.ky.gov/Personnel%20Memos/2024-20.pdf; cites KRS 18A.190, KRS 2.110, KRS 2.190, EO 2024-155) and the 2026 State Holidays list at extranet.personnel.ky.gov/Pages/Leave.aspx. Used as the proxy for 'holiday' (the 740-ES instructions state no weekend/holiday rule). Good Friday is a half day and is listed. Calendar year 2026 plus Jan. 1, 2027 (listed in the 2026 schedule). The Personnel Cabinet had not published the 2027 holiday list; the TY2026 installment (Jan. 15, 2027, Friday) and farmer (Mar. 1, 2027, Monday) dates are not affected.",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'KY', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'KY', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KY', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
