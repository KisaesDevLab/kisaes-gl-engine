// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// OH state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research batch 5, 2026-10-11).
// Every row cites the document it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch5-sources.md. Rows marked 'unverified'
// state the reason in the citation. The CPA signs off OH (D12).
export const OH_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'OH', year: 2025, key: 'has_income_tax', value: true,
    citation: 'R.C. 5747.02 (income tax on individuals); 2025 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) (tax brackets 0% / 2.75% / 3.125% on nonbusiness income; 3% on business income).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'required_threshold', value: 500,
    citation: 'R.C. 5747.09(B) (declaration required if estimated taxes less withholding are "more than five hundred dollars"); 2025 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) "Do I Have To Make Estimated Payments?" ("more than $500"). The key is "at least"; Ohio\'s test is strictly more than $500.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'R.C. 5747.09(A)(4)(a) and (E)(1) (90% of tax liability); 2025 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) worksheet line 10 (multiply by 90%).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'R.C. 5747.09(A)(4)(b) and (E)(2) (100% of prior-year liability, only if a return was filed and the prior year was a 12-month year); 2025 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) worksheet lines 9 and 11.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: R.C. 5747.09(A)(4)(b) and the IT 1040 ES worksheet use 100% of the prior-year liability for all taxpayers.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: '2025 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) "Estimated payments are due as follows" (1st quarter April 15, 2025; 2nd quarter June 16, 2025; 3rd quarter Sept. 15, 2025; 4th quarter Jan. 15, 2026); R.C. 5747.09(C) (15th day of the 4th, 6th, 9th month and 1st month of the next year). June 15, 2025 is a Sunday; the 2025 instructions print June 16.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'R.C. 5747.09(A)(4) ("required installment" = 25% of the lesser amount) and (C) (cumulative 22.5% / 45% / 67.5% / 90% of liability = four equal installments of 25% of the 90%); 2025 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) worksheet line 14 ("Multiply line 13 by 25%").',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 1.0, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: 'Ohio Adm. Code 5703-7-04(B)-(C) (read at codes.ohio.gov, eff. Nov 28, 2024: at least two-thirds of estimated gross income from farming/fishing and the same method used federally: either file the return and pay in full by the first day of the third month after year end, or make "payment in full of the Ohio individual income estimated tax" by the 15th day of the first month after year end and timely file); 2025 Ohio IT/SD 2210 "Farmers and Fishermen" (not subject to the 2210 interest penalty if "You file your return and make payment in full of the tax due on or before March 1, 2026" or "make payment in full of the tax due" by January [15] and file by April 15). The Department\'s form describes payment in full of the tax due, so current_pct = 1.0 (no 90% reduction). March 1, 2026 is a Sunday -> March 2, 2026 under R.C. 1.14. Audit 2026-10-11: corrected current_pct 0.9 -> 1.0 and upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: 'R.C. 5747.09(D) (interest penalty "at the rate per annum prescribed by section 5703.47"); R.C. 5703.47 (federal short-term rate for July, rounded, plus 3%, set by the Tax Commissioner on Oct 15 for the following calendar year).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'penalty.rate', value: 0.08,
    citation: '2025 Ohio IT/SD 2210 (statutory interest rate "8% for 2025 and 7% for 2026"). CAUTION: single-rate key; underpayment days in 2026 accrue at 7%.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'R.C. 5747.05(B) (credit for resident taxpayers for income tax paid to another state or DC; lesser of Ohio tax on that income or the other-state liability).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: 'R.C. 5747.05(A)(1) (nonresident credit equal to the Ohio tax on the portion of combined AGI and business income not allocable or apportionable to Ohio, i.e. Ohio tax computed on all income reduced proportionally; Ohio nonresident credit, Form IT NRC).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: 'R.C. 1.14 (legal holidays for computing the last day to act; codes.ohio.gov/ohio-revised-code/section-1.14): New Year\'s Day; MLK Day (3rd Mon Jan); Washington-Lincoln Day (3rd Mon Feb); Memorial Day; Juneteenth (June 19); July 4; Labor Day; Columbus Day (2nd Mon Oct); Nov 11; Thanksgiving; Dec 25; plus governor/President-appointed days (not listed). A holiday falling on Sunday moves to the next day; Saturday holidays are not moved. Calendar years 2025-2027 computed.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'OH', year: 2026, key: 'has_income_tax', value: true,
    citation: 'R.C. 5747.02 (income tax on individuals); 2026 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) (tax brackets 0% / 2.75% / 3.125% on nonbusiness income; 3% on business income).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'required_threshold', value: 500,
    citation: 'R.C. 5747.09(B) (declaration required if estimated taxes less withholding are "more than five hundred dollars"); 2026 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) "Do I Have To Make Estimated Payments?" ("more than $500"). The key is "at least"; Ohio\'s test is strictly more than $500.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'R.C. 5747.09(A)(4)(a) and (E)(1) (90% of tax liability); 2026 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) worksheet line 10 (multiply by 90%).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'R.C. 5747.09(A)(4)(b) and (E)(2) (100% of prior-year liability, only if a return was filed and the prior year was a 12-month year); 2026 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) worksheet lines 9 and 11.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: R.C. 5747.09(A)(4)(b) and the IT 1040 ES worksheet use 100% of the prior-year liability for all taxpayers.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: '2026 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) "Estimated payments are due as follows" (1st quarter April 15, 2026; 2nd quarter June 15, 2026; 3rd quarter Sept. 15, 2026; 4th quarter Jan. 15, 2027); R.C. 5747.09(C) (15th day of the 4th, 6th, 9th month and 1st month of the next year).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'R.C. 5747.09(A)(4) ("required installment" = 25% of the lesser amount) and (C) (cumulative 22.5% / 45% / 67.5% / 90% of liability = four equal installments of 25% of the 90%); 2026 Ohio Estimated Income Tax Instructions (IT 1040 ES worksheet) worksheet line 14 ("Multiply line 13 by 25%").',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 1.0, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: 'Ohio Adm. Code 5703-7-04(B)-(C) (read at codes.ohio.gov, eff. Nov 28, 2024: at least two-thirds of estimated gross income from farming/fishing and the same method used federally: either file the return and pay in full by the first day of the third month after year end, or make "payment in full of the Ohio individual income estimated tax" by the 15th day of the first month after year end and timely file); 2025 Ohio IT/SD 2210 "Farmers and Fishermen" (not subject to the 2210 interest penalty if "You file your return and make payment in full of the tax due on or before March 1, 2026" or "make payment in full of the tax due" by January [15] and file by April 15). The Department\'s form describes payment in full of the tax due, so current_pct = 1.0 (no 90% reduction). March 1, 2027 is a Monday. Audit 2026-10-11: corrected current_pct 0.9 -> 1.0 and upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: 'R.C. 5747.09(D) (interest penalty "at the rate per annum prescribed by section 5703.47"); R.C. 5703.47 (federal short-term rate for July, rounded, plus 3%, set by the Tax Commissioner on Oct 15 for the following calendar year).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: '2025 Ohio IT/SD 2210 (7% for 2026); 2026 certified rate 7% (Tax Commissioner certification under R.C. 5703.47). CAUTION: the rate for calendar 2027 days (TY2026 underpayments to April 15, 2027) is certified Oct 15, 2026 and was not read.',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'R.C. 5747.05(B) (credit for resident taxpayers for income tax paid to another state or DC; lesser of Ohio tax on that income or the other-state liability).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: 'R.C. 5747.05(A)(1) (nonresident credit equal to the Ohio tax on the portion of combined AGI and business income not allocable or apportionable to Ohio, i.e. Ohio tax computed on all income reduced proportionally; Ohio nonresident credit, Form IT NRC).',
    status: 'verified',
  },
  {
    state: 'OH', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: 'R.C. 1.14 (legal holidays for computing the last day to act; codes.ohio.gov/ohio-revised-code/section-1.14): New Year\'s Day; MLK Day (3rd Mon Jan); Washington-Lincoln Day (3rd Mon Feb); Memorial Day; Juneteenth (June 19); July 4; Labor Day; Columbus Day (2nd Mon Oct); Nov 11; Thanksgiving; Dec 25; plus governor/President-appointed days (not listed). A holiday falling on Sunday moves to the next day; Saturday holidays are not moved. Calendar years 2025-2027 computed.',
    status: 'verified',
  },
];
