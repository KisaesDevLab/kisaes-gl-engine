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
    citation: "Threshold is a two-tier statutory test (La. R.S. 47:116(A)): expected Louisiana tax after credits and withholding must EXCEED $1,000 for a single filer or $2,000 for joint filers. The key holds one number, so 1000 (single) is stored and the joint $2,000 tier is not expressible. Louisiana IT-540ESi (2025), Declaration of Estimated Tax for Individuals instructions, dam.ldr.la.gov/taxforms/IT540ESi(2025) d5.pdf 'Who Must Make Estimated Tax Payments'; Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf Exception 1",
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
    citation: "No high-AGI rule: Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf Section 1 and Exceptions 2-5 use only 100% of prior-year tax (or prior year at current-year rates), or 90% annualized",
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
    value: {"ratio": 0.6666666667, "current_pct": 0.6666, "due_date": "2026-01-15", "file_by": "2026-03-01"},
    citation: "Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf 'Special Rules for Farmers and Fishermen' (La. R.S. 47:117(B): at least two-thirds of estimated gross income from farming or fishing; declaration and payment by January 15 'must be at least 66.66 percent of the estimated tax'); Louisiana IT-540ESi (2025), Declaration of Estimated Tax for Individuals instructions, dam.ldr.la.gov/taxforms/IT540ESi(2025) d5.pdf (R.S. 47:116(B): one payment by January 15; no estimated payment required if the return is filed by March 1 and the total tax paid). file_by stored as stated (March 1, 2026 is a Sunday).",
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
    citation: "Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf General Information (12 percent, per day of underpayment, La. R.S. 47:118); Louisiana IT-540ESi (2025), Declaration of Estimated Tax for Individuals instructions, dam.ldr.la.gov/taxforms/IT540ESi(2025) d5.pdf",
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
    citation: "Louisiana 2025 Form IT-540B (Nonresident and Part-Year Resident), dam.ldr.la.gov/taxforms/IT540B(2025)WEB-BC-F.pdf lines 7-13: ratio of Louisiana AGI to federal AGI (line 9) prorates deductions, Louisiana taxable income x .03 (line 13 'Multiply Line 12 by .03'). Tax is the flat rate on Louisiana-source taxable income.",
    status: 'verified',
  },
  {
    state: 'LA', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-08", "2025-01-20", "2025-02-17", "2025-03-04", "2025-04-18", "2025-05-26", "2025-07-04", "2025-08-30", "2025-09-01", "2025-10-13", "2025-11-01", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-08", "2026-01-19", "2026-02-16", "2026-02-17", "2026-04-03", "2026-05-25", "2026-07-04", "2026-08-30", "2026-09-07", "2026-10-12", "2026-11-01", "2026-11-11", "2026-11-26", "2026-12-25"],
    citation: "La. R.S. 1:55(A)(1) legal holidays (legis.la.gov/Legis/LawPrint.aspx?d=74097): Jan 1; Jan 8 (Battle of New Orleans); 3rd Mon Jan (MLK); 3rd Mon Feb (Washington's Birthday); Mardi Gras; Good Friday; last Mon May; Jul 4; Aug 30 (Huey P. Long Day); 1st Mon Sep; 2nd Mon Oct (Columbus); Nov 1 (All Saints); Nov 11; 4th Thu Nov; Dec 25. Dates computed from the statute (Easter 2025 Apr 20, 2026 Apr 5, 2027 Mar 28). UNVERIFIED: the Louisiana IT-540ES instructions say only 'weekend or legal holiday' without naming the statute, Mardi Gras is a parish-option holiday in R.S. 1:55(A)(3), and a 2026 act (HB 61 / Act 113 of 2026) amends R.S. 1:55 in ways not reviewed. No installment date falls on any of these. Calendar years 2025-2026.",
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
    citation: "Threshold is a two-tier statutory test (La. R.S. 47:116(A)): expected Louisiana tax after credits and withholding must EXCEED $1,000 for a single filer or $2,000 for joint filers. The key holds one number, so 1000 (single) is stored and the joint $2,000 tier is not expressible. Louisiana IT-540ESi (2026), dam.ldr.la.gov/taxforms/IT540ESi-2026.pdf 'Who Must Make Estimated Tax Payments'",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "2026 Form R-210R-i is not yet published; the 2026 IT-540ESi does not restate this rule. Carried forward from Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf and La. R.S. 47:118 (statute text not read). 90% of current-year liability.",
    status: 'unverified',
  },
  {
    state: 'LA', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "2026 Form R-210R-i is not yet published; the 2026 IT-540ESi does not restate this rule. Carried forward from Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf and La. R.S. 47:118 (statute text not read). 100% of prior-year liability.",
    status: 'unverified',
  },
  {
    state: 'LA', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "2026 Form R-210R-i is not yet published; the 2026 IT-540ESi does not restate this rule. Carried forward from Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf and La. R.S. 47:118 (statute text not read). No 110% rule appears in the 2025 form.",
    status: 'unverified',
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
    value: {"ratio": 0.6666666667, "current_pct": 0.6666, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Louisiana IT-540ESi (2026), dam.ldr.la.gov/taxforms/IT540ESi-2026.pdf 'Special Rules for Farmers and Fishermen' (La. R.S. 47:116(B): one payment of the full amount by January 15 of the succeeding year; no estimated tax required if the return is filed by March 1 and total tax paid). current_pct 0.6666 from Louisiana R-210R-i (1/26), Underpayment of Individual Income Tax Penalty Computation, 2025 Taxable Year (Resident Filers), dam.ldr.la.gov/taxforms/210Ri(1_26).pdf (66.66 percent); the 2026 R-210R-i is not yet published.",
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
    citation: "Louisiana IT-540ESi (2026), dam.ldr.la.gov/taxforms/IT540ESi-2026.pdf 'When a Penalty is Applied' ('a 12 percent penalty ... imposed on each underpayment for the number of days it was unpaid')",
    status: 'verified',
  },
  {
    state: 'LA', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "Verified for 2025 (IT-540 Schedule C Line 1, R-10606 (1/26)); 2026 IT-540 instructions not yet published, carried forward",
    status: 'unverified',
  },
  {
    state: 'LA', year: 2026, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "Verified for 2025 on IT-540B line 13; 2026 IT-540B not yet published, carried forward",
    status: 'unverified',
  },
  {
    state: 'LA', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-08", "2026-01-19", "2026-02-16", "2026-02-17", "2026-04-03", "2026-05-25", "2026-07-04", "2026-08-30", "2026-09-07", "2026-10-12", "2026-11-01", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-08", "2027-01-18", "2027-02-09", "2027-02-15", "2027-03-26", "2027-05-31", "2027-07-04", "2027-08-30", "2027-09-06", "2027-10-11", "2027-11-01", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "La. R.S. 1:55(A)(1) legal holidays (legis.la.gov/Legis/LawPrint.aspx?d=74097): Jan 1; Jan 8 (Battle of New Orleans); 3rd Mon Jan (MLK); 3rd Mon Feb (Washington's Birthday); Mardi Gras; Good Friday; last Mon May; Jul 4; Aug 30 (Huey P. Long Day); 1st Mon Sep; 2nd Mon Oct (Columbus); Nov 1 (All Saints); Nov 11; 4th Thu Nov; Dec 25. Dates computed from the statute (Easter 2025 Apr 20, 2026 Apr 5, 2027 Mar 28). UNVERIFIED: the Louisiana IT-540ES instructions say only 'weekend or legal holiday' without naming the statute, Mardi Gras is a parish-option holiday in R.S. 1:55(A)(3), and a 2026 act (HB 61 / Act 113 of 2026) amends R.S. 1:55 in ways not reviewed. No installment date falls on any of these. Calendar years 2026-2027.",
    status: 'unverified',
  },
];
