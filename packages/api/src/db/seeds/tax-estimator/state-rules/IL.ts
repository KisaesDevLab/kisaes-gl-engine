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
    citation: "2025 IL-1040 Instructions ('The Illinois income tax rate is 4.95 percent (.0495)'); 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 6 line 43; 2025 Schedule NR line 52",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'required_threshold',
    value: 1000,
    citation: "35 ILCS 5/803(a) (estimated tax required if it can reasonably be expected to be more than $1,000 for taxable years ending on or after December 31, 2019) and 5/803(b) (estimated tax = tax less amounts withheld or credited), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'Am I required to make estimated income tax payments?' (tax liability expected to EXCEED $1,000 after Illinois withholding, pass-through withholding and listed credits); 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 2 line 7 ('If Line 5 is $1,000 or less ... enter 0'; line 5 = tax after credits less withholding). Inexpressible extra exceptions: no penalty if not required to file an IL return for the prior year, or (individuals) zero prior-year liability for a 12-month year (35 ILCS 5/804(d); IL-2210 Instructions p.1); age 65+ permanently in a nursing home is exempt (IL-1040-ES).",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "35 ILCS 5/804(c)(1)(B)(i) (required annual payment = lesser of 90% of the tax shown on the return or ...), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 2 line 6 ('Multiply Column A, Line 3, by 90%') and line 7; Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "35 ILCS 5/804(c)(1)(B)(ii) (100% of the tax shown on the preceding year's return, only if a return showing a liability was filed for that year and it was a 12-month year; the 150% figure in (iii) applied only to installments due Feb 1, 2011 - Jan 31, 2012), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 2 line 7 (lesser of line 6 or Column B line 3 = prior-year tax); Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "None: 35 ILCS 5/804(c)(1)(B) has no income-based increase of the prior-year percentage (only the expired 150% rule for installments due Feb 1, 2011 - Jan 31, 2012), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 2 line 7 and 2025 IL-2210 Instructions (R-12/25) (.../currentyear/individual/il-2210-instr.pdf) line 7 note and Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf state only 90% current / 100% prior.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "35 ILCS 5/803(d) (installments due April 15, June 15, September 15 and January 15 of the following taxable year), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'When are my estimated payments due?' ('unless the date falls on a weekend or holiday, then the payment will be due on the next business day'); 2025 IL-2210 Instructions (R-12/25) (.../currentyear/individual/il-2210-instr.pdf) line 9a ('If this date falls on a weekend or holiday, use the next business day'); 5 ILCS 70/1.11. June 15, 2025 is a Sunday -> Monday June 16, 2025; April 15, 2025 (Tue), Sept 15, 2025 (Mon) and Jan 15, 2026 (Thu) are business days. The 2025 Form IL-1040-ES itself was not retrieved (prior-year URL 404); dates computed from the statute and IDOR's stated roll rule.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "35 ILCS 5/803(d) ('4 equal installments') and 5/804(c)(1)(A) (each required installment = 25% of the required annual payment), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 2 line 8 ('Divide the amount entered on Line 7 by four')",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0, "due_date": "2026-04-15", "file_by": "2026-04-15", "treatment": "exempt"},
    citation: "IL-1040-ES (2026) \"Are there any exceptions?\" (tax.illinois.gov, read 2026-10-12): \"You do not have to make estimated payments if you are ... a farmer. We consider you a farmer if at least two-thirds of your total federal gross income is from farming.\" 35 ILCS 5/803(a),(e). Farmers are EXEMPT (treatment exempt; current_pct 0; placeholder dates = return due date) (R5 M7). The 2025 IL-1040-ES is no longer posted; the exemption is statutory (803(a)) and unchanged.",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Illinois late-payment penalty for underpayment of estimated tax is set by state law: 35 ILCS 5/804(a) (penalty 'at the rate prescribed by Section 3-3 of the Uniform Penalty and Interest Act' on each required installment's underpayment), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Uniform Penalty and Interest Act 35 ILCS 735/3-3(b-25)(1) (applicable to returns due on or after January 1, 2024: 2% of any amount paid no later than 30 days after the due date, 10% of any amount paid later than 30 days after the due date), ilga.gov/legislation/ILCS/details?ActID=632&ChapterID=8&ChapAct=FullText; Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'What if I do not make my estimated payments'; 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 4 penalty-rate table (1-30 days .02; 31 or more .10) and Penalty Worksheet 1. ENGINE NOTE: this is NOT an annual interest-style rate. Per underpaid installment (IL-2210 Penalty Worksheet 1): penalty = 2% x amount paid 1-30 days after the installment due date + 10% x amount paid 31+ days late; any amount still unpaid (no payment applied) is charged 10% (IL-2210 Instructions, Column H). Payments apply to the earliest unpaid installment first (Pub 105). The engine must NOT fall back to the federal rate when penalty.rate is null for IL.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'penalty.rate',
    value: null,
    citation: "Illinois late-payment penalty for underpayment of estimated tax is set by state law: 35 ILCS 5/804(a) (penalty 'at the rate prescribed by Section 3-3 of the Uniform Penalty and Interest Act' on each required installment's underpayment), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Uniform Penalty and Interest Act 35 ILCS 735/3-3(b-25)(1) (applicable to returns due on or after January 1, 2024: 2% of any amount paid no later than 30 days after the due date, 10% of any amount paid later than 30 days after the due date), ilga.gov/legislation/ILCS/details?ActID=632&ChapterID=8&ChapAct=FullText; Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'What if I do not make my estimated payments'; 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 4 penalty-rate table (1-30 days .02; 31 or more .10) and Penalty Worksheet 1. The key holds an annual rate; IL's flat 2%/10% tiers cannot be expressed, so the value is null. ENGINE NOTE: this is NOT an annual interest-style rate. Per underpaid installment (IL-2210 Penalty Worksheet 1): penalty = 2% x amount paid 1-30 days after the installment due date + 10% x amount paid 31+ days late; any amount still unpaid (no payment applied) is charged 10% (IL-2210 Instructions, Column H). Payments apply to the earliest unpaid installment first (Pub 105). The engine must NOT fall back to the federal rate when penalty.rate is null for IL.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "2025 Schedule CR (R-12/25), Credit for Tax Paid to Other States (residents and part-year residents only; not nonresidents), tax.illinois.gov/.../currentyear/individual/il-1040-schedule-cr.pdf; 2025 IL-1040 Instructions Line 15; credit nets against the $1,000 threshold (Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf; Form IL-1040-ES (2026) (R-09/26), tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-es.pdf worksheet line 8)",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "2025 Schedule NR (R-12/25) Step 5 (tax.illinois.gov/.../currentyear/individual/il-1040-schedule-nr.pdf): line 46 Illinois base income (Illinois-allocated income only), line 48 ratio of Illinois base income to total base income used ONLY to prorate the exemption (line 50), line 52 = Illinois net income x 4.95%; statutory basis 35 ILCS 5/301(c) (nonresident items allocated to Illinois only per Sections 302-304), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText. Flat rate on Illinois-source income = sourced_flat.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-12", "2025-02-17", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25"],
    citation: "Corrected per R5 review m4 (CMS state holidays page + memo 11/18/2025: no Casimir Pulaski Day or Good Friday; day after Thanksgiving added; July 4, 2026 observed July 3; 2027 Juneteenth June 18, July 4 -> July 5, Christmas -> Dec 24); not re-read in this task. Previous citation: Illinois statutory legal holidays, 205 ILCS 630/17(a) (Promissory Note and Bank Holiday Act: Jan 1; 3rd Mon Jan; Feb 12; 3rd Mon Feb; 1st Mon Mar (Casimir Pulaski); Good Friday; last Mon May; June 19; July 4; 1st Mon Sep; 2nd Mon Oct; Nov 11; 4th Thu Nov; Dec 25; general-election days for the U.S. House (even years); days proclaimed by the Governor), ilga.gov/legislation/ILCS/details?ActID=1195&ChapterID=20&ChapAct=FullText, with 5 ILCS 490/60 (Lincoln's Birthday on a Sunday -> following Monday) and 5 ILCS 490/63 (Juneteenth on a Sunday -> following Monday; Saturday not moved), ilga.gov ActID=134. Due-date roll: 5 ILCS 70/1.11 (Statute on Statutes: a last day falling on Saturday, Sunday or 'a holiday as defined or fixed in any statute' is excluded, and so is a succeeding Saturday/Sunday/holiday), ilga.gov ActID=79; IDOR states the same rule (Pub 105 'weekend or holiday ... next business day'; 2025 IL-2210 Instructions line 9a; 2025 IL-1040 Instructions 'When must I file?'). No other statutory weekend shift; the day after Thanksgiving is NOT a statutory legal holiday (state-employee leave only). Dates computed from the statutes. Calendar years 2025-2026 (no general election in 2025; Nov 3, 2026 general election). No installment date of TY2025 falls on one of these holidays.",
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'IL', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Form IL-1040-ES (2026) (R-09/26), tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-es.pdf Estimated Tax Worksheet line 4 ('Multiply Line 3 by 4.95% (.0495)')",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'required_threshold',
    value: 1000,
    citation: "35 ILCS 5/803(a) (estimated tax required if it can reasonably be expected to be more than $1,000 for taxable years ending on or after December 31, 2019) and 5/803(b) (estimated tax = tax less amounts withheld or credited), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'Am I required to make estimated income tax payments?' (tax liability expected to EXCEED $1,000 after Illinois withholding, pass-through withholding and listed credits); Form IL-1040-ES (2026) (R-09/26), tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-es.pdf worksheet line 10 ('If $1,000 or less, stop'). Inexpressible extra exceptions: no penalty if not required to file an IL return for the prior year, or (individuals) zero prior-year liability for a 12-month year (35 ILCS 5/804(d); IL-2210 Instructions p.1); age 65+ permanently in a nursing home is exempt (IL-1040-ES).",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "35 ILCS 5/804(c)(1)(B)(i) (required annual payment = lesser of 90% of the tax shown on the return or ...), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Form IL-1040-ES (2026) (R-09/26), tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-es.pdf 'What if I do not make my payments?' (90 percent of this year's tax); Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "35 ILCS 5/804(c)(1)(B)(ii) (100% of the tax shown on the preceding year's return, only if a return showing a liability was filed for that year and it was a 12-month year; the 150% figure in (iii) applied only to installments due Feb 1, 2011 - Jan 31, 2012), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Form IL-1040-ES (2026) (R-09/26), tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-es.pdf ('at least 100 percent of last year's tax'); Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "None: 35 ILCS 5/804(c)(1)(B) has no income-based increase of the prior-year percentage (only the expired 150% rule for installments due Feb 1, 2011 - Jan 31, 2012), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Form IL-1040-ES (2026) (R-09/26), tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-es.pdf and Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf state only 90% current / 100% prior.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Form IL-1040-ES (2026) (R-09/26), tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-es.pdf 'When are my payments due?' ('April 15, 2026; June 15, 2026; September 15, 2026; and January 15, 2027') and voucher; 35 ILCS 5/803(d); none falls on a weekend or Illinois statutory holiday (Wed/Mon/Tue/Fri).",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "35 ILCS 5/803(d) ('4 equal installments') and 5/804(c)(1)(A) (each required installment = 25% of the required annual payment), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Form IL-1040-ES (2026) (R-09/26), tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-es.pdf worksheet line 11 ('Divide Line 10 by 4')",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0, "due_date": "2027-04-15", "file_by": "2027-04-15", "treatment": "exempt"},
    citation: "IL-1040-ES (2026) \"Are there any exceptions?\" (tax.illinois.gov, read 2026-10-12): \"You do not have to make estimated payments if you are ... a farmer. We consider you a farmer if at least two-thirds of your total federal gross income is from farming.\" 35 ILCS 5/803(a),(e). Farmers are EXEMPT (treatment exempt; current_pct 0; placeholder dates = return due date) (R5 M7).",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "Illinois late-payment penalty for underpayment of estimated tax is set by state law: 35 ILCS 5/804(a) (penalty 'at the rate prescribed by Section 3-3 of the Uniform Penalty and Interest Act' on each required installment's underpayment), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Uniform Penalty and Interest Act 35 ILCS 735/3-3(b-25)(1) (applicable to returns due on or after January 1, 2024: 2% of any amount paid no later than 30 days after the due date, 10% of any amount paid later than 30 days after the due date), ilga.gov/legislation/ILCS/details?ActID=632&ChapterID=8&ChapAct=FullText; Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'What if I do not make my estimated payments'; 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 4 penalty-rate table (1-30 days .02; 31 or more .10) and Penalty Worksheet 1. ENGINE NOTE: this is NOT an annual interest-style rate. Per underpaid installment (IL-2210 Penalty Worksheet 1): penalty = 2% x amount paid 1-30 days after the installment due date + 10% x amount paid 31+ days late; any amount still unpaid (no payment applied) is charged 10% (IL-2210 Instructions, Column H). Payments apply to the earliest unpaid installment first (Pub 105). The engine must NOT fall back to the federal rate when penalty.rate is null for IL.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'penalty.rate',
    value: null,
    citation: "Illinois late-payment penalty for underpayment of estimated tax is set by state law: 35 ILCS 5/804(a) (penalty 'at the rate prescribed by Section 3-3 of the Uniform Penalty and Interest Act' on each required installment's underpayment), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText; Uniform Penalty and Interest Act 35 ILCS 735/3-3(b-25)(1) (applicable to returns due on or after January 1, 2024: 2% of any amount paid no later than 30 days after the due date, 10% of any amount paid later than 30 days after the due date), ilga.gov/legislation/ILCS/details?ActID=632&ChapterID=8&ChapAct=FullText; Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf 'What if I do not make my estimated payments'; 2025 Form IL-2210 (R-12/25) (.../currentyear/individual/il-2210.pdf) Step 4 penalty-rate table (1-30 days .02; 31 or more .10) and Penalty Worksheet 1. The key holds an annual rate; IL's flat 2%/10% tiers cannot be expressed, so the value is null. ENGINE NOTE: this is NOT an annual interest-style rate. Per underpaid installment (IL-2210 Penalty Worksheet 1): penalty = 2% x amount paid 1-30 days after the installment due date + 10% x amount paid 31+ days late; any amount still unpaid (no payment applied) is charged 10% (IL-2210 Instructions, Column H). Payments apply to the earliest unpaid installment first (Pub 105). The engine must NOT fall back to the federal rate when penalty.rate is null for IL.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "2025 Schedule CR (R-12/25), Credit for Tax Paid to Other States (residents and part-year residents only; not nonresidents), tax.illinois.gov/.../currentyear/individual/il-1040-schedule-cr.pdf; 2025 IL-1040 Instructions Line 15; credit nets against the $1,000 threshold (Illinois Publication 105 (R-12/25), tax.illinois.gov/content/dam/soi/en/web/tax/research/publications/pubs/documents/pub-105.pdf; Form IL-1040-ES (2026) (R-09/26), tax.illinois.gov/content/dam/soi/en/web/tax/forms/incometax/documents/currentyear/individual/il-1040-es.pdf worksheet line 8); 2026 Schedule CR not yet published, rule unchanged in the 2026 IL-1040-ES credit list",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "2025 Schedule NR (R-12/25) Step 5 (tax.illinois.gov/.../currentyear/individual/il-1040-schedule-nr.pdf): line 46 Illinois base income (Illinois-allocated income only), line 48 ratio of Illinois base income to total base income used ONLY to prorate the exemption (line 50), line 52 = Illinois net income x 4.95%; statutory basis 35 ILCS 5/301(c) (nonresident items allocated to Illinois only per Sections 302-304), Illinois Income Tax Act full text, ilga.gov/legislation/ILCS/details?ActID=577&ChapterID=8&ChapAct=FullText. Flat rate on Illinois-source income = sourced_flat; 2026 Schedule NR not yet published but the statute is unchanged and the 2026 IL-1040-ES keeps the flat 4.95% rate.",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'holidays', value: ["2025-11-28", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-12", "2027-02-15", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-24"],
    citation: "Corrected per R5 review m4 (CMS state holidays page + memo 11/18/2025: no Casimir Pulaski Day or Good Friday; day after Thanksgiving added; July 4, 2026 observed July 3; 2027 Juneteenth June 18, July 4 -> July 5, Christmas -> Dec 24); not re-read in this task. Previous citation: Illinois statutory legal holidays, 205 ILCS 630/17(a) (Promissory Note and Bank Holiday Act: Jan 1; 3rd Mon Jan; Feb 12; 3rd Mon Feb; 1st Mon Mar (Casimir Pulaski); Good Friday; last Mon May; June 19; July 4; 1st Mon Sep; 2nd Mon Oct; Nov 11; 4th Thu Nov; Dec 25; general-election days for the U.S. House (even years); days proclaimed by the Governor), ilga.gov/legislation/ILCS/details?ActID=1195&ChapterID=20&ChapAct=FullText, with 5 ILCS 490/60 (Lincoln's Birthday on a Sunday -> following Monday) and 5 ILCS 490/63 (Juneteenth on a Sunday -> following Monday; Saturday not moved), ilga.gov ActID=134. Due-date roll: 5 ILCS 70/1.11 (Statute on Statutes: a last day falling on Saturday, Sunday or 'a holiday as defined or fixed in any statute' is excluded, and so is a succeeding Saturday/Sunday/holiday), ilga.gov ActID=79; IDOR states the same rule (Pub 105 'weekend or holiday ... next business day'; 2025 IL-2210 Instructions line 9a; 2025 IL-1040 Instructions 'When must I file?'). No other statutory weekend shift; the day after Thanksgiving is NOT a statutory legal holiday (state-employee leave only). Dates computed from the statutes. Calendar years 2026-2027 (no general election in 2027). No installment date of TY2026 falls on one of these holidays.",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'IL', year: 2025, key: 'threshold_comparison', value: "more_than",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md m1/D2: the requirement and penalty tests read \"more than\" the dollar threshold); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2025, key: 'penalty.method', value: "tiered_flat",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md D3: Illinois late-payment penalty is a tiered flat 2%/10% (35 ILCS 735/3-3), not a rate over time; penalty.rate stays null); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'IL', year: 2026, key: 'threshold_comparison', value: "more_than",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md m1/D2: the requirement and penalty tests read \"more than\" the dollar threshold); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2026, key: 'penalty.method', value: "tiered_flat",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md D3: Illinois late-payment penalty is a tiered flat 2%/10% (35 ILCS 735/3-3), not a rate over time; penalty.rate stays null); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'IL', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
