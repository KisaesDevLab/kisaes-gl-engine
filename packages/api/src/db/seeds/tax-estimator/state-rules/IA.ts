// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// IA state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 3 research, 2026-10-11).
// Iowa's installments are due Apr 30 / Jun 30 / Sep 30 / Jan 31 (not the federal dates); see
// features/tax-estimator/docs/reviews/phase2-batch3-sources.md.
export const IA_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'IA', year: 2025, key: 'has_income_tax',
    value: true,
    citation: "Iowa Code ch. 422 individual income tax; 2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download line 1 (2025 tax from IA 1040 line 18); 2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download (rate 3.8% on worksheet line 4 for 2026)",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'required_threshold',
    value: 200,
    citation: "2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download lines 3 and 6 ('If less than $200, stop. You do not owe a penalty'); Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments ('estimate they will owe $200 ($1,000 for tax years beginning on or after January 1, 2026)'). Measured on tax after listed credits (line 3) and again after Iowa withholding (line 6).",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download line 4 ('Multiply line 3 by 90% (.90)') and line 8 (smaller of line 4 or line 7); Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments 'Avoiding Penalty'",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download line 7 (2024 tax less credits) and line 8; Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments ('payments equal or exceed the prior year's tax liability')",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: {"threshold": 150000, "pct": 1.1},
    citation: "2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download line 7 ('If 2024 federal AGI plus Iowa net modifications reported on IA 1040, line 3 exceeds $150,000 ($75,000 if married filing separate), enter 110% (1.10) of your 2024 Iowa tax'); Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments 'High income taxpayers'. The MFS $75,000 threshold and the Iowa-modification add-on cannot be expressed in the key.",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-30", "2025-06-30", "2025-09-30", "2026-02-02"],
    citation: "2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download page 2 'Due Dates of Installments' (April 30, 2025; June 30, 2025; Sept. 30, 2025; Jan. 31, 2026); Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments ('If a due date ends on a weekend or holiday as defined in Iowa Code section 421.9A, substitute the next regular business day'); Iowa Code 421.9A (due dates and holidays) subsection 2. Jan. 31, 2026 is a Saturday -> Monday Feb. 2, 2026.",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download line 17 ('Divide the amount on line 8 by the number of installments required'); schedule has four installments",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.667, "due_date": "2026-01-15", "file_by": "2026-03-01"},
    citation: "2025 IA 2210F (45-008a), revenue.iowa.gov/media/4398/download (line 4 'Multiply line 3 by 66.7% (.667)'; exceptions: pay the installment by January 15, 2026, or file the return and pay in full by March 1, 2026, check box on IA 1040 line 35); Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments 'Farmers and Fishers' (two-thirds of annual income; pay by January 15 and file by April 30, or file and pay by March 1). file_by stored as stated (March 1, 2026 is a Sunday; Iowa Code 421.9A (due dates and holidays) would move it to Monday March 2).",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download lines 24a/24b ('0.027397% (.00027397) per day'): Iowa sets its own penalty rate",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'penalty.rate',
    value: 0.1,
    citation: "2025 IA 2210F (45-008a), revenue.iowa.gov/media/4398/download instructions ('10% per annum = 0.027397% per day (01/01/26 - 12/31/26)'); 2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download lines 24a/24b (same daily factor applied to days in 2025 and to days in 2026 through April 30, 2026). Simple daily rate.",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "Iowa Code 422.8(1)(a) (credit against Iowa tax for income tax paid to another state or foreign country on income derived outside Iowa, limited by a ratio formula), legis.iowa.gov/docs/code/422.8.pdf; 2025 IA 1040 expanded instructions 'Out-of-State Tax Credit' / IA 130 (revenue.iowa.gov/media/4435/download)",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'nonresident_method',
    value: "ratio",
    citation: "Verified for 2026 on the 2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download traditional worksheet lines 9-11 ('Percentage of Iowa income vs. total income ... Estimated Iowa tax. Multiply line 8 by line 10'). Iowa Code 422.8(2)(a) allocates nonresident net income to Iowa. The 2025 IA 1040ES instructions were not located (only the 2024 version was indexed), so the 2025 application is carried back from 2026.",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-20", "2025-02-12", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25"],
    citation: "Iowa Code 421.9A(1) defines 'holiday' as a legal public holiday (Iowa Code 1C.1: Jan 1, MLK, Feb 12, Washington's Birthday, Memorial Day, Jul 4, Labor Day, Nov 11, Thanksgiving, Dec 25), a state paid holiday (1C.2: adds Friday after Thanksgiving; Saturday holidays taken the preceding Friday, Sunday the following Monday), a federal holiday observed by USPS, or a Federal Reserve banking holiday (adds Juneteenth, Columbus Day). Statute text read at legis.iowa.gov/docs/code/1C.1.pdf, 1C.2.pdf, 421.9A.pdf. UNVERIFIED because the federal-observance dates were computed from federal rules, not read from a USPS/Federal Reserve list in this task. Calendar years 2025-2026.",
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'IA', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download traditional worksheet line 4 ('Multiply line 3 by 3.8% (.038)')",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'required_threshold',
    value: 1000,
    citation: "2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download 'Who needs to file and pay estimates' ('tax liability of $1,000 or more from income not subject to withholding') and worksheet line 15; Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments; Iowa Tax Year 2025 form changes page (threshold raised from $200 to $1,000 starting tax year 2026)",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "2026 IA 2210 not yet published; 90% of current-year tax per 2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download line 4 and Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments 'Avoiding Penalty' (current-year payments at least 90% of tax on annualized income). The 2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download itself lists only the prior-year methods and the traditional worksheet.",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download 'How to compute estimated taxes' ('Pay 100% of the prior year's Iowa tax liability from IA 1040, line 18, less applicable credits')",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: {"threshold": 150000, "pct": 1.1},
    citation: "2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download ('Pay 110% of the prior year's Iowa tax liability ... if prior year's federal adjusted gross income (AGI) plus any bonus depreciation adjustment/section 179 ... exceeded $150,000 ($75,000 if married filing separately)'); worksheet line 16 ('100% (110% if high income taxpayer)')",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-30", "2026-06-30", "2026-09-30", "2027-02-01"],
    citation: "2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download Estimated Tax Payment Schedule (04/30/2026, 06/30/2026, 09/30/2026, 01/31/2027) and 'Due dates' ('If a due date ends on a weekend or holiday as defined in Iowa Code section 421.9A, substitute the next regular business day'); Iowa Code 421.9A (due dates and holidays). Jan. 31, 2027 is a Sunday -> Monday Feb. 1, 2027.",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download worksheet line 17 ('Multiply line 16 by 25% (.25)')",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download 'Farmers and Fishers' (two-thirds or more of estimated gross income from farming or commercial fishing: pay in one payment by January 15, 2027 and file by April 30, 2027, or file and pay in full by March 1, 2027) verified; current_pct 0.667 is carried from 2025 IA 2210F (45-008a), revenue.iowa.gov/media/4398/download line 4 because the 2026 IA 2210F is not yet published.",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "2025 IA 2210 (45-007a/b), revenue.iowa.gov/media/4399/download and 2025 IA 2210F (45-008a), revenue.iowa.gov/media/4398/download: Iowa computes its own daily penalty; 2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download ('See IA 2210 ... for penalty exceptions')",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'penalty.rate',
    value: 0.1,
    citation: "2025 IA 2210F (45-008a), revenue.iowa.gov/media/4398/download ('10% per annum = 0.027397% per day (01/01/26 - 12/31/26)') covers calendar 2026 days only; the rate for 2027 days (TY2026 underpayments run to April 30, 2027) is not yet published, and the 2026 IA 2210 is not out.",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "Iowa Code 422.8(1)(a); 2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download traditional worksheet line 12 ('Out-of-state tax credit and any other nonrefundable Iowa credits')",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'nonresident_method',
    value: "ratio",
    citation: "2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download traditional worksheet lines 9-11 (Iowa-source net income / line 1 total = percentage; estimated Iowa tax = line 8 x line 10)",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-12", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24"],
    citation: "Iowa Code 421.9A(1) defines 'holiday' as a legal public holiday (Iowa Code 1C.1: Jan 1, MLK, Feb 12, Washington's Birthday, Memorial Day, Jul 4, Labor Day, Nov 11, Thanksgiving, Dec 25), a state paid holiday (1C.2: adds Friday after Thanksgiving; Saturday holidays taken the preceding Friday, Sunday the following Monday), a federal holiday observed by USPS, or a Federal Reserve banking holiday (adds Juneteenth, Columbus Day). Statute text read at legis.iowa.gov/docs/code/1C.1.pdf, 1C.2.pdf, 421.9A.pdf. UNVERIFIED because the federal-observance dates were computed from federal rules, not read from a USPS/Federal Reserve list in this task. Calendar years 2026-2027.",
    status: 'unverified',
  },
];
