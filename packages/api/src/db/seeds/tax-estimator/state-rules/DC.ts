// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// DC state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11;
// re-audited against primary sources 2026-10-11). Every row cites the primary source it was read in;
// unverified rows say why. See features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const DC_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'DC', year: 2025, key: 'has_income_tax', value: true,
    citation: 'D.C. Code 47-1806.01 (taxable income = entire net income of every resident); D.C. Code 47-1812.08(i)(1) (declaration of estimated tax by residents)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'required_threshold', value: 100,
    citation: 'D.C. Code 47-1812.08(i)(1) (declaration required if non-withheld income will "result in a tax liability of more than $100"); D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(e)(1) (no interest if tax less timely credits/payments "is less than $100"); OTR 2025 D-40ES booklet (REV. 062024, .../attachments/2025_D40ES_Booklet_121824.pdf) "Who must file" ("expect to owe $100 or more"). Boundary at exactly $100 differs between sources (statute: more than / less than; booklet: $100 or more).',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(b)(1)(B)(i) (90% of the tax shown on the return for the taxable year); OTR Form D-2210 TY2025 (Revised 05/2025, otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2025_D-2210_021226.pdf) lines 1-4 and instructions; OTR 2025 D-40ES booklet (REV. 062024, .../attachments/2025_D40ES_Booklet_121824.pdf) ("At least 90% of your 2025 income tax")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'safe_harbor.prior_pct', value: 1.1,
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(b)(1)(B)(ii)(II) ("For tax years beginning after December 31, 2011, 110% of the tax shown on the return ... for the preceding taxable year" of 12 months) - universal, no AGI test; OTR Form D-2210 TY2025 (Revised 05/2025, otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2025_D-2210_021226.pdf) lines 1-4 and instructions (D-2210 adds that the filer must have been a full-year DC resident in the prior year); OTR 2025 D-40ES booklet (REV. 062024, .../attachments/2025_D40ES_Booklet_121824.pdf) ("110% of your 2024 DC income tax for a 12-month period")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(b)(1)(B)(ii)(II): 110% prior-year test applies to every individual for tax years after 2011; there is no separate high-AGI variant',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(a) (4 installments on the dates in 47-1812.08(i)(4): April 15, June 15, September 15, January 15); OTR 2025 D-40ES booklet (REV. 062024, .../attachments/2025_D40ES_Booklet_121824.pdf) "When are your vouchers due?" (Voucher 1-4 dates) and "If the due date falls on a Saturday, Sunday, or legal holiday, the voucher is due the next business day." June 15, 2025 is a Sunday -> 2025-06-16 (note: the 2025 D-2210 prints the unrolled 06/15/25 column heading).',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(b)(1)(B) (each installment = 25% of the required annual payment); OTR Form D-2210 TY2025 (Revised 05/2025, otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2025_D-2210_021226.pdf) line 6 ("Multiply Line 5 amount by 25%")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'farmer.rule', value: null,
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11) (full text: no farmer/fisherman provision; exceptions in (e) are de minimis, no prior-year liability, retirement/disability, casualty, death) and 47-1812.08(i) (no farmer provision); OTR Form D-2210 TY2025 (Revised 05/2025, otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2025_D-2210_021226.pdf) (no farmer rule)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(c)(1) (interest at the underpayment rate set forth in 47-4201); D.C. Code 47-4201(d)(2) (code.dccouncil.gov, read 2026-10-11) ("10% per year, compounded daily, beginning January 1, 2003")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'penalty.rate', value: 0.1,
    citation: 'D.C. Code 47-4201(d)(2) (10% per year, compounded daily); D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(c); OTR 2025 D-40ES booklet (REV. 062024, .../attachments/2025_D40ES_Booklet_121824.pdf) ("rate of 10% per year compounded daily"). CAUTION: daily compounding and 47-4203(c)(2)(B) ("an underpayment that is unpaid during part of a month shall be considered to be paid at the end of the month") are not captured by a simple annual rate; the TY2025 D-2210 line 10 uses fixed period factors .0175/.0265/.0351/.0259.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'D.C. Code 47-1806.04(a) (code.dccouncil.gov, read 2026-10-11) (resident credit for income tax paid to another state on income attributable to it, limited to the proportion of DC tax that the other-jurisdiction AGI bears to entire AGI)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'nonresident_method', value: 'other',
    citation: 'D.C. Code 47-1806.01 (code.dccouncil.gov, read 2026-10-11) (taxable income = entire net income of every resident and only that portion of a nonresident\'s income subject to tax under 47-1808.01 to 47-1808.06, i.e. the unincorporated business franchise tax); DC does not impose its individual income tax on nonresident wages, so none of ratio/sourced_flat applies.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-16', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    citation: 'D.C. Code 1-612.02(a) (code.dccouncil.gov, read 2026-10-11): New Year, MLK (3rd Mon Jan), Washington\'s Birthday (3rd Mon Feb), Memorial Day, Juneteenth (June 19), July 4, Labor Day, Indigenous Peoples\' Day (2nd Mon Oct), Veterans Day, Thanksgiving, Christmas, DC Emancipation Day (April 16); 1-612.02(b)(1) Saturday -> preceding Friday / Sunday -> following Monday (employee observance rule, included conservatively). 1-612.02(c) Inauguration Day (Jan 20, 2025) coincides with MLK Day 2025, already listed. Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'DC', year: 2026, key: 'has_income_tax', value: true,
    citation: 'D.C. Code 47-1806.01 (taxable income = entire net income of every resident); D.C. Code 47-1812.08(i)(1) (declaration of estimated tax by residents)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'required_threshold', value: 100,
    citation: 'D.C. Code 47-1812.08(i)(1) (declaration required if non-withheld income will "result in a tax liability of more than $100"); D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(e)(1) (no interest if tax less timely credits/payments "is less than $100"); OTR 2026 D-40ES booklet (REV. 03/2026, .../attachments/2026_D40ES_Book_wLinks04012026.pdf) "Who must file" ("expect to owe $100 or more"). Boundary at exactly $100 differs between sources (statute: more than / less than; booklet: $100 or more).',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(b)(1)(B)(i) (90% of the tax shown on the return for the taxable year); OTR Form D-2210 TY2025 (Revised 05/2025, otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2025_D-2210_021226.pdf) lines 1-4 (TY2026 D-2210 not yet published; statute governs); OTR 2026 D-40ES booklet (REV. 03/2026, .../attachments/2026_D40ES_Book_wLinks04012026.pdf) ("At least 90% of your 2026 income tax")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'safe_harbor.prior_pct', value: 1.1,
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(b)(1)(B)(ii)(II) ("For tax years beginning after December 31, 2011, 110% of the tax shown on the return ... for the preceding taxable year" of 12 months) - universal, no AGI test; OTR Form D-2210 TY2025 (Revised 05/2025, otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2025_D-2210_021226.pdf) lines 1-4 (TY2026 D-2210 not yet published; statute governs) (D-2210 adds that the filer must have been a full-year DC resident in the prior year); OTR 2026 D-40ES booklet (REV. 03/2026, .../attachments/2026_D40ES_Book_wLinks04012026.pdf) ("110% of your 2025 DC income tax for a 12-month period")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(b)(1)(B)(ii)(II): 110% prior-year test applies to every individual for tax years after 2011; there is no separate high-AGI variant',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(a) (4 installments on the dates in 47-1812.08(i)(4): April 15, June 15, September 15, January 15); OTR 2026 D-40ES booklet (REV. 03/2026, .../attachments/2026_D40ES_Book_wLinks04012026.pdf) "When are your vouchers due?" (Voucher 1-4 dates) and "If the due date falls on a Saturday, Sunday, or legal holiday, the voucher is due the next business day."',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(b)(1)(B) (each installment = 25% of the required annual payment); OTR Form D-2210 TY2025 (Revised 05/2025, otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2025_D-2210_021226.pdf) line 6 ("Multiply Line 5 amount by 25%")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'farmer.rule', value: null,
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11) (full text: no farmer/fisherman provision; exceptions in (e) are de minimis, no prior-year liability, retirement/disability, casualty, death) and 47-1812.08(i) (no farmer provision); OTR Form D-2210 TY2025 (Revised 05/2025, otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2025_D-2210_021226.pdf) (no farmer rule)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(c)(1) (interest at the underpayment rate set forth in 47-4201); D.C. Code 47-4201(d)(2) (code.dccouncil.gov, read 2026-10-11) ("10% per year, compounded daily, beginning January 1, 2003")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'penalty.rate', value: 0.1,
    citation: 'D.C. Code 47-4201(d)(2) (10% per year, compounded daily); D.C. Code 47-4203 (code.dccouncil.gov, read 2026-10-11)(c); OTR 2026 D-40ES booklet (REV. 03/2026, .../attachments/2026_D40ES_Book_wLinks04012026.pdf) ("rate of 10% per year compounded daily"). CAUTION: daily compounding and 47-4203(c)(2)(B) ("an underpayment that is unpaid during part of a month shall be considered to be paid at the end of the month") are not captured by a simple annual rate; the TY2025 D-2210 line 10 uses fixed period factors .0175/.0265/.0351/.0259.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'D.C. Code 47-1806.04(a) (code.dccouncil.gov, read 2026-10-11) (resident credit for income tax paid to another state on income attributable to it, limited to the proportion of DC tax that the other-jurisdiction AGI bears to entire AGI)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'nonresident_method', value: 'other',
    citation: 'D.C. Code 47-1806.01 (code.dccouncil.gov, read 2026-10-11) (taxable income = entire net income of every resident and only that portion of a nonresident\'s income subject to tax under 47-1808.01 to 47-1808.06, i.e. the unincorporated business franchise tax); DC does not impose its individual income tax on nonresident wages, so none of ratio/sourced_flat applies.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-16', '2027-05-31', '2027-06-18', '2027-06-19', '2027-07-04', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-25'],
    citation: 'D.C. Code 1-612.02(a) (code.dccouncil.gov, read 2026-10-11): New Year, MLK (3rd Mon Jan), Washington\'s Birthday (3rd Mon Feb), Memorial Day, Juneteenth (June 19), July 4, Labor Day, Indigenous Peoples\' Day (2nd Mon Oct), Veterans Day, Thanksgiving, Christmas, DC Emancipation Day (April 16); 1-612.02(b)(1) Saturday -> preceding Friday / Sunday -> following Monday (employee observance rule, included conservatively). Next Inauguration Day (1-612.02(c)) is Jan 20, 2029, outside this range. Calendar years 2026-2027.',
    status: 'verified',
  },
];
