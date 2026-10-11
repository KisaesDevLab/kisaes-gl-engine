// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// HI state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 3 research, 2026-10-11).
// Every row cites the primary source it was read in; see features/tax-estimator/docs/reviews/phase2-batch3-sources.md.
export const HI_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'HI', year: 2025, key: 'has_income_tax',
    value: true,
    citation: "Form N-15 (Rev. 2025) line 44 (tax from Tax Rate Schedule) and Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part II line 1 (2025 tax liability): Hawaii imposes a graduated individual income tax on residents and nonresidents (HRS ch. 235)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'required_threshold',
    value: 500,
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(1) and Q5(1) ('expect to owe at least $500 in tax ... after subtracting your withholding and credits'); Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part II line 5 (stop if balance less than $500)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.6,
    citation: "Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part II line 6 ('Multiply the amount on line 3 by 60% (.60)'); Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(2) and Estimated Tax Worksheet line 11a (60%)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part II line 7 (tax from 2024 return) and line 8 (smaller of line 6 or 7); Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(2)/worksheet line 11b ('100% of the tax shown on your tax return for the preceding year', which must cover 12 months)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule: Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part II lines 6-8 and Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf worksheet lines 11a-11c use only 60% of current / 100% of prior year for all taxpayers",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-21", "2025-06-20", "2025-09-22", "2026-01-20"],
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q8: April 20, June 20, September 20 of the current year, January 20 next year; 'If the due date ... falls on a Saturday, Sunday, or legal holiday, the payment will be on time if you make it on the next day that is not a Saturday, Sunday, or a holiday'; Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part III prints 4/20/2025, 6/20/2025, 9/20/2025, 1/20/2026. April 20, 2025 was a Sunday (-> Mon Apr 21); Sept 20, 2025 a Saturday (-> Mon Sep 22); roll computed here.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q8 ('four equal amounts'); Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part III line 9 ('All others, enter 1/4 of line 8 in each column')",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.6, "due_date": "2026-01-20", "file_by": "2026-03-01"},
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q13 (two-thirds of gross income from farming or fishing for the preceding or current year: pay all estimated tax by January 20 of the following year, or file the return by March 1 of the following year and pay the total tax); Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part III line 9 ('Farmers and fishermen, enter the amount from line 8 in column (d)'), line 8 = smaller of 60% current-year tax or prior-year tax, hence current_pct 0.60. file_by stored as stated (March 1, 2026 is a Sunday; roll not stated by the source). ratio stored just under 2/3 per MO seed convention.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part IV lines 18-21 compute a Hawaii penalty (months x .00667 x underpayment), not the federal Form 2210 rate",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'penalty.rate',
    value: 0.08,
    citation: "Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part IV line 20 ('Number of months on line 19 x .00667 x underpayment'); .00667 per month = 8% per annum, simple, measured in whole months to the earlier of payment or April 20, 2026",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "Hawaii Schedule CR (Rev. 2025) line 12 ('Income tax paid to another state or foreign country (N-11, N-15, N-40, and N-70NP filers)'), files.hawaii.gov/tax/forms/current/schcr_f.pdf and schcr_i.pdf",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'nonresident_method',
    value: "other",
    citation: "Form N-15 (Rev. 2025) lines 35-44: Hawaii AGI (column B) less standard deduction and exemptions each prorated by the ratio of Hawaii AGI to total AGI (line 37), then tax from the graduated Tax Rate Schedule on the resulting Hawaii taxable income (line 44). Not a flat sourced x rate and not a ratio applied to full-return tax, so classed 'other'.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-03-26", "2025-04-18", "2025-05-26", "2025-06-11", "2025-07-04", "2025-08-15", "2025-09-01", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-03-26", "2026-04-03", "2026-05-25", "2026-06-11", "2026-07-03", "2026-08-21", "2026-09-07", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25"],
    citation: "Hawaii DHRD 'Holidays to be observed in 2025 and 2026' (HRS 8-1), dhrd.hawaii.gov/wp-content/uploads/2025/01/State-Holidays-2025-2026-1.pdf; 2026 dates cross-checked against Hawaii DoTax CY 2026 Calendar of Due Dates ('State Holidays 2026'). Calendar years 2025-2026.",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'HI', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf (rev. Feb 2026) Estimated Tax Worksheet line 6 uses the 2026 Tax Rate Schedules (Schedule I etc.); Hawaii graduated individual income tax, HRS ch. 235",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'required_threshold',
    value: 500,
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(1), Q5(1) and Estimated Tax Worksheet line 13 ('If less than $500, you are not required to make estimated tax payments')",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.6,
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(2) and Estimated Tax Worksheet line 11a ('Multiply line 10 by 60%')",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(2) and worksheet line 11b ('100% of the tax shown on your tax return for the preceding year ... must cover all 12 months')",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule in Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf (worksheet lines 11a-11c: smaller of 60% of current or 100% of prior year for all taxpayers)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-20", "2026-06-22", "2026-09-21", "2027-01-20"],
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q8 (April 20, June 20, September 20 current year; January 20 next year; roll to next day that is not a Saturday, Sunday or holiday); Hawaii DoTax CY 2026 Calendar of Due Dates (4/20 first-quarter estimated taxes). June 20, 2026 is a Saturday (-> Mon Jun 22); Sept 20, 2026 a Sunday (-> Mon Sep 21); none of the rolled dates is on the 2026 state holiday list.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q8 ('four equal amounts') and Estimated Tax Worksheet note ('pay 1/4 of the amount on line 13' on each date)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.6, "due_date": "2027-01-20", "file_by": "2027-03-01"},
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q13 (pay all estimated tax by January 20 of the following year, or file by March 1 of the following year and pay the total tax due); required payment is worksheet line 11c = smaller of 60% of current / 100% of prior year, hence current_pct 0.60. file_by stored as stated.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "2026 Form N-210 not yet published; Hawaii uses its own penalty computed at .00667 per month on the 2025 Form N-210 (Rev. 2025) Part IV line 20. HRS 231-39 and the capitol.hawaii.gov statute pages were blocked (Cloudflare 403) so the 2026-year rate source was not read.",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'penalty.rate',
    value: 0.08,
    citation: "Carried from Form N-210 (Rev. 2025) Part IV line 20 (.00667 per month = 8% per annum). 2026 Form N-210 not yet published; statute HRS 231-39 not readable (capitol.hawaii.gov blocked).",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "Verified for 2025 on Schedule CR (Rev. 2025) line 12; 2026 Schedule CR not yet published (HRS 235-55 not readable, capitol.hawaii.gov blocked), carried forward",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'nonresident_method',
    value: "other",
    citation: "Form N-15 (Rev. 2025) lines 35-44 (deductions/exemptions prorated by Hawaii AGI ratio, graduated rate schedule on Hawaii taxable income); 2026 Form N-15 not yet published, carried forward",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-03-26", "2026-04-03", "2026-05-25", "2026-06-11", "2026-07-03", "2026-08-21", "2026-09-07", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-11", "2027-07-05", "2027-08-20", "2027-09-06", "2027-11-11", "2027-11-25", "2027-12-24"],
    citation: "Hawaii DHRD 'Holidays to be observed in 2026 and 2027' (HRS 8-1), dhrd.hawaii.gov/wp-content/uploads/2026/06/State-Holidays-2026-2027.pdf (created 01/12/2026, subject to change); 2026 dates match DoTax CY 2026 Calendar of Due Dates. Calendar years 2026-2027.",
    status: 'verified',
  },
];
