// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// ND state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research batch 5, 2026-10-11).
// Every row cites the document it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch5-sources.md. Rows marked 'unverified'
// state the reason in the citation. The CPA signs off ND (D12).
export const ND_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'ND', year: 2025, key: 'has_income_tax', value: true,
    citation: 'N.D.C.C. §57-38-30.3 (individual income tax); 2025 Form ND-1ES (SFN 28709) tax rate schedules (1.95%-2.50%).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'required_threshold', value: 1000,
    citation: '2025 Form ND-1ES (SFN 28709) "Who must pay estimated tax?" (all four conditions: required to pay federal estimated tax; prior-year net tax liability at least $1,000; expect to owe, after ND withholding, $1,000 or more; withholding below the lesser of 90%/100%); worksheet line 10; N.D.C.C. §57-38-62(1) and (3).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2025 Form ND-1ES (SFN 28709) worksheet line 11 ("Multiply line 8 by 90% (.90) [or 66 2/3% if a qualified farmer]"); N.D.C.C. §57-38-62(1)(a).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2025 Form ND-1ES (SFN 28709) worksheet lines 12-13; N.D.C.C. §57-38-62(1)(b) (100% of preceding year net tax liability; not available if no prior return or the individual moved into ND during the preceding year).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: N.D.C.C. §57-38-62(1)(b) and Form ND-1ES use 100% of prior-year net tax liability for all taxpayers.',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: 'N.D.C.C. §57-38-63 (April 15, June 15, September 15, January 15); 2025 Form ND-1ES (SFN 28709) "Payment amounts and due dates" (any date on a Saturday, Sunday or legal holiday is due the next business day). June 15, 2025 is a Sunday -> June 16, 2025.',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2025 Form ND-1ES (SFN 28709) "Payment amounts and due dates" (one-fourth (25%) of the total estimated tax by each due date); worksheet line 14; N.D.C.C. §57-38-63 ("no less than one-quarter").',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-01-15"},
    citation: '2025 Form ND-1ES (SFN 28709) "Farmer" (qualify as a farmer for federal estimated tax: pay the full estimated tax by Jan 15 of the following year) and worksheet line 11 (66 2/3%). ND states you still have until the regular due date to file the return, so no earlier file-by exists; file_by is set equal to due_date (mapping choice).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: 'N.D.C.C. §57-38-62(3) (interest under §57-38-45 accrues on estimated-tax underpayments); §57-38-45 (twelve percent per annum).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'penalty.rate', value: 0.12,
    citation: '2025 Form ND-1ES (SFN 28709) "Underpayment or late payment interest" (12% per year from the installment due date to the earlier of payment or the regular due date of the return); N.D.C.C. §57-38-45.',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'N.D.C.C. §57-38-30.3(4) (resident credit for income tax paid to another state/territory/DC on income also taxed by ND, limited by the ratio of other-jurisdiction federal AGI to total).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: '2025 Form ND-1ES (SFN 28709) worksheet lines 15-19 for full-year nonresidents/part-year residents (line 18 "North Dakota income ratio" = ND-source income / federal AGI, multiplied by tax on all taxable income).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-31"],
    citation: 'N.D.C.C. §1-03-01 (holidays), §1-03-02 (Jan 1/Jul 4/Nov 11/Dec 25 on Sunday -> Monday), §1-03-02.1 (those on Saturday -> preceding Friday) (ndlegis.gov/cencode/t01c03.pdf): New Year\'s Day; MLK Day (3rd Mon Jan); 3rd Mon Feb (Washington); Good Friday; Memorial Day; July 4; Labor Day; Nov 11; Thanksgiving; Dec 25 (plus every Sunday and any President/governor-appointed day, not listed). No Juneteenth or Columbus Day. Dec 31, 2027 included because Jan 1, 2028 is a Saturday. ND-1ES: due dates on a Saturday, Sunday or legal holiday move to the next business day. Calendar years 2025-2027 computed.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'ND', year: 2026, key: 'has_income_tax', value: true,
    citation: 'N.D.C.C. §57-38-30.3 (individual income tax); 2026 Form ND-1ES (SFN 28709) tax rate schedules (1.95%-2.50%).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'required_threshold', value: 1000,
    citation: '2026 Form ND-1ES (SFN 28709) "Who must pay estimated tax?" (all four conditions: required to pay federal estimated tax; prior-year net tax liability at least $1,000; expect to owe, after ND withholding, $1,000 or more; withholding below the lesser of 90%/100%); worksheet line 10; N.D.C.C. §57-38-62(1) and (3).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2026 Form ND-1ES (SFN 28709) worksheet line 11 ("Multiply line 8 by 90% (.90) [or 66 2/3% if a qualified farmer]"); N.D.C.C. §57-38-62(1)(a).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2026 Form ND-1ES (SFN 28709) worksheet lines 12-13; N.D.C.C. §57-38-62(1)(b) (100% of preceding year net tax liability; not available if no prior return or the individual moved into ND during the preceding year).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: N.D.C.C. §57-38-62(1)(b) and Form ND-1ES use 100% of prior-year net tax liability for all taxpayers.',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: 'N.D.C.C. §57-38-63 (April 15, June 15, September 15, January 15); 2026 Form ND-1ES (SFN 28709) "Payment amounts and due dates" (any date on a Saturday, Sunday or legal holiday is due the next business day).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2026 Form ND-1ES (SFN 28709) "Payment amounts and due dates" (one-fourth (25%) of the total estimated tax by each due date); worksheet line 14; N.D.C.C. §57-38-63 ("no less than one-quarter").',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-01-15"},
    citation: '2026 Form ND-1ES (SFN 28709) "Farmer" (qualify as a farmer for federal estimated tax: pay the full estimated tax by Jan 15 of the following year) and worksheet line 11 (66 2/3%). ND states you still have until the regular due date to file the return, so no earlier file-by exists; file_by is set equal to due_date (mapping choice).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: 'N.D.C.C. §57-38-62(3) (interest under §57-38-45 accrues on estimated-tax underpayments); §57-38-45 (twelve percent per annum).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'penalty.rate', value: 0.12,
    citation: '2026 Form ND-1ES (SFN 28709) "Underpayment or late payment interest" (12% per year from the installment due date to the earlier of payment or the regular due date of the return); N.D.C.C. §57-38-45.',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'N.D.C.C. §57-38-30.3(4) (resident credit for income tax paid to another state/territory/DC on income also taxed by ND, limited by the ratio of other-jurisdiction federal AGI to total).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: '2026 Form ND-1ES (SFN 28709) worksheet lines 15-19 for full-year nonresidents/part-year residents (line 18 "North Dakota income ratio" = ND-source income / federal AGI, multiplied by tax on all taxable income).',
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-31"],
    citation: 'N.D.C.C. §1-03-01 (holidays), §1-03-02 (Jan 1/Jul 4/Nov 11/Dec 25 on Sunday -> Monday), §1-03-02.1 (those on Saturday -> preceding Friday) (ndlegis.gov/cencode/t01c03.pdf): New Year\'s Day; MLK Day (3rd Mon Jan); 3rd Mon Feb (Washington); Good Friday; Memorial Day; July 4; Labor Day; Nov 11; Thanksgiving; Dec 25 (plus every Sunday and any President/governor-appointed day, not listed). No Juneteenth or Columbus Day. Dec 31, 2027 included because Jan 1, 2028 is a Saturday. ND-1ES: due dates on a Saturday, Sunday or legal holiday move to the next business day. Calendar years 2025-2027 computed.',
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'ND', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'ND', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ND', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
