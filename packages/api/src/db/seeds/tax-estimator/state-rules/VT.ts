// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// VT state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 6 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch6-sources.md. The CPA signs off VT (D12).
// Sources: 32 V.S.A. §§5851, 5852, 5855; 1 V.S.A. §371; Form IN-114 (2025, 2026) and instructions;
// IN-111 2025 instructions; tax.vermont.gov Interest Rates page (32 V.S.A. §3108).
export const VT_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'VT', year: 2025, key: 'has_income_tax', value: true,
    citation: "32 V.S.A. §5822 (income tax on individuals) as referenced in §5852(a); 2025 Form IN-114 Instructions, 2025 Preliminary Vermont Tax Rates (3.35%-8.75%)",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'required_threshold', value: 500,
    citation: "32 V.S.A. §5855(b)(1) (no interest or penalty for underpayment of estimated tax if the tax shown on the return \"reduced by the amount deducted and withheld ... is less than $500.00\"); 2025 Form IN-114 Instructions and 2025 IN-111 Instructions Line 31 (\"If the tax liability due, less withholding, is less than $500, you will not be subject to penalty or interest charges\"). Same semantics as the federal $1,000 de minimis of IRC §6654(e)(1) (the key's meaning: no estimates needed below this amount after withholding). §5852(a) itself has no dollar floor. Audit 2026-10-11 upgraded from unverified.",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "32 V.S.A. §5851(2)(A) (\"Required annual payment\" = lesser of 90 percent of the tax shown on the return); 2025 Form IN-114 Instructions (\"2) 90% of this year's tax liability\")",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "32 V.S.A. §5851(2)(B) (100 percent of the tax shown on the preceding 12-month year's return); 2025 Form IN-114 Instructions (\"1) 100% of last year's tax liability\")",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: 32 V.S.A. §5851(2) uses 100% of prior-year tax with no income test; 2025 Form IN-114 Instructions",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "32 V.S.A. §5852(a) (April 15, June 15, September 15 and January 15); 2025 Form IN-114 Instructions \"When Are Estimated Income Tax Payments Due?\" (April 15, June 16, September 15, 2025; January 15, 2026 - June 15, 2025 was a Sunday)",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "32 V.S.A. §5852(a) (\"The amount of each payment shall be 25 percent of the required annual payment\"); 2025 Form IN-114 Instructions (\"four equal amounts\")",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'farmer.rule', value: null,
    citation: "MAPPING (key set cannot express): Vermont exempts a person receiving at least two-thirds of income from farming or fishing from estimated payments entirely - 32 V.S.A. §5852(a) (\"other than a person receiving at least two-thirds of his or her income from farming or fishing as defined under the laws of the United States\"); IN-114 Instructions \"Who Must Make Estimated Income Tax Payments?\". No reduced-payment/January-15 alternative exists, so null is stored. Primary sources: 32 V.S.A. §5852(a); 2025 Form IN-114 Instructions.",
    status: 'unverified',
  },
  {
    state: 'VT', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "32 V.S.A. §5855(a) (interest and penalty provisions of the chapter apply to estimated-tax underpayments) and §3108 (Commissioner sets the annual interest rate); tax.vermont.gov Interest Rates page",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'penalty.rate', value: 0.085,
    citation: "32 V.S.A. §3108(a) (annual rate = average prime for the 12 months from Oct 1 of the prior year, rounded up to 1/4%); tax.vermont.gov Interest Rates page: underpayment rate 8.5% for 2025 and 7.75% for 2026; Worksheet IN-152 (2025) lines 9a/9b (8.50% for 2025 days, 7.75% for 2026 days). CAUTION (audit 2026-10-11): (1) days in 2026 accrue at 7.75%; (2) IN-152 lines 12-14 ALSO charge a PENALTY of 1% per month (part month = whole month) on each quarter's underpayment, on top of this interest - not representable by the single-rate key, so the engine understates the Vermont charge.",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "32 V.S.A. §5825(a) (credit for taxes paid to other states and provinces); 2025 Form IN-111 Instructions, Line 17 (\"Credit for Income Tax Paid To Other State or Canadian Province\"; Schedule IN-117)",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "32 V.S.A. §5822(e) (tax reduced by the percentage of AGI that is not Vermont income); 2025 Form IN-111 Instructions, Lines 15-16 (Income Adjustment percentage from Schedule IN-113 line 35 multiplied by the Vermont income tax on line 14)",
    status: 'verified',
  },
  {
    state: 'VT', year: 2025, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-03-04", "2025-05-26", "2025-06-19", "2025-07-04", "2025-08-15", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-03-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-08-17", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-02", "2027-05-31", "2027-06-18", "2027-07-05", "2027-08-16", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24"
    ],
    citation: "1 V.S.A. §371(a) (Jan 1; 3rd Mon Jan; 3rd Mon Feb; Town Meeting Day, 1st Tue Mar; last Mon May; Juneteenth June 19; July 4; Bennington Battle Day Aug 16; 1st Mon Sep; Indigenous Peoples' Day, 2nd Mon Oct; Nov 11; Thanksgiving; Dec 25) and §371(b) (state offices observe a Saturday holiday on the preceding Friday and a Sunday holiday on the following Monday; observed dates stored). Calendar years 2025-2027. Dates computed from the statute.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'VT', year: 2026, key: 'has_income_tax', value: true,
    citation: "32 V.S.A. §5822; 2026 Form IN-114 Instructions, 2026 Preliminary Vermont Tax Rates",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'required_threshold', value: 500,
    citation: "32 V.S.A. §5855(b)(1) (tax less Vermont withholding under $500.00 -> no interest or penalty); 2026 Form IN-114 Instructions (\"If the tax liability due is less than $500, you will not be subject to penalty or interest charges\"). De minimis with the same semantics as IRC §6654(e)(1). Audit 2026-10-11 upgraded from unverified.",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "32 V.S.A. §5851(2)(A); 2026 Form IN-114 Instructions (\"90% of this year's tax liability\")",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "32 V.S.A. §5851(2)(B); 2026 Form IN-114 Instructions (\"100% of last year's tax liability\")",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: 32 V.S.A. §5851(2); 2026 Form IN-114 Instructions",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "32 V.S.A. §5852(a); 2026 Form IN-114 Instructions (April 15, June 15, September 15, 2026; January 15, 2027). None is a weekend or 1 V.S.A. §371 holiday.",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "32 V.S.A. §5852(a) (25 percent each); 2026 Form IN-114 Instructions (\"four equal amounts\")",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'farmer.rule', value: null,
    citation: "MAPPING (key set cannot express): Vermont exempts a person receiving at least two-thirds of income from farming or fishing from estimated payments entirely - 32 V.S.A. §5852(a) (\"other than a person receiving at least two-thirds of his or her income from farming or fishing as defined under the laws of the United States\"); IN-114 Instructions \"Who Must Make Estimated Income Tax Payments?\". No reduced-payment/January-15 alternative exists, so null is stored. Primary sources: 32 V.S.A. §5852(a); 2026 Form IN-114 Instructions.",
    status: 'unverified',
  },
  {
    state: 'VT', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "32 V.S.A. §3108 and §5855(a); tax.vermont.gov Interest Rates page",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'penalty.rate', value: 0.0775,
    citation: "32 V.S.A. §3108(a); tax.vermont.gov Interest Rates page (underpayment annual rate 7.75% for calendar 2026). CAUTION (audit 2026-10-11): the calendar-2027 rate (set by December 15, 2026) governs days after Dec 31, 2026 and was not yet published; and Worksheet IN-152 (2025 edition) adds a 1%-per-month penalty (part month = whole month) on each quarter's underpayment on top of interest, which the single-rate key cannot express.",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "32 V.S.A. §5825(a) (resident credit for income taxes imposed by and paid to another state, territory, DC or Canadian province on income from sources there, capped at the Vermont tax attributable to that AGI); Schedule IN-117. Statute text read in audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "32 V.S.A. §5822(e) (tax \"shall be reduced by a percentage equal to the portion of adjusted gross income that is not Vermont income\" - i.e. full tax x Vermont income / AGI); 2025 Form IN-111 Instructions Lines 15-16 (Schedule IN-113 income-adjustment percentage). Statute text read in audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'VT', year: 2026, key: 'holidays', value: [
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-03-04", "2025-05-26", "2025-06-19", "2025-07-04", "2025-08-15", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25",
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-03-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-08-17", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-02", "2027-05-31", "2027-06-18", "2027-07-05", "2027-08-16", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24"
    ],
    citation: "1 V.S.A. §371(a)-(b) (see 2025 row). Calendar years 2025-2027. Dates computed from the statute.",
    status: 'verified',
  },
];
