// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// NC state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research batch 5, 2026-10-11).
// Every row cites the document it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch5-sources.md. Rows marked 'unverified'
// state the reason in the citation. The CPA signs off NC (D12).
export const NC_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'NC', year: 2025, key: 'has_income_tax', value: true,
    citation: 'G.S. 105-153.7 (flat individual income tax; statute not read directly); 2025 Form D-422 Part I line 1 ("North Carolina income tax (From 2025 Form D-400, Line 15)"); NC-40 instructions.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'required_threshold', value: 1000,
    citation: '2025 Form D-422 (Rev. web 12-25) "Who Must Pay Underpayment Interest" / Part I: estimated payments expected when tax due on the return, reduced by tax withheld and credits, will be $1,000 or more (NC-40 "Who Must Make Estimated Income Tax Payments"); D-422 exception: tax minus credits and NC withholding less than $1,000 (Part I line 6).',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2025 Form D-422 (Rev. web 12-25) "Who Must Pay Underpayment Interest" / Part I: 90% of the current-year tax (66 2/3% for farmers/fishermen); NC-40 "Interest for Failure to Pay"; G.S. 105-163.15(d) as referenced on D-422.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2025 Form D-422 (Rev. web 12-25) "Who Must Pay Underpayment Interest" / Part I: 100% of the previous year\'s tax if that return was for a 12-month year and a return was filed (NC-40); D-422 Part I line 7-8 (required annual payment = smaller of line 4 or line 7).',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: D-422 (2025) Part I line 8 and NC-40 use 100% of the prior-year tax for all taxpayers.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: 'NC-40 "When To Pay" (April 15, June 15, September 15 and January 15 of the following year; when a due date falls on a Saturday, Sunday or holiday the payment is due the next business day). D-422 (2025) prints 6/15/25; June 15, 2025 is a Sunday -> June 16, 2025.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'NC-40 "Steps for Preparing" step (3) (enter one-fourth of the amount on Line 11 of the worksheet per payment); D-422 line 16 ("Divide Line 8 by 4"); NC-40: each installment equals 25% of the lesser amount.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-01"},
    citation: 'NC-40 "Farmers and Fishermen" (at least two-thirds of estimated gross income from farming/commercial fishing: pay at any time on or before January 15; or file Form D-400 and pay the total tax on or before March 1); D-422 (2025) exception and line 4 (66 2/3%). March 1, 2026 is a Sunday; the printed date is stored.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: 'G.S. 105-241.21 (interest rate set by the Secretary of Revenue twice a year; rate not less than 5% nor more than 16%) per NCDOR Interest Overview; 2025 Form D-422 line 26 uses a state rate (.07).',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'penalty.rate', value: 0.07,
    citation: '2025 Form D-422 Part III Section B line 26 ("Underpayment x days x .07 / 365", period April 15, 2025 - April 15, 2026) and Part II line 13 (.04655).',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'G.S. 105-153.9 (effective for taxable years beginning on or after Jan 1, 2023: tax credit for income taxes paid to other states by individuals), read at ncleg.gov; Form D-400TC.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: '2025 Form D-400 Schedule PN, Part C "Part-Year Residents and Nonresidents Taxable Percentage" (line 24 = line 22 / line 23; percentage of total income from all sources subject to NC tax, applied on Form D-400 line 13); ncdor.gov "Individual Income Filing Requirements" (nonresidents and part-year residents).',
    status: 'verified',
  },
  {
    state: 'NC', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-03-25", "2025-04-12", "2025-04-16", "2025-04-18", "2025-05-10", "2025-05-20", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-09-11", "2025-10-02", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-03-25", "2026-04-03", "2026-04-13", "2026-04-16", "2026-05-11", "2026-05-20", "2026-05-25", "2026-06-19", "2026-07-03", "2026-07-04", "2026-09-07", "2026-09-11", "2026-09-21", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-01-19", "2027-02-15", "2027-03-25", "2027-03-26", "2027-04-12", "2027-04-16", "2027-05-10", "2027-05-20", "2027-05-31", "2027-06-18", "2027-06-19", "2027-07-04", "2027-07-05", "2027-09-06", "2027-09-11", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-25", "2027-12-31"],
    citation: 'NCDOR Directive TA-16-1 (Apr 12, 2016, ncdor.gov, read in audit 2026-10-11): G.S. 105-263(a) makes IRC §§7502 and 7503 govern timeliness, so a "legal holiday" is a District of Columbia legal holiday (the Directive\'s worked example rolls an April 15 due date for DC Emancipation Day) plus a statewide legal holiday in North Carolina; tax payments due on a Saturday, Sunday or legal holiday are timely on the next business day. List = union of (1) federal/DC legal holidays (New Year, MLK, Washington, DC Emancipation Day Apr 16, Memorial, Juneteenth, July 4, Labor, Columbus, Veterans, Thanksgiving, Christmas; 2025-01-20 is also Inauguration Day; Saturday holidays observed the Friday before, Sunday the Monday after, incl. 2027-12-31 for Jan 1, 2028) and (2) G.S. 103-4(a) legal public holidays (read at ncleg.gov: adds Jan 19 R.E. Lee, Mar 25 Greek Independence, Apr 12 Halifax Resolves, May 10 Confederate Memorial, May 20 Mecklenburg Declaration, Good Friday, Sept 11 First Responders Day, Yom Kippur, election Tuesday in general-election years; 103-4(b) Sunday -> Monday). Yom Kippur dates (2025-10-02, 2026-09-21, 2027-10-11) are from the Jewish calendar. NC-40 "When To Pay": a Saturday/Sunday/holiday due date moves to the next business day. Calendar 2025-2027 computed. Audit 2026-10-11 added the federal/DC dates (Emancipation Day, Juneteenth, Friday/Monday observances); the researcher\'s G.S. 103-4-only list missed them.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'NC', year: 2026, key: 'has_income_tax', value: true,
    citation: 'G.S. 105-153.7 (flat individual income tax; statute not read directly); 2025 Form D-422 Part I line 1 ("North Carolina income tax (From 2025 Form D-400, Line 15)"); NC-40 instructions.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'required_threshold', value: 1000,
    citation: 'Form NC-40 Individual Estimated Income Tax instructions (web 7-25, not tax-year specific): estimated payments expected when tax due on the return, reduced by tax withheld and credits, will be $1,000 or more (NC-40 "Who Must Make Estimated Income Tax Payments"); D-422 exception: tax minus credits and NC withholding less than $1,000 (Part I line 6).',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Form NC-40 Individual Estimated Income Tax instructions (web 7-25, not tax-year specific): 90% of the current-year tax (66 2/3% for farmers/fishermen); NC-40 "Interest for Failure to Pay"; G.S. 105-163.15(d) as referenced on D-422.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Form NC-40 Individual Estimated Income Tax instructions (web 7-25, not tax-year specific): 100% of the previous year\'s tax if that return was for a 12-month year and a return was filed (NC-40); D-422 Part I line 7-8 (required annual payment = smaller of line 4 or line 7).',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: D-422 (2025) Part I line 8 and NC-40 use 100% of the prior-year tax for all taxpayers.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: 'NC-40 "When To Pay" (April 15, June 15, September 15 and January 15 of the following year; when a due date falls on a Saturday, Sunday or holiday the payment is due the next business day). None of the 2026-27 dates is a weekend/NC holiday.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'NC-40 "Steps for Preparing" step (3) (enter one-fourth of the amount on Line 11 of the worksheet per payment); D-422 line 16 ("Divide Line 8 by 4"); NC-40: each installment equals 25% of the lesser amount.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: 'NC-40 "Farmers and Fishermen" (at least two-thirds of estimated gross income from farming/commercial fishing: pay at any time on or before January 15; or file Form D-400 and pay the total tax on or before March 1); D-422 (2025) exception and line 4 (66 2/3%). March 1, 2027 is a Monday; the printed date is stored.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: 'G.S. 105-241.21 (interest rate set by the Secretary of Revenue twice a year; rate not less than 5% nor more than 16%) per NCDOR Interest Overview; 2025 Form D-422 line 26 uses a state rate (.07).',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: 'NCDOR "Interest Rate" page (ncdor.gov/taxes-forms/interest-rate, read in audit 2026-10-11; G.S. 105-241.21): 7% for July 1, 2026 through December 31, 2026 and 7% for January 1, 2025 through December 31, 2026; NCDOR memo (Oct. 2025) 7% for Jan-Jun 2026. 7% covers Apr 16-Dec 31, 2026, the largest part of the TY2026 window; the Jan 1-Apr 15, 2027 rate is set by Dec 1, 2026 and is unknown. Rate applies to D-422 underpayment interest (2025 D-422 line 26 uses .07). Audit 2026-10-11: upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'G.S. 105-153.9 (effective for taxable years beginning on or after Jan 1, 2023: tax credit for income taxes paid to other states by individuals), read at ncleg.gov; Form D-400TC.',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: '2025 Form D-400 Schedule PN, Part C "Part-Year Residents and Nonresidents Taxable Percentage" (line 24 = line 22 / line 23; percentage of total income from all sources subject to NC tax, applied on Form D-400 line 13); ncdor.gov "Individual Income Filing Requirements" (nonresidents and part-year residents).',
    status: 'verified',
  },
  {
    state: 'NC', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-03-25", "2025-04-12", "2025-04-16", "2025-04-18", "2025-05-10", "2025-05-20", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-09-11", "2025-10-02", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-03-25", "2026-04-03", "2026-04-13", "2026-04-16", "2026-05-11", "2026-05-20", "2026-05-25", "2026-06-19", "2026-07-03", "2026-07-04", "2026-09-07", "2026-09-11", "2026-09-21", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-01-19", "2027-02-15", "2027-03-25", "2027-03-26", "2027-04-12", "2027-04-16", "2027-05-10", "2027-05-20", "2027-05-31", "2027-06-18", "2027-06-19", "2027-07-04", "2027-07-05", "2027-09-06", "2027-09-11", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-25", "2027-12-31"],
    citation: 'NCDOR Directive TA-16-1 (Apr 12, 2016, ncdor.gov, read in audit 2026-10-11): G.S. 105-263(a) makes IRC §§7502 and 7503 govern timeliness, so a "legal holiday" is a District of Columbia legal holiday (the Directive\'s worked example rolls an April 15 due date for DC Emancipation Day) plus a statewide legal holiday in North Carolina; tax payments due on a Saturday, Sunday or legal holiday are timely on the next business day. List = union of (1) federal/DC legal holidays (New Year, MLK, Washington, DC Emancipation Day Apr 16, Memorial, Juneteenth, July 4, Labor, Columbus, Veterans, Thanksgiving, Christmas; 2025-01-20 is also Inauguration Day; Saturday holidays observed the Friday before, Sunday the Monday after, incl. 2027-12-31 for Jan 1, 2028) and (2) G.S. 103-4(a) legal public holidays (read at ncleg.gov: adds Jan 19 R.E. Lee, Mar 25 Greek Independence, Apr 12 Halifax Resolves, May 10 Confederate Memorial, May 20 Mecklenburg Declaration, Good Friday, Sept 11 First Responders Day, Yom Kippur, election Tuesday in general-election years; 103-4(b) Sunday -> Monday). Yom Kippur dates (2025-10-02, 2026-09-21, 2027-10-11) are from the Jewish calendar. NC-40 "When To Pay": a Saturday/Sunday/holiday due date moves to the next business day. Calendar 2025-2027 computed. Audit 2026-10-11 added the federal/DC dates (Emancipation Day, Juneteenth, Friday/Monday observances); the researcher\'s G.S. 103-4-only list missed them.',
    status: 'verified',
  },
];
