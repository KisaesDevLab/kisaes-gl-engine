// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// IN state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 3 research, 2026-10-11).
// Every row cites the primary source it was read in; see features/tax-estimator/docs/reviews/phase2-batch3-sources.md.
export const IN_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'IN', year: 2025, key: 'has_income_tax',
    value: true,
    citation: "Form IT-40PNR 2025 line 8 ('State adjusted gross income tax: multiply line 7 by 3% (.03)'), forms.in.gov/Download.aspx?id=16919; Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section C line 1 (state AGI tax plus county tax)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'required_threshold',
    value: 1000,
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section C line 6 ('If less than $1,000, STOP HERE! You do not owe a penalty') and 'Who should use' ('after credits, is $1,000 or more'); IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf); 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (e)(1) (no addition if tax less withholding is less than $1,000); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf Introduction ($1,000 or more of unpaid state AND local tax). Measured on state plus county tax after credits and withholding (and PTET). Required at $1,000 or more (statute: not required if 'less than $1,000').",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) incorporating 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (d)(1)(B)(i) (90% of the tax shown on the current-year return); Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section C line 4 ('Multiply line 3 by 90%') and line 8; Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties'.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) incorporating 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (d)(1)(B)(ii) (100% of the prior-year tax; not available if the prior year was not 12 months or no prior return was filed - but under the 2026 version of IC 6-3-4-4.1(a)(3) an individual who filed no prior return and had no Indiana liability is treated as having $0 prior-year tax); Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section C line 7 (prior year's tax) and line 8; Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties'.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: {"threshold": 150000, "pct": 1.1},
    citation: "IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) incorporating 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (d)(1)(C) (prior-year FEDERAL AGI over $150,000 -> 110%; $75,000 for married filing separately; not applied to farmers/fishermen per (i)(1)(C)); Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 line 7 instructions and CAUTION box ('If your 2024 federal adjusted gross income is more than $150,000 ($75,000 if your 2024 filing status is married filing separately), and you are not subject to the special rules for farmers and fishermen, you must enter 110% of last year's tax'); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties'. Inexpressible in the key: the $75,000 MFS threshold, the farmer carve-out, and that the test is on PRIOR-year federal AGI.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section E column headings (April 15, 2025; June 16, 2025; September 15, 2025; January 15, 2026); IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) incorporating 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (c)(2) (April 15, June 15, September 15, January 15); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Methods for Payment' (due date on a national or state holiday, Saturday or Sunday -> next business day). June 15, 2025 was a Sunday -> June 16.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section E line 14 ('Divide amount on line 8 by 4'); 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (d)(1)(A) via IC 6-3-4-4.1(a).",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666666, "current_pct": 0.667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section A and instructions ('If at least two-thirds of your gross income for 2024 or 2025 was from farming or fishing, you have only one payment due date for 2025 estimated tax - Jan. 15, 2026'; Option 1 pay by Jan. 15, 2026; Option 2 'File your Form IT-40 by March 2, 2026, and pay all the tax due' - March 1, 2026 is a Sunday); line 4 note (66 2/3% (.667)); IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) incorporating 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (i) (one installment due January 15, 66 2/3% of current-year tax, March 1 file-and-pay; farmer = 2/3 of gross income from farming/fishing in the current OR preceding year; 110% high-AGI rule does not apply); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Farmers and Fishermen'. Ratio stored just under 2/3 per MO convention; current_pct .667 as printed on the form.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Indiana's own penalty: IC 6-3-4-4.1(b) (underpayment of estimated tax under IRC 6654 -> 'a penalty in an amount prescribed by IC 6-8.1-10-2.1(b)') and IC 6-8.1-10-2.1(b) ('ten percent (10%)' of the tax not paid), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties' ('the penalty will be 10 percent of the underpayment for that period ... computed on a quarter-by-quarter basis'); Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 lines 13 and 21 ('Multiply line 20 by 10%'). ENGINE NOTE: 0.10 is NOT an annual rate. Indiana's penalty is a flat 10% of each installment period's underpayment, not prorated by days late (IT-2210 lines 19-21; IB3 'Penalties'); a payment made after an installment due date counts toward the NEXT installment period (IT-2210 line 16 instructions; IB3 'Underpayment'), so any late payment leaves the earlier period fully underpaid; an overpayment carried back to an earlier period does not reduce that period's penalty (IB3). No 4th-installment penalty if the return is filed and all tax paid by January 31 (Feb. 2, 2026 for TY2025 after weekend roll; IT-2210 Section B; IRC 6654(h)). Do NOT apply 0.10 as an annualized interest rate. (Illinois' comparable flat penalty is seeded as rate null; the engine must special-case IN.)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'penalty.rate',
    value: 0.1,
    citation: "Indiana's own penalty: IC 6-3-4-4.1(b) (underpayment of estimated tax under IRC 6654 -> 'a penalty in an amount prescribed by IC 6-8.1-10-2.1(b)') and IC 6-8.1-10-2.1(b) ('ten percent (10%)' of the tax not paid), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties' ('the penalty will be 10 percent of the underpayment for that period ... computed on a quarter-by-quarter basis'); Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 lines 13 and 21 ('Multiply line 20 by 10%'). ENGINE NOTE: 0.10 is NOT an annual rate. Indiana's penalty is a flat 10% of each installment period's underpayment, not prorated by days late (IT-2210 lines 19-21; IB3 'Penalties'); a payment made after an installment due date counts toward the NEXT installment period (IT-2210 line 16 instructions; IB3 'Underpayment'), so any late payment leaves the earlier period fully underpaid; an overpayment carried back to an earlier period does not reduce that period's penalty (IB3). No 4th-installment penalty if the return is filed and all tax paid by January 31 (Feb. 2, 2026 for TY2025 after weekend roll; IT-2210 Section B; IRC 6654(h)). Do NOT apply 0.10 as an annualized interest rate. (Illinois' comparable flat penalty is seeded as rate null; the engine must special-case IN.)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "Indiana 2025 Schedule 6 (State Form 53999, R16/9-25) line 5 'Credit for taxes paid to other states: enclose other state's return', forms.in.gov/Download.aspx?id=16940; credit limited to state AGI tax on Form IT-40 line 8",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "Form IT-40PNR 2025 (State Form 472, R24/9-25), forms.in.gov/Download.aspx?id=16919 lines 1-8: Indiana-source income (Schedule A) less Indiana add-backs/deductions/exemptions = Indiana adjusted gross income (line 7), state tax = line 7 x 3% (line 8) plus county tax from Schedule CT-40PNR; IC 6-3-2-1(b)(6) (3% on a nonresident's Indiana-source AGI), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-20", "2025-02-12", "2025-02-17", "2025-04-18", "2025-05-26", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2025-12-26", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-04-03", "2026-05-05", "2026-05-25", "2026-07-03", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25"],
    citation: "Indiana legal holidays 'for all purposes', IC 1-1-9-1 (Indiana Code 2025 Title 1, iga.in.gov/ic/2025/Title_1.pdf): Jan 1; 3rd Mon Jan; Feb 12; 3rd Mon Feb; Good Friday; last Mon May; July 4; 1st Mon Sep; 2nd Mon Oct; Election Day (any general, municipal or primary election); Nov 11; 4th Thu Nov; Dec 25; a Sunday holiday -> following Monday, a Saturday holiday -> preceding Friday (IC 1-1-9-1(b)); UNION with the Governor's state-employee observance dates under IC 1-1-9-2 (which moves Lincoln's and Washington's Birthdays to the Friday after Thanksgiving and around Christmas): 2025 Holidays Memorandum, Office of the Governor (read from the Wayback Machine capture web.archive.org/web/20250830213230/https://www.in.gov/spd/benefits/files/2025-Holidays-Memorandum.pdf; the live in.gov URL now 404s) and 2026 Holidays Memorandum (secure.in.gov/spd/benefits/files/2026-Holidays-Memorandum.pdf). Due-date roll: Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf ('national or state holiday, Saturday, or Sunday' -> following business day; also IRS-recognized legal holidays for federal estimated tax). Federal-only holidays (e.g. Juneteenth) are not listed; none affects an installment date. Calendar years 2025-2026.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'IN', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Form ES-40 (State Form 46005, R26/9-25) for 2026, forms.in.gov/Download.aspx?id=16906 worksheet line D ('line C multiplied by .0295') plus county tax line E; IC 6-3-2-1(b)(7) (2.95% for taxable years beginning after December 31, 2025 and before January 1, 2027), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'required_threshold',
    value: 1000,
    citation: "IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) (version effective 1-1-2026); 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (e)(1); Form ES-40 (State Form 46005, R26/9-25) for 2026, forms.in.gov/Download.aspx?id=16906 instructions (says 'more than $1,000', slightly looser than the statute's 'less than $1,000' exemption, i.e. exactly $1,000 is required by statute); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf. Measured on state plus county tax after credits and withholding.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) incorporating 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (d)(1)(B)(i) (90% of the tax shown on the current-year return); the 2026 Schedule IT-2210 is not yet published, so the rule is taken from the statute; Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties'.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) incorporating 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (d)(1)(B)(ii) (100% of the prior-year tax; not available if the prior year was not 12 months or no prior return was filed - but under the 2026 version of IC 6-3-4-4.1(a)(3) an individual who filed no prior return and had no Indiana liability is treated as having $0 prior-year tax); 2026 Schedule IT-2210 not yet published; rule from the statute; Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties'.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: {"threshold": 150000, "pct": 1.1},
    citation: "IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) incorporating 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (d)(1)(C) (prior-year FEDERAL AGI over $150,000 -> 110%; $75,000 for married filing separately; not applied to farmers/fishermen per (i)(1)(C)); 2026 Schedule IT-2210 not yet published; rule from the statute (IC 6-3-4-4.1 incorporates IRC 6654 without modifying (d)(1)(C)); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties'. Inexpressible in the key: the $75,000 MFS threshold, the farmer carve-out, and that the test is on PRIOR-year federal AGI.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Form ES-40 (State Form 46005, R26/9-25) for 2026, forms.in.gov/Download.aspx?id=16906 'Installment Period Information' (April 15, 2026; June 15, 2026; Sept. 15, 2026; Jan. 15, 2027); 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (c)(2); none is a weekend or Indiana holiday (Wed/Mon/Tue/Fri).",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form ES-40 (State Form 46005, R26/9-25) for 2026, forms.in.gov/Download.aspx?id=16906 worksheet line I ('Each installment payment due for 2026 (divide line H by 4)'); 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (d)(1)(A) (25% of the required annual payment) via IC 6-3-4-4.1(a).",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'farmer.rule',
    value: {"ratio": 0.6666666666, "current_pct": 0.667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "IC 6-3-4-4.1 (both the version effective until 1-1-2026 and the version effective 1-1-2026 as amended by P.L.205-2025: individuals pay estimated tax 'at the time or times and in the installments as provided by Section 6654 of the Internal Revenue Code'; estimated tax = state AGI tax + local income tax under IC 6-3.6 less credits other than withholding; no declaration required if estimated tax is reasonably expected to be less than $1,000), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf) (version effective 1-1-2026) incorporating 26 U.S.C. 6654 (govinfo.gov/content/pkg/USCODE-2024-title26/html/USCODE-2024-title26-subtitleF-chap68-subchapA-partI-sec6654.htm) (i)(1)-(2) (one installment due January 15, 2027; required amount 66 2/3% of current-year tax; no penalty if return filed and tax paid by March 1, 2027 (a Monday, no roll); farmer = 2/3 of gross income from farming/fishing in the current or preceding year); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Farmers and Fishermen'. 2026 Schedule IT-2210 not yet published; current_pct .667 follows the 2025 form's rounding.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "Indiana's own penalty: IC 6-3-4-4.1(b) (underpayment of estimated tax under IRC 6654 -> 'a penalty in an amount prescribed by IC 6-8.1-10-2.1(b)') and IC 6-8.1-10-2.1(b) ('ten percent (10%)' of the tax not paid), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties' ('the penalty will be 10 percent of the underpayment for that period ... computed on a quarter-by-quarter basis'); Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 lines 13 and 21 ('Multiply line 20 by 10%'). ENGINE NOTE: 0.10 is NOT an annual rate. Indiana's penalty is a flat 10% of each installment period's underpayment, not prorated by days late (IT-2210 lines 19-21; IB3 'Penalties'); a payment made after an installment due date counts toward the NEXT installment period (IT-2210 line 16 instructions; IB3 'Underpayment'), so any late payment leaves the earlier period fully underpaid; an overpayment carried back to an earlier period does not reduce that period's penalty (IB3). No 4th-installment penalty if the return is filed and all tax paid by January 31 (Feb. 2, 2026 for TY2025 after weekend roll; IT-2210 Section B; IRC 6654(h)). Do NOT apply 0.10 as an annualized interest rate. (Illinois' comparable flat penalty is seeded as rate null; the engine must special-case IN.)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'penalty.rate',
    value: 0.1,
    citation: "Indiana's own penalty: IC 6-3-4-4.1(b) (underpayment of estimated tax under IRC 6654 -> 'a penalty in an amount prescribed by IC 6-8.1-10-2.1(b)') and IC 6-8.1-10-2.1(b) ('ten percent (10%)' of the tax not paid), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf 'Penalties' ('the penalty will be 10 percent of the underpayment for that period ... computed on a quarter-by-quarter basis'); Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 lines 13 and 21 ('Multiply line 20 by 10%'). ENGINE NOTE: 0.10 is NOT an annual rate. Indiana's penalty is a flat 10% of each installment period's underpayment, not prorated by days late (IT-2210 lines 19-21; IB3 'Penalties'); a payment made after an installment due date counts toward the NEXT installment period (IT-2210 line 16 instructions; IB3 'Underpayment'), so any late payment leaves the earlier period fully underpaid; an overpayment carried back to an earlier period does not reduce that period's penalty (IB3). No 4th-installment penalty if the return is filed and all tax paid by January 31 (Feb. 2, 2026 for TY2025 after weekend roll; IT-2210 Section B; IRC 6654(h)). Do NOT apply 0.10 as an annualized interest rate. (Illinois' comparable flat penalty is seeded as rate null; the engine must special-case IN.)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "IC 6-3-3-3(a) (resident credit for tax paid to another state on income from sources outside Indiana, limited to the Indiana tax on that income; denied where the other state grants the reverse credit) and 6-3-3-3(b) (reciprocal-type credit for nonresidents), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf); verified on the 2025 Schedule 6 (State Form 53999, R16/9-25) line 5, forms.in.gov/Download.aspx?id=16940; 2026 Schedule 6 not yet published. Credit offsets state AGI tax only, not county tax.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "IC 6-3-2-1(b) (tax imposed 'on that part of the adjusted gross income derived from sources within Indiana of every nonresident person'; (b)(7) 2.95% for taxable years beginning in 2026) and IC 6-3-2-2(a) (Indiana-source income defined), Indiana Code 2025 Title 6 (iga.in.gov/ic/2025/Title_6.pdf); 2025 Form IT-40PNR (State Form 472, R24/9-25) lines 1-8, forms.in.gov/Download.aspx?id=16919; plus county tax for nonresidents via Schedule CT-40PNR. 2026 IT-40PNR not yet published.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-04-03", "2026-05-05", "2026-05-25", "2026-07-03", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-12", "2027-02-15", "2027-03-26", "2027-05-04", "2027-05-31", "2027-07-04", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-02", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-23", "2027-12-24", "2027-12-25", "2027-12-31"],
    citation: "Indiana legal holidays 'for all purposes', IC 1-1-9-1 (Indiana Code 2025 Title 1, iga.in.gov/ic/2025/Title_1.pdf): Jan 1; 3rd Mon Jan; Feb 12; 3rd Mon Feb; Good Friday; last Mon May; July 4; 1st Mon Sep; 2nd Mon Oct; Election Day (any general, municipal or primary election); Nov 11; 4th Thu Nov; Dec 25; a Sunday holiday -> following Monday, a Saturday holiday -> preceding Friday (IC 1-1-9-1(b)); UNION with the Governor's state-employee observance dates under IC 1-1-9-2 (which moves Lincoln's and Washington's Birthdays to the Friday after Thanksgiving and around Christmas): 2026 and 2027 Holidays Memoranda, Office of the Governor (secure.in.gov/spd/benefits/files/2026-Holidays-Memorandum.pdf and 2027%20Holidays%20Memorandum.pdf; both Saturday/Sunday-schedule observances kept; 2027 memo lists New Year's Day 2028 observed Friday Dec 31, 2027, matching IC 1-1-9-1(b)). Due-date roll: Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf ('national or state holiday, Saturday, or Sunday'). Federal-only holidays not listed; none affects an installment date. Calendar years 2026-2027.",
    status: 'verified',
  },
];
