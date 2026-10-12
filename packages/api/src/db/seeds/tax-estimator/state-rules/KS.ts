// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// KS state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 3 research, 2026-10-11).
// Every row cites the primary source it was read in; see features/tax-estimator/docs/reviews/phase2-batch3-sources.md.
export const KS_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'KS', year: 2025, key: 'has_income_tax',
    value: true,
    citation: "2025 Kansas Individual Income Tax booklet (ip25), ksrevenue.gov/pdf/ip25.pdf (Kansas individual income tax; Form K-40 line 18 tax); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 1 ('Amount from line 18, 2025 Form K-40')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'required_threshold',
    value: 500,
    citation: "K.S.A. 79-32,101(a)(1) (ksrevisor.gov/statutes/chapters/ch79/079_032_0101.html: individual 'can reasonably expect to owe, after withholding and credits, tax of at least $500' and expects withholding and credits below 90% of current-year or 100% of prior-year tax); Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf ('estimated Kansas income tax after withholding and credits is $500 or more'; worksheet line 8); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf Who may use ('2025 tax due ... less withholding and tax credits ... is $500 or more'). Nonresidents consider only Kansas-source income (K-40ES).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf ('90% of the tax on your tax return for tax year 2025'); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 2 ('Multiply line 1 by 90% (farmers and fishers multiply by 66 2/3%)')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "K.S.A. 79-32,107(b)(1) (ksrevisor.gov/statutes/chapters/ch79/079_032_0107.html: tax shown on the preceding year's return, if a return showing a liability was filed); Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf ('100% of the tax shown on your 2024 tax return'); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 3 and line 9. NOT EXPRESSIBLE: 79-32,107(b)(2) also exempts if no prior return was required or prior-year liability was less than $200 (required amount = zero).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule: K.S.A. 79-32,107(b)(1) uses 100% of the preceding year's tax with no income test; Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf (90% of 2025 tax or 100% of 2024 tax); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf lines 2, 3, 9 (lesser of 90% current or 100% prior; no 110% language anywhere on the 2025 K-210).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf 'When to file' (April 15, 2025, June 15, 2025, September 15, 2025 and January 15, 2026; 'When the due date falls on a Saturday, Sunday, or legal holiday, substitute the next regular workday'); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 12 and NOTE ('If any due date falls on a Saturday, Sunday, or legal holiday, substitute the next regular work day'); K.S.A. 79-32,102(a), 79-32,103. June 15, 2025 was a Sunday -> Monday June 16, 2025. The Jan. 15, 2026 installment is not required if the return is filed and tax paid in full by Jan. 31, 2026 (K.S.A. 79-32,101(c); K-210 instructions).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf Part I (cumulative 25%/50%/75%/100% by each due date); Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf worksheet line 9 ('enter 1/4 of line 8'); K.S.A. 79-32,103(a)(1) ('four equal installments').",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "K.S.A. 79-32,102(b) (estimated gross income from farming or fishing at least 2/3 of total; declaration by January 15 of the succeeding year); K.S.A. 79-32,101(c) (no installment required if return filed and tax paid in full by March 1); K.S.A. 79-32,107(b)(3) (66 2/3%); Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf 'Farmers and Fishers' (due on or before January 15, 2026 unless return filed and tax fully paid on or before March 1, 2026); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 2 (66 2/3%), line 10b, Who may use (exempt if two-thirds test met and K-40 filed and tax paid on or before March 1, 2026) and the schedule-wide NOTE ('If any due date falls on a Saturday, Sunday, or legal holiday, substitute the next regular work day'). March 1, 2026 is a Sunday -> stored rolled to Monday March 2, 2026. Ratio stored just under 2/3 (seed convention).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf lines 15-16 (Kansas computes its own interest-rate penalty, 9% to 12/31/25 and 8% from 1/1/26)",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'penalty.rate',
    value: 0.09,
    citation: "Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf lines 15-16 and instructions ('Penalty is computed to 12/31/25 at 9% and from 1/1/26 to the date the tax was paid or 4/15/26, whichever is earlier, at 8%'); K.S.A. 79-32,107(a) (penalty at the K.S.A. 79-2968 rate); K.S.A. 79-2968 (IRC 6621(a)(2) underpayment rate in effect July 1 of the preceding year plus one point: 8%+1 = 9% for 2025, 7%+1 = 8% for 2026). CAUTION: single-rate key; underpayment days falling in 2026 accrue at 8%, not 9%.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "K.S.A. 79-32,111(a) (ksrevisor.gov/statutes/chapters/ch79/079_032_0111.html: resident credit for income tax paid to another state, limited by the other-state KAGI / total KAGI proportion); 2025 Kansas Individual Income Tax booklet (ip25), ksrevenue.gov/pdf/ip25.pdf Form K-40 line 13 ('Credit for taxes paid to other states') and the 'Taxes Paid to Other States by Kansas Residents' worksheet (line 5 percentage limitation).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'nonresident_method',
    value: "ratio",
    citation: "K.S.A. 79-32,110(b) (ksrevisor.gov/statutes/chapters/ch79/079_032_0110.html: nonresident tax = resident-basis tax x modified Kansas source income / Kansas AGI); 2025 Kansas Individual Income Tax booklet (ip25), ksrevenue.gov/pdf/ip25.pdf Form K-40 line 9 ('Nonresident percentage (from Schedule S, line B23)') and line 10; Schedule S line B23 (B21 / B22).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25"],
    citation: "K.S.A. 35-107 (ksrevisor.gov/statutes/chapters/ch35/035_001_0007.html): legal public holidays are New Year's Day Jan 1; MLK Day 3rd Mon Jan; President's Day 3rd Mon Feb; Memorial Day last Mon May; Independence Day Jul 4; Labor Day 1st Mon Sep; Columbus Day 2nd Mon Oct; Veterans' Day Nov 11; Thanksgiving 4th Thu Nov; Christmas Dec 25; subsection (b) provides that any reference in Kansas law to legal holidays means these days (no weekend-observance shift; case annotation 3: the Friday after Thanksgiving is not excluded). Used for the K-40ES/K-210 'Saturday, Sunday, or legal holiday ... next regular workday' roll. Replaces the earlier Dept. of Administration executive-branch employee holiday list (which added Juneteenth, day after Thanksgiving, Christmas Eve 2026, observed-Friday dates and omitted President's Day and Columbus Day). Dates computed from the statute. Calendar years 2025-2026. No TY2025 installment or farmer date falls on one of these holidays.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'KS', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf worksheet lines 5-6 ('Estimated Kansas tax liability (use the Tax Computation Schedules below)')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'required_threshold',
    value: 500,
    citation: "K.S.A. 79-32,101(a)(1) ('tax of at least $500' after withholding and credits); Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf ('estimated Kansas income tax after withholding and credits is $500 or more'; worksheet line 8 'If the amount is less than $500, estimated tax payments are not required'). Nonresidents consider only Kansas-source income.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf ('90% of the tax on your tax return for tax year 2026')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "K.S.A. 79-32,107(b)(1) (preceding year's tax, if a return showing a liability was filed); Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf ('100% of the tax shown on your 2025 tax return' (the return must cover a 12-month period with a tax liability)). NOT EXPRESSIBLE: 79-32,107(b)(2) zero required amount if prior-year liability was under $200 or no return was required.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule: K.S.A. 79-32,107(b) has no income test; Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf (only 90% of 2026 tax, 100% of 2025 tax, or 90% of annualized income).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf 'When to file your estimated tax vouchers' (April 15, 2026, June 15, 2026, September 15, 2026 and January 15, 2027; weekend/legal-holiday roll to the next regular workday). None falls on a weekend (Wed/Mon/Tue/Fri) or Kansas holiday.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf worksheet line 9 ('Amount of each quarterly payment (enter 1/4 of line 8 ...)')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'farmer.rule',
    value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "K.S.A. 79-32,102(b) (2/3 farming/fishing gross income; declaration by January 15); K.S.A. 79-32,101(c) (return filed and paid by March 1); K.S.A. 79-32,107(b)(3) (66 2/3%); Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf ('Farmers and Fishers - Payment is due on or before January 15, 2027 unless your return for the 2026 tax year is filed and tax fully paid on or before March 1, 2027'; penalty test '66 2/3% for farmers and fishers'). Jan. 15, 2027 (Fri) and Mar. 1, 2027 (Mon) need no roll. Ratio stored just under 2/3 (seed convention).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "Kansas computes its own penalty rate: Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf lines 15-16; Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf 'Estimated tax penalty' (Schedule K-210)",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'penalty.rate',
    value: 0.08,
    citation: "K.S.A. 79-32,107(a) (penalty 'at the same rate per annum prescribed by K.S.A. 79-2968(b)' from the due date until paid or the 15th day of the 4th month after year end); K.S.A. 79-2968 (ksrevisor.gov/statutes/chapters/ch79/079_029_0068.html: IRC 6621(a)(2) underpayment rate in effect July 1 of the preceding year plus one point). 2026 days: July 1, 2025 rate 7% + 1 = 8% (confirmed by Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 16, 8% from 1/1/26). 2027 days: Rev. Rul. 2026-10, Internal Revenue Bulletin 2026-22 (irs.gov/irb/2026-22_IRB: underpayment rate 7% for the quarter beginning July 1, 2026) + 1 = 8%. So 8% applies to every day of a TY2026 underpayment (2027 figure derived from the statute; the 2026 K-210 is not yet published).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "K.S.A. 79-32,111(a) (ksrevisor.gov/statutes/chapters/ch79/079_032_0111.html, current statute: resident credit for income tax paid to another state, KAGI-proportion limited); form-level confirmation from the 2025 K-40 line 13 (ip25); 2026 K-40 not yet published.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'nonresident_method',
    value: "ratio",
    citation: "K.S.A. 79-32,110(b) (ksrevisor.gov/statutes/chapters/ch79/079_032_0110.html, current statute: nonresident tax = resident-basis tax x modified Kansas source income / Kansas AGI); Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf ('Nonresidents should only consider income from Kansas sources'); form-level confirmation from the 2025 K-40 lines 9-10 / Schedule S line B23 (ip25).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-07-04", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "K.S.A. 35-107 (ksrevisor.gov/statutes/chapters/ch35/035_001_0007.html): legal public holidays are New Year's Day Jan 1; MLK Day 3rd Mon Jan; President's Day 3rd Mon Feb; Memorial Day last Mon May; Independence Day Jul 4; Labor Day 1st Mon Sep; Columbus Day 2nd Mon Oct; Veterans' Day Nov 11; Thanksgiving 4th Thu Nov; Christmas Dec 25; subsection (b) provides that any reference in Kansas law to legal holidays means these days (no weekend-observance shift; case annotation 3: the Friday after Thanksgiving is not excluded). Used for the K-40ES/K-210 'Saturday, Sunday, or legal holiday ... next regular workday' roll. Replaces the earlier Dept. of Administration executive-branch employee holiday list (which added Juneteenth, day after Thanksgiving, Christmas Eve 2026, observed-Friday dates and omitted President's Day and Columbus Day). Dates computed from the statute. Calendar years 2026-2027. No TY2026 installment or farmer date falls on one of these holidays.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
