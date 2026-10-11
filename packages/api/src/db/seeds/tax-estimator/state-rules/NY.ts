// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// NY state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research batch 5, 2026-10-11).
// Every row cites the document it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch5-sources.md. Rows marked 'unverified'
// state the reason in the citation. The CPA signs off NY (D12).
export const NY_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'NY', year: 2025, key: 'has_income_tax', value: true,
    citation: '2025 Form IT-2105-I (Instructions for Form IT-2105) "General information" (estimated New York State, New York City and Yonkers income tax); Tax Law Art. 22.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'required_threshold', value: 300,
    citation: '2025 Form IT-2105-I (Instructions for Form IT-2105) "Who must make estimated income tax payments" (expect to owe, after withholding and credits, at least $300 of NYS, NYC or Yonkers tax); IT-2105.9-I (2025) line 17 (penalty not computed if less than $300).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2025 Form IT-2105-I (Instructions for Form IT-2105) "Penalty for underpayment of estimated taxes" (at least 90% (66 2/3% for farmers and fishermen) of the 2025 return tax, or 90% of tax annualized).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2025 Form IT-2105-I (Instructions for Form IT-2105) (100% of the tax shown on the 2024 return; the 2024 return must be a full 12-month year; no penalty if no NY tax liability for the preceding full 12-month year).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: '2025 Form IT-2105-I (Instructions for Form IT-2105): 110% of the 2024 tax if NYAGI (or MCTD net earnings) on that return is more than $150,000 ($75,000 if married filing separately for 2025). The key stores only the $150,000 threshold; the $75,000 MFS variant cannot be expressed. Does not apply to farmers/fishermen.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: '2025 Form IT-2105-I (Instructions for Form IT-2105) "When to pay" (April 15, June 16, September 15, 2025, and January 15, 2026). June 15, 2025 is a Sunday; the form prints June 16.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2025 Form IT-2105-I (Instructions for Form IT-2105) "When to pay" (pay all with the first voucher or in four equal installments).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-01"},
    citation: '2025 Form IT-2105-I (Instructions for Form IT-2105) "Farmers and fishermen" (two-thirds or more of federal gross income for 2024 or 2025 from farming/fishing: one installment date, Jan 15; pay 66 2/3% of 2025 tax by Jan 15, 2026, or file the NYS return by March 1, 2026 and pay the total tax due). March 1, 2026 is a Sunday; the printed date is stored.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: '2025 Form IT-2105.9-I "Penalty rate" (federal short-term rate plus 5.5 percentage points, not less than 7.5%, set quarterly by the Tax Department); Tax Law §685(c) (statute not read).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'penalty.rate', value: 0.095,
    citation: '2025 Form IT-2105.9-I: rates April 15, 2025 through April 15, 2026 are 9.5% in each quarter (April 15-June 30, July 1-Sept 30, Oct 1-Dec 31 2025, Jan 1-April 15 2026).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'credit_for_other_state', value: true,
    citation: '2025 Form IT-112-R-I (New York State Resident Credit): resident credit for income tax imposed by another state/political subdivision on income also taxed by NY.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: '2025 Form IT-203-I line 45 "Income percentage" (NY-source income / federal AGI; tax computed as a resident then multiplied by the income percentage); 2025 IT-2105.9-I line 11d and Income percentage worksheet A; IT-2105-I line instructions ("Compute your estimated NYAGI as if you were a New York State resident").',
    status: 'verified',
  },
  {
    state: 'NY', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-12", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-04", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-12", "2027-02-15", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-02", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: 'N.Y. General Construction Law §24 public holidays (verbatim text re-read in audit 2026-10-11 via newyork.public.law, which reproduces nysenate.gov/legislation/laws/GCN/24 as updated Oct. 16, 2020; "if any of such days except Flag day is Sunday, the next day thereafter"; "each general election day"): New Year\'s Day; MLK Day (3rd Mon Jan); Lincoln\'s Birthday (Feb 12); Washington\'s Birthday (3rd Mon Feb); Memorial Day; Flag Day (2nd Sunday in June, always a Sunday); Juneteenth (June 19); July 4; Labor Day; Columbus Day (2nd Mon Oct); Veterans\' Day (Nov 11); Thanksgiving; Christmas; each general election day (Tuesday after first Monday in Nov, assumed every year incl. odd-year local general elections). A fixed-date holiday falling on Sunday moves to the next day; Saturday not moved. IT-2105-I says a due date on a Saturday, Sunday or legal holiday moves to the next regular workday. Calendar years 2025-2027 computed.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'NY', year: 2026, key: 'has_income_tax', value: true,
    citation: '2026 Form IT-2105-I (Instructions for Form IT-2105) "General information" (estimated New York State, New York City and Yonkers income tax); Tax Law Art. 22.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'required_threshold', value: 300,
    citation: '2026 Form IT-2105-I (Instructions for Form IT-2105) "Who must make estimated income tax payments" (expect to owe, after withholding and credits, at least $300 of NYS, NYC or Yonkers tax); IT-2105.9-I (2025) line 17 (penalty not computed if less than $300).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2026 Form IT-2105-I (Instructions for Form IT-2105) "Penalty for underpayment of estimated taxes" (at least 90% (66 2/3% for farmers and fishermen) of the 2026 return tax, or 90% of tax annualized).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2026 Form IT-2105-I (Instructions for Form IT-2105) (100% of the tax shown on the 2025 return; the 2025 return must be a full 12-month year; no penalty if no NY tax liability for the preceding full 12-month year).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'safe_harbor.high_agi_rule', value: {"threshold": 150000, "pct": 1.1},
    citation: '2026 Form IT-2105-I (Instructions for Form IT-2105): 110% of the 2025 tax if NYAGI (or MCTD net earnings) on that return is more than $150,000 ($75,000 if married filing separately for 2026). The key stores only the $150,000 threshold; the $75,000 MFS variant cannot be expressed. Does not apply to farmers/fishermen.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: '2026 Form IT-2105-I (Instructions for Form IT-2105) "When to pay" (April 15, June 15, September 15, 2026, and January 15, 2027).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2026 Form IT-2105-I (Instructions for Form IT-2105) "When to pay" (pay all with the first voucher or in four equal installments).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: '2026 Form IT-2105-I (Instructions for Form IT-2105) "Farmers and fishermen" (two-thirds or more of federal gross income for 2025 or 2026 from farming/fishing: one installment date, Jan 15; pay 66 2/3% of 2026 tax by Jan 15, 2027, or file the NYS return by March 1, 2027 and pay the total tax due). March 1, 2027 is a Monday; the printed date is stored.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: '2025 Form IT-2105.9-I "Penalty rate" (federal short-term rate plus 5.5 percentage points, not less than 7.5%, set quarterly by the Tax Department); Tax Law §685(c) (statute not read).',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'penalty.rate', value: 0.095,
    citation: 'Tax Law §685(c)(1) (estimated-tax addition at "the underpayment rate established under subsection (j) of §697", read via newyork.public.law); NYS Tax Department quarterly interest pages tax.ny.gov/pay/interest/2026/p2.htm, p3.htm, p4.htm: §697(j) underpayment rate 8.5% for 4/1/26-6/30/26, 9.5% for 7/1/26-9/30/26 and 10/1/26-12/31/26. 9.5% covers the largest part of the TY2026 window (Jul-Dec 2026); 4/16/26-6/30/26 accrues at 8.5% and the 1/1/27-4/15/27 rate is not yet published. CAUTION: single-rate key. Audit 2026-10-11: upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'credit_for_other_state', value: true,
    citation: '2025 Form IT-112-R-I (New York State Resident Credit): resident credit for income tax imposed by another state/political subdivision on income also taxed by NY.',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: '2025 Form IT-203-I line 45 "Income percentage" (NY-source income / federal AGI; tax computed as a resident then multiplied by the income percentage); 2025 IT-2105.9-I line 11d and Income percentage worksheet A; IT-2105-I line instructions ("Compute your estimated NYAGI as if you were a New York State resident").',
    status: 'verified',
  },
  {
    state: 'NY', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-12", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-04", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-12", "2027-02-15", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-02", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: 'N.Y. General Construction Law §24 public holidays (verbatim text re-read in audit 2026-10-11 via newyork.public.law, which reproduces nysenate.gov/legislation/laws/GCN/24 as updated Oct. 16, 2020; "if any of such days except Flag day is Sunday, the next day thereafter"; "each general election day"): New Year\'s Day; MLK Day (3rd Mon Jan); Lincoln\'s Birthday (Feb 12); Washington\'s Birthday (3rd Mon Feb); Memorial Day; Flag Day (2nd Sunday in June, always a Sunday); Juneteenth (June 19); July 4; Labor Day; Columbus Day (2nd Mon Oct); Veterans\' Day (Nov 11); Thanksgiving; Christmas; each general election day (Tuesday after first Monday in Nov, assumed every year incl. odd-year local general elections). A fixed-date holiday falling on Sunday moves to the next day; Saturday not moved. IT-2105-I says a due date on a Saturday, Sunday or legal holiday moves to the next regular workday. Calendar years 2025-2027 computed.',
    status: 'verified',
  },
];
