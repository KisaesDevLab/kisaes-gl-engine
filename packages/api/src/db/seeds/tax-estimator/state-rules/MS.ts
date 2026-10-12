// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// MS state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 4 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch4-sources.md. Rows marked 'unverified' say why in the citation.
export const MS_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------ 2025
  {
    state: 'MS', year: 2025, key: 'has_income_tax', value: true,
    citation: "Form 80-100 (2025, Rev. 12/25) Resident/Non-Resident instruction booklet, \"Declaration of Estimated Tax\" and income tax rate table",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'required_threshold', value: 200,
    citation: "Form 80-100 (2025) \"Declaration of Estimated Tax\" (\"if you do not have at least 80 percent of your annual Mississippi income tax liability prepaid through withholding and if your annual tax liability exceeds $200.00\") and Line 30; Form 80-320 (2025) instructions line 1 (\"If your 2025 Mississippi Income Tax Liability is $200 or less ... no interest is due\")",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'safe_harbor.current_pct', value: 0.8,
    citation: "Form 80-320 (2025) line 2 (\"Multiply the amount on line 1 by 80%\"); Form 80-100 (2025) Line 30",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form 80-320 (2025) lines 3-4 (\"Enter the lesser of line 2 [80% of 2025] or line 3 [2024 Mississippi income tax liability]\")",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: Form 80-320 (2025) line 4 uses 100% of prior-year liability with no income test",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Form 80-100 (2025) Declaration of Estimated Tax table (First quarter April 15th, Second June 15th, Third September 15th, Fourth January 15th) and Form 80-320 (2025) columns (Apr. 15, 2025; June 15, 2025; Sept. 15, 2025; Jan. 15, 2026). June 15, 2025 is a Sunday and is stored as June 16, 2025 on the next-business-day rule that the DOR FAQ states for returns (\"If the due date falls on a Saturday, Sunday or legal holiday, the return is due the next business day\"); no estimated-installment roll sentence was found, so unverified.",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form 80-320 (2025) line 5 (\"Required installments. Enter 1/4th (.25) of line 4\") and line instructions (\"Divide the amount on Line 4 by (4) four\")",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.8, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "Form 80-100 (2025, Rev. 12/25) Line 30 \"Farmers or Fishermen Exception\" (gross income from farming or fishing at least two-thirds of total gross income and \"(a) 80% of estimated tax is paid by the 15th day of the first month after the close of the income year or (b) the income tax return is filed by the first day of the third month following the close of the income year and tax shown due is paid\"). CAUTION: Form 80-320 (Rev. 09/25) Exceptions and the 80-100 Declaration of Estimated Tax section state (a) without the 80% figure (\"estimate tax paid by the 15th day\"); 0.8 follows Line 30. March 1, 2026 is a Sunday; file_by rolled to March 2, 2026 per Mississippi DOR Individual Income Tax FAQ (\"If the due date falls on a Saturday, Sunday or legal holiday, the return is due the next business day\"), MO roll convention. Audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "Form 80-100 (2025) Declaration of Estimated Tax (\"assessment of interest at the rate of 1/2% per month on underpayment of tax from the date payment is due until paid\"); Form 80-320 (2025) line 9",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'penalty.rate', value: 0.06,
    citation: "Form 80-320 (2025) line 9 (\"compute interest at 1/2% per month\") = 6% a year simple (not compounded)",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "Form 80-100 (2025) Line 18 \"Credit for Income Tax Paid to Another State\" (Form 80-160 and the other-state return attached)",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'nonresident_method', value: "sourced_flat",
    citation: "Form 80-205 (2025) lines 13a-13c (ratio = Mississippi AGI / total AGI), 14b-15b (deductions and exemptions multiplied by the ratio), 16-19 (Mississippi taxable income = Mississippi-source income less prorated deductions/exemptions), line 20 (tax from the Schedule of Tax Computation); Form 80-100 (2025) \"Prorate\" instruction. Tax is on Mississippi-source income (sourced, not resident-tax x ratio); only deductions/exemptions are prorated, which `sourced_flat` approximates. Audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-28", "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-27", "2026-05-25", "2026-07-04", "2026-09-07", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-26", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "Miss. Code 3-3-7(1) as reproduced in HB 641 (2026 Reg. Sess., signed version, approved by Governor 02/17/2026) and SB 2098 (2026, introduced, existing-law text): Jan 1; 3rd Mon Jan (Robert E. Lee / MLK); 3rd Mon Feb; last Mon April (Confederate Memorial Day); last Mon May; July 4; 1st Mon Sep; Nov 11; Thanksgiving (Governor's proclamation matching the President's); Dec 25; \"In the event any holiday hereinbefore declared legal shall fall on Sunday, then the next following day shall be a legal holiday\" (Saturday holidays not moved). Juneteenth is NOT a legal holiday: SB 2588 (2025) died in committee 02/04/2025, HB 352/434/471 (2025) and HB 197/200 (2026) died; SB 2098 (2026, would make June 19 a non-holiday commemoration) died. Read at billstatus.ls.state.ms.us 2026-10-11. Calendar 2025-2027 computed (July 4, 2027 Sunday -> July 5).",
    status: 'verified',
  },
  // ------------------------------------------------------------ 2026
  {
    state: 'MS', year: 2026, key: 'has_income_tax', value: true,
    citation: "Mississippi DOR Individual Income Tax FAQ (\"What are the requirements for filing and paying estimated tax?\") read 2026-10-11",
    status: 'verified',
  },
  {
    state: 'MS', year: 2026, key: 'required_threshold', value: 200,
    citation: "Mississippi DOR Individual Income Tax FAQ (\"must make estimated tax payments if his/her annual tax liability exceeds two hundred dollars ($200)\")",
    status: 'verified',
  },
  {
    state: 'MS', year: 2026, key: 'safe_harbor.current_pct', value: 0.8,
    citation: "Mississippi DOR FAQ (\"Estimated tax payments must not be less than 80% of the annual income tax liability\")",
    status: 'verified',
  },
  {
    state: 'MS', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Carried from Form 80-320 (2025) lines 3-4 (lesser of 80% of current-year or 100% of prior-year liability); no 2026 Form 80-320 is published yet and the DOR FAQ does not mention the prior-year alternative",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: Form 80-320 (2025) line 4 uses 100% of prior-year liability with no income test",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Mississippi DOR FAQ (\"When are estimated tax payments due? April 15th, June 15th, September 15th, and January 15th\"); none of the 2026-2027 dates is a weekend (Wed/Mon/Tue/Fri) and none is a Mississippi legal holiday.",
    status: 'verified',
  },
  {
    state: 'MS', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Carried from Form 80-320 (2025) line 5 (1/4th per installment); no 2026 form published yet",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.8, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Carried from Form 80-320 / Form 80-100 (2025) farmers-or-fishermen exception (80% by January 15 or file and pay by March 1); no 2026 form published yet",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "Mississippi DOR FAQ (\"liable for interest of 1/2% per month on underpayment of tax from the date payment is due until paid\")",
    status: 'verified',
  },
  {
    state: 'MS', year: 2026, key: 'penalty.rate', value: 0.06,
    citation: "Mississippi DOR FAQ (1/2% per month underpayment interest) = 6% a year simple",
    status: 'verified',
  },
  {
    state: 'MS', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "Mississippi DOR Individual Income Tax FAQ (current, read 2026-10-11): a resident earning income in another state \"may be entitled to claim a credit against your Mississippi tax liability for the income taxes paid to the other state ... credit for taxes paid to other states is the other state's actual tax liability\"; Form 80-100 (2025) Line 18 / Form 80-160.",
    status: 'verified',
  },
  {
    state: 'MS', year: 2026, key: 'nonresident_method', value: "sourced_flat",
    citation: "Mississippi DOR Individual Income Tax FAQ (current, read 2026-10-11): nonresidents file Form 80-205; \"only the wages you are paid for the services performed in Mississippi are subject to Mississippi income tax\"; \"Total income is reported in order to prorate exemptions and deductions\"; Form 80-205 (2025) lines 13-20 (Mississippi-source income less ratio-prorated deductions/exemptions, taxed at the rate schedule). `sourced_flat` approximates this.",
    status: 'verified',
  },
  {
    state: 'MS', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-28", "2025-05-26", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-27", "2026-05-25", "2026-07-04", "2026-09-07", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-26", "2027-05-31", "2027-07-05", "2027-09-06", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "Miss. Code 3-3-7(1) as reproduced in HB 641 (2026 Reg. Sess., signed version, approved by Governor 02/17/2026): Jan 1; 3rd Mon Jan; 3rd Mon Feb; last Mon April (Confederate Memorial Day); last Mon May; July 4; 1st Mon Sep; Nov 11; Thanksgiving; Dec 25; Sunday holiday -> next following day (Saturday not moved). Juneteenth not a legal holiday (2025-2026 Juneteenth bills SB 2588, SB 2098, HB 352/434/471/197/200 all died in committee per billstatus.ls.state.ms.us code-section 3-3-7 histories, read 2026-10-11). Calendar 2025-2027 computed.",
    status: 'verified',
  },
  {
    state: 'MS', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'MS', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MS', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
