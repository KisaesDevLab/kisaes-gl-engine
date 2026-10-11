// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// PA state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research batch 5, 2026-10-11).
// Every row cites the document it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch5-sources.md. Rows marked 'unverified'
// state the reason in the citation. The CPA signs off PA (D12).
export const PA_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'PA', year: 2025, key: 'has_income_tax', value: true,
    citation: '72 P.S. §7302 (3.07% flat rate; statute not read directly); 2025 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) (tax computed at 3.07% of taxable income, REV-414(I)).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'required_threshold', value: 338,
    citation: '2025 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Who must make estimated tax payments": expect to owe at least $338 ($11,000 of income not subject to employer withholding, at 3.07%) after withholding and credits; the threshold table steps $8,000 (2023) -> $9,500 (2024) -> $11,000 (2025) -> $14,000 (2026) -> $17,000 (2027) -> $20,000 (2028). Also the REV-1630A line 3 floor ($338 for 2025).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2025 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Safe harbor rules" (timely payments at least 90 percent of the actual tax due on income earned/received in each installment period) and "Who must make..." (90% of the tax to be shown on the 2025 return). Applied per installment period (annualized-style), not on the full-year tax.',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2025 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Safe harbor rules" #1 (payments at least current-year tax rate times net PA taxable income on the 2024 PA-40; not available if no prior return or not a full-year PA resident; and only if the tax rate is unchanged). Value 1.0 is applied to prior-year taxable income x current rate, not to prior-year tax.',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-income variant: 2025 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) safe harbor rules.',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: '2025 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Payment Due Dates Table" (Apr. 15, Jun. 15, Sep. 15, 2025; Jan. 15, 2026; "or the next business day if the due date falls on a Saturday, Sunday, or holiday"). June 15, 2025 is a Sunday -> June 16, 2025.',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2025 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) Payment Due Dates Table (25% / 25% / 25% / 25% when the requirement is met before April 1; 50/25/25, 75/25 and 100% for later starts).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: '2025 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Farmers" (at least two-thirds of gross income from farming: pay all estimated tax by Jan. 15, 2026, or file the 2025 PA return by March 2, 2026 and pay the total tax due); 2025 Form REV-1630A (farmers: 66.67% test at 0.6667; Section I line 1b uses 90% of tax; Jan 15 payment).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: 'REV-1611 (AD+) 11-25 "Interest Rate and Calculation Method for Title 72 Taxes" (state-set annual rate by calendar year); 2025 Form REV-1630A line 12 (0.000192 daily factor).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'penalty.rate', value: 0.07,
    citation: 'REV-1611 (AD+) 11-25, 2026 table: calendar years 2025 - 2026 = 7% (daily 0.000192), charged 1/1/25 - 12/31/26. Covers all TY2025 underpayment days (Apr 15, 2025 - Apr 15, 2026).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'credit_for_other_state', value: true,
    citation: '2025 PA-40 Instructions (resident credit for taxes paid to other states, PA Schedule G-L; "PA Schedule(s) G-L. If you are claiming a resident credit for taxes paid to other states").',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'nonresident_method', value: "sourced_flat",
    citation: '2025 PA-40 Instructions, "Nonresidents and Part-Year Residents" (N): "PA law taxes nonresidents on the income earned, received, or realized from Pennsylvania sources" at the flat 3.07% rate (no ratio of a full-return computation).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: 'UNVERIFIED (partly): 1 Pa.C.S. §1908 (read in audit 2026-10-11 at palegis.us) omits from a statutory period a last day falling "on Saturday or Sunday, or on any day made a legal holiday by the laws of this Commonwealth or of the United States", so every federal legal public holiday counts (5 U.S.C. §6103(a), read at law.cornell.edu: New Year\'s, MLK, Washington, Memorial, Juneteenth, July 4, Labor, Columbus, Veterans, Thanksgiving, Christmas; Sunday -> Monday). The Pennsylvania-only legal holidays (Legal Holiday Law of 1893, 44 P.S. §11; reportedly Good Friday, Flag Day, Election Day) still could not be read in a primary source; Good Friday is kept from secondary summaries (FindLaw), Flag Day and Election Day omitted. Evidence the Department does not treat Flag Day as a roll day: the 2026 REV-413 (I) Payment Due Dates Table prints Jun. 15, 2026, although June 14, 2026 is a Sunday. Saturday holidays are not moved to Friday. REV-413 (I): a due date on a Saturday, Sunday or holiday moves to the next business day. Calendar 2025-2027 computed.',
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'PA', year: 2026, key: 'has_income_tax', value: true,
    citation: '72 P.S. §7302 (3.07% flat rate; statute not read directly); 2026 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) (tax computed at 3.07% of taxable income, REV-414(I)).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'required_threshold', value: 430,
    citation: '2026 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Who must make estimated tax payments": expect to owe at least $430 ($14,000 of income not subject to employer withholding, at 3.07%) after withholding and credits; the threshold table steps $8,000 (2023) -> $9,500 (2024) -> $11,000 (2025) -> $14,000 (2026) -> $17,000 (2027) -> $20,000 (2028). Also the REV-1630A line 3 floor ($338 for 2025).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2026 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Safe harbor rules" (timely payments at least 90 percent of the actual tax due on income earned/received in each installment period) and "Who must make..." (90% of the tax to be shown on the 2026 return). Applied per installment period (annualized-style), not on the full-year tax.',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2026 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Safe harbor rules" #1 (payments at least current-year tax rate times net PA taxable income on the 2025 PA-40; not available if no prior return or not a full-year PA resident; and only if the tax rate is unchanged). Value 1.0 is applied to prior-year taxable income x current rate, not to prior-year tax.',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-income variant: 2026 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) safe harbor rules.',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: '2026 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Payment Due Dates Table" (Apr. 15, Jun. 15, Sep. 15, 2026; Jan. 15, 2027; "or the next business day if the due date falls on a Saturday, Sunday, or holiday").',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2026 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) Payment Due Dates Table (25% / 25% / 25% / 25% when the requirement is met before April 1; 50/25/25, 75/25 and 100% for later starts).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: '2026 REV-413 (I) Instructions for Estimating PA Personal Income Tax (Individuals Only) "Farmers" (at least two-thirds of gross income from farming: pay all estimated tax by Jan. 15, 2027, or file the 2026 PA return by March 1, 2027 and pay the total tax due); 2025 Form REV-1630A (farmers: 66.67% test at 0.6667; Section I line 1b uses 90% of tax; Jan 15 payment).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: 'REV-1611 (AD+) 11-25 "Interest Rate and Calculation Method for Title 72 Taxes" (state-set annual rate by calendar year); 2025 Form REV-1630A line 12 (0.000192 daily factor).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: 'REV-1611 (AD+) 11-25, 2026 table: calendar years 2025 - 2026 = 7% (daily 0.000192), charged 1/1/25 - 12/31/26. The calendar-2027 rate (days Jan 1-Apr 15, 2027 of a TY2026 underpayment) was not yet published.',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'credit_for_other_state', value: true,
    citation: '2025 PA-40 Instructions (resident credit for taxes paid to other states, PA Schedule G-L; "PA Schedule(s) G-L. If you are claiming a resident credit for taxes paid to other states").',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'nonresident_method', value: "sourced_flat",
    citation: '2025 PA-40 Instructions, "Nonresidents and Part-Year Residents" (N): "PA law taxes nonresidents on the income earned, received, or realized from Pennsylvania sources" at the flat 3.07% rate (no ratio of a full-return computation).',
    status: 'verified',
  },
  {
    state: 'PA', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: 'UNVERIFIED (partly): 1 Pa.C.S. §1908 (read in audit 2026-10-11 at palegis.us) omits from a statutory period a last day falling "on Saturday or Sunday, or on any day made a legal holiday by the laws of this Commonwealth or of the United States", so every federal legal public holiday counts (5 U.S.C. §6103(a), read at law.cornell.edu: New Year\'s, MLK, Washington, Memorial, Juneteenth, July 4, Labor, Columbus, Veterans, Thanksgiving, Christmas; Sunday -> Monday). The Pennsylvania-only legal holidays (Legal Holiday Law of 1893, 44 P.S. §11; reportedly Good Friday, Flag Day, Election Day) still could not be read in a primary source; Good Friday is kept from secondary summaries (FindLaw), Flag Day and Election Day omitted. Evidence the Department does not treat Flag Day as a roll day: the 2026 REV-413 (I) Payment Due Dates Table prints Jun. 15, 2026, although June 14, 2026 is a Sunday. Saturday holidays are not moved to Friday. REV-413 (I): a due date on a Saturday, Sunday or holiday moves to the next business day. Calendar 2025-2027 computed.',
    status: 'unverified',
  },
];
