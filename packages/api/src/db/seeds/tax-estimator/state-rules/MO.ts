// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// MO state estimated-tax rules, tax years 2025 and 2026 (Phase 2 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-mo-ar-sources.md. The CPA signs off MO (D12).
// Sources: RSMo (revisor.mo.gov) §§143.041, 143.081, 143.521, 143.531, 143.541, 143.761,
// 143.851, 32.065, 9.010; Form MO-1040ES 2025 (Rev. 12-2024) and 2026 (Rev. 12-2025);
// Form MO-2210 2025; 12 CSR 10-41.010 emergency amendment (filed Oct. 2025).
export const MO_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'MO', year: 2025, key: 'has_income_tax', value: true,
    citation: 'RSMo §143.011.1 ("A tax is hereby imposed for every taxable year on the Missouri taxable income of every resident"); RSMo §143.041.1 (nonresidents)',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'required_threshold', value: 100,
    citation: 'RSMo §143.521.1 (declaration required "if the Missouri estimated tax can reasonably be expected to be at least one hundred dollars"); §143.521.3 ("Missouri estimated tax" = estimated Chapter 143 tax less estimated credits "including tax withheld"); 2025 Form MO-1040ES General Instructions 1-2 ("$100.00 or more")',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'RSMo §143.761.2(1) and .4(2)-(3) ("ninety percent ... of the tax shown on the return"); 2025 Form MO-1040ES General Instruction 8(b) ("90% ... of the total amount due for the current year"); Form MO-2210 (2025) Part I line 2 ("Multiply Line 1 by 90%")',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'RSMo §143.761.4(1) (no addition if payments equal "The tax shown on the return ... for the preceding taxable year, if a return showing a liability for tax was filed for the preceding year and such preceding year was a taxable year of twelve months"); Form MO-2210 (2025) line 21 Exception No. 1 (25%/50%/75%/100% of 2024 tax); MO-1040ES 2025 Instruction 8(a). Note: §143.761.4(4) adds a further exception (prior-year facts at current-year rates, MO-2210 line 22 Exception No. 2) that this key cannot represent.',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI rule: RSMo §143.761.4(1) uses 100% of the preceding year\'s tax with no income test (no analogue of IRC §6654(d)(1)(C) 110%); Form MO-2210 (2025) line 21 Exception No. 1 = 100% of 2024 tax for all taxpayers',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'RSMo §143.541.1(1) (April 15, June 15, September 15, January 15 of the succeeding year); 2025 Form MO-1040ES Instruction 5 table + note "If the due date falls on a Saturday, Sunday, or legal holiday, the voucher will be considered timely if filed on the next business day"; RSMo §143.851 (next day not a Saturday, Sunday or legal holiday). June 15, 2025 is a Sunday -> June 16, 2025.',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'RSMo §143.541.1(1) ("the estimated tax shall be paid in four equal installments"); Form MO-2210 (2025) line 21 cumulative 25%/50%/75%/100%',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: 'RSMo §143.531.2 (farming gross income at least two-thirds of total Missouri gross income; declaration on or before January 15 of the succeeding year); §143.761.2(1)/.4(2) ("sixty-six and two-thirds percent in the case of a farmer"); §143.521.6 (return filed and paid "on or before March first in the case of a farmer"); Form MO-2210 (2025) Instruction J ("paid tax on or before March 1, 2026 ... exempt"); 2025 MO-1040ES Instruction 3. March 1, 2026 is a Sunday -> March 2, 2026 per RSMo §143.851. Ratio stored just under 2/3 (federal seed convention).',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'RSMo §143.761.1 (addition to tax "at the rate determined by section 32.065"); RSMo §32.065 (director sets annual adjusted rate from the September prime rate)',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'penalty.rate', value: 0.08,
    citation: '12 CSR 10-41.010(1) table (2025 = 8%, 2026 = 7%); Form MO-2210 (2025) lines 28a/28b (8% for days in 2025, 7% for days from Jan 1, 2026 to the payment date or April 15, 2026). CAUTION: single-rate key; underpayment days falling in 2026 accrue at 7%, not 8%.',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'RSMo §143.081.1-.2 (resident credit for income tax imposed by another state or DC on income derived there, limited to the ratio of other-state-source Missouri AGI to total Missouri AGI times Missouri tax)',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'nonresident_method', value: 'ratio',
    citation: 'RSMo §143.041.1 (nonresident tax = resident-basis tax x Missouri-source AGI / Missouri AGI from all sources); 2025 Form MO-1040ES General Instruction 5 and worksheet Line 10 "Nonresident" (Missouri income percentage x tax from the rate chart)',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'holidays',
    value: ['2025-01-01', '2025-01-20', '2025-02-12', '2025-02-17', '2025-05-08', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25',
      '2026-01-01', '2026-01-19', '2026-02-12', '2026-02-16', '2026-05-08', '2026-05-25', '2026-06-19', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    citation: 'RSMo §9.010 public holidays (Jan 1; 3rd Mon Jan; Feb 12; 3rd Mon Feb; May 8; last Mon May; June 19; July 4; 1st Mon Sep; 2nd Mon Oct; Nov 11; 4th Thu Nov; Dec 25; a Sunday holiday moves to the following Monday, a Saturday holiday is not moved) used by RSMo §143.851 ("legal holiday in this state"). Calendar years 2025-2026 (all installment and farmer dates of TY2025). Dates computed from the statute.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'MO', year: 2026, key: 'has_income_tax', value: true,
    citation: 'RSMo §143.011.1 (tax on Missouri taxable income of every resident); RSMo §143.041.1 (nonresidents); 2026 Form MO-1040ES tax rate chart',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'required_threshold', value: 100,
    citation: 'RSMo §143.521.1 ("at least one hundred dollars"); §143.521.3 (net of credits incl. withholding); 2026 Form MO-1040ES (Rev. 12-2025) General Instructions 1-2 ("$100.00 or more (Section 143.521.1, RSMo)")',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'RSMo §143.761.2(1) and .4(2)-(3) (ninety percent); 2026 Form MO-1040ES General Instruction 8(b) ("90% ... of the total amount due for the current year")',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: 'RSMo §143.761.4(1) (100% of the tax shown on the preceding 12-month return showing a liability); 2026 Form MO-1040ES General Instruction 8(a). §143.761.4(4) (prior-year facts at current rates) is an additional exception not represented by this key.',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'No high-AGI rule: RSMo §143.761.4(1) has no income test; 2026 Form MO-1040ES Instruction 8(a) ("the tax shown on the preceding year\'s return") with no AGI-based percentage',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'RSMo §143.541.1(1); 2026 Form MO-1040ES Instruction 5 table (April 15, June 15, September 15, January 15) + weekend/holiday note; RSMo §143.851. None of these dates is a weekend or RSMo §9.010 holiday (Wed/Mon/Tue/Fri).',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'RSMo §143.541.1(1) ("four equal installments"); 2026 Form MO-1040ES General Instruction 4 ("in equal installments on or before April 15, June 15, September 15, and January 15")',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6666666667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: 'RSMo §143.531.2 (two-thirds farming gross income; declaration by January 15); §143.761.2(1)/.4(2) (66 2/3%); §143.521.6 (return and full payment by March 1); 2026 Form MO-1040ES General Instructions 3 and 8(b). Jan 15, 2027 (Fri) and Mar 1, 2027 (Mon) need no roll.',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'RSMo §143.761.1 (rate determined by §32.065); RSMo §32.065',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: '12 CSR 10-41.010(1) emergency amendment filed Oct. 2025, effective Jan. 1, 2026 (calendar 2026 = 7%); Form MO-2210 (2025) line 28b (7% for 2026 days). CAUTION: the calendar-2027 rate (days Jan 1-Apr 15, 2027 of a TY2026 underpayment) is set under §32.065.2 / 12 CSR 10-41.010(4) by Oct. 22, 2026 and had not been read at research time (2026-10-11).',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'RSMo §143.081.1-.2 (resident credit for other-state/DC income tax, ratio-limited); 2026 Form MO-1040ES worksheet Line 11 ("credit for income tax to be paid to another state")',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'nonresident_method', value: 'ratio',
    citation: 'RSMo §143.041.1 (ratio of Missouri-source AGI to all-source AGI applied to resident-basis tax); 2026 Form MO-1040ES General Instruction 5 and worksheet Line 10 "Nonresident"',
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'holidays',
    value: ['2026-01-01', '2026-01-19', '2026-02-12', '2026-02-16', '2026-05-08', '2026-05-25', '2026-06-19', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25',
      '2027-01-01', '2027-01-18', '2027-02-12', '2027-02-15', '2027-05-08', '2027-05-31', '2027-06-19', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-25'],
    citation: 'RSMo §9.010 public holidays (statutory dates; Sunday -> following Monday, e.g. July 4, 2027 -> July 5, 2027; Saturday holidays not moved) used by RSMo §143.851. Calendar years 2026-2027 (all installment and farmer dates of TY2026). Dates computed from the statute.',
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'estimates_required', value: true,
    citation: "RSMo §143.521.1 (declaration of estimated tax required at $100 or more) and §143.541.1(1) (four installments April 15, June 15, September 15, January 15); Form MO-1040ES 2025 General Instruction 4 (read 2026-10-12)",
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'threshold_comparison', value: "at_least",
    citation: "RSMo §143.521.1 (\"at least one hundred dollars\"); MO-1040ES 2025 Instr. 1-2 (\"$100.00 or more\"); Form MO-2210 (2025), dor.mo.gov/forms/MO-2210_2025.pdf, read 2026-10-12 Part I line 4 (\"If less than $500, stop here\") — both boundaries are \"at least\"",
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'installments.q4_file_and_pay_date', value: "2026-02-02",
    citation: "RSMo §143.521.6 (return filed and tax paid in full \"on or before January thirty-first\" of the succeeding year stands as the declaration due January 15; read on revisor.mo.gov 2026-10-12); Form MO-2210 (2025), dor.mo.gov/forms/MO-2210_2025.pdf, read 2026-10-12 Instruction H (\"If you filed your return and paid the balance of tax due on or before January 31, 2026, consider the balance paid as of January 15, 2026\"); MO-1040ES 2026 Instr. 4. Jan 31, 2026 is a Saturday -> Monday Feb 2, 2026 under RSMo §143.851 (Saturday, Sunday or legal holiday -> next succeeding day).",
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'return_due_date', value: "2026-04-15",
    citation: "RSMo §143.511 (return and payment due \"on or before the fifteenth day of the fourth month following the close of the taxpayer's taxable year\"; read 2026-10-12); Form MO-2210 (2025), dor.mo.gov/forms/MO-2210_2025.pdf, read 2026-10-12 lines 26/27b (penalty period ends at payment or \"April 15, 2026\")",
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'penalty.rate_schedule', value: [{"from": "2025-01-01", "to": "2025-12-31", "rate": 0.08}, {"from": "2026-01-01", "to": "2026-12-31", "rate": 0.07}],
    citation: "12 CSR 10-41.010(1) table (calendar 2025 = 8%, 2026 = 7%; emergency amendment filed Oct. 2025, dor.mo.gov, read 2026-10-12); Form MO-2210 (2025), dor.mo.gov/forms/MO-2210_2025.pdf, read 2026-10-12 lines 27a/27b and 28a/28b: 8% for days through December 31, 2025, 7% for days from January 1, 2026 to payment or April 15, 2026. RSMo §32.065.",
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'penalty.method', value: "daily_simple",
    citation: "Form MO-2210 (2025), dor.mo.gov/forms/MO-2210_2025.pdf, read 2026-10-12 lines 28a/28b instructions: \"Multiply the amount on Line 25 by the number of days ... Divide this amount by 365 days and multiply the product by\" the annual rate; RSMo §143.761.1 (rate under §32.065, per diem, not compounded)",
    status: 'verified',
  },
  {
    state: 'MO', year: 2025, key: 'penalty.min_balance_due', value: 500,
    citation: "Form MO-2210 (2025), dor.mo.gov/forms/MO-2210_2025.pdf, read 2026-10-12 Part I line 4: \"Subtract Line 3 [withholding] from Line 1 [2025 tax after credits]. If less than $500, stop here; do not complete or file this form. You do not owe the penalty.\" Distinct from the $100 declaration threshold (required_threshold).",
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'estimates_required', value: true,
    citation: "RSMo §143.521.1 (declaration of estimated tax required at $100 or more) and §143.541.1(1) (four installments April 15, June 15, September 15, January 15); Form MO-1040ES 2026 General Instruction 4 (read 2026-10-12)",
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'threshold_comparison', value: "at_least",
    citation: "RSMo §143.521.1 (\"at least one hundred dollars\"); MO-1040ES 2026 Instr. 1-2 (\"$100.00 or more\"); Form MO-2210 (2025), dor.mo.gov/forms/MO-2210_2025.pdf, read 2026-10-12 Part I line 4 (\"If less than $500, stop here\") — both boundaries are \"at least\"",
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'installments.q4_file_and_pay_date', value: "2027-02-01",
    citation: "RSMo §143.521.6 (\"on or before January thirty-first\"; read on revisor.mo.gov 2026-10-12); MO-1040ES 2026 (Rev. 12-2025) General Instruction 4 (\"no declaration need be filed on January 15, if you file a voucher and pay the tax on or before January 31\"). Jan 31, 2027 is a Sunday -> Monday Feb 1, 2027 under RSMo §143.851.",
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'return_due_date', value: "2027-04-15",
    citation: "RSMo §143.511 (fifteenth day of the fourth month; read on revisor.mo.gov 2026-10-12). April 15, 2027 is a Thursday (no roll). MO-2210 (2025) lines 26/27b show the penalty period ending on that date.",
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'penalty.rate_schedule', value: [{"from": "2026-01-01", "to": "2026-12-31", "rate": 0.07}],
    citation: "12 CSR 10-41.010(1) (calendar 2026 = 7%, read 2026-10-12). The calendar-2027 rate (days Jan 1-Apr 15, 2027 of a TY2026 underpayment) is posted by Oct. 22, 2026 under 12 CSR 10-41.010(4) / RSMo §32.065 and was not published on 2026-10-12; days after 12/31/2026 are deliberately uncovered so the engine falls back to penalty.rate with a verify flag. Add the 2027 leg when posted.",
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'penalty.method', value: "daily_simple",
    citation: "Form MO-2210 (2025), dor.mo.gov/forms/MO-2210_2025.pdf, read 2026-10-12 lines 28a/28b instructions: \"Multiply the amount on Line 25 by the number of days ... Divide this amount by 365 days and multiply the product by\" the annual rate; RSMo §143.761.1 (rate under §32.065, per diem, not compounded)",
    status: 'verified',
  },
  {
    state: 'MO', year: 2026, key: 'penalty.min_balance_due', value: 500,
    citation: "Form MO-2210 (2025), dor.mo.gov/forms/MO-2210_2025.pdf, read 2026-10-12 Part I line 4: \"Subtract Line 3 [withholding] from Line 1 [2025 tax after credits]. If less than $500, stop here; do not complete or file this form. You do not owe the penalty.\" Distinct from the $100 declaration threshold (required_threshold). The 2026 MO-2210 is not yet published; value carried from the current (2025) form.",
    status: 'verified',
  },
];
