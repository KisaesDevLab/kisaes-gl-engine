// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// IL state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 3 research, 2026-10-11).
// Illinois farmers are exempt and its penalty is a flat 2%/10% of the underpayment; neither fits the key shapes
// (farmer.rule and penalty.rate are null). See features/tax-estimator/docs/reviews/phase2-batch3-sources.md.
export const IL_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'IL', year: 2025, key: 'has_income_tax',
    value: true,
    citation: "Illinois Income Tax Act flat 4.95% individual tax: Form IL-1040-ES (2026) (R-09/26) Estimated Tax Worksheet line 4 ('Multiply Line 3 by 4.95% (.0495)'); 2025 Form IL-2210 (R-12/25) Step 6 line 43",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'required_threshold',
    value: 1000,
    citation: "Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'Am I required to make estimated income tax payments?' (reasonably expect tax liability to EXCEED $1,000 after Illinois withholding, pass-through withholding and listed credits); Form IL-1040-ES (2026) (R-09/26) worksheet line 10 ('If $1,000 or less, stop'); 2025 Form IL-2210 (R-12/25) Step 2 lines 5 and 7 ('$1,000 or less')",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "2025 Form IL-2210 (R-12/25) Step 2 line 6 ('Multiply Column A, Line 3, by 90% (.9)') and line 7 (lesser of line 6 or prior-year line 3); Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf ('at least 90 percent of this year's tax or 100 percent of last year's tax in four equal timely installments')",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "2025 Form IL-2210 (R-12/25) Step 2 line 7 (lesser of 90% of current tax or Column B line 3 = 100% of prior-year tax); Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf and Form IL-1040-ES (2026) (R-09/26) ('100 percent of last year's tax')",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule: 2025 Form IL-2210 (R-12/25) Step 2 line 7 uses 100% of prior-year tax for all taxpayers; Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf mentions only 90%/100%",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf ('April 15; June 15; September 15; and January 15 of the following year ... unless the date falls on a weekend or holiday, then the payment will be due on the next business day'); June 15, 2025 was a Sunday -> Monday June 16, 2025. Rolled dates computed from the stated rule (the 2025 Form IL-1040-ES itself was not located).",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'four equal installments'; 2025 Form IL-2210 (R-12/25) Step 2 line 8 ('Divide the amount entered on Line 7 by four')",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'farmer.rule',
    value: null,
    citation: "Illinois farmers (at least two-thirds of total federal gross income from farming) are EXEMPT from estimated payments and the underpayment penalty (Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'Are there any exceptions'; Form IL-1040-ES (2026) (R-09/26) 'Are there any exceptions?'; 2025 IL-1040 Instructions Step 10 Line 34a). The farmer.rule shape ({ratio,current_pct,due_date,file_by}) cannot express a full exemption, so the value is null.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Illinois assesses a flat late-payment penalty on each underpaid installment, 2% of the underpayment if 1-30 days late and 10% if 31 or more days late (Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'What if I do not make my estimated payments'; 2025 Form IL-2210 (R-12/25) Step 4 penalty-rate table and Penalty Worksheet 1). This is not an annual rate, so the key set cannot express it; penalty.rate is null.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'penalty.rate',
    value: null,
    citation: "Illinois assesses a flat late-payment penalty on each underpaid installment, 2% of the underpayment if 1-30 days late and 10% if 31 or more days late (Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'What if I do not make my estimated payments'; 2025 Form IL-2210 (R-12/25) Step 4 penalty-rate table and Penalty Worksheet 1). This is not an annual rate, so the key set cannot express it; penalty.rate is null.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf (income tax paid to other states is a credit netted against the $1,000 threshold); Form IL-1040-ES (2026) (R-09/26) worksheet line 8; 2025 IL-1040 Instructions (Schedule CR, Credit for Tax Paid to Other States)",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "2025 IL-1040 Instructions ('Who must file' nonresident: Schedule NR Step 5 line 46 Illinois base income vs line 50 exemption allowance) with the flat 4.95% rate (2025 Form IL-2210 (R-12/25) Step 6 line 43): nonresident tax = 4.95% x Illinois-source net income",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-20", "2025-02-12", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25"],
    citation: "Illinois 80 Ill. Adm. Code 303.190 'Authorized Holidays' (State employees: New Year's Day, Martin Luther King Day, Lincoln's Birthday, Washington's Birthday, Memorial Day, Juneteenth, Independence Day, Labor Day, Columbus Day, Veterans' Day, Thanksgiving, Christmas, General Election Day, plus any day proclaimed), ilga.gov/ftp/JCAR/AdminCode/080/080003030B01900R.html. UNVERIFIED because IDOR's due-date note ('weekend or holiday') does not say which holidays it means, 5 ILCS 490/17 could not be fetched (ilga.gov certificate/error page), and weekday-observance shifts for Saturday/Sunday holidays were not confirmed; nominal dates only. None of the installment dates falls on or adjacent to these holidays. Calendar years 2025-2026.",
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'IL', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Form IL-1040-ES (2026) (R-09/26) Estimated Tax Worksheet line 4 ('Multiply Line 3 by 4.95% (.0495)')",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'required_threshold',
    value: 1000,
    citation: "Form IL-1040-ES (2026) (R-09/26) 'Am I required to make estimated income tax payments?' ('exceed $1,000 after subtracting your Illinois withholding, pass-through withholding, and tax credits') and worksheet line 10; Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Form IL-1040-ES (2026) (R-09/26) 'What if I do not make my payments?' ('if you pay at least 90 percent of this year's tax or at least 100 percent of last year's tax in four equal timely installments'); Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Form IL-1040-ES (2026) (R-09/26) 'What if I do not make my payments?' ('at least 100 percent of last year's tax'); Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule in Form IL-1040-ES (2026) (R-09/26) or Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf (only 90% current / 100% prior)",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Form IL-1040-ES (2026) (R-09/26) ('due on April 15, 2026; June 15, 2026; September 15, 2026; and January 15, 2027') and voucher; Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf weekend/holiday rule. None falls on a weekend (Wed/Mon/Tue/Fri).",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form IL-1040-ES (2026) (R-09/26) ('four equal installments'; worksheet line 11 'Divide Line 10 by 4')",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'farmer.rule',
    value: null,
    citation: "Illinois farmers (at least two-thirds of total federal gross income from farming) are EXEMPT from estimated payments and the underpayment penalty (Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'Are there any exceptions'; Form IL-1040-ES (2026) (R-09/26) 'Are there any exceptions?'; 2025 IL-1040 Instructions Step 10 Line 34a). The farmer.rule shape ({ratio,current_pct,due_date,file_by}) cannot express a full exemption, so the value is null.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "Illinois assesses a flat late-payment penalty on each underpaid installment, 2% of the underpayment if 1-30 days late and 10% if 31 or more days late (Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'What if I do not make my estimated payments'; 2025 Form IL-2210 (R-12/25) Step 4 penalty-rate table and Penalty Worksheet 1). This is not an annual rate, so the key set cannot express it; penalty.rate is null.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'penalty.rate',
    value: null,
    citation: "Illinois assesses a flat late-payment penalty on each underpaid installment, 2% of the underpayment if 1-30 days late and 10% if 31 or more days late (Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'What if I do not make my estimated payments'; 2025 Form IL-2210 (R-12/25) Step 4 penalty-rate table and Penalty Worksheet 1). This is not an annual rate, so the key set cannot express it; penalty.rate is null.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "Form IL-1040-ES (2026) (R-09/26) 'Am I required' credit list ('income tax paid to other states') and worksheet line 8; Illinois Publication 105 (R-12/25), 'Illinois Estimated Payments Requirements for Individuals and Businesses', tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "2025 IL-1040 Instructions ('Who must file' nonresident: Schedule NR Step 5 line 46 Illinois base income vs line 50 exemption allowance) with the flat 4.95% rate (2025 Form IL-2210 (R-12/25) Step 6 line 43): nonresident tax = 4.95% x Illinois-source net income; 2026 IL-1040/Schedule NR not yet published, carried forward",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-12", "2027-02-15", "2027-05-31", "2027-06-19", "2027-07-04", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "Illinois 80 Ill. Adm. Code 303.190 'Authorized Holidays' (State employees: New Year's Day, Martin Luther King Day, Lincoln's Birthday, Washington's Birthday, Memorial Day, Juneteenth, Independence Day, Labor Day, Columbus Day, Veterans' Day, Thanksgiving, Christmas, General Election Day, plus any day proclaimed), ilga.gov/ftp/JCAR/AdminCode/080/080003030B01900R.html. UNVERIFIED because IDOR's due-date note ('weekend or holiday') does not say which holidays it means, 5 ILCS 490/17 could not be fetched (ilga.gov certificate/error page), and weekday-observance shifts for Saturday/Sunday holidays were not confirmed; nominal dates only. None of the installment dates falls on or adjacent to these holidays. Calendar years 2026-2027.",
    status: 'unverified',
  },
];
