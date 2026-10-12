// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// VA state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 6 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch6-sources.md. The CPA signs off VA (D12).
// Sources: Form 760ES 2025 (Rev. 09/24) and 2026; Form 760C 2025; Form 763 2025; Va. Code §2.2-3300;
// Virginia Tax Bulletins on interest rates (Va. Code §58.1-15).
export const VA_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'VA', year: 2025, key: 'has_income_tax', value: true,
    citation: "Form 760ES 2025 (Rev. 09/24), Tax Rate Schedule (2%-5.75%)",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'required_threshold', value: 150,
    citation: "Form 760ES 2025 (Rev. 09/24) Section I (\"If your Virginia income tax liability, after subtracting income tax withheld and any allowable credits, is expected to be more than $150, then you must make estimated tax payments\") and exception (d) ($150 or less). Strictly \"more than\", stored as 150. Income exemptions (single AGI under $11,950, joint under $23,900) are not in the key set.",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form 760ES 2025 Sections III and VIII (\"at least 90% ... of your total tax liability\"); Form 760C 2025 Part I line 2 (\"Enter 90% of the Amount Shown on Line 1\")",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form 760ES 2025 Section VIII exception (d) (installment equals or exceeds the prior year's tax liability for each period, prior year full 12 months with liability) and the closing sentence (\"90% of the current year's ... or 100% of your liability for the preceding year, whichever is less\"); Form 760C 2025 Part II line 16 Exception 1 (25/50/75/100% of 2024 tax)",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: Form 760C 2025 Part II Exception 1 and Form 760ES 2025 Section VIII use 100% of prior-year tax with no income test",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'installments.due_dates', value: ["2025-05-01", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Form 760ES 2025 Section II (May 1, June 15, September 15, 2025; January 15, 2026; \"When the last day ... falls on a Saturday, Sunday or legal holiday ... next succeeding business day\"). June 15, 2025 is a Sunday -> June 16, 2025 (rolled by this file). Late starters pay 3/2/1 installments (Payment Schedule; not in key set).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form 760ES 2025 Payment Schedule (25% on May 1, June 15, September 15 and January 15 when requirements are met on or before April 15)",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "Form 760ES 2025 Section II (farmers, fishermen, merchant seamen with 2/3 of estimated gross income from those sources file only Voucher 4 by January 15, 2026; no 760ES required if the return is filed on or before March 1, 2026 with full payment) and Section VIII (662/3% in place of 90%). March 1, 2026 is a Sunday -> file_by 2026-03-02 (MO convention). Ratio stored just under 2/3. Statute: Va. Code 58.1-490(F) (two-thirds gross income from farming, fishing or merchant seaman; declaration by January 15) and (I) (return and full payment by March 1); 58.1-492(A)(1) (\"sixty-six and two-thirds percent\"); current_pct stored as 0.6666666667 (audit: was 0.6667).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "Va. Code 58.1-492(A) (addition to tax \"at the rate established for interest, under 58.1-15\"); Va. Code 58.1-15(A)-(B) (IRC 6621(a)(2) underpayment rate plus two percent; for calendar-year individuals the rate of the third month after the year also applies through May 1); Va. Code 58.1-492(B)(1) (period of underpayment ends no later than May 1); Form 760C 2025 line 23 (Virginia daily rate .00025).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'penalty.rate', value: 0.09,
    citation: "Form 760C 2025 Part III line 23 (\"Multiply the Number of Days ... by the Daily Rate .00025 (9% Per Annum)\", one rate for every period through May 1, 2026); consistent with Va. Code 58.1-15 (IRC 6621 underpayment rate 7% for every quarter of 2025 and Q1 2026 per irs.gov Quarterly interest rates, plus 2% = 9%).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "Form 760ES 2025 Section III, Tax Credits and Adjustments (a): residents may claim an expected credit for income tax paid to another state as a nonresident, except Arizona, California, Oregon and D.C. Statute: Va. Code 58.1-332(A) - credit only for other-state tax on earned or business income or capital gains, limited to the proportional Virginia tax (not expressible in the key set).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'nonresident_method', value: "other",
    citation: "Va. Code 58.1-325(A) (nonresident Virginia taxable income = resident-basis Virginia taxable income x Virginia-source / all-source income); Form 763 2025 line 15 Virginia taxable income, line 16 Nonresident Allocation Percentage (Page 2 line 15 = Virginia sources / all sources), line 17 \"Nonresident Taxable Income (Multiply Line 15 by percentage on Line 16)\", line 18 tax from the rate schedule - a proration of taxable income, not of tax, hence \"other\".",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-04", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-02", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24"
    ],
    citation: "Va. Code §2.2-3300 (Jan 1; 3rd Mon Jan; 3rd Mon Feb; last Mon May; June 19; July 4; 1st Mon Sep; 2nd Mon Oct; Election Day, Tuesday after the first Monday in November; Nov 11; Thanksgiving Thursday and the Friday after; Dec 25; a Saturday holiday moves to the preceding Friday, a Sunday holiday to the following Monday). Calendar years 2025-2027. Dates computed from the statute. Statute: Va. Code 58.1-332(A) - credit only for other-state tax on earned or business income or capital gains, limited to the proportional Virginia tax (not expressible in the key set).",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'VA', year: 2026, key: 'has_income_tax', value: true,
    citation: "Form 760ES 2026, Tax Rate Schedule (2%-5.75%)",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'required_threshold', value: 1000,
    citation: "Form 760ES 2026 Section I (\"For taxable years beginning on and after January 1, 2026, if your Virginia income tax liability, after subtracting income tax withheld and any allowable credits, is expected to be more than $1,000\") and exception (d) ($1,000 or less). The threshold rose from $150 (2025) to $1,000 (2026). Strictly \"more than\", stored as 1000.",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form 760ES 2026 Sections III and VIII (\"at least 90% ... of your total tax liability\")",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form 760ES 2026 Section VIII (exception (d) prior-year liability per installment; \"90% ... or 100% of your liability for the preceding year, whichever is less\")",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: Form 760ES 2026 Section VIII uses 100% of prior-year liability with no income test",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'installments.due_dates', value: ["2026-05-01", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Form 760ES 2026 Section II (May 1, June 15, September 15, 2026; January 15, 2027) and Payment Schedule. May 1, 2026 is a Friday and June 15, 2026 a Monday; no roll needed.",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form 760ES 2026 Payment Schedule (25% each when requirements are met on or before April 15)",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Form 760ES 2026 Section II (Voucher 4 by January 15, 2027; return filed on or before March 1, 2027 with full payment) and Section VIII (662/3%). March 1, 2027 is a Monday. Statute: Va. Code 58.1-490(F) (two-thirds gross income from farming, fishing or merchant seaman; declaration by January 15) and (I) (return and full payment by March 1); 58.1-492(A)(1) (\"sixty-six and two-thirds percent\"); current_pct stored as 0.6666666667 (audit: was 0.6667).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "Va. Code 58.1-492(A) (addition to tax \"at the rate established for interest, under 58.1-15\"); Va. Code 58.1-15(A)-(B) (IRC 6621(a)(2) underpayment rate plus two percent; for calendar-year individuals the rate of the third month after the year also applies through May 1); Va. Code 58.1-492(B)(1) (period of underpayment ends no later than May 1).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'penalty.rate', value: 0.09,
    citation: "Va. Code 58.1-15(A)-(B) (IRC 6621(a)(2) underpayment rate + 2%, applied per period; March rate continues through May 1); irs.gov Quarterly interest rates (read 2026-10-11): 2026 underpayment rate 7% (Q1), 6% (Q2), 7% (Q3), 7% (Q4) -> Virginia 9%, 8%, 9%, 9%. 0.09 is the dominant rate; Q2 2026 days accrue at 8%, and the Q1 2027 rate (which runs through May 1, 2027) is not yet announced. Form 760C 2026 not yet published. Single-rate key cannot hold the quarterly variation.",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "Form 760ES 2026 Section III, Tax Credits and Adjustments (a) (credit for tax paid to another state as a nonresident, except AZ, CA, OR, DC) Statute: Va. Code 58.1-332(A) - credit only for other-state tax on earned or business income or capital gains, limited to the proportional Virginia tax (not expressible in the key set).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'nonresident_method', value: "other",
    citation: "Va. Code 58.1-325(A) (nonresident Virginia taxable income \"shall be an amount bearing the same proportion to his Virginia taxable income, computed as though he were a resident, as the net amount of his income ... from Virginia sources bears to ... all sources\"); Form 763 (2025) lines 15-18 (resident-basis taxable income x Nonresident Allocation Percentage, then tax from the rate schedule on the prorated taxable income - a proration of taxable income, not of tax, hence \"other\"). Form 763 for 2026 not yet published; statute unchanged.",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-04", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-02", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24"
    ],
    citation: "Va. Code §2.2-3300 (see 2025 row). Calendar years 2025-2027. Dates computed from the statute.",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2025, key: 'threshold_comparison', value: "more_than",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md m1/D2: the requirement and penalty tests read \"more than\" the dollar threshold); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2025, key: 'return_due_date', value: "2026-05-01",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md D6: Virginia individual return due May 1; Form 760C penalty period ends May 1, 2026 (a Friday)); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'VA', year: 2026, key: 'threshold_comparison', value: "more_than",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md m1/D2: the requirement and penalty tests read \"more than\" the dollar threshold); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2026, key: 'return_due_date', value: "2027-05-03",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md D6: Virginia return due May 1); primary source not re-read in this task (agency page blocked or not reached). May 1, 2027 is a Saturday; next business day assumed.",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2026, key: 'penalty.rate_schedule', value: [{"from": "2026-05-01", "to": "2026-06-30", "rate": 0.08}, {"from": "2026-07-01", "to": "2026-12-31", "rate": 0.09}],
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md M11: Tax Bulletins 26-2, 26-3, 26-4; 8% May 1-Jun 30, 2026, 9% Q3-Q4 2026; Q1 2027 not set; §58.1-15(B) carries the Q1 rate to May 1); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'VA', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
