// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// RI state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 6 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch6-sources.md. The CPA signs off RI (D12).
// Sources: 2025 and 2026 Form RI-1040ES (tax.ri.gov); 2025 Form RI-2210; RI Division of Taxation
// ADV 2025-09 and ADV 2025-23; 2025 RI-1040NR Schedule II; R.I. Gen. Laws §25-1-1.
export const RI_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'RI', year: 2025, key: 'has_income_tax', value: true,
    citation: "2025 Form RI-1040ES (Rev. 2024-12), \"Who must make estimated payments\" (\"Every resident and nonresident individual shall make estimated Rhode Island personal income tax payments\") and 2025 Tax Rate Schedule (3.75% / 4.75% / 5.99%)",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'required_threshold', value: 250,
    citation: "R.I. Gen. Laws §44-30-55(a) (declaration required if estimated RI tax \"can reasonably be expected to be two hundred and fifty dollars ($250) or more in excess of any credits allowable\"); 2025 Form RI-1040ES \"Who must make estimated payments\"; 2025 Form RI-2210 Part 1 line 4 (stop if tax less withholding is $250.00 or less)",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'safe_harbor.current_pct', value: 0.8,
    citation: "2025 Form RI-2210 Part 1 line 2 (\"Enter 80% of the amount shown on line 1\") and line 6 (smaller of line 2 or line 5); RI-1040ES \"Charge for underpayment of installments\" (underpayment measured against 80% of the installment). RI uses 80%, not the federal 90%.",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "2025 Form RI-2210 Part 1 line 5-6 (2024 RI tax; smaller of 80% of 2025 tax or 100% of 2024 tax); 2025 RI-1040ES Estimated Tax Worksheet lines 6-7 (\"Enter your 2024 Rhode Island income tax\"; \"Enter the SMALLER of lines 5 or 6\")",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: 2025 Form RI-2210 Part 1 line 5-6 uses 100% of the prior-year RI tax for all taxpayers; 2025 RI-1040ES worksheet line 7 has no income test",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "2025 Form RI-1040ES \"When and where to make estimates\" (April 15, June 15, September 15, 2025; January 15, 2026); RI Division of Taxation ADV 2025-09 (June 13, 2025): personal income tax estimate Form RI-1040ES due June 16, 2025 because June 15, 2025 is a Sunday",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "2025 Form RI-2210 Part 3 line 13 (\"Divide the amount on line 6 by four (4) and enter the result in each column\"); 2025 RI-1040ES worksheet line 14 (divide by number of installments)",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "2025 Form RI-2210 instructions \"Farmer and Fisherman\" (gross income from farming or fishing at least two-thirds of annual gross income; return filed and tax paid on or before March 1, 2026 exempts; otherwise substitute 66.67% for 80% on Part 1 line 2 and pay in Column D, January 15, 2026). March 1, 2026 is a Sunday; file_by rolled to 2026-03-02 (MO convention; RI form prints March 1). Ratio stored just under 2/3 (federal seed convention).",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "R.I. Gen. Laws §44-30-84(b) (estimated-tax underpayment interest \"at the annual rate provided by § 44-1-7\"); §44-1-7(b) (Jan 1 rate = prime on Oct 1 of prior year + 2%, floor 12% for non-trust-fund taxes from 2023); 2025 Form RI-2210 Part 4 lines 19b-21b (12%)",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'penalty.rate', value: 0.12,
    citation: "2025 Form RI-2210 Part 4 lines 19b, 20b, 21b (\"Number of days ... X 12% X underpayment\"); RI Division of Taxation ADV 2025-23 (Nov. 26, 2025): non-trust-fund delinquency rate 12.00% for calendar 2025 and 2026. A TY2025 underpayment accrues at 12% through April 15, 2026 (both calendar years), so a single rate holds.",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "R.I. Gen. Laws §44-30-18(a)-(b) (resident credit for net income taxes of other states incl. DC, limited to RI tax x other-state-derived RI income / entire RI income); 2025 Form RI-1040ES \"Allowable credits\" item 4",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "2025 Form RI-1040NR Schedule II, line 15 (\"RI INCOME TAX. Multiply line 14 by line 13\") - RI tax on all income times the Rhode Island income percentage; 2025 RI-1040NR booklet",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-04", "2025-05-05", "2025-05-26", "2025-06-19", "2025-07-04", "2025-08-11", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-04", "2026-05-25", "2026-06-19", "2026-07-06", "2026-08-10", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-04", "2027-05-31", "2027-06-21", "2027-07-05", "2027-08-09", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-27"
    ],
    citation: "R.I. Gen. Laws §25-1-1 (text read 2026-10-11 audit): Jan 1; 3rd Mon Jan; 3rd Mon Feb; May 4 (RI Independence Day); last Mon May; June 19; July 4; 2nd Mon Aug (Victory Day); 1st Mon Sep; 2nd Mon Oct; Nov 11; Dec 25; Election Day (Tuesday after the first Monday in November in years with a general election of state officers: 2026); \"days of thanksgiving\" appointed by the President or governor (Thanksgiving, 4th Thu Nov). Weekend rules: \"when either of the above days falls on the first day of the week, then the day following it\" (every listed day: e.g. May 4, 2025 is a Sunday -> May 5, 2025 added in audit); state employees observe Jan 1, June 19, July 4, Nov 11 and Dec 25 on the following Monday when on a Saturday or Sunday (those Mondays stored). Calendar years 2025-2027. Dates computed from the statute.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'RI', year: 2026, key: 'has_income_tax', value: true,
    citation: "2026 Form RI-1040ES (Rev. 2026-01), \"Who must make estimated payments\" and 2026 Tax Rate Schedule (3.75% / 4.75% / 5.99%)",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'required_threshold', value: 250,
    citation: "R.I. Gen. Laws §44-30-55(a) ($250 or more in excess of allowable credits); 2026 Form RI-1040ES \"Who must make estimated payments\"",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'safe_harbor.current_pct', value: 0.8,
    citation: "R.I. Gen. Laws §44-30-84(b) (interest on an unpaid installment \"computed on the amount by which his or her actual payments and credits in respect of the tax are less than eighty percent (80%) of the installment at the time it is due\"); 2026 Form RI-1040ES \"Charge for underpayment of installments\" (same 80% language). 2025 Form RI-2210 Part 1 line 2 applies it as 80% of current-year tax.",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "2026 Form RI-1040ES worksheet lines 6-7 (\"Enter your 2025 Rhode Island income tax\"; \"Enter the SMALLER of lines 5 or 6\"); 2025 Form RI-2210 Part 1 lines 5-6 (100% of prior-year tax). The prior-year alternative is NOT in R.I. Gen. Laws §44-30-84(b) (which incorporates only 26 U.S.C. §6654(e)(1)-(2) exceptions); it rests on the RI-2210 form, and the 2026 RI-2210 is not yet published (audit 2026-10-11), so unverified.",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: 2026 Form RI-1040ES worksheet line 7 has no income test; consistent with 2025 Form RI-2210 Part 1",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "2026 Form RI-1040ES \"When and where to make estimates\" (April 15, June 15, September 15, 2026; January 15, 2027). None of these dates is a weekend (Wed/Mon/Tue/Fri) or R.I. Gen. Laws §25-1-1 holiday.",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "R.I. Gen. Laws §44-30-56(a) (\"due dates of equal installments\": April 15; June 15; September 15; January 15 of following year); 2026 Form RI-1040ES worksheet line 14",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Carried forward from 2025 Form RI-2210 instructions \"Farmer and Fisherman\" (two-thirds test, 66.67% in place of 80%, file and pay by March 1); the 2026 RI-2210 and its instructions are not yet published and the 2026 RI-1040ES does not mention farmers. Jan 15, 2027 (Fri) and Mar 1, 2027 (Mon) need no roll.",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "R.I. Gen. Laws §44-30-84(b) and §44-1-7(b) (state-set annual rate); RI Division of Taxation ADV 2025-23 (calendar-2026 rates)",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'penalty.rate', value: 0.12,
    citation: "RI Division of Taxation ADV 2025-23 (Nov. 26, 2025): delinquency interest on non-trust-fund taxes is 12.00% for calendar 2026 (formula: prime + 2%, floor 12%, §44-1-7). CAUTION: the calendar-2027 rate (Jan 1-Apr 15, 2027 days of a TY2026 underpayment) is announced in late 2026 and had not been read.",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "R.I. Gen. Laws §44-30-18(a)-(b) (resident credit, ratio-limited); 2026 Form RI-1040ES \"Allowable credits\" item 4",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "2025 Form RI-1040NR Schedule II line 15 (RI tax times Rhode Island income percentage). The 2026 RI-1040NR booklet is not yet published; 2025 method carried forward.",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2026, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-05-04", "2025-05-05", "2025-05-26", "2025-06-19", "2025-07-04", "2025-08-11", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-04", "2026-05-25", "2026-06-19", "2026-07-06", "2026-08-10", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-04", "2027-05-31", "2027-06-21", "2027-07-05", "2027-08-09", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-27"
    ],
    citation: "R.I. Gen. Laws §25-1-1 (see 2025 row for the list and weekend rules, incl. the Sunday -> Monday rule for every listed day and the Saturday/Sunday -> Monday state-employee rule; Thanksgiving as a \"day of thanksgiving\" appointed by the President/governor; Election Day Nov 3, 2026). Calendar years 2025-2027. Dates computed from the statute.",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'RI', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'RI', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'RI', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
