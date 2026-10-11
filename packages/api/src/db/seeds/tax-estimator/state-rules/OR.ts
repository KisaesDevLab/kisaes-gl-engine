// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// OR state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research batch 5, 2026-10-11).
// Every row cites the document it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch5-sources.md. Rows marked 'unverified'
// state the reason in the citation. The CPA signs off OR (D12).
export const OR_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'OR', year: 2025, key: 'has_income_tax', value: true,
    citation: 'ORS chapter 316 (personal income tax); 2025 Publication OR-ESTIMATE (150-101-026) rate charts S and J (4.75%-9.9%).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'required_threshold', value: 1000,
    citation: '2025 Publication OR-ESTIMATE (150-101-026) "General information" (must make estimated payments if you expect to owe tax of $1,000 or more after all credits and withholding); "Interest on late installment payments" (difference more than $1,000).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2025 Publication OR-ESTIMATE (150-101-026) "Do I have to make Oregon estimated tax payments?" (90% of 2025 tax after all credits; or 90% of annualized income) and Method 1; ORS 316.585 (statute not read).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2025 Publication OR-ESTIMATE (150-101-026) (100% of the tax after all credits shown on your 2024 return, "safe harbor"; not available for a short-year 2024 return).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: 2025 Publication OR-ESTIMATE (150-101-026) states 90% / 100% prior with no income test.',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: '2025 Publication OR-ESTIMATE (150-101-026) "Estimated tax payment due dates" (calendar-year: April 15, June 16, September 15, 2025; January 15, 2026; a date on a Saturday, Sunday or Oregon legal holiday is due the next business day). June 15, 2025 is a Sunday; the publication prints June 16.',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2025 Publication OR-ESTIMATE (150-101-026) "Regular installments" (all at the first due date or four equal installments; Method 1 line 24 divides the annual payment by the number of installments).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.0, "due_date": "2026-04-15", "file_by": "2026-04-15"},
    citation: '2025 Publication OR-ESTIMATE (150-101-026) "Exception for farmers and commercial fishermen" (gross income from farming or fishing, including oyster farming, at least two-thirds of the gross income on the prior-year return or of estimated current-year gross income: "you don\'t have to make Oregon estimated tax payments"); 2025 Form OR-10 Instructions "Exception 1-Farmers and commercial fishermen" ("you don\'t have to pay underpayment interest"), both re-read in audit 2026-10-11. Farmers are genuinely exempt. Mapping: the key cannot express an exemption, so current_pct 0 (no required payment) with due_date/file_by = the return due date (2026-04-15); engine must treat current_pct 0 as no installments and no underpayment interest. Audit 2026-10-11: upgraded from unverified (exemption read; mapping documented).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: 'ORS 316.587(1) (interest at the rate established under ORS 305.220 on the amount underpaid); 2025 Form OR-10 Instructions "Interest rates".',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'penalty.rate', value: 0.09,
    citation: '2025 Form OR-10 Instructions, interest section: "For 2025, the annual interest rate is 9 percent. For 2026, the annual interest rate is 8 percent." CAUTION: single-rate key; underpayment days in 2026 accrue at 8%.',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'ORS 316.082 (resident credit for income tax imposed by another state on income also taxed by Oregon, limited by the ratio of other-state MAGI to total MAGI); read at oregon.public.law.',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: '2025 Publication OR-ESTIMATE (150-101-026) Estimated tax worksheet: line 6 "Estimated Oregon percentage" (Oregon-source income / federal income), "Nonresidents: Line 11 times line 6"; 2025 Form OR-10 Instructions (Oregon percentage from Form OR-40-N line 35).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-31"],
    citation: 'ORS 187.010(1)-(2) (legal holidays; oregon.public.law/statutes/ors_187.010, reproducing the 2021 text): each Sunday; New Year\'s Day; MLK Day (3rd Mon Jan); Presidents Day (3rd Mon Feb); Memorial Day; Juneteenth (June 19); July 4; Labor Day; Veterans Day (Nov 11); Thanksgiving; Christmas. A holiday on a Saturday is observed the preceding Friday, on a Sunday the following Monday (187.010(2)); 187.010(3): an act due on a holiday may be done the next business day. No Columbus Day. Dec 31, 2027 included (Jan 1, 2028 is a Saturday). Calendar years 2025-2027 computed.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'OR', year: 2026, key: 'has_income_tax', value: true,
    citation: 'ORS chapter 316 (personal income tax); 2026 Publication OR-ESTIMATE (150-101-026) rate charts S and J (4.75%-9.9%).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'required_threshold', value: 1000,
    citation: '2026 Publication OR-ESTIMATE (150-101-026) "General information" (must make estimated payments if you expect to owe tax of $1,000 or more after all credits and withholding); "Interest on late installment payments" (difference more than $1,000).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2026 Publication OR-ESTIMATE (150-101-026) "Do I have to make Oregon estimated tax payments?" (90% of 2026 tax after all credits; or 90% of annualized income) and Method 1; ORS 316.585 (statute not read).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2026 Publication OR-ESTIMATE (150-101-026) (100% of the tax after all credits shown on your 2025 return, "safe harbor"; not available for a short-year 2025 return).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: 2026 Publication OR-ESTIMATE (150-101-026) states 90% / 100% prior with no income test.',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: '2026 Publication OR-ESTIMATE (150-101-026) "Estimated tax payment due dates" (calendar-year: April 15, June 15, September 15, 2026; January 15, 2027; a date on a Saturday, Sunday or Oregon legal holiday is due the next business day).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2026 Publication OR-ESTIMATE (150-101-026) "Regular installments" (all at the first due date or four equal installments; Method 1 line 24 divides the annual payment by the number of installments).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.0, "due_date": "2027-04-15", "file_by": "2027-04-15"},
    citation: '2026 Publication OR-ESTIMATE (150-101-026) "Exception for farmers and commercial fishermen" (gross income from farming or fishing, including oyster farming, at least two-thirds of the gross income on the prior-year return or of estimated current-year gross income: "you don\'t have to make Oregon estimated tax payments"); 2025 Form OR-10 Instructions "Exception 1-Farmers and commercial fishermen" ("you don\'t have to pay underpayment interest"), both re-read in audit 2026-10-11. Farmers are genuinely exempt. Mapping: the key cannot express an exemption, so current_pct 0 (no required payment) with due_date/file_by = the return due date (2027-04-15); engine must treat current_pct 0 as no installments and no underpayment interest. Audit 2026-10-11: upgraded from unverified (exemption read; mapping documented).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: 'ORS 316.587(1) (interest at the rate established under ORS 305.220 on the amount underpaid); 2025 Form OR-10 Instructions "Interest rates".',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'penalty.rate', value: 0.08,
    citation: '2025 Form OR-10 Instructions: 8% for 2026 (days from Jan 1, 2026). CAUTION: the rate for calendar 2027 days (to April 15, 2027) had not been published at research time.',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'ORS 316.082 (resident credit for income tax imposed by another state on income also taxed by Oregon, limited by the ratio of other-state MAGI to total MAGI); read at oregon.public.law.',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: '2026 Publication OR-ESTIMATE (150-101-026) Estimated tax worksheet: line 6 "Estimated Oregon percentage" (Oregon-source income / federal income), "Nonresidents: Line 11 times line 6"; 2025 Form OR-10 Instructions (Oregon percentage from Form OR-40-N line 35).',
    status: 'verified',
  },
  {
    state: 'OR', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-31"],
    citation: 'ORS 187.010(1)-(2) (legal holidays; oregon.public.law/statutes/ors_187.010, reproducing the 2021 text): each Sunday; New Year\'s Day; MLK Day (3rd Mon Jan); Presidents Day (3rd Mon Feb); Memorial Day; Juneteenth (June 19); July 4; Labor Day; Veterans Day (Nov 11); Thanksgiving; Christmas. A holiday on a Saturday is observed the preceding Friday, on a Sunday the following Monday (187.010(2)); 187.010(3): an act due on a holiday may be done the next business day. No Columbus Day. Dec 31, 2027 included (Jan 1, 2028 is a Saturday). Calendar years 2025-2027 computed.',
    status: 'verified',
  },
];
