// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// UT state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 6 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch6-sources.md. The CPA signs off UT (D12).
// Utah does NOT require quarterly estimated payments from individuals (audited 2026-10-11 against
// the 2025 TC-40 Instructions, Pub 58, TC-546/TC-547 and Utah Code 59-10-514/516). The only rule is a
// single prepayment test at the original return due date; installments/threshold/penalty rows map it
// (one 100% installment on the return due date, threshold 0, 24%/yr extension penalty). See
// features/tax-estimator/docs/reviews/phase2-audit-batches4-6.md.
// Sources: 2025 TC-40 Instructions, Form TC-546 (Rev. 10/26), Pub 58 (Rev. 11/25), TC-40B,
// incometax.utah.gov Extensions and Prepayments, Utah Code §63G-1-301 (three versions).
export const UT_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'UT', year: 2025, key: 'has_income_tax', value: true,
    citation: "2025 TC-40 Instructions (Utah individual income tax return TC-40, tax line 27)",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'required_threshold', value: 0,
    citation: "AUDITED 2026-10-11: Utah has NO individual estimated-tax (quarterly installment) requirement. 2025 TC-40 Instructions p.4 \"Utah does not require quarterly estimated tax payments. You can prepay at any time at tap.utah.gov, or by mailing your payment with form TC-546\"; Pub 58 (Rev. 11/25) \"Underpayment Penalties\" lists quarterly-payment penalties only for corporation, insurance and severance taxes; Form TC-547 (Rev. 10/26) is only a return payment coupon (\"Do not use this return payment coupon to prepay future individual income taxes. Use form TC-546\"); there is no Utah Code 59-10-107 estimated-tax section (le.utah.gov returns no such section). The only prepayment rule is Utah Code 59-10-516(2)(b)-(3) (effective 5/5/2021): no extension-period penalty under 59-1-401 if, on or before the return due date in 59-10-514, the taxpayer pays the lesser of 90% of current-year tax or 100% of prior-year tax. MAPPING into the key set: 0 = no dollar floor: 59-10-516(2)(b) applies to every individual taxpayer with no minimum, and Form TC-546 (Rev. 10/26) worksheet line 8 (\"If greater than zero ... send coupon with payment\") has no threshold.",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "2025 TC-40 Instructions, \"Prepayment Requirements for Filing Extension\" (prepay \"90 percent of your 2025 tax due (TC-40, line 27 plus line 30)\"); Pub 58 (Rev. 11/25) \"Insufficient Prepayment (Extension Penalty)\"",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "2025 TC-40 Instructions, Prepayment Requirements for Filing Extension (\"100 percent of your 2024 tax liability\"); Pub 58 (Rev. 11/25) \"Insufficient Prepayment\"",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: 2025 TC-40 Instructions and Pub 58 state only the 90% current-year / 100% prior-year tests",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'installments.due_dates', value: ["2026-04-15"],
    citation: "AUDITED 2026-10-11: Utah has NO individual estimated-tax (quarterly installment) requirement. 2025 TC-40 Instructions p.4 \"Utah does not require quarterly estimated tax payments. You can prepay at any time at tap.utah.gov, or by mailing your payment with form TC-546\"; Pub 58 (Rev. 11/25) \"Underpayment Penalties\" lists quarterly-payment penalties only for corporation, insurance and severance taxes; Form TC-547 (Rev. 10/26) is only a return payment coupon (\"Do not use this return payment coupon to prepay future individual income taxes. Use form TC-546\"); there is no Utah Code 59-10-107 estimated-tax section (le.utah.gov returns no such section). The only prepayment rule is Utah Code 59-10-516(2)(b)-(3) (effective 5/5/2021): no extension-period penalty under 59-1-401 if, on or before the return due date in 59-10-514, the taxpayer pays the lesser of 90% of current-year tax or 100% of prior-year tax. MAPPING into the key set: one \"installment\" on the original return due date, April 15, 2026 (TC-40 Instructions 2025 p.4 \"by April 15, 2026, if you file on a calendar year basis\"). Utah Code 59-10-514(2): tax is payable \"before the due date for filing the return, without regard to any extension\". The engine must NOT schedule four quarterly Utah vouchers.",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'installments.pcts', value: [1.0],
    citation: "AUDITED 2026-10-11: Utah has NO individual estimated-tax (quarterly installment) requirement. 2025 TC-40 Instructions p.4 \"Utah does not require quarterly estimated tax payments. You can prepay at any time at tap.utah.gov, or by mailing your payment with form TC-546\"; Pub 58 (Rev. 11/25) \"Underpayment Penalties\" lists quarterly-payment penalties only for corporation, insurance and severance taxes; Form TC-547 (Rev. 10/26) is only a return payment coupon (\"Do not use this return payment coupon to prepay future individual income taxes. Use form TC-546\"); there is no Utah Code 59-10-107 estimated-tax section (le.utah.gov returns no such section). The only prepayment rule is Utah Code 59-10-516(2)(b)-(3) (effective 5/5/2021): no extension-period penalty under 59-1-401 if, on or before the return due date in 59-10-514, the taxpayer pays the lesser of 90% of current-year tax or 100% of prior-year tax. MAPPING into the key set: 100% of the required prepayment (lesser of 90% current / 100% prior, 59-10-516(2)(b)) is measured once, at the original return due date. Form TC-546 (Rev. 10/26) worksheet \"Pay the amount on line 8 on or before the return due date\".",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'farmer.rule', value: null,
    citation: "No farmer/fisherman rule: Utah Code 59-10-516 (effective 5/5/2021) has no farmer variation of the 90%/100% prepayment test, Pub 58 (Rev. 11/25) and Form TC-546 (Rev. 10/26) state none, and Utah has no individual estimated-tax installments for a farmer exception to modify (2025 TC-40 Instructions \"Utah does not require quarterly estimated tax payments\").",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "Pub 58 (Rev. 11/25) \"Insufficient Prepayment (Extension Penalty)\" and \"Interest Rates\" (Utah-set rate = federal short-term rate + 2 points, Utah Code §59-1-402); 2025 TC-40 Instructions line 40",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'penalty.rate', value: 0.24,
    citation: "AUDITED 2026-10-11: Utah has NO individual estimated-tax (quarterly installment) requirement. 2025 TC-40 Instructions p.4 \"Utah does not require quarterly estimated tax payments. You can prepay at any time at tap.utah.gov, or by mailing your payment with form TC-546\"; Pub 58 (Rev. 11/25) \"Underpayment Penalties\" lists quarterly-payment penalties only for corporation, insurance and severance taxes; Form TC-547 (Rev. 10/26) is only a return payment coupon (\"Do not use this return payment coupon to prepay future individual income taxes. Use form TC-546\"); there is no Utah Code 59-10-107 estimated-tax section (le.utah.gov returns no such section). The only prepayment rule is Utah Code 59-10-516(2)(b)-(3) (effective 5/5/2021): no extension-period penalty under 59-1-401 if, on or before the return due date in 59-10-514, the taxpayer pays the lesser of 90% of current-year tax or 100% of prior-year tax. MAPPING into the key set: 0.24 = the insufficient-prepayment (extension) penalty: Pub 58 (Rev. 11/25) \"(underpayment) x .24 x (number of days outstanding) / 365 ... 2 percent rate per month up to a maximum of six months, or 12 percent (annual 24 percent)\", assessed only until the return is filed or the extension expires; Form TC-546 (Rev. 10/26) \"a penalty equal to 2 percent of the unpaid tax for each month of the extension period\". If the return is filed by the original due date unpaid, the 59-1-401 late-payment penalty applies instead (Pub 58 \"Penalty Detail\"). Interest is separate: 6% for Jan. 1, 2025 - Dec. 31, 2026 (Pub 58 \"Interest Rates\"); calendar-2027 rate not yet published.",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "2025 TC-40 Instructions, \"Income from Other States\" and \"Credit for Income Tax Paid to Another State\" (Utah residents taxed by another state on the same income may claim a credit)",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "Form TC-40B (2025) Part \"Non or Part-year Resident Utah Tax\": line 39 divides Utah income by total income (4 decimal places), line 41 \"UTAH TAX - Multiply line 40 by the decimal on line 39\"",
    status: 'verified',
  },
  {
    state: 'UT', year: 2025, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-16", "2025-07-04", "2025-07-24", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-15", "2026-07-03", "2026-07-24", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-07-23", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24"
    ],
    citation: "Utah Code 63G-1-301 as in force on each date: version effective 5/7/2025 (superseded 5/6/2026) for 2025 and Jan 1 - May 5, 2026 (Jan 1, July 4, July 24, Nov 11, Dec 25 move to the preceding Friday / following Monday when on Saturday / Sunday; 3rd Mon Jan; 3rd Mon Feb; last Mon May; 1st Mon Sep; 2nd Mon Oct; 4th Thu Nov; Juneteenth June 19 observed the preceding Monday when Tue-Fri and the following Monday when Sat/Sun); version effective 5/6/2026 (superseded 1/1/2027) adds Good Friday, so Good Friday April 3, 2026 was NOT a legal holiday (the amendment took effect after it) - AUDIT CORRECTION removed 2026-04-03; version effective 1/1/2027 (Juneteenth becomes a fixed June 19 date under the Saturday/Sunday rule; Good Friday March 26, 2027). Easter Sunday and other Sundays omitted (weekends roll anyway). Dates computed from the statute texts read 2026-10-11. Calendar years 2025-2027.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'UT', year: 2026, key: 'has_income_tax', value: true,
    citation: "Form TC-546 (Rev. 10/26) payment worksheet (tax you expect to owe this year); 2025 TC-40 Instructions (2026 forms not yet published)",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'required_threshold', value: 0,
    citation: "AUDITED 2026-10-11: Utah has NO individual estimated-tax (quarterly installment) requirement. 2025 TC-40 Instructions p.4 \"Utah does not require quarterly estimated tax payments. You can prepay at any time at tap.utah.gov, or by mailing your payment with form TC-546\"; Pub 58 (Rev. 11/25) \"Underpayment Penalties\" lists quarterly-payment penalties only for corporation, insurance and severance taxes; Form TC-547 (Rev. 10/26) is only a return payment coupon (\"Do not use this return payment coupon to prepay future individual income taxes. Use form TC-546\"); there is no Utah Code 59-10-107 estimated-tax section (le.utah.gov returns no such section). The only prepayment rule is Utah Code 59-10-516(2)(b)-(3) (effective 5/5/2021): no extension-period penalty under 59-1-401 if, on or before the return due date in 59-10-514, the taxpayer pays the lesser of 90% of current-year tax or 100% of prior-year tax. MAPPING into the key set: 0 = no dollar floor: 59-10-516(2)(b) applies to every individual taxpayer with no minimum, and Form TC-546 (Rev. 10/26) worksheet line 8 (\"If greater than zero ... send coupon with payment\") has no threshold.",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form TC-546 (Rev. 10/26) Payment Worksheet lines 2-5 (\"Minimum payment rate x .90\"; \"enter the lesser of line 3 or line 4\")",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form TC-546 (Rev. 10/26) Payment Worksheet line 4 (\"Last year's Utah tax liability (as filed, amended or audited)\") and line 5 (lesser of line 3 or line 4)",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: Form TC-546 (Rev. 10/26) worksheet has only the 90% / prior-year lesser-of test",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'installments.due_dates', value: ["2027-04-15"],
    citation: "AUDITED 2026-10-11: Utah has NO individual estimated-tax (quarterly installment) requirement. 2025 TC-40 Instructions p.4 \"Utah does not require quarterly estimated tax payments. You can prepay at any time at tap.utah.gov, or by mailing your payment with form TC-546\"; Pub 58 (Rev. 11/25) \"Underpayment Penalties\" lists quarterly-payment penalties only for corporation, insurance and severance taxes; Form TC-547 (Rev. 10/26) is only a return payment coupon (\"Do not use this return payment coupon to prepay future individual income taxes. Use form TC-546\"); there is no Utah Code 59-10-107 estimated-tax section (le.utah.gov returns no such section). The only prepayment rule is Utah Code 59-10-516(2)(b)-(3) (effective 5/5/2021): no extension-period penalty under 59-1-401 if, on or before the return due date in 59-10-514, the taxpayer pays the lesser of 90% of current-year tax or 100% of prior-year tax. MAPPING into the key set: one \"installment\" on the original return due date, April 15, 2027 (Utah Code 59-10-514(1)(a)(i): due \"on or before the day on which a federal individual income tax return is due\"; IRC 6072(a) \"15th day of April\"; April 15, 2027 is a Thursday, not a 63G-1-301 holiday). Utah Code 59-10-514(2): tax is payable \"before the due date for filing the return, without regard to any extension\". The engine must NOT schedule four quarterly Utah vouchers.",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'installments.pcts', value: [1.0],
    citation: "AUDITED 2026-10-11: Utah has NO individual estimated-tax (quarterly installment) requirement. 2025 TC-40 Instructions p.4 \"Utah does not require quarterly estimated tax payments. You can prepay at any time at tap.utah.gov, or by mailing your payment with form TC-546\"; Pub 58 (Rev. 11/25) \"Underpayment Penalties\" lists quarterly-payment penalties only for corporation, insurance and severance taxes; Form TC-547 (Rev. 10/26) is only a return payment coupon (\"Do not use this return payment coupon to prepay future individual income taxes. Use form TC-546\"); there is no Utah Code 59-10-107 estimated-tax section (le.utah.gov returns no such section). The only prepayment rule is Utah Code 59-10-516(2)(b)-(3) (effective 5/5/2021): no extension-period penalty under 59-1-401 if, on or before the return due date in 59-10-514, the taxpayer pays the lesser of 90% of current-year tax or 100% of prior-year tax. MAPPING into the key set: 100% of the required prepayment (lesser of 90% current / 100% prior, 59-10-516(2)(b)) is measured once, at the original return due date. Form TC-546 (Rev. 10/26) worksheet \"Pay the amount on line 8 on or before the return due date\".",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'farmer.rule', value: null,
    citation: "No farmer/fisherman rule: Utah Code 59-10-516 (effective 5/5/2021) has no farmer variation of the 90%/100% prepayment test, Pub 58 (Rev. 11/25) and Form TC-546 (Rev. 10/26) state none, and Utah has no individual estimated-tax installments for a farmer exception to modify (2025 TC-40 Instructions \"Utah does not require quarterly estimated tax payments\").",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "Form TC-546 (Rev. 10/26) \"Penalties\" (2 percent of the unpaid tax for each month of the extension period) and \"Interest\" (Pub 58 / Utah Code §59-1-402)",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'penalty.rate', value: 0.24,
    citation: "AUDITED 2026-10-11: Utah has NO individual estimated-tax (quarterly installment) requirement. 2025 TC-40 Instructions p.4 \"Utah does not require quarterly estimated tax payments. You can prepay at any time at tap.utah.gov, or by mailing your payment with form TC-546\"; Pub 58 (Rev. 11/25) \"Underpayment Penalties\" lists quarterly-payment penalties only for corporation, insurance and severance taxes; Form TC-547 (Rev. 10/26) is only a return payment coupon (\"Do not use this return payment coupon to prepay future individual income taxes. Use form TC-546\"); there is no Utah Code 59-10-107 estimated-tax section (le.utah.gov returns no such section). The only prepayment rule is Utah Code 59-10-516(2)(b)-(3) (effective 5/5/2021): no extension-period penalty under 59-1-401 if, on or before the return due date in 59-10-514, the taxpayer pays the lesser of 90% of current-year tax or 100% of prior-year tax. MAPPING into the key set: 0.24 = the insufficient-prepayment (extension) penalty: Pub 58 (Rev. 11/25) \"(underpayment) x .24 x (number of days outstanding) / 365 ... 2 percent rate per month up to a maximum of six months, or 12 percent (annual 24 percent)\", assessed only until the return is filed or the extension expires; Form TC-546 (Rev. 10/26) \"a penalty equal to 2 percent of the unpaid tax for each month of the extension period\". If the return is filed by the original due date unpaid, the 59-1-401 late-payment penalty applies instead (Pub 58 \"Penalty Detail\"). Interest is separate: 6% for Jan. 1, 2025 - Dec. 31, 2026 (Pub 58 \"Interest Rates\"); calendar-2027 rate not yet published.",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "Utah Code 59-10-1003 (resident claimant credit for tax imposed by another state, DC or possession on income derived from sources there and also taxed by Utah; limited so Utah tax is not reduced below the tax computed with that income disregarded) - section in force unchanged since 2006; 2025 TC-40 Instructions Schedule A credit code 17. TY2026 TC-40 Instructions not yet published.",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "Utah Code 59-10-116(1) (effective 1/1/2023: nonresident tax = state taxable income x the 59-10-104(2) rate) with 59-10-103(1)(z)(ii) (effective 5/7/2025: nonresident state taxable income built from Utah-source income) and 59-10-103(1)(x) (state income tax percentage = Utah state taxable income / total adjusted gross income, the ratio applied on TC-40B); Form TC-40B (2025) lines 39-41 (Utah income / total income x Utah tax). TY2026 TC-40B not yet published.",
    status: 'verified',
  },
  {
    state: 'UT', year: 2026, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-06-16", "2025-07-04", "2025-07-24", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-06-15", "2026-07-03", "2026-07-24", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-07-23", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24"
    ],
    citation: "Utah Code 63G-1-301 as in force on each date: version effective 5/7/2025 (superseded 5/6/2026) for 2025 and Jan 1 - May 5, 2026 (Jan 1, July 4, July 24, Nov 11, Dec 25 move to the preceding Friday / following Monday when on Saturday / Sunday; 3rd Mon Jan; 3rd Mon Feb; last Mon May; 1st Mon Sep; 2nd Mon Oct; 4th Thu Nov; Juneteenth June 19 observed the preceding Monday when Tue-Fri and the following Monday when Sat/Sun); version effective 5/6/2026 (superseded 1/1/2027) adds Good Friday, so Good Friday April 3, 2026 was NOT a legal holiday (the amendment took effect after it) - AUDIT CORRECTION removed 2026-04-03; version effective 1/1/2027 (Juneteenth becomes a fixed June 19 date under the Saturday/Sunday rule; Good Friday March 26, 2027). Easter Sunday and other Sundays omitted (weekends roll anyway). Dates computed from the statute texts read 2026-10-11. Calendar years 2025-2027 (2025 dates harmless).",
    status: 'verified',
  },
];
