// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// NM state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research batch 5, 2026-10-11).
// Every row cites the document it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch5-sources.md. Rows marked 'unverified'
// state the reason in the citation. The CPA signs off NM (D12).
export const NM_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'NM', year: 2025, key: 'has_income_tax', value: true,
    citation: 'NMSA 1978 §7-2-12.2 as cited on the TRD Estimated Payments page ("Every individual who must file a New Mexico personal income tax return must pay estimated tax under Section 7-2-12.2 NMSA 1978"); 2025 PIT-1 Instructions (tax on net income).',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'required_threshold', value: 1000,
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) "Who must pay estimated taxes" (penalty applies unless "Your tax for the current year, less amounts withheld, is under $1,000"); NM TRD "Estimated Payments : Individuals" page (tax.newmexico.gov/individuals/file-your-taxes-overview/estimated-payments/, fetched 2026-10-11; vouchers/instructions "not tax year specific") (underpayment computed if the difference exceeds $1,000). Measured as tax less withholding; oil-and-gas withholding (7-3A) is excluded.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) "How much do you need to pay?" (required annual payment = lesser of 90% of the current-year return tax or 100% of the prior-year return tax); NM TRD "Estimated Payments : Individuals" page (tax.newmexico.gov/individuals/file-your-taxes-overview/estimated-payments/, fetched 2026-10-11; vouchers/instructions "not tax year specific").',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf): 100% of the prior-year return tax, only if a return was filed for a full 12-month prior year; also no penalty for a full-year resident who owed zero tax last year.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: 2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) and the TRD Estimated Payments page state only the 90% / 100% lesser-of test.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) "When are calendar-year ... payments due" (April 15, June 15, September 15, January 15 of the following year; if a due date is a Saturday, Sunday or state/national legal holiday the payment is timely on the next business day); NM TRD "Estimated Payments : Individuals" page (tax.newmexico.gov/individuals/file-your-taxes-overview/estimated-payments/, fetched 2026-10-11; vouchers/instructions "not tax year specific"). June 15, 2025 is a Sunday -> June 16, 2025.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) ("four installments of the required annual payment"); NM TRD "Estimated Payments : Individuals" page (tax.newmexico.gov/individuals/file-your-taxes-overview/estimated-payments/, fetched 2026-10-11; vouchers/instructions "not tax year specific") (quarterly installments).',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2026-01-15", "file_by": "2026-03-01"},
    citation: '2025 PIT-ES Instructions "Exception for farmers and ranchers" (at least 2/3 of gross income from farming/ranching this year or last: one payment of the required annual payment on or before January 15, or file and pay in full on or before March 1); Form RPD-41272 (2025) instruction 10 ("If you are a qualified farmer or rancher, enter 100% of the required annual payment on line 12, column d"; filed and paid in full by March 1 = no penalty) with lines 5-7 (required annual payment = lesser of 90% of current-year tax and 100% of prior-year tax). NM therefore uses 90% (not the federal 66 2/3%) for farmers despite calling the rule "identical to the federal rule"; current_pct 0.9 confirmed and the prior-year 100% alternative also applies. March 1 dates stored as printed (TY2025: Sunday). Audit 2026-10-11: upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'penalty.rate_source', value: "federal",
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) "Penalty for underpayment": "New Mexico calculates the penalty (in the form of interest) on underpayment of estimated tax at the same rate as interest on an underpayment of tax ... on a daily basis at the interest rate established by the U.S. Internal Revenue Code"; TRD publishes the quarterly rate at tax.newmexico.gov/.../penalty-interest-rates/ (page not read).',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'penalty.rate', value: null,
    citation: 'Not applicable: rate source is federal (IRC underpayment rate, announced quarterly), so no state rate is stored. Citation: 2025 PIT-ES Instructions "Penalty for underpayment or non-payment of estimated tax payments".',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'credit_for_other_state', value: true,
    citation: '2025 PIT-1 Instructions "LINE 20. Credit for Taxes Paid to Another State" (resident credit; requires the "Line 20. Worksheet for Computation of Allowable Credit for Taxes Paid to Other States by New Mexico Residents" and the other state\'s return; capped at NM tax liability); PIT-1 p.PIT-1-13 "Credit for Taxes Paid to Another State".',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: '2025 Schedule PIT-B (Allocation and Apportionment of Income) lines 11-14: line 12 = New Mexico income (Column 2) / total income (Column 1); line 13 = tax from the rate tables on PIT-1 line 17 (all net income); line 14 = line 12 x line 13, carried to PIT-1 line 18 (2025 PIT-1 Instructions "LINE 18" / "If You File Schedule PIT-B"). This is the ratio method. Audit 2026-10-11: corrected from `other` (unverified).',
    status: 'verified',
  },
  {
    state: 'NM', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-06-19", "2027-07-04", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-25", "2027-12-31"],
    citation: 'Form RPD-41272 (2025, Rev. 12/22/2025) instructions "Due dates": "The Department does observe Federal and State holidays ... If the due date falls on a Saturday, Sunday, or a Federal/State holiday the due date is the next business day." List = union of (1) federal legal public holidays, 5 U.S.C. §6103(a) (read at law.cornell.edu: New Year, MLK, Washington, Memorial, Juneteenth, July 4, Labor, Columbus, Veterans, Thanksgiving, Christmas; Saturday -> preceding Friday per §6103(b)(1), Sunday -> Monday per Executive Order 11582 (EO not read), incl. 2027-12-31 for Jan 1, 2028) and (2) the New Mexico State Personnel Board paid holiday schedules: SPO General Memorandum 2024-007 (2025: adds Fri Nov 28, 2025 "Presidents\' Day (Observed)") and General Memorandum 2025-015 (2026: Independence Day observed Fri July 3, Presidents\' Day observed Fri Nov 27, 2026). The 2027 state schedule is not yet published, so 2027 carries only federal dates (the likely Fri Nov 26, 2027 state day is omitted; it affects no TY2026 date). NMSA 1978 §12-5-2 still not readable (403). Audit 2026-10-11: replaced the researcher\'s bank-holiday list (which lacked the Friday-after-Thanksgiving state days and the Saturday->Friday observances) and upgraded from unverified.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'NM', year: 2026, key: 'has_income_tax', value: true,
    citation: 'NMSA 1978 §7-2-12.2 as cited on the TRD Estimated Payments page ("Every individual who must file a New Mexico personal income tax return must pay estimated tax under Section 7-2-12.2 NMSA 1978"); 2025 PIT-1 Instructions (tax on net income).',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'required_threshold', value: 1000,
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) "Who must pay estimated taxes" (penalty applies unless "Your tax for the current year, less amounts withheld, is under $1,000"); NM TRD "Estimated Payments : Individuals" page (tax.newmexico.gov/individuals/file-your-taxes-overview/estimated-payments/, fetched 2026-10-11; vouchers/instructions "not tax year specific") (underpayment computed if the difference exceeds $1,000). Measured as tax less withholding; oil-and-gas withholding (7-3A) is excluded.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) "How much do you need to pay?" (required annual payment = lesser of 90% of the current-year return tax or 100% of the prior-year return tax); NM TRD "Estimated Payments : Individuals" page (tax.newmexico.gov/individuals/file-your-taxes-overview/estimated-payments/, fetched 2026-10-11; vouchers/instructions "not tax year specific").',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf): 100% of the prior-year return tax, only if a return was filed for a full 12-month prior year; also no penalty for a full-year resident who owed zero tax last year.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: 2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) and the TRD Estimated Payments page state only the 90% / 100% lesser-of test.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) "When are calendar-year ... payments due" (April 15, June 15, September 15, January 15 of the following year; if a due date is a Saturday, Sunday or state/national legal holiday the payment is timely on the next business day); NM TRD "Estimated Payments : Individuals" page (tax.newmexico.gov/individuals/file-your-taxes-overview/estimated-payments/, fetched 2026-10-11; vouchers/instructions "not tax year specific"). None of these dates is a weekend/holiday.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) ("four installments of the required annual payment"); NM TRD "Estimated Payments : Individuals" page (tax.newmexico.gov/individuals/file-your-taxes-overview/estimated-payments/, fetched 2026-10-11; vouchers/instructions "not tax year specific") (quarterly installments).',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: '2025 PIT-ES Instructions "Exception for farmers and ranchers" (at least 2/3 of gross income from farming/ranching this year or last: one payment of the required annual payment on or before January 15, or file and pay in full on or before March 1); Form RPD-41272 (2025) instruction 10 ("If you are a qualified farmer or rancher, enter 100% of the required annual payment on line 12, column d"; filed and paid in full by March 1 = no penalty) with lines 5-7 (required annual payment = lesser of 90% of current-year tax and 100% of prior-year tax). NM therefore uses 90% (not the federal 66 2/3%) for farmers despite calling the rule "identical to the federal rule"; current_pct 0.9 confirmed and the prior-year 100% alternative also applies. March 1 dates stored as printed (TY2025: Sunday). Audit 2026-10-11: upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'penalty.rate_source', value: "federal",
    citation: '2025 PIT-ES Instructions (realfile.tax.newmexico.gov/2025pit-es-ins.pdf) "Penalty for underpayment": "New Mexico calculates the penalty (in the form of interest) on underpayment of estimated tax at the same rate as interest on an underpayment of tax ... on a daily basis at the interest rate established by the U.S. Internal Revenue Code"; TRD publishes the quarterly rate at tax.newmexico.gov/.../penalty-interest-rates/ (page not read).',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'penalty.rate', value: null,
    citation: 'Not applicable: rate source is federal (IRC underpayment rate, announced quarterly), so no state rate is stored. Citation: 2025 PIT-ES Instructions "Penalty for underpayment or non-payment of estimated tax payments".',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'credit_for_other_state', value: true,
    citation: '2025 PIT-1 Instructions "LINE 20. Credit for Taxes Paid to Another State" (resident credit; requires the "Line 20. Worksheet for Computation of Allowable Credit for Taxes Paid to Other States by New Mexico Residents" and the other state\'s return; capped at NM tax liability); PIT-1 p.PIT-1-13 "Credit for Taxes Paid to Another State".',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: '2025 Schedule PIT-B (Allocation and Apportionment of Income) lines 11-14: line 12 = New Mexico income (Column 2) / total income (Column 1); line 13 = tax from the rate tables on PIT-1 line 17 (all net income); line 14 = line 12 x line 13, carried to PIT-1 line 18 (2025 PIT-1 Instructions "LINE 18" / "If You File Schedule PIT-B"). This is the ratio method. Audit 2026-10-11: corrected from `other` (unverified).',
    status: 'verified',
  },
  {
    state: 'NM', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-06-18", "2027-06-19", "2027-07-04", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-25", "2027-12-31"],
    citation: 'Form RPD-41272 (2025, Rev. 12/22/2025) instructions "Due dates": "The Department does observe Federal and State holidays ... If the due date falls on a Saturday, Sunday, or a Federal/State holiday the due date is the next business day." List = union of (1) federal legal public holidays, 5 U.S.C. §6103(a) (read at law.cornell.edu: New Year, MLK, Washington, Memorial, Juneteenth, July 4, Labor, Columbus, Veterans, Thanksgiving, Christmas; Saturday -> preceding Friday per §6103(b)(1), Sunday -> Monday per Executive Order 11582 (EO not read), incl. 2027-12-31 for Jan 1, 2028) and (2) the New Mexico State Personnel Board paid holiday schedules: SPO General Memorandum 2024-007 (2025: adds Fri Nov 28, 2025 "Presidents\' Day (Observed)") and General Memorandum 2025-015 (2026: Independence Day observed Fri July 3, Presidents\' Day observed Fri Nov 27, 2026). The 2027 state schedule is not yet published, so 2027 carries only federal dates (the likely Fri Nov 26, 2027 state day is omitted; it affects no TY2026 date). NMSA 1978 §12-5-2 still not readable (403). Audit 2026-10-11: replaced the researcher\'s bank-holiday list (which lacked the Friday-after-Thanksgiving state days and the Saturday->Friday observances) and upgraded from unverified.',
    status: 'verified',
  },
];
