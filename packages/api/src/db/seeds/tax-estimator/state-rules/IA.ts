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
    citation: "2025 IA 2210 (45-007a/b/c/d), revenue.iowa.gov/media/4399/download lines 3 and 6 ('If less than $200, stop. You do not owe a penalty'), measured on tax after refundable credits (line 3) and again after Iowa withholding (line 6); Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments ('estimate they will owe $200 ($1,000 for tax years beginning on or after January 1, 2026) or more'); Iowa Code 422.16(12)(a)(1) editor's note (2025 Acts ch 148 amendment to $1,000 applies to tax years beginning on or after January 1, 2026), legis.iowa.gov/docs/code/422.16.pdf.",
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
    citation: "2025 IA 2210 (45-007a/b/c/d), revenue.iowa.gov/media/4399/download page 2 'Due Dates of Installments' (April 30, 2025; June 30, 2025; Sept. 30, 2025; Jan. 31, 2026) and instructions note ('If a due date ends on a weekend or holiday as defined in Iowa Code section 421.9A, substitute the next regular business day'); Iowa Code 422.16(12)(b)(1) (last day of 4th, 6th, 9th month and of the first month after the tax year); Iowa Code 421.9A(2). Jan. 31, 2026 is a Saturday -> Monday Feb. 2, 2026.",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "2025 IA 2210 (45-007a/b/c/d), revenue.iowa.gov/media/4399/download line 17 ('Divide the amount on line 8 by the number of installments required') with four installments for requirements first met by April 1 (instructions table); Iowa Code 422.16(12)(b)(1) ('quarterly installments').",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666666, "current_pct": 0.667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "2025 IA 2210F (45-008a/b), revenue.iowa.gov/media/4398/download (line 4 'Multiply line 3 by 66.7% (.667)'; instructions: gross income from farming or fishing at least two-thirds of gross annual income per Treas. Reg. 1.6073-1(b); avoid the penalty by paying in full by January 15, 2026 or by filing and paying in full by March 1, 2026; 'Note: If a due date ends on a weekend or holiday as defined in Iowa Code section 421.9A, substitute the next regular business day for the due date'); 2025 IA 2210 (45-007a/b/c/d), revenue.iowa.gov/media/4399/download instructions 'Farmers and Fishers' (same two exceptions) and the same roll note; Iowa Code 422.16(12)(a)(2) (IRC farmer/fisher exceptions apply). March 1, 2026 is a Sunday -> stored rolled to Monday March 2, 2026 (Iowa Code 421.9A(2)); Jan. 15, 2026 is a Thursday. Ratio stored just under 2/3 (federal/MO seed convention, 'at least two-thirds'). Iowa's form uses 66.7%, not 66 2/3%.",
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
    citation: "2025 IA 2210 (45-007a/b/c/d), revenue.iowa.gov/media/4399/download instructions line 24 ('Line 24a: 10% per annum = 0.027397% per day (01/01/25 - 12/31/25); Line 24b: 10% per annum = 0.027397% per day (01/01/26 - 12/31/26)'), days counted through the payment date or April 30, 2026; Iowa Code 422.16(12)(d)(3) (IRC 6654 method at the rate in effect under 421.7); Iowa Code 421.7. Simple daily rate; same 10% for all days of a TY2025 underpayment.",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "Iowa Code 422.8(1)(a) (credit against Iowa tax for income tax paid to another state or foreign country by a resident on income derived outside Iowa, limited by the ratio formula), legis.iowa.gov/docs/code/422.8.pdf; 2025 IA 2210 (45-007a/b/c/d), revenue.iowa.gov/media/4399/download (IA 2210 line 3 tax after credits).",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'nonresident_method',
    value: "ratio",
    citation: "2025 IA 126 Iowa Nonresident and Part-Year Resident Credit Schedule, revenue.iowa.gov/media/4385/download lines 29-34 (Iowa income percentage = Iowa-source income / all-source income; credit = tax after credits x (100% - Iowa percentage)), i.e. resident-basis tax times the Iowa-source ratio; Iowa Code 422.8(2)(a) (nonresident net income allocated to Iowa); 2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download traditional worksheet lines 9-11 (same ratio for estimates).",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-20", "2025-02-12", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25"],
    citation: "Iowa Code 421.9A(1) (Iowa Code 2026, read at legis.iowa.gov/docs/code/421.9A.pdf): 'holiday' = (a) legal public holiday under 1C.1 (Jan 1; 3rd Mon Jan; Feb 12; 3rd Mon Feb; last Mon May; Jul 4; 1st Mon Sep; Nov 11; 4th Thu Nov; Dec 25 - legis.iowa.gov/docs/code/1C.1.pdf, no weekend shift), (b) paid holiday under 1C.2(1) (adds Friday after Thanksgiving - legis.iowa.gov/docs/code/1C.2.pdf) and executive-council days under 1C.2(2)(b), (c) a federal holiday observed by USPS, (d) a Federal Reserve banking holiday, (e) department closure days under 4.1(34). Federal observed dates read from the OPM federal holiday schedules (opm.gov/policy-data-oversight/pay-leave/federal-holidays, 5 U.S.C. 6103: Juneteenth, Columbus Day, Saturday holidays observed the preceding Friday, Sunday holidays the following Monday) and the Federal Reserve Board holiday schedule (federalreserve.gov/aboutthefed/k8.htm). The USPS holiday page (about.usps.com/newsroom/events/holidays.htm) returned 404; USPS observance of the 5 U.S.C. 6103 days is assumed from the OPM schedule. Weekend-falling statutory dates (e.g. Jul 4 on a Saturday) are omitted because weekends roll anyway. Ad hoc executive-council (1C.2(2)(b)) or 4.1(34) closure days are not predictable and are not listed. None of the TY installment or farmer dates is affected by a holiday (only by weekends). Calendar years 2025-2026.",
    status: 'verified',
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
    citation: "Iowa Code 422.16(12)(a)(1) (Iowa Code 2026, legis.iowa.gov/docs/code/422.16.pdf: estimates required if Iowa income tax liability 'can reasonably be expected to amount to one thousand dollars or more'; 2025 Acts ch 148 amendment applies to tax years beginning on or after January 1, 2026); 2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download 'Who needs to file and pay estimates' ($1,000 or more from income not subject to withholding) and worksheet line 15 (estimated tax after all credits and withholding; 'not required if line 15 is less than $1,000'); Iowa DOR 'Estimated Income Tax Payments' page.",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Iowa Code 422.16(12)(d)(3) (Iowa Code 2026, legis.iowa.gov/docs/code/422.16.pdf: the IRC 6654 method applies and 'the exceptions in the Internal Revenue Code also apply', i.e. 90% of current-year tax under IRC 6654(d)(1)(B)(i)); Iowa DOR 'Estimated Income Tax Payments' page, revenue.iowa.gov/taxes/tax-guidance/individual-income-tax/estimated-income-tax-payments 'Avoiding Penalty' (at least 90% of the tax on the current year's annualized taxable income). The 2026 IA 2210 is not yet published.",
    status: 'verified',
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
    value: {"ratio": 0.6666666666, "current_pct": 0.667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "2026 IA 1040ES instructions (45-009a/b, 08/29/2025), revenue.iowa.gov/media/2725/download 'Farmers and Fishers' (two-thirds or more of estimated gross income from farming or commercial fishing: pay in one payment on or before January 15, 2027 and file by April 30, 2027, or file and pay in full on or before March 1, 2027); Iowa Code 422.16(12)(a)(2) (IRC farmer/fisher exceptions apply, IRC 6654(i) = 66 2/3%). current_pct 0.667 follows Iowa's own form convention (2025 IA 2210F line 4 'Multiply line 3 by 66.7% (.667)', revenue.iowa.gov/media/4398/download); the 2026 IA 2210F is not yet published. Jan. 15, 2027 (Fri) and Mar. 1, 2027 (Mon) need no roll. Ratio stored just under 2/3 (seed convention).",
    status: 'verified',
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
    citation: "Calendar-2026 days: 10% per annum (Iowa DOR press release 2025-10-21 'IDR announces 2026 individual income tax and interest rates', revenue.iowa.gov/press-release/2025-10-21/idr-announces-2026-individual-income-tax-and-interest-rates: 10.0% annually, 0.027397% daily; 2025 IA 2210F, revenue.iowa.gov/media/4398/download '10% per annum ... (01/01/26 - 12/31/26)'). UNVERIFIED for the Jan 1 - Apr 30, 2027 days of a TY2026 underpayment: the 2027 rate is not yet announced (Iowa Code 421.7(6) advisory notice due November). PROJECTION: under Iowa Code 421.7(2)-(3) (legis.iowa.gov/docs/code/421.7.pdf) the 2027 rate = average monthly prime Oct 2025-Sep 2026 rounded to the nearest 1% plus 2 points, kept at 10% unless it moves by at least 1 point; monthly prime (FRED MPRIME, secondary) averages about 6.83% -> 7% + 2 = 9%, a full point lower, so 2027 days would likely accrue at 9%, not 10%. Single-rate key cannot express the split.",
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
    value: ["2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-12", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24", "2027-12-31"],
    citation: "Iowa Code 421.9A(1) (Iowa Code 2026, read at legis.iowa.gov/docs/code/421.9A.pdf): 'holiday' = (a) legal public holiday under 1C.1 (Jan 1; 3rd Mon Jan; Feb 12; 3rd Mon Feb; last Mon May; Jul 4; 1st Mon Sep; Nov 11; 4th Thu Nov; Dec 25 - legis.iowa.gov/docs/code/1C.1.pdf, no weekend shift), (b) paid holiday under 1C.2(1) (adds Friday after Thanksgiving - legis.iowa.gov/docs/code/1C.2.pdf) and executive-council days under 1C.2(2)(b), (c) a federal holiday observed by USPS, (d) a Federal Reserve banking holiday, (e) department closure days under 4.1(34). Federal observed dates read from the OPM federal holiday schedules (opm.gov/policy-data-oversight/pay-leave/federal-holidays, 5 U.S.C. 6103: Juneteenth, Columbus Day, Saturday holidays observed the preceding Friday, Sunday holidays the following Monday) and the Federal Reserve Board holiday schedule (federalreserve.gov/aboutthefed/k8.htm). The USPS holiday page (about.usps.com/newsroom/events/holidays.htm) returned 404; USPS observance of the 5 U.S.C. 6103 days is assumed from the OPM schedule. Weekend-falling statutory dates (e.g. Jul 4 on a Saturday) are omitted because weekends roll anyway. Ad hoc executive-council (1C.2(2)(b)) or 4.1(34) closure days are not predictable and are not listed. None of the TY installment or farmer dates is affected by a holiday (only by weekends). Calendar years 2026-2027; 2027-12-31 is the OPM/Federal Reserve Board observed day for New Year's Day 2028 (a Saturday).",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'IA', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'IA', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IA', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
