// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// MD state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 4 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch4-sources.md. Rows marked 'unverified' say why in the citation.
// Audited 2026-10-11: features/tax-estimator/docs/reviews/phase2-audit-batches4-6.md.
export const MD_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------ 2025
  {
    state: 'MD', year: 2025, key: 'has_income_tax', value: true,
    citation: "Md. Form 502UP (2025) General Instructions (Tax-General 10-815 requires estimated payments from individuals with taxable income not subject to Maryland withholding); Form 505NR (2025) Part II (Maryland tax and special nonresident tax)",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'required_threshold', value: 500,
    citation: "Md. Code, Tax-General 10-815(a) (declaration required if estimated tax on income not subject to withholding is expected \"to exceed one-half the amount specified in sec. 6654(e)(1) of the Internal Revenue Code\", i.e. $500) and 13-602(c) (no interest if unpaid tax is less than one-half the 6654(e)(1) amount); Form 502UP (2025) Exception A (\"$500 or less\") and General Instructions (\"more than $500 in excess of the Maryland withholding\"). Statute text read 2026-10-11 on mgaleg.maryland.gov.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Md. Code, Tax-General 13-602(a)(2) (interest if the estimate is \"less than 90% of the tax required to be shown on the return for the current taxable year\" and less than 110% of prior-year tax); Form 502UP (2025) line 8 (\"Multiply Line 7 by 90% (.90)\") and Exception B(2).",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'safe_harbor.prior_pct', value: 1.1,
    citation: "Md. Code, Tax-General 13-602(a)(2)(ii) (\"less than 110% of the tax paid for the prior taxable year, reduced by the credit allowed under sec. 10-703\"); Form 502UP (2025) line 9b (\"Multiply Line 9a by 110% (1.10)\") and Exception B(1). Maryland applies 110% to ALL taxpayers (no AGI test). Note: prior-year tax is measured net of the other-state credit.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No separate high-AGI rule: Maryland's single prior-year test is already 110% of prior-year tax for every taxpayer (Form 502UP (2025) line 9b; Exception B(1)); there is no 100% tier with a 110% high-AGI variant",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Md. Code, Tax-General 10-820(b)(1) (initial declaration April 15; quarterly returns June 15, September 15 and January 15); Form 502UP (2025) line 16 header prints \"June 15, 2025\" and its interest instructions count months from June 15, 2025. June 15, 2025 is a Sunday; stored as June 16, 2025. General Provisions 1-302(b)(1) (a statutory period ending on a Sunday or legal holiday runs to the next day that is not) would give June 16, but it is written for computed periods, and no Maryland document read states a weekend roll for estimated installments (the PVW states it only for extension/return payments). UNVERIFIED roll (audit 2026-10-11).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Md. Code, Tax-General 10-902(a)(1) (\"at least 25% of the estimated income tax shown on the declaration\" with the declaration and each quarterly return); Form 502UP (2025) Exception B (four quarterly payments each at least one-fourth).",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "Md. Code, Tax-General 10-820(c) (estimated gross income from fishing or farming at least 2/3 of total estimated income: declaration by January 15 of the next year OR return by March 1) and 10-902(c) (pay in full by March 1); 13-602(a)(2) (no reduced farmer percentage: 90% current / 110% prior); Form 502UP (2025) \"FARMERS AND FISHERMEN\" (declaration and full payment by January 15, 2026, or file and pay by March 1, 2026; otherwise lines 1-10, column 4 only). current_pct 0.90 verified. file_by: March 1, 2026 is a Sunday; audit rolled it to March 2, 2026 for consistency with the installment roll (General Provisions 1-302(b)(1) Sunday rule; PVW next-business-day rule for return payments), but Maryland does not state the roll for this date, so UNVERIFIED (audit 2026-10-11, was 2026-03-01 verified).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "Md. Code, Tax-General 13-602(a) (interest on underestimated / unpaid installments) and 13-604 (monthly rate = 1/12 of the annual rate the Comptroller sets each calendar year: greater of 9% or prime + 3 points); Form 502UP (2025) line 16 (\"0.9568% per month for due dates prior to January 1, 2026\").",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'penalty.rate', value: 0.114825,
    citation: "Form 502UP (2025) Line 16 instructions (\"11.4825% annual rate\" for periods before Jan 1, 2026; \"10.8133% annual rate\" for the 4th period due Jan 15, 2026; \"0.9011% per month after December 31, 2025\"). CAUTION: single-rate key; the Jan 15, 2026 installment accrues at 10.8133%.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "Md. Code, Tax-General 10-703(b)-(e) (raw statute text read 2026-10-11 on mgaleg.maryland.gov): resident credit for tax on income paid to another state = lesser of the other-state tax or an amount that does not reduce Maryland tax below the tax with that income disregarded; NOT allowed if the other state allows the resident a credit for Maryland tax (reverse-credit states), nor to part-year residents for tax paid while resident elsewhere; split between State and county tax per (e). Audit upgraded from unverified.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "Form 505NR (2025) Part II lines 9, 14-16 (Maryland income factor = Maryland AGI / federal AGI; Maryland tax = tax on all-income taxable net income x nonresident factor; PLUS special nonresident tax 2.25% on Maryland taxable net income, line 17)",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-12", "2025-02-17", "2025-03-25", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-09-12", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-03-25", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-09-12", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-12", "2027-02-15", "2027-03-25", "2027-03-26", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-09-13", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-25"],
    citation: "Md. Code, General Provisions 1-111 (raw statute text read 2026-10-11 on mgaleg.maryland.gov): Jan 1; MLK (Congress-designated day = 3rd Mon Jan); Lincoln's birthday Feb 12; Washington's birthday 3rd Mon Feb; Maryland Day Mar 25; Good Friday; Memorial Day (Congress-designated = last Mon May); Juneteenth June 19; July 4; Labor Day; Defenders' Day Sep 12; Columbus Day (Congress-designated = 2nd Mon Oct); Nov 11; Thanksgiving; American Indian Heritage Day (Friday after Thanksgiving); Dec 25; each statewide general election day (Nov 3, 2026); plus any day the President or Governor designates (not computable); (b) Sunday -> next Monday, Saturday not moved. Calendar 2025-2027 computed (Good Friday Apr 18 2025 / Apr 3 2026 / Mar 26 2027) and re-checked by the auditor. Audit upgraded from unverified.",
    status: 'verified',
  },
  // ------------------------------------------------------------ 2026
  {
    state: 'MD', year: 2026, key: 'has_income_tax', value: true,
    citation: "2025-PV-Worksheet (payment voucher worksheet used for 2026 estimates) Tax Rate Schedules I/II and local-tax rate table \"for tax year 2026\"",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'required_threshold', value: 500,
    citation: "Md. Code, Tax-General 10-815(a) (one-half of the IRC 6654(e)(1) amount = $500) and 13-602(c); 2026 Payment Voucher Worksheet \"Who must file a declaration\" (\"tax of more than $500 in excess of your Maryland withholding\").",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Md. Code, Tax-General 13-602(a)(2)(i) (\"less than 90% of the tax required to be shown on the return for the current taxable year\"), current law read 2026-10-11 on mgaleg.maryland.gov; Form 502UP (2025) line 8. Audit upgraded from unverified: the percentage is statutory, not a form-year choice.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'safe_harbor.prior_pct', value: 1.1,
    citation: "Md. Code, Tax-General 13-602(a)(2)(ii) (110% of prior-year tax reduced by the 10-703 credit); 2026 PVW (\"you must pay at least 110% of your prior year tax to avoid interest\"); Form 502UP (2025) line 9b.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No separate high-AGI rule: the 2026 PVW and Form 502UP (2025) apply 110% of prior-year tax to every taxpayer",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "2026 PVW \"When to file a declaration\" (\"one-fourth ... on or before April 15, 2026. The remaining quarterly payments are due June 15, 2026, September 15, 2026 and January 15, 2027\"); none of the dates is a weekend or Maryland legal holiday.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Md. Code, Tax-General 10-902(a)(1) (at least 25% with the declaration and each quarterly return); 2026 PVW \"When to file a declaration\" (\"at least one-fourth of the total estimated tax ... remaining quarterly payments\").",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.9, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Md. Code, Tax-General 10-820(c), 10-902(c) and 13-602(a)(2) (current law read 2026-10-11: 2/3 farming/fishing income; declaration by January 15 or return and full payment by March 1; required amount is the general 90% current / 110% prior, no farmer reduction); 2026 PVW \"Farmers and fishermen\" (due on or before January 15, 2027; or file and pay by March 1, 2027). Jan 15, 2027 (Fri) and Mar 1, 2027 (Mon) need no roll. Audit upgraded from unverified.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "Md. Code, Tax-General 13-602(a) and 13-604 (Comptroller-set annual rate for each calendar year, applied monthly, floor 9%); Form 502UP (2025) line 16 (0.9011% per month after December 31, 2025).",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'penalty.rate', value: 0.108133,
    citation: "Form 502UP (2025) Line 16 instructions (\"0.9011% per month after December 31, 2025\", \"10.8133% annual rate\"). CAUTION: the calendar-2027 rate (months of a TY2026 underpayment after Dec 31, 2026) had not been published when read; single-rate key.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "Md. Code, Tax-General 10-703(b)-(e) (current law, raw text read 2026-10-11): lesser of other-state tax or the Maryland tax attributable to that income; not allowed where the other state gives the credit; split State/county. Audit upgraded from unverified.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "Form 505NR (2025) Part II lines 9, 14-17 (Maryland income factor = Maryland AGI / federal AGI; Maryland tax x nonresident factor; plus special nonresident tax at 0.0225 on Maryland taxable net income); 2026 PVW local rate table (\"Nonresidents use .0225\" for tax year 2026); Md. Code, Tax-General 10-106.1 (special nonresident tax = lowest county rate). No 2026 Form 505NR yet, so the ratio method itself is carried from the 2025 form: unverified.",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-12", "2025-02-17", "2025-03-25", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-09-12", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-12", "2026-02-16", "2026-03-25", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-04", "2026-09-07", "2026-09-12", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-12", "2027-02-15", "2027-03-25", "2027-03-26", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-09-13", "2027-10-11", "2027-11-11", "2027-11-25", "2027-11-26", "2027-12-25"],
    citation: "Md. Code, General Provisions 1-111 (raw statute text read 2026-10-11; list as in the TY2025 row; Sunday -> Monday, e.g. Sep 12, 2027 -> Sep 13 and July 4, 2027 -> July 5; statewide general election Nov 3, 2026). Calendar 2025-2027 computed and re-checked by the auditor. Audit upgraded from unverified.",
    status: 'verified',
  },
  {
    state: 'MD', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2025, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'MD', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2026, key: 'penalty.method', value: null,
    citation: "Not separately researched; null = daily simple accrual (rate x days / 365, the federal pattern). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'MD', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
