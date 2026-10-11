// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// ID state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 3 research, 2026-10-11).
// IDAHO DOES NOT REQUIRE INDIVIDUAL ESTIMATED PAYMENTS; several rows are modeling placeholders (see citations and
// features/tax-estimator/docs/reviews/phase2-batch3-sources.md).
export const ID_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'ID', year: 2025, key: 'has_income_tax',
    value: true,
    citation: "Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf ('Effective January 1, 2025, the individual income tax rate is 5.3%'); Idaho Code 63-3024 flat rate on Idaho taxable income",
    status: 'verified',
  },
  {
    state: 'ID', year: 2025, key: 'required_threshold',
    value: 0,
    citation: "MODELING PLACEHOLDER: Idaho does not require individuals to make estimated payments (Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf, 'Idaho doesn't require estimated tax payments. You can prepay at any time ... or mail your payment with Form 51'); Idaho Code 63-3036A (estimated tax) applies only to corporations. The key set cannot express 'not required'. Threshold 0 is used so the engine can still compute voluntary Form 51 prepayments; the tax year 2025 Form 51 (Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/) is a voluntary voucher ('Make estimated payments for tax year 2026'). RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.8,
    citation: "Not an estimated-tax safe harbor: the only percentages Idaho publishes are the filing-extension payment tests in Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/ worksheet lines 1-7 (lesser of 100% of prior-year tax or 80% of current-year tax). MODELING PLACEHOLDER: Idaho does not require individuals to make estimated payments (Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf, 'Idaho doesn't require estimated tax payments. You can prepay at any time ... or mail your payment with Form 51'); Idaho Code 63-3036A (estimated tax) applies only to corporations. The key set cannot express 'not required'. The 80%/100% test is Idaho Code 63-3033(a) (automatic six-month filing extension if 'at least eighty percent (80%) of the total tax due ... or the total tax due on the income tax return for the prior year' is paid by the unextended due date; 63-3033(f): otherwise 2% per month penalty on the balance from the original due date). RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Same extension payment test as safe_harbor.current_pct (Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/ worksheet line 1 and line 7, 100% of 2024 tax). Not an underpayment safe harbor; Idaho assesses no individual underpayment penalty. MODELING PLACEHOLDER: Idaho does not require individuals to make estimated payments (Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf, 'Idaho doesn't require estimated tax payments. You can prepay at any time ... or mail your payment with Form 51'); Idaho Code 63-3036A (estimated tax) applies only to corporations. The key set cannot express 'not required'. Idaho Code 63-3033(a) extension test (100% of prior-year total tax). RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule: Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/ worksheet uses 80%/100% with no income test",
    status: 'verified',
  },
  {
    state: 'ID', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Federal-style placeholder dates. Idaho law fixes no individual installment dates; the Form 51 voucher (Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/) carries none. Idaho Code 63-3036A(b) adopts the IRC dates for CORPORATE estimates only. June 15, 2025 is a Sunday -> June 16. RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Placeholder equal installments; Idaho prescribes none for individuals. MODELING PLACEHOLDER: Idaho does not require individuals to make estimated payments (Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf, 'Idaho doesn't require estimated tax payments. You can prepay at any time ... or mail your payment with Form 51'); Idaho Code 63-3036A (estimated tax) applies only to corporations. The key set cannot express 'not required'. RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2025, key: 'farmer.rule',
    value: null,
    citation: "Idaho has no individual estimated-tax requirement and therefore no farmer/fisherman estimated-tax rule: Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf ('Idaho doesn't require estimated tax payments'); Idaho Code 63-3036 (farmers) concerns only farm-employer wage withholding. Re-read 2026-10-11: Idaho Code 63-3036 is 'State withholding tax for farmers' (farmer-employer wage withholding).",
    status: 'verified',
  },
  {
    state: 'ID', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Idaho charges interest (not an estimated-tax penalty) on tax unpaid after the original due date: Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf ('original due date of the return until paid at the rate of 6% per year (rate effective for 2026)'); tax.idaho.gov interest-rates page (2024 6%, 2025 6%, 2026 6%, 2027 6%). Interest, not a penalty, and charged on the unpaid balance after the return due date rather than per installment; closest available mapping. Idaho Code 63-3046 (read 2026-10-11) imposes no addition for underpaying estimated tax by individuals; only the 63-3033(f) 2%/month extension-payment penalty and 63-3046(c) late-filing/late-payment penalties exist, all measured from the return due date.",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2025, key: 'penalty.rate',
    value: 0.06,
    citation: "Idaho charges interest (not an estimated-tax penalty) on tax unpaid after the original due date: Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf ('original due date of the return until paid at the rate of 6% per year (rate effective for 2026)'); tax.idaho.gov interest-rates page (2024 6%, 2025 6%, 2026 6%, 2027 6%). Rate re-read 2026-10-11 on tax.idaho.gov/online-services/compliance/penalty-and-interest/interest-rates/ (2025 6%, 2026 6%, 2027 6%); 2025 booklet line 52 ('The rate for 2026 is 6%'). Value is a placeholder mapping (interest after the return due date), kept unverified.",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf 'Line 21 Income Tax Paid to Other States' and Form 39R/39NR (credit for tax paid to another state, enclose other state's return)",
    status: 'verified',
  },
  {
    state: 'ID', year: 2025, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "CORRECTED 2026-10-11 (was 'ratio'). Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf Form 43 (EFO00091 03-02-2026): line 37 larger of itemized or standard deduction; line 38 'Idaho percentage. Divide line 31, Column B, by line 31, Column A'; line 39 'Multiply amount on line 37 by the percentage on line 38' (the ratio prorates the DEDUCTION, not the tax); line 41 'Idaho taxable income. Subtract lines 39 and 40 from line 31, Column B' (Idaho-source income); line 42 tax from the worksheet (5.3% above the $4,811/$9,622 zero bracket) on that Idaho taxable income. Idaho Code 63-3026A(1): nonresident Idaho taxable income 'includes only those components ... derived from or related to sources within Idaho'. Same pattern as GA/AZ/KY seeded as sourced_flat; prorated-deduction and zero-bracket mechanics are not captured by the enum.",
    status: 'verified',
  },
  {
    state: 'ID', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25"],
    citation: "Idaho Code 73-108 (legislature.idaho.gov Title 73 Ch 1): Jan 1; 3rd Mon Jan; 3rd Mon Feb; last Mon May; Jul 4; 1st Mon Sep; 2nd Mon Oct; Nov 11; 4th Thu Nov; Dec 25; a Saturday holiday is observed the preceding Friday and a Sunday holiday the following Monday. Dates computed from the statute for calendar years 2025-2026. Statute re-read 2026-10-11 at legislature.idaho.gov/statutesrules/idstat/title73/t73ch1/sect73-108/ (list and Saturday->Friday / Sunday->Monday observance confirmed; 'Every Sunday' and proclaimed days also holidays).",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'ID', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf ('Effective January 1, 2025, the individual income tax rate is 5.3%'); Idaho Code 63-3024 flat rate on Idaho taxable income",
    status: 'verified',
  },
  {
    state: 'ID', year: 2026, key: 'required_threshold',
    value: 0,
    citation: "MODELING PLACEHOLDER: Idaho does not require individuals to make estimated payments (Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf, 'Idaho doesn't require estimated tax payments. You can prepay at any time ... or mail your payment with Form 51'); Idaho Code 63-3036A (estimated tax) applies only to corporations. The key set cannot express 'not required'. Threshold 0 is used so the engine can still compute voluntary Form 51 prepayments; the tax year 2026 Form 51 (Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/) is a voluntary voucher ('Make estimated payments for tax year 2026'). RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.8,
    citation: "Not an estimated-tax safe harbor: the only percentages Idaho publishes are the filing-extension payment tests in Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/ worksheet lines 1-7 (lesser of 100% of prior-year tax or 80% of current-year tax). MODELING PLACEHOLDER: Idaho does not require individuals to make estimated payments (Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf, 'Idaho doesn't require estimated tax payments. You can prepay at any time ... or mail your payment with Form 51'); Idaho Code 63-3036A (estimated tax) applies only to corporations. The key set cannot express 'not required'. The 80%/100% test is Idaho Code 63-3033(a) (automatic six-month filing extension if 'at least eighty percent (80%) of the total tax due ... or the total tax due on the income tax return for the prior year' is paid by the unextended due date; 63-3033(f): otherwise 2% per month penalty on the balance from the original due date). RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Same extension payment test as safe_harbor.current_pct (Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/ worksheet line 1 and line 7, 100% of 2024 tax). Not an underpayment safe harbor; Idaho assesses no individual underpayment penalty. MODELING PLACEHOLDER: Idaho does not require individuals to make estimated payments (Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf, 'Idaho doesn't require estimated tax payments. You can prepay at any time ... or mail your payment with Form 51'); Idaho Code 63-3036A (estimated tax) applies only to corporations. The key set cannot express 'not required'. Idaho Code 63-3033(a) extension test (100% of prior-year total tax). RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule: Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/ worksheet uses 80%/100% with no income test",
    status: 'verified',
  },
  {
    state: 'ID', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Federal-style placeholder dates. Idaho law fixes no individual installment dates; the Form 51 voucher (Idaho Form 51 voucher (EFO00092, 09-18-2025), tax.idaho.gov/document-mngr/forms_EFO00092/) carries none. Idaho Code 63-3036A(b) adopts the IRC dates for CORPORATE estimates only.  RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Placeholder equal installments; Idaho prescribes none for individuals. MODELING PLACEHOLDER: Idaho does not require individuals to make estimated payments (Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf, 'Idaho doesn't require estimated tax payments. You can prepay at any time ... or mail your payment with Form 51'); Idaho Code 63-3036A (estimated tax) applies only to corporations. The key set cannot express 'not required'. RE-AUDITED 2026-10-11 against primary sources, conclusion confirmed: tax.idaho.gov/taxes/income-tax/withholding/help/ ('Idaho doesn't require estimated tax payments from individuals, but you can make payments at any time'); Idaho Code 63-3036A(a) (read at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3036a/: 'Any corporation subject to this chapter which is required to make a payment of estimated taxes to the internal revenue service and will have an Idaho income tax liability of five hundred dollars ($500) or more shall pay ... estimated taxes'), the $500 threshold is corporate-only; IDAPA 35.01.01 Rules 820-825 (adminrules.idaho.gov/rules/current/35/350101.pdf) govern only 'Corporate Estimated Payments'; Idaho Code 63-3046 contains no individual estimated-tax underpayment addition; 63-3036 is farm-employer withholding and 63-3029B is the capital investment credit (neither concerns individual estimates).",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2026, key: 'farmer.rule',
    value: null,
    citation: "Idaho has no individual estimated-tax requirement and therefore no farmer/fisherman estimated-tax rule: Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf ('Idaho doesn't require estimated tax payments'); Idaho Code 63-3036 (farmers) concerns only farm-employer wage withholding. Re-read 2026-10-11: Idaho Code 63-3036 is 'State withholding tax for farmers' (farmer-employer wage withholding).",
    status: 'verified',
  },
  {
    state: 'ID', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "Idaho charges interest (not an estimated-tax penalty) on tax unpaid after the original due date: Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf ('original due date of the return until paid at the rate of 6% per year (rate effective for 2026)'); tax.idaho.gov interest-rates page (2024 6%, 2025 6%, 2026 6%, 2027 6%). Interest, not a penalty, and charged on the unpaid balance after the return due date rather than per installment; closest available mapping. Idaho Code 63-3046 (read 2026-10-11) imposes no addition for underpaying estimated tax by individuals; only the 63-3033(f) 2%/month extension-payment penalty and 63-3046(c) late-filing/late-payment penalties exist, all measured from the return due date.",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2026, key: 'penalty.rate',
    value: 0.06,
    citation: "Idaho charges interest (not an estimated-tax penalty) on tax unpaid after the original due date: Idaho 2025 Individual Income Tax booklet (EIN00046, rev. 03-02-2026), tax.idaho.gov/wp-content/uploads/forms/EIN00046/EIN00046_03-02-2026.pdf ('original due date of the return until paid at the rate of 6% per year (rate effective for 2026)'); tax.idaho.gov interest-rates page (2024 6%, 2025 6%, 2026 6%, 2027 6%). Rate re-read 2026-10-11 on tax.idaho.gov/online-services/compliance/penalty-and-interest/interest-rates/ (2025 6%, 2026 6%, 2027 6%); 2025 booklet line 52 ('The rate for 2026 is 6%'). Value is a placeholder mapping (interest after the return due date), kept unverified.",
    status: 'unverified',
  },
  {
    state: 'ID', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "Idaho Code 63-3029(1) (read 2026-10-11 at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3029/): 'A resident individual shall be allowed a credit against the tax otherwise due under this chapter for the amount of any income tax imposed on the individual ... by another state on income derived from sources therein while domiciled in Idaho'; claimed on 2025 Form 40 line 21 / Form 39R. Statute not year-specific; 2026 booklet not yet published.",
    status: 'verified',
  },
  {
    state: 'ID', year: 2026, key: 'nonresident_method',
    value: "sourced_flat",
    citation: "CORRECTED 2026-10-11 (was 'ratio'). Idaho Code 63-3026A(1) (read 2026-10-11 at legislature.idaho.gov/statutesrules/idstat/title63/t63ch30/sect63-3026a/): nonresident 'Idaho taxable income' 'includes only those components of Idaho taxable income as computed for a resident which are derived from or related to sources within Idaho'; deductions prorated per 63-3026A(4) (2025 Form 43 lines 37-41: deduction x Idaho percentage, subtracted from Idaho-source income; flat-rate tax on the result). Statute not year-specific; 2026 Form 43 not yet published. Prorated-deduction and zero-bracket mechanics are not captured by the enum.",
    status: 'verified',
  },
  {
    state: 'ID', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24"],
    citation: "Idaho Code 73-108 (legislature.idaho.gov Title 73 Ch 1): Jan 1; 3rd Mon Jan; 3rd Mon Feb; last Mon May; Jul 4; 1st Mon Sep; 2nd Mon Oct; Nov 11; 4th Thu Nov; Dec 25; a Saturday holiday is observed the preceding Friday and a Sunday holiday the following Monday. Dates computed from the statute for calendar years 2026-2027. Statute re-read 2026-10-11 at legislature.idaho.gov/statutesrules/idstat/title73/t73ch1/sect73-108/ (list and Saturday->Friday / Sunday->Monday observance confirmed; 'Every Sunday' and proclaimed days also holidays).",
    status: 'verified',
  },
];
