// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// AL state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11;
// re-audited against primary sources 2026-10-11). Every row cites the primary source it was read in;
// unverified rows say why. See features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
// Statutory frame: Code of Alabama 40-18-80(a) adopts 26 U.S.C. 6654 wholesale except 6654(d)(2)(C)(iii)
// and 6654(f)(2), with $500 substituted for the 6654(e)(1) de minimis amount.
export const AL_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'AL', year: 2025, key: 'has_income_tax', value: true,
    citation: 'Alabama Form 40ES 2025 Instructions ("Who Must Pay Estimated Tax"; revenue.alabama.gov/wp-content/uploads/2025/02/25f40esinstr.pdf, read via Internet Archive capture 2025-07-16); Code of Alabama 40-18-80(a)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'required_threshold', value: 500,
    citation: 'Alabama Form 40ES 2025 Instructions, "General Rule" item 1 ("You expect to owe at least $500 in tax for 2025, after subtracting your withholding and credits") and worksheet line 11; Code of Alabama 40-18-80(a)(2) ($500 substituted for 26 U.S.C. 6654(e)(1)); Form 2210AL Instructions (2025) Part I line 6 ("If less than $500, you don\'t owe a penalty")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Alabama Form 40ES 2025 Instructions, "General Rule" item 2a ("90% of the tax to be shown on your 2025 tax return"); Form 2210AL (2025) Part I line 4 ("Multiply line 3 by 90% (.90)")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Alabama Form 40ES 2025 Instructions, "General Rule" item 2b ("100% of the tax shown on your 2024 tax return. Your 2024 tax return must cover all 12 months"); Form 2210AL Instructions (2025), "Who Must Pay the Underpayment Penalty" item 2',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'Alabama Form 40ES 2025 Instructions, "Special Rule for Higher Income Taxpayers" ("If your Alabama AGI for 2024 was more than $150,000 ($75,000 if your filing status for 2025 is Married Filing a Separate Return) substitute 110% for 100%"); Form 2210AL Instructions (2025) "Higher income taxpayers". MFS $75,000 threshold not expressible (single value stored).',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'Alabama Form 40ES 2025 Instructions, "Payment of Estimated Tax" (April 15, 2025, June 15, 2025, September 15, 2025 and January 15, 2026; "If the 15th falls on a Saturday, Sunday, or State holiday, the due date will then be considered the following business day"); Form 2210AL (2025) Part III column dates. June 15, 2025 is a Sunday -> 2025-06-16 (also Code of Alabama 1-1-4).',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Alabama Form 40ES 2025 Instructions ("equal installments"; voucher schedule 1/4, 1/3, 1/2, all of line 11); Form 2210AL Instructions (2025) Part III line 1 ("enter 25% (.25) of your Required Annual Payment ... on line 1, columns (a)-(d)")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'Alabama Form 40ES 2025 Instructions, "Farmers" (at least 2/3 of gross income from farming; pay on or before January 15, 2026; "if farmers file their tax return on or before March 1, 2026, and pay the total tax at that time, they need not file estimated tax"); Form 2210AL (2025) Part IV line 4 ("Multiply line 3 by 66 2/3% (0.667)") and Instructions (two-thirds of 2024 or 2025 gross income from farming or fishing); Form 40 Booklet 2025 "Estimated Tax Penalty" (file and pay by March 1, 2026). March 1, 2026 is a Sunday -> 2026-03-02 per Code of Alabama 1-1-4 (seed convention). Ratio stored just under 2/3.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Form 2210AL (2025) Part III line 11 and Part IV line 13 print a single annual rate (".07") for the whole period April 16, 2025 - April 15, 2026. Statutory basis is federal: Code of Alabama 40-18-80(a) adopts 26 U.S.C. 6654, whose 6654(a)(1) applies the 6621 underpayment rate; 40-1-44(a) also uses the 6621 rate. Stored as state 0.07 because the TY2025 form fixes the figure.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'penalty.rate', value: 0.07,
    citation: 'Form 2210AL (2025) Part III line 11 ("Underpayment X No. of days on line 10 X .07 / 365", period April 16, 2025 - April 15, 2026) and Part IV line 13 ("X 0.07"); Form 2210AL Instructions (2025) Part IV line 13. NOTE: the statute points to the quarterly 6621 rate (federal short-term + 3; azdor.gov shows that formula at 6% for April-June 2026), but the state form prints .07 for the full period.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'Code of Alabama 40-18-21(a) (resident credit for income tax actually paid to another state or territory, limited to the Alabama tax on that income); Alabama Form 40 Booklet 2025 ("Credit for Taxes Paid to Another State. You must complete Schedule CR"; available only to legal residents filing Form 40)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'nonresident_method', value: 'other',
    citation: 'Alabama Form 40NR Booklet 2025, page 1 line 10 ("divide the amount on line 9, Column C, by the amount on line 9, Column B, to determine the ratio of Alabama Adjusted total income"), line 13 ("The Standard Deduction must be prorated by the percentage on page 1, line 10") and prorated exemptions; the graduated 2%/4%/5% rates then apply to Alabama taxable income. Neither a ratio of full-return tax nor a flat rate on Alabama-source income, so "other".',
    status: 'verified',
  },
  {
    state: 'AL', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-28', '2025-05-26', '2025-06-02', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-27', '2026-05-25', '2026-06-01', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25'],
    citation: 'Code of Alabama 1-3-8(a)-(b) (alison.legislature.state.al.us: New Year; MLK/Robert E. Lee 3rd Mon Jan; Washington/Jefferson 3rd Mon Feb; Confederate Memorial Day 4th Mon Apr; Memorial Day; Jefferson Davis 1st Mon June; Juneteenth June 19 (added by Act 2025-303); July 4; Labor Day; Columbus/Fraternal/American Indian Heritage Day 2nd Mon Oct; Veterans Day; Thanksgiving as designated by the Governor; Christmas; Sunday -> Monday, Saturday -> Friday). Dates as printed on the State of Alabama 2025 Official State Holidays list (rsa-al.gov/about-rsa/holidays, Internet Archive capture 2025-10-30: no Juneteenth and no day after Thanksgiving in 2025) and 2026 list (current rsa-al.gov: includes June 19 and Nov 26-27). Mardi Gras (Baldwin/Mobile only) and Rosa L. Parks Day (commemoration only) omitted. Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'AL', year: 2026, key: 'has_income_tax', value: true,
    citation: 'Alabama Form 40ES 2026 Instructions ("Who Must Pay Estimated Tax"; revenue.alabama.gov/wp-content/uploads/2026/01/26f40esinstr.pdf); Code of Alabama 40-18-80(a)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'required_threshold', value: 500,
    citation: 'Alabama Form 40ES 2026 Instructions, "General Rule" item 1 ("You expect to owe at least $500 in tax for 2026, after subtracting your withholding and credits"); Code of Alabama 40-18-80(a)(2); Form 40 Booklet 2025 "Payment of Estimated Tax" ("Every individual who reasonably expects to owe at least $500 in tax in 2026 ...")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'Alabama Form 40ES 2026 Instructions, "General Rule" item 2a ("90% of the tax to be shown on your 2026 tax return")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'Alabama Form 40ES 2026 Instructions, "General Rule" item 2b ("100% of the tax shown on your 2025 tax return. Your 2025 tax return must cover all 12 months")',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: 'Alabama Form 40ES 2026 Instructions, "Special Rule for Higher Income Taxpayers" (Alabama AGI for 2025 more than $150,000, or $75,000 if married filing separately for 2026, substitute 110% for 100%). MFS $75,000 threshold not expressible.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'Alabama Form 40ES 2026 Instructions, "Payment of Estimated Tax" (April 15, 2026, June 15, 2026, September 15, 2026 and January 15, 2027; roll to next business day on Saturday, Sunday or State holiday). All four dates are business days.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'Alabama Form 40ES 2026 Instructions, "Payment of Estimated Tax" ("equal installments"); voucher table (1/4, 1/3, 1/2, all of line 11)',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'Alabama Form 40ES 2026 Instructions, "Farmers" (at least 2/3 of gross income from farming; pay on or before January 15, 2027; file by March 1, 2027 and pay total tax -> no estimates); Code of Alabama 40-18-80(a) adopting 26 U.S.C. 6654(i) (66 2/3% required payment; 2/3 of current- or prior-year gross income); Form 2210AL (2025) Part IV line 4 (66 2/3%). March 1, 2027 is a Monday.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'penalty.rate_source', value: 'federal',
    citation: 'Code of Alabama 40-18-80(a) ("Individuals shall pay estimated income tax in accordance with 26 U.S.C. 6654") -> 26 U.S.C. 6654(a)(1) ("the underpayment rate established under section 6621"); Code of Alabama 40-1-44(a) (interest "computed based on the underpayment rate established by the Secretary of the Treasury under ... 26 U.S.C. 6621"). The TY2026 Form 2210AL is not yet published; the TY2025 form printed a single rate (.07) equal to the then-current 6621 rate. ENGINE NOTE: when Alabama publishes the 2026 Form 2210AL it may again print one flat rate for the whole period.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'penalty.rate', value: null,
    citation: 'Null because penalty.rate_source = federal (26 U.S.C. 6621 underpayment rate via Code of Alabama 40-18-80(a)); the engine should apply the quarterly federal 6621 underpayment rate (federal rates for 2026 not re-read in this audit). Form 2210AL (2026) not yet published.',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'Code of Alabama 40-18-21(a) (current text, alison.legislature.state.al.us: resident credit for income tax actually paid to another state or territory, limited to the Alabama tax on that income; no sunset); Form 40 Booklet 2025 Schedule CR instructions',
    status: 'verified',
  },
  {
    state: 'AL', year: 2026, key: 'nonresident_method', value: 'other',
    citation: 'UNVERIFIED for TY2026: the 2026 Form 40NR booklet is not published. Alabama Form 40NR Booklet 2025 (line 10 Alabama income ratio; line 13 standard deduction "must be prorated by the percentage on page 1, line 10"; prorated exemptions; graduated rates on Alabama taxable income) - neither a full-return ratio nor a flat rate.',
    status: 'unverified',
  },
  {
    state: 'AL', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-27', '2026-05-25', '2026-06-01', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-26', '2027-05-31', '2027-06-07', '2027-06-18', '2027-06-19', '2027-07-04', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-11-26', '2027-12-24', '2027-12-25'],
    citation: 'PARTLY UNVERIFIED (2027 day after Thanksgiving): 2026 dates as printed on the State of Alabama 2026 Official State Holidays list (rsa-al.gov/about-rsa/holidays); 2027 dates computed from Code of Alabama 1-3-8(a)-(b) (read; Saturday -> preceding Friday, Sunday -> following Monday). Friday Nov 26, 2027 assumes the Governor again designates the day after Thanksgiving as in 2026 (1-3-8(a)(12) "as designated by the Governor"; it was not designated in 2025). No official 2027 list retrieved. Mardi Gras and Parks Day omitted. Calendar years 2026-2027.',
    status: 'unverified',
  },
];
