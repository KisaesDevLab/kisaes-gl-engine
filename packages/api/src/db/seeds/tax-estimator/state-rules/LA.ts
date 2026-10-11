// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// LA state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 3 research, 2026-10-11).
// Every row cites the primary source it was read in; see features/tax-estimator/docs/reviews/phase2-batch3-sources.md.
export const LA_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'LA', year: 2025, key: 'has_income_tax',
    value: true,
    citation: "Louisiana IT-540ESi (2025), Declaration of Estimated Tax for Individuals instructions, dam.ldr.la.gov/taxforms/IT540ESi(2025) d5.pdf ('Beginning January 1, 2025, the individual income tax is computed at a tax rate of 3 percent'); Louisiana 2025 Form IT-540B (Nonresident and Part-Year Resident), dam.ldr.la.gov/taxforms/IT540B(2025)WEB-BC-F.pdf line 13 ('Multiply Line 12 by .03')",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'required_threshold',
    value: 1000,
    citation: "Expected Louisiana tax after credits and withholding must EXCEED $1,000 for a single filer or $2,000 for joint filers: Louisiana IT-540ESi (2025), Declaration of Estimated Tax for Individuals instructions, dam.ldr.la.gov/taxforms/IT540ESi(2025) d5.pdf 'Who Must Make Estimated Tax Payments'; Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf Exception 1 / Line 10 (Single, MFS, HOH, QSS <= $1,000; MFJ <= $2,000: no penalty). The statute, La. R.S. 47:116(A) (legis.la.gov/Legis/LawPrint.aspx?d=101106), states only $1,000; the $2,000 joint tier is the Department's published position. The key holds one number: 1000 (single) is stored; the joint $2,000 tier is not expressible.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf Section 1 ('The required annual payment is the lesser of: 90 percent of your 2025 Louisiana income tax liability OR 100 percent of your 2024 Louisiana income tax liability'; Line 1 'Ninety percent of current year's tax liability')",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf Section 1 / Line 2 ('One hundred percent of previous year's tax liability'), Exception 2",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule: La. R.S. 47:118 (legis.la.gov/Legis/LawPrint.aspx?d=101109; last amended Acts 2006, No. 33) (B)(2)(b) 'required annual payment' is the lesser of 90% of current-year tax or 100% of preceding-year tax, with no income-based increase; Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf Section 1 and Exceptions 2-5. Note: 47:118(D)(1)(b) / R-210R Exception 3 also excuses payments equal to the prior year's income taxed at CURRENT-year rates (relevant to the 2025 flat-rate reform) - not expressible.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Louisiana IT-540ESi (2025), Declaration of Estimated Tax for Individuals instructions, dam.ldr.la.gov/taxforms/IT540ESi(2025) d5.pdf 'Estimated Tax Payment Due Dates' (April 15, 2025; June 15, 2025; September 15, 2025; January 15, 2026; 'If a due date ... falls on a weekend or legal holiday, the payment is due on the next business day'); Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf table. June 15, 2025 was a Sunday -> Monday June 16, 2025.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Louisiana IT-540ESi (2025), Declaration of Estimated Tax for Individuals instructions, dam.ldr.la.gov/taxforms/IT540ESi(2025) d5.pdf ('equal installments'; worksheet line 11 '1/4 of Line 10 (Make 4 installments)')",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "La. R.S. 47:117(B) (legis.la.gov/Legis/LawPrint.aspx?d=101107: estimated gross income from farming at least two-thirds of total; declaration any time on or before January 15 of the succeeding year); La. R.S. 47:118 (legis.la.gov/Legis/LawPrint.aspx?d=101109; last amended Acts 2006, No. 33) (B)(1)(a) and (D)(1)(c) ('sixty-six and two-thirds percent' for R.S. 47:117(B) individuals; the R-210R-i rounds this to '66.66 percent'); La. R.S. 47:116(F) (legis.la.gov/Legis/LawPrint.aspx?d=101106: return filed and paid in full on or before March first treated as the declaration); La. R.S. 47:117.1(B); Louisiana IT-540ESi (2025) 'Special Rules for Farmers and Fishermen' (fishermen included administratively). March 1, 2026 is a Sunday -> March 2, 2026 under La. R.S. 47:103(A)(4) (legis.la.gov/legis/LawPrint.aspx?d=101072: return due on Saturday, Sunday or legal holiday is due the next business day).",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf General Information ('La. R.S. 47:118 provides for a 12 percent penalty for underpayment of individual income tax ... imposed on each underpayment for the number of days it was unpaid')",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'penalty.rate',
    value: 0.12,
    citation: "La. R.S. 47:118 (legis.la.gov/Legis/LawPrint.aspx?d=101109; last amended Acts 2006, No. 33)(A) ('a penalty of twelve percent per annum upon the amount of the underpayment ... for the period of the underpayment'); (C) the period runs from the installment due date to the earlier of payment or the 15th day of the fourth month after year end (April 15), not the May 15 return due date; Louisiana IT-540ESi (2025) 'When a Penalty is Applied'.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "Louisiana 2025 Individual Income Tax Instructions (IT-540i), dam.ldr.la.gov/taxforms/IT540i-WEB-2025.pdf (Nonrefundable Priority 1 Credits, Schedule C, Line 1 'Credit for taxes paid to another state'; Form R-10606 (1/26), dam.ldr.la.gov/taxforms/10606-1-26-F.pdf; La. R.S. 47:33)",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "Louisiana 2025 Form IT-540B (Nonresident and Part-Year Resident), dam.ldr.la.gov/taxforms/IT540B(2025)WEB-BC-F.pdf lines 7-13: Louisiana AGI (line 8) less the FULL Louisiana standard deduction (line 10, $12,500/$25,000 - not prorated) and excess federal itemized deductions prorated by the Louisiana/federal AGI ratio (lines 9, 11E), x .03 (line 13 'Multiply Line 12 by .03'). Tax is the flat rate on Louisiana-source taxable income.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-08", "2025-01-20", "2025-02-17", "2025-03-04", "2025-04-18", "2025-05-26", "2025-07-04", "2025-08-30", "2025-09-01", "2025-10-13", "2025-11-01", "2025-11-11", "2025-11-27", "2025-12-25", "2025-12-31", "2026-01-01", "2026-01-02", "2026-01-08", "2026-01-19", "2026-02-16", "2026-02-17", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-04", "2026-08-30", "2026-09-07", "2026-10-12", "2026-11-01", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25"],
    citation: "La. R.S. 1:55 (legis.la.gov/Legis/LawPrint.aspx?d=74097, current text incl. Acts 2026 Nos. 40 and 113). Union of: (A)(1) legal holidays - Jan 1; Jan 8 (Battle of New Orleans); 3rd Mon Jan (MLK); 3rd Mon Feb (Washington's Birthday); Mardi Gras; Good Friday; last Mon May; Jul 4; Aug 30 (Huey P. Long Day); 1st Mon Sep; 2nd Mon Oct (Columbus); Nov 1 (All Saints'); Nov 11; 4th Thu Nov; Dec 25; (A)(4) Jan 1/Jul 4/Dec 25 falling on a Sunday -> Monday holiday; (B)(1)(a) state-department holiday on the first Tuesday after the first Monday in November in even-numbered years (Election Day); plus Governor-proclaimed state holidays read in State Civil Service General Circulars: 2025-053 / Proclamation 74 JML 2025 (Dec 31, 2025; Jan 2, 2026), 2026-010 (Lundi Gras Feb 16, 2026), 2026-023 / Proclamations 06 and 07 JML 2026 (Memorial Day May 25, 2026; Juneteenth Jun 19, 2026) (civilservice.louisiana.gov/files/general_circulars/). Movable dates computed (Easter 2025 Apr 20, 2026 Apr 5, 2027 Mar 28). The IT-540ESi says only 'weekend or legal holiday'. UNVERIFIED because the Governor proclaims further holidays year by year (e.g. 2025 Lundi Gras/Juneteenth/Dec 26, and all 2027 proclamations) and no complete official dated calendar was found; some (A)(1) days (Jan 8, Aug 30, Columbus, Nov 1) are legal holidays but not observed by state departments under (B). No installment or farmer date falls on any of these. Calendar years 2025-2026.",
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'LA', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Louisiana IT-540ESi (2026), dam.ldr.la.gov/taxforms/IT540ESi-2026.pdf ('Beginning January 1, 2026, the individual income tax is computed at a tax rate of 3 percent'; worksheet line 5 'Multiply Line 4 by .03')",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'required_threshold',
    value: 1000,
    citation: "Expected Louisiana tax after credits and withholding must EXCEED $1,000 for a single filer or $2,000 for joint filers: Louisiana IT-540ESi (2026), dam.ldr.la.gov/taxforms/IT540ESi-2026.pdf 'Who Must Make Estimated Tax Payments'. The statute, La. R.S. 47:116(A) (legis.la.gov/Legis/LawPrint.aspx?d=101106), states only $1,000; the $2,000 joint tier is the Department's published position. The key holds one number: 1000 (single) is stored; the joint $2,000 tier is not expressible.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "La. R.S. 47:118 (legis.la.gov/Legis/LawPrint.aspx?d=101109; last amended Acts 2006, No. 33) (B)(1)(a) and (B)(2)(b)(i): ninety percent of the tax shown on the return for the taxable year. Statute is current law (unchanged since 2006) and governs TY2026; the 2026 Form R-210R-i is not yet published. Same rule on Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf Section 1.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "La. R.S. 47:118 (legis.la.gov/Legis/LawPrint.aspx?d=101109; last amended Acts 2006, No. 33) (B)(2)(b)(ii): one hundred percent of the tax shown on the return for the preceding taxable year; (D)(1)(a) requires the preceding year to be a 12-month year with a liability. Statute is current law (unchanged since 2006) and governs TY2026; the 2026 Form R-210R-i is not yet published. Same rule on Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf Section 1.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "La. R.S. 47:118 (legis.la.gov/Legis/LawPrint.aspx?d=101109; last amended Acts 2006, No. 33) (B)(2)(b): required annual payment is the lesser of 90% current / 100% prior with no income-based increase; no 110% rule. (D)(1)(b) also excuses the prior year's income taxed at current-year rates (not expressible). Statute is current law (unchanged since 2006) and governs TY2026; the 2026 Form R-210R-i is not yet published. Same rule on Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf Section 1.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Louisiana IT-540ESi (2026), dam.ldr.la.gov/taxforms/IT540ESi-2026.pdf 'Estimated Tax Payment Due Dates' (April 15, 2026; June 15, 2026; September 15, 2026; January 15, 2027; weekend/legal-holiday roll to next business day). None falls on a weekend (Wed/Mon/Tue/Fri).",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Louisiana IT-540ESi (2026), dam.ldr.la.gov/taxforms/IT540ESi-2026.pdf worksheet line 11 ('1/4 of Line 10 (Make 4 installments)')",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'farmer.rule',
    value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "La. R.S. 47:117(B) (legis.la.gov/Legis/LawPrint.aspx?d=101107: estimated gross income from farming at least two-thirds of total; declaration any time on or before January 15 of the succeeding year); La. R.S. 47:118 (legis.la.gov/Legis/LawPrint.aspx?d=101109; last amended Acts 2006, No. 33) (B)(1)(a) and (D)(1)(c) ('sixty-six and two-thirds percent' for R.S. 47:117(B) individuals; the R-210R-i rounds this to '66.66 percent'); La. R.S. 47:116(F) (legis.la.gov/Legis/LawPrint.aspx?d=101106: return filed and paid in full on or before March first treated as the declaration); La. R.S. 47:117.1(B); Louisiana IT-540ESi (2026) 'Special Rules for Farmers and Fishermen' (fishermen included administratively). March 1, 2027 is a Monday (no roll).",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "Louisiana IT-540ESi (2026), dam.ldr.la.gov/taxforms/IT540ESi-2026.pdf 'When a Penalty is Applied' (La. R.S. 47:118 provides for a 12 percent penalty for underpayment of estimated income tax)",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'penalty.rate',
    value: 0.12,
    citation: "La. R.S. 47:118 (legis.la.gov/Legis/LawPrint.aspx?d=101109; last amended Acts 2006, No. 33)(A) ('a penalty of twelve percent per annum upon the amount of the underpayment ... for the period of the underpayment'); (C) the period runs from the installment due date to the earlier of payment or the 15th day of the fourth month after year end (April 15), not the May 15 return due date; Louisiana IT-540ESi (2026) 'When a Penalty is Applied'.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "La. R.S. 47:33 (legis.la.gov/Legis/LawPrint.aspx?d=102000; current text, last amended Acts 2023, No. 413 - no 2025 or 2026 amendment): resident individuals allowed a credit for net income taxes imposed by and paid to another state, limited to the Louisiana tax on that income and not allowed for a state that grants nonresidents a credit for taxes paid to the state of residence. Same rule on the 2025 IT-540 Schedule C Line 1 and Form R-10606 (1/26); 2026 IT-540 instructions not yet published.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "Verified for 2025 on IT-540B line 13; 2026 IT-540B not yet published, carried forward",
    status: 'unverified',
  },
  {
    state: 'LA', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-02", "2026-01-08", "2026-01-19", "2026-02-16", "2026-02-17", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-04", "2026-08-30", "2026-09-07", "2026-10-12", "2026-11-01", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-08", "2027-01-18", "2027-02-09", "2027-02-15", "2027-03-26", "2027-05-31", "2027-07-04", "2027-07-05", "2027-08-30", "2027-09-06", "2027-10-11", "2027-11-01", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "La. R.S. 1:55 (legis.la.gov/Legis/LawPrint.aspx?d=74097, current text incl. Acts 2026 Nos. 40 and 113). Union of: (A)(1) legal holidays - Jan 1; Jan 8 (Battle of New Orleans); 3rd Mon Jan (MLK); 3rd Mon Feb (Washington's Birthday); Mardi Gras; Good Friday; last Mon May; Jul 4; Aug 30 (Huey P. Long Day); 1st Mon Sep; 2nd Mon Oct (Columbus); Nov 1 (All Saints'); Nov 11; 4th Thu Nov; Dec 25; (A)(4) Jan 1/Jul 4/Dec 25 falling on a Sunday -> Monday holiday; (B)(1)(a) state-department holiday on the first Tuesday after the first Monday in November in even-numbered years (Election Day); plus Governor-proclaimed state holidays read in State Civil Service General Circulars: 2025-053 / Proclamation 74 JML 2025 (Dec 31, 2025; Jan 2, 2026), 2026-010 (Lundi Gras Feb 16, 2026), 2026-023 / Proclamations 06 and 07 JML 2026 (Memorial Day May 25, 2026; Juneteenth Jun 19, 2026) (civilservice.louisiana.gov/files/general_circulars/). Movable dates computed (Easter 2025 Apr 20, 2026 Apr 5, 2027 Mar 28). The IT-540ESi says only 'weekend or legal holiday'. UNVERIFIED because the Governor proclaims further holidays year by year (e.g. 2025 Lundi Gras/Juneteenth/Dec 26, and all 2027 proclamations) and no complete official dated calendar was found; some (A)(1) days (Jan 8, Aug 30, Columbus, Nov 1) are legal holidays but not observed by state departments under (B). No installment or farmer date falls on any of these. Calendar years 2026-2027.",
    status: 'unverified',
  },
];
