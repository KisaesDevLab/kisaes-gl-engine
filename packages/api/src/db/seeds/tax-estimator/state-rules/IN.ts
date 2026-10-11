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
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section C line 6 ('If less than $1,000, STOP HERE! You do not owe a penalty') and 'Who should use' ('amount you owe for tax year 2025, after credits, is $1,000 or more'); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) Introduction (total unpaid state and local income tax liability of $1,000 or more). Measured on state plus county tax after withholding and credits.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section C line 4 ('Multiply line 3 by 90% (.90) (farmers/fishermen multiply by .667)') and line 8 (lesser of line 4 or line 7); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) 'Penalties' (90 percent of current-year tax)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section C line 7 (prior year's tax) and line 8; Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) 'Penalties' (100 percent of previous year's tax)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: {"threshold": 150000, "pct": 1.1},
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 line 7 instructions and CAUTION box ('If your 2024 federal adjusted gross income is more than $150,000 ($75,000 if your 2024 filing status is married filing separately), and you are not subject to the special rules for farmers and fishermen, you must enter 110% of last year's tax'); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1). The $75,000 MFS threshold and the farmer carve-out cannot be expressed in the key.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section E column headings (April 15, 2025; June 16, 2025; September 15, 2025; January 15, 2026); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) 'Methods for Payment' (due dates April 15, June 15, September 15, January 15; weekend or state/national holiday moves to the next business day)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section E line 14 ('Divide amount on line 8 by 4' for every column)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 Section A and instructions ('If at least two-thirds of your gross income for 2024 or 2025 was from farming or fishing, you have only one payment due date for 2025 estimated tax - Jan. 15, 2026'; Option 1 pay by Jan. 15, 2026 and file by April 15, 2026; Option 2 'File your Form IT-40 by March 2, 2026, and pay all the tax due'); line 4 note ('multiply line 3 by 66 2/3% (.667)'); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) Section IX. Ratio stored just under 2/3 per MO convention.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Indiana's penalty is 10% of each period's underpayment (flat per installment period, not an annual rate and not time-prorated): Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) 'Penalties'; Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 lines 13 and 21 ('Multiply line 20 by 10%'). Stored as 0.10 although the key is described as an annual rate.",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'penalty.rate',
    value: 0.1,
    citation: "Indiana's penalty is 10% of each period's underpayment (flat per installment period, not an annual rate and not time-prorated): Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) 'Penalties'; Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 lines 13 and 21 ('Multiply line 20 by 10%'). Stored as 0.10 although the key is described as an annual rate.",
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
    citation: "Form IT-40PNR 2025 (State Form 472, R24/9-25) lines 1-8: Indiana-source income (Schedule A) less Indiana add-backs/deductions/exemptions = Indiana adjusted gross income (line 7), state tax = line 7 x 3% (line 8) plus county tax from Schedule CT-40PNR",
    status: 'verified',
  },
  {
    state: 'IN', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-20", "2025-04-18", "2025-05-26", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2025-12-26", "2026-01-01", "2026-01-19", "2026-04-03", "2026-05-05", "2026-05-25", "2026-07-03", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25"],
    citation: "2026 portion verified: Indiana SPD 2026 Holidays Memorandum (secure.in.gov/spd/benefits/files/2026-Holidays-Memorandum.pdf). 2025 portion UNVERIFIED: the 2025 memorandum URL returned 404; the 12 dates (Good Friday Apr 18, Lincoln's Birthday Nov 28, Washington's Birthday Dec 26, Columbus Day Oct 13, etc.) come from a search-engine summary of that memo and standard-rule computation. Basis: Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) ('national or state holiday' roll).",
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'IN', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Form ES-40 (State Form 46005, R26/9-25) for 2026, forms.in.gov/Download.aspx?id=16906 worksheet line D ('line C multiplied by .0295') plus county tax line E",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'required_threshold',
    value: 1000,
    citation: "Form ES-40 (State Form 46005, R26/9-25) for 2026, forms.in.gov/Download.aspx?id=16906 instructions ('You expect to owe more than $1,000 when you file your tax return, then you should pay estimated tax'); Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) Introduction and 'Penalties' ($1,000 of state plus local tax)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "2026 Schedule IT-2210 is not yet published; rule taken from the 2025 form and Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) (statute IC 6-3-4-4.1 not retrievable: iga.in.gov is a JavaScript app). 90% of current-year tax.",
    status: 'unverified',
  },
  {
    state: 'IN', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "2026 Schedule IT-2210 is not yet published; rule taken from the 2025 form and Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) (statute IC 6-3-4-4.1 not retrievable: iga.in.gov is a JavaScript app). 100% of prior-year tax.",
    status: 'unverified',
  },
  {
    state: 'IN', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: {"threshold": 150000, "pct": 1.1},
    citation: "2026 Schedule IT-2210 is not yet published; rule taken from the 2025 form and Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) (statute IC 6-3-4-4.1 not retrievable: iga.in.gov is a JavaScript app). Prior-year federal AGI over $150,000 ($75,000 MFS), non-farmer: 110%.",
    status: 'unverified',
  },
  {
    state: 'IN', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Form ES-40 (State Form 46005, R26/9-25) for 2026, forms.in.gov/Download.aspx?id=16906 'Installment Period Information' (April 15, 2026; June 15, 2026; Sept. 15, 2026; Jan. 15, 2027); none is a weekend or Indiana holiday (Wed/Mon/Tue/Fri)",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form ES-40 (State Form 46005, R26/9-25) for 2026, forms.in.gov/Download.aspx?id=16906 worksheet line I ('Each installment payment due for 2026 (divide line H by 4)')",
    status: 'verified',
  },
  {
    state: 'IN', year: 2026, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "2026 Schedule IT-2210 is not yet published; rule taken from the 2025 form and Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) (statute IC 6-3-4-4.1 not retrievable: iga.in.gov is a JavaScript app). Farmer/fisherman: one payment by Jan. 15, 2027, or file and pay all tax by March 1, 2027; 66 2/3% (.667) of current-year tax.",
    status: 'unverified',
  },
  {
    state: 'IN', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "Indiana's penalty is 10% of each period's underpayment (flat per installment period, not an annual rate and not time-prorated): Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) 'Penalties'; Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 lines 13 and 21 ('Multiply line 20 by 10%'). Stored as 0.10 although the key is described as an annual rate. 2026 Schedule IT-2210 is not yet published; rule taken from the 2025 form and Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) (statute IC 6-3-4-4.1 not retrievable: iga.in.gov is a JavaScript app).",
    status: 'unverified',
  },
  {
    state: 'IN', year: 2026, key: 'penalty.rate',
    value: 0.1,
    citation: "Indiana's penalty is 10% of each period's underpayment (flat per installment period, not an annual rate and not time-prorated): Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) 'Penalties'; Schedule IT-2210 (2025, State Form 46002, R27/9-25), forms.in.gov/Download.aspx?id=16926 lines 13 and 21 ('Multiply line 20 by 10%'). Stored as 0.10 although the key is described as an annual rate. 2026 Schedule IT-2210 is not yet published; rule taken from the 2025 form and Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) (statute IC 6-3-4-4.1 not retrievable: iga.in.gov is a JavaScript app).",
    status: 'unverified',
  },
  {
    state: 'IN', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "Verified for 2025 on Schedule 6 line 5; 2026 Schedule 6 not yet published, carried forward",
    status: 'unverified',
  },
  {
    state: 'IN', year: 2026, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "Verified for 2025 on Form IT-40PNR line 8; 2026 IT-40PNR not yet published (2026 ES-40 shows state rate .0295), carried forward",
    status: 'unverified',
  },
  {
    state: 'IN', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-19", "2026-04-03", "2026-05-05", "2026-05-25", "2026-07-03", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25", "2027-01-01", "2027-01-18", "2027-03-26", "2027-05-04", "2027-05-31", "2027-07-04", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-02", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-23", "2027-12-24", "2027-12-25"],
    citation: "Indiana SPD 2026 and 2027 Holidays Memoranda (secure.in.gov/spd/benefits/files/2026-Holidays-Memorandum.pdf and 2027%20Holidays%20Memorandum.pdf, Governor's Office), both Saturday- and Sunday-schedule observances listed. Basis: Indiana DOR Income Tax Information Bulletin #3 (March 2023), in.gov/dor/files/ib03.pdf (refs IC 6-3-2-1; IC 6-3-4-4.1) ('national or state holiday' roll).",
    status: 'verified',
  },
];
