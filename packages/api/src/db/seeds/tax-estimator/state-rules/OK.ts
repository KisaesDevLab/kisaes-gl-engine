// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// OK state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research batch 5, 2026-10-11).
// Every row cites the document it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch5-sources.md. Rows marked 'unverified'
// state the reason in the citation. The CPA signs off OK (D12).
export const OK_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'OK', year: 2025, key: 'has_income_tax', value: true,
    citation: '2025 Oklahoma Resident Income Tax Packet (Form 511 instructions, "Estimated Income Tax" p.5; oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-Pkt.pdf) (Form 511 resident income tax return, graduated rates); 68 O.S. §2355 (statute not read).',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'required_threshold', value: 500,
    citation: '2025 Oklahoma Resident Income Tax Packet (Form 511 instructions, "Estimated Income Tax" p.5; oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-Pkt.pdf): quarterly estimates required if tax liability can reasonably be expected to exceed withholding by $500 or more AND withholding is below the safe-harbor amount. A separate rule exempts underpayment interest if tax shown on the return is under $1,000 (OTC "Pay Taxes" page, Estimated Income Tax Payments and Penalty & Interest sections (oklahoma.gov/tax/individuals/pay-taxes.html, fetched 2026-10-11)).',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'safe_harbor.current_pct', value: 0.7,
    citation: '2025 Oklahoma Resident Income Tax Packet (Form 511 instructions, "Estimated Income Tax" p.5; oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-Pkt.pdf): withholding/estimates must equal the smaller of 70% of the current-year tax liability or 100% of the prior-year liability; OW-8-ES General Instructions (digitalprairie.ok.gov forms #2734). Oklahoma differs from the 90% norm.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2025 Oklahoma Resident Income Tax Packet (Form 511 instructions, "Estimated Income Tax" p.5; oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-Pkt.pdf): the tax liability shown on the return for the preceding taxable year of 12 months; OW-8-ES General Instructions ("100% of your prior year tax liability").',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: the OTC Pay Taxes page and the 2025 Form 511 packet state only 70% current / 100% prior.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: 'OAC 710:50-13-6(b) (April 15, June 15, September 15 of the current taxable year and January 15 of the following year; read at law.cornell.edu); 25 O.S. 2021 §82.1(A) (each Saturday and Sunday is a holiday) and (C) ("Any act authorized, required, or permitted to be performed on a holiday ... may be performed on the next succeeding business day"), as reproduced in HB 1692 (2025, as introduced), read in audit 2026-10-11. June 15, 2025 is a Sunday -> June 16, 2025. Audit 2026-10-11: upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: '2025 Oklahoma Resident Income Tax Packet (Form 511 instructions, "Estimated Income Tax" p.5; oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-Pkt.pdf): "equal quarterly estimated tax payments"; OW-8-ES General Instructions ("equal* quarterly estimated tax payments").',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.0, "due_date": "2026-04-15", "file_by": "2026-04-15"},
    citation: '2025 Oklahoma Resident Income Tax Packet (511-Pkt.pdf) "Estimated Income Tax" p.5 and line 22 ("If at least 66.67% (or two-thirds) of your gross income for this year or last year is from farming, estimated payments are not required"; mark the box on line 22 and attach the federal return); 2025 Form 511-NR packet p.4 (same text); OTC "Pay Taxes" page ("at least 66.66% ... from farming, estimated income tax payments are not required"), all read in audit 2026-10-11. Farmers are genuinely exempt. Mapping: the key cannot express an exemption, so current_pct 0 (no required payment) with due_date/file_by = the return due date (2026-04-15); engine must treat current_pct 0 as no installments and no underpayment interest. Exemption fact verified; status reflects the read source.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: '68 O.S. §2385.13 (interest at 20% per year on underpayment of estimated tax) as described in the OTC Pay Taxes page ("computed at a rate of 20% per annum for the period of underpayment") and OW-8-ES General Instructions.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'penalty.rate', value: 0.2,
    citation: 'OTC "Pay Taxes" page, Estimated Income Tax Payments and Penalty & Interest sections (oklahoma.gov/tax/individuals/pay-taxes.html, fetched 2026-10-11): "The underpayment of estimated tax Interest due on any quarterly due date is computed at a rate of 20% per annum"; OW-8-ES General Instructions (20% per annum). No interest if tax shown on the return is under $1,000.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'credit_for_other_state', value: true,
    citation: '2025 Form 511 Instructions, Line 16 "Credit for Tax Paid to Another State" (Form 511-TX; allowed on Form 511 when another state also taxes the income for personal services).',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: '2025 Oklahoma Form 511-NR packet (oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-NR-Pkt.pdf, read in audit 2026-10-11) "How Nonresidents and Part-Year Residents Are Taxed" (taxable income computed as if all income were earned in Oklahoma, then prorated by Oklahoma-source AGI / AGI from all sources) and line 17 "Tax Percentage" / line 18 (Oklahoma percentage x base tax on all income). Audit 2026-10-11: upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-23", "2027-12-24", "2027-12-25", "2027-12-31"],
    citation: '25 O.S. 2021 §82.1 as reproduced in the Oklahoma Legislature\'s HB 1692 (2025, as introduced; oklegislature.gov), read in audit 2026-10-11: A. holidays are each Saturday, Sunday, New Year\'s Day (Jan 1), MLK (3rd Mon Jan), Presidents\' Day (3rd Mon Feb), Memorial Day, Independence Day (July 4), Labor Day, Veterans\' Day (Nov 11), Thanksgiving, the day after Thanksgiving, Christmas (Dec 25), the day before or after Christmas if Christmas is not on a weekend, the Thursday and Friday before Christmas if Christmas is on a Saturday; holidays other than Christmas on a Saturday move to the preceding Friday and on a Sunday to the succeeding Monday; C. an act due on a holiday may be performed on the next succeeding business day. Juneteenth and Columbus Day are NOT in §82.1 (audit removed 2025-06-19, 2026-06-19, 2027-06-18 which the researcher had included). 2027-12-23/24 added (Christmas 2027 is a Saturday); 2027-12-31 is the Friday for Jan 1, 2028. UNVERIFIED because (1) the Governor\'s executive order picks the day before or after Christmas in 2025 and 2026 (not read; neither date can move an installment or farmer date, so both are omitted), and (2) HB 1692\'s text adds "the day upon which any General Election is held" and the underlining that marks new language was lost in text extraction, so whether election day is current law is unconfirmed (omitted; the bill\'s purpose is to add it). Calendar 2025-2027.',
    status: 'unverified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'OK', year: 2026, key: 'has_income_tax', value: true,
    citation: '2025 Oklahoma Resident Income Tax Packet (Form 511 instructions, "Estimated Income Tax" p.5; oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-Pkt.pdf) (Form 511 resident income tax return, graduated rates); 68 O.S. §2355 (statute not read).',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'required_threshold', value: 500,
    citation: 'OTC "Pay Taxes" page, Estimated Income Tax Payments and Penalty & Interest sections (oklahoma.gov/tax/individuals/pay-taxes.html, fetched 2026-10-11): quarterly estimates required if tax liability can reasonably be expected to exceed withholding by $500 or more AND withholding is below the safe-harbor amount. A separate rule exempts underpayment interest if tax shown on the return is under $1,000 (OTC "Pay Taxes" page, Estimated Income Tax Payments and Penalty & Interest sections (oklahoma.gov/tax/individuals/pay-taxes.html, fetched 2026-10-11)).',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'safe_harbor.current_pct', value: 0.7,
    citation: 'OTC "Pay Taxes" page, Estimated Income Tax Payments and Penalty & Interest sections (oklahoma.gov/tax/individuals/pay-taxes.html, fetched 2026-10-11): withholding/estimates must equal the smaller of 70% of the current-year tax liability or 100% of the prior-year liability; OW-8-ES General Instructions (digitalprairie.ok.gov forms #2734). Oklahoma differs from the 90% norm.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'OTC "Pay Taxes" page, Estimated Income Tax Payments and Penalty & Interest sections (oklahoma.gov/tax/individuals/pay-taxes.html, fetched 2026-10-11): the tax liability shown on the return for the preceding taxable year of 12 months; OW-8-ES General Instructions ("100% of your prior year tax liability").',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI variant: the OTC Pay Taxes page and the 2025 Form 511 packet state only 70% current / 100% prior.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: 'OAC 710:50-13-6(b) (April 15 and June 15 and September 15 of the current taxable year and January 15 of the following year; read at law.cornell.edu). None of the 2026-27 dates falls on a weekend; no roll needed.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'OTC "Pay Taxes" page, Estimated Income Tax Payments and Penalty & Interest sections (oklahoma.gov/tax/individuals/pay-taxes.html, fetched 2026-10-11): "equal quarterly estimated tax payments"; OW-8-ES General Instructions ("equal* quarterly estimated tax payments").',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.0, "due_date": "2027-04-15", "file_by": "2027-04-15"},
    citation: '2025 Oklahoma Resident Income Tax Packet (511-Pkt.pdf) "Estimated Income Tax" p.5 and line 22 ("If at least 66.67% (or two-thirds) of your gross income for this year or last year is from farming, estimated payments are not required"; mark the box on line 22 and attach the federal return); 2025 Form 511-NR packet p.4 (same text); OTC "Pay Taxes" page ("at least 66.66% ... from farming, estimated income tax payments are not required"), all read in audit 2026-10-11. Farmers are genuinely exempt. Mapping: the key cannot express an exemption, so current_pct 0 (no required payment) with due_date/file_by = the return due date (2027-04-15); engine must treat current_pct 0 as no installments and no underpayment interest. Exemption fact verified; status reflects the read source.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: '68 O.S. §2385.13 (interest at 20% per year on underpayment of estimated tax) as described in the OTC Pay Taxes page ("computed at a rate of 20% per annum for the period of underpayment") and OW-8-ES General Instructions.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'penalty.rate', value: 0.2,
    citation: 'OTC "Pay Taxes" page, Estimated Income Tax Payments and Penalty & Interest sections (oklahoma.gov/tax/individuals/pay-taxes.html, fetched 2026-10-11): "The underpayment of estimated tax Interest due on any quarterly due date is computed at a rate of 20% per annum"; OW-8-ES General Instructions (20% per annum). No interest if tax shown on the return is under $1,000.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'credit_for_other_state', value: true,
    citation: '2025 Form 511 Instructions, Line 16 "Credit for Tax Paid to Another State" (Form 511-TX; allowed on Form 511 when another state also taxes the income for personal services).',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: '2025 Oklahoma Form 511-NR packet (oklahoma.gov/content/dam/ok/en/tax/documents/forms/individuals/current/511-NR-Pkt.pdf, read in audit 2026-10-11) "How Nonresidents and Part-Year Residents Are Taxed" (taxable income computed as if all income were earned in Oklahoma, then prorated by Oklahoma-source AGI / AGI from all sources) and line 17 "Tax Percentage" / line 18 (Oklahoma percentage x base tax on all income). Audit 2026-10-11: upgraded from unverified.',
    status: 'verified',
  },
  {
    state: 'OK', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-23", "2027-12-24", "2027-12-25", "2027-12-31"],
    citation: '25 O.S. 2021 §82.1 as reproduced in the Oklahoma Legislature\'s HB 1692 (2025, as introduced; oklegislature.gov), read in audit 2026-10-11: A. holidays are each Saturday, Sunday, New Year\'s Day (Jan 1), MLK (3rd Mon Jan), Presidents\' Day (3rd Mon Feb), Memorial Day, Independence Day (July 4), Labor Day, Veterans\' Day (Nov 11), Thanksgiving, the day after Thanksgiving, Christmas (Dec 25), the day before or after Christmas if Christmas is not on a weekend, the Thursday and Friday before Christmas if Christmas is on a Saturday; holidays other than Christmas on a Saturday move to the preceding Friday and on a Sunday to the succeeding Monday; C. an act due on a holiday may be performed on the next succeeding business day. Juneteenth and Columbus Day are NOT in §82.1 (audit removed 2025-06-19, 2026-06-19, 2027-06-18 which the researcher had included). 2027-12-23/24 added (Christmas 2027 is a Saturday); 2027-12-31 is the Friday for Jan 1, 2028. UNVERIFIED because (1) the Governor\'s executive order picks the day before or after Christmas in 2025 and 2026 (not read; neither date can move an installment or farmer date, so both are omitted), and (2) HB 1692\'s text adds "the day upon which any General Election is held" and the underlining that marks new language was lost in text extraction, so whether election day is current law is unconfirmed (omitted; the bill\'s purpose is to add it). Calendar 2025-2027.',
    status: 'unverified',
  },
];
