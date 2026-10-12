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
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(1) and Q5(1) ('expect to owe at least $500 in tax ... after subtracting your withholding and credits'); Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part II line 5 (stop if balance less than $500); HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (a)(6): 'In the case of a taxpayer whose tax liability is less than $500, the filing of an estimate and the payment of estimated tax shall not be required.'",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.6,
    citation: "Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part II line 6 ('Multiply the amount on line 3 by 60% (.60)'); Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(2) and Estimated Tax Worksheet line 11a (60%); HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f)(4): 'the required annual payment shall be the lesser of sixty per cent of the tax shown on the return for the taxable year ... or one hundred per cent of the tax shown on the return of the individual for the preceding taxable year'",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part II line 7 (tax from 2024 return) and line 8 (smaller of line 6 or 7); Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(2)/worksheet line 11b ('100% of the tax shown on your tax return for the preceding year', which must cover 12 months); HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f)(4) (lesser of 60% of current-year tax or 100% of the preceding year's tax)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule: Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part II lines 6-8 and Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf worksheet lines 11a-11c use only 60% of current / 100% of prior year for all taxpayers; HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f)(4) replaces the IRC 6654(d) required annual payment with the 60%/100% test for all individuals, so the federal 110% high-AGI rule does not apply",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-21", "2025-06-20", "2025-09-22", "2026-01-20"],
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q8: April 20, June 20, September 20 of the current year, January 20 next year; 'If the due date ... falls on a Saturday, Sunday, or legal holiday, the payment will be on time if you make it on the next day that is not a Saturday, Sunday, or a holiday'; Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part III prints 4/20/2025, 6/20/2025, 9/20/2025, 1/20/2026. April 20, 2025 was a Sunday (-> Mon Apr 21); Sept 20, 2025 a Saturday (-> Mon Sep 22); roll computed here.; HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (a)(1)-(2) (voucher and first quarter by April 20; 'on the twentieth day of June and September'; fourth quarter 'by January 20 of the year following'); HRS 1-32 (Sunday/holiday -> next business day)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q8 ('four equal amounts'); Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part III line 9 ('All others, enter 1/4 of line 8 in each column'); HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (a)(2) ('payment of one-quarter of the estimated tax' with each voucher)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666666, "current_pct": 0.6, "due_date": "2026-01-20", "file_by": "2026-03-02"},
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q13 (at least two-thirds of gross income from farming or fishing for the preceding or current year: pay all estimated tax by January 20 of the following year, or file the current year return by March 1 of the following year and pay the total tax); Instructions for Form N-210 (2025), files.hawaii.gov/tax/forms/2025/n210ins.pdf p.1 'Farmers and fishermen' (two-thirds test for 2024 or 2025; 'filed your Hawaii return and paid the entire tax due by March 1, 2026') and p.2 (farmers: skip columns (a)-(c); line 9 column (d) = full Part II line 8); Form N-210 (Rev. 2025) Part II line 6 ('Multiply the amount on line 3 by 60% (.60)') and line 8 (smaller of line 6 or 7) -> current_pct 0.60. HRS 235-97(f)(4) makes IRC 6654(i) operative with due dates 'deemed to be the twentieth day of the applicable month' and sets the required annual payment at 60%/100%; the Department applies 60% (not the federal 66 2/3%) to farmers. March 1, 2026 is a Sunday -> Monday March 2, 2026 per HRS 1-32 ('falls upon a Sunday or holiday, the act may be performed upon the next business day'); roll computed here (form prints March 1, 2026). ratio stored just under 2/3 (federal/MO seed convention) so an exactly-2/3 farmer qualifies.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part IV lines 18-21 compute a Hawaii penalty (months x .00667 x underpayment), not the federal Form 2210 rate; HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f): underpayment addition 'at the rate of two-thirds of one per cent a month or fraction of a month'",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'penalty.rate',
    value: 0.08,
    citation: "Form N-210 (Rev. 2025), Underpayment of Estimated Tax Part IV line 20 ('Number of months on line 19 x .00667 x underpayment'); .00667 per month = 8% per annum, simple, measured in whole months to the earlier of payment or April 20, 2026; HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f) ('two-thirds of one per cent a month or fraction of a month' = 8%/yr, simple, whole/partial months); same rate in HRS 231-39(b)(4)(A)",
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
    citation: "Hawaii DHRD 'Holidays to be observed in 2025 and 2026' (HRS 8-1), dhrd.hawaii.gov/wp-content/uploads/2025/01/State-Holidays-2025-2026-1.pdf; 2026 dates cross-checked against Hawaii DoTax CY 2026 Calendar of Due Dates ('State Holidays 2026'). Calendar years 2025-2026.; statute HRS 8-1 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol01_Ch0001-0042F/HRS0008/HRS_0008-0001.htm): Jan 1; 3rd Mon Jan; 3rd Mon Feb; Mar 26 (Prince Kuhio Day); Good Friday; last Mon May; Jun 11 (Kamehameha Day); Jul 4; 3rd Fri Aug (Statehood Day); 1st Mon Sep; Nov 11; 4th Thu Nov; Dec 25; 'All election days, except primary and special election days' (general election in even years: Nov 3, 2026). Observed dates for Saturday/Sunday holidays taken from the DHRD lists (e.g. Jul 4, 2026 -> Jul 3; Dec 25, 2027 -> Dec 24). 2027 Good Friday coincides with Prince Kuhio Day (Mar 26, 2027).",
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
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(1), Q5(1) and Estimated Tax Worksheet line 13 ('If less than $500, you are not required to make estimated tax payments'); HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (a)(6): 'In the case of a taxpayer whose tax liability is less than $500, the filing of an estimate and the payment of estimated tax shall not be required.'",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.6,
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(2) and Estimated Tax Worksheet line 11a ('Multiply line 10 by 60%'); HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f)(4): 'the required annual payment shall be the lesser of sixty per cent of the tax shown on the return for the taxable year ... or one hundred per cent of the tax shown on the return of the individual for the preceding taxable year'",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q4(2) and worksheet line 11b ('100% of the tax shown on your tax return for the preceding year ... must cover all 12 months'); HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f)(4) (lesser of 60% of current-year tax or 100% of the preceding year's tax)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule in Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf (worksheet lines 11a-11c: smaller of 60% of current or 100% of prior year for all taxpayers); HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f)(4) replaces the IRC 6654(d) required annual payment with the 60%/100% test for all individuals, so the federal 110% high-AGI rule does not apply",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-20", "2026-06-22", "2026-09-21", "2027-01-20"],
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q8 (April 20, June 20, September 20 current year; January 20 next year; roll to next day that is not a Saturday, Sunday or holiday); Hawaii DoTax CY 2026 Calendar of Due Dates (4/20 first-quarter estimated taxes). June 20, 2026 is a Saturday (-> Mon Jun 22); Sept 20, 2026 a Sunday (-> Mon Sep 21); none of the rolled dates is on the 2026 state holiday list.; HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (a)(1)-(2) (voucher and first quarter by April 20; 'on the twentieth day of June and September'; fourth quarter 'by January 20 of the year following'); HRS 1-32 (Sunday/holiday -> next business day)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q8 ('four equal amounts') and Estimated Tax Worksheet note ('pay 1/4 of the amount on line 13' on each date); HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (a)(2) ('payment of one-quarter of the estimated tax' with each voucher)",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'farmer.rule',
    value: {"ratio": 0.6666666666, "current_pct": 0.6, "due_date": "2027-01-20", "file_by": "2027-03-01"},
    citation: "Hawaii Tax Facts 2019-3, 'Estimated Income Tax for Individuals' (rev. Feb 2026), files.hawaii.gov/tax/legal/taxfacts/tf2019-3.pdf Q13 (two-thirds of gross income from farming or fishing for the preceding or current year: pay all estimated tax by January 20 of the following year, or file by March 1 of the following year and pay the total tax due); required payment is worksheet line 11c = smaller of 60% of current / 100% of prior year, hence current_pct 0.60; HRS 235-97(f)(4) (read 2026-10-11) makes IRC 6654(i) operative with the 60%/100% required annual payment. January 20, 2027 is a Wednesday and March 1, 2027 a Monday (no roll). ratio stored just under 2/3 (federal/MO seed convention).",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f): 'In the case of any underpayment of estimated tax ... there shall be added to the tax for the taxable year an amount determined at the rate of two-thirds of one per cent a month or fraction of a month upon the amount of the underpayment for the period of the underpayment' -- a Hawaii statutory rate, not the federal IRC 6621 rate; computed on 2025 Form N-210 (Rev. 2025) Part IV line 20 (.00667 per month). Statute is not year-specific; 2026 Form N-210 not yet published.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'penalty.rate',
    value: 0.08,
    citation: "HRS 235-97 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0097.htm) subsection (f) ('two-thirds of one per cent a month or fraction of a month' = 8% per annum, simple, counted in months or fractions of a month to the earlier of payment or the 20th day of the 4th month after year end); Form N-210 (Rev. 2025) Part IV line 20 (.00667). Statute is not year-specific; 2026 Form N-210 not yet published.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "HRS 235-55(a) (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0055.htm): a resident who 'has become liable for income taxes to a state ... upon any part of the individual's ... taxable income ... derived or received from sources without the State' is credited 'the tax so paid', limited by 235-55(b)(2) to the Hawaii tax on that income; claimed on Schedule CR (Rev. 2025) line 12. Statute is not year-specific; 2026 Schedule CR not yet published.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'nonresident_method',
    value: "other",
    citation: "HRS 235-5 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol04_Ch0201-0257/HRS0235/HRS_0235-0005.htm): income from Hawaii sources determined 'by an allocation and separate accounting' and deductions not connected with particular income 'allowed only to the extent of the ratio of the adjusted gross income attributed to this State to the entire adjusted gross income'; Form N-15 (Rev. 2025) lines 35-44 then applies the graduated Tax Rate Schedule to the resulting Hawaii taxable income. Not a flat sourced x rate and not a ratio applied to full-return tax, so 'other'. Statute is not year-specific; 2026 Form N-15 not yet published.",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-03-26", "2026-04-03", "2026-05-25", "2026-06-11", "2026-07-03", "2026-08-21", "2026-09-07", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-11", "2027-07-05", "2027-08-20", "2027-09-06", "2027-11-11", "2027-11-25", "2027-12-24"],
    citation: "Hawaii DHRD 'Holidays to be observed in 2026 and 2027' (HRS 8-1), dhrd.hawaii.gov/wp-content/uploads/2026/06/State-Holidays-2026-2027.pdf (created 01/12/2026, subject to change); 2026 dates match DoTax CY 2026 Calendar of Due Dates. Calendar years 2026-2027.; statute HRS 8-1 (read 2026-10-11 at data.capitol.hawaii.gov/hrscurrent/Vol01_Ch0001-0042F/HRS0008/HRS_0008-0001.htm): Jan 1; 3rd Mon Jan; 3rd Mon Feb; Mar 26 (Prince Kuhio Day); Good Friday; last Mon May; Jun 11 (Kamehameha Day); Jul 4; 3rd Fri Aug (Statehood Day); 1st Mon Sep; Nov 11; 4th Thu Nov; Dec 25; 'All election days, except primary and special election days' (general election in even years: Nov 3, 2026). Observed dates for Saturday/Sunday holidays taken from the DHRD lists (e.g. Jul 4, 2026 -> Jul 3; Dec 25, 2027 -> Dec 24). 2027 Good Friday coincides with Prince Kuhio Day (Mar 26, 2027).",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2025, key: 'return_due_date', value: "2026-04-20",
    citation: "Form N-210 (2025) Instructions Part IV, files.hawaii.gov/tax/forms/2025/n210ins.pdf, read 2026-10-12: period of underpayment counted \"to and including the date of payment or April 20, 2026, whichever is earlier\".",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2025, key: 'penalty.method', value: "monthly_or_fraction",
    citation: "Form N-210 (2025) Instructions Part IV, files.hawaii.gov/tax/forms/2025/n210ins.pdf, read 2026-10-12: \"The underpayment penalty is computed on a monthly basis ... at the rate of 2/3% (.00667) a month or part of a month\"; \"A part of a month is counted as one month.\" penalty.rate 0.08 is the nominal annual equivalent (2/3% x 12). HRS §235-97(f).",
    status: 'verified',
  },
  {
    state: 'HI', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'HI', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'return_due_date', value: "2027-04-20",
    citation: "Hawaii individual return due the 20th day of the 4th month (Form N-210 2025 Part IV pattern: April 20 ends the penalty period). April 20, 2027 is a Tuesday. 2026 N-210 not read.",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'penalty.method', value: "monthly_or_fraction",
    citation: "Form N-210 (2025) Instructions Part IV, files.hawaii.gov/tax/forms/2025/n210ins.pdf, read 2026-10-12 (2025 form; 2026 N-210 not yet published): 2/3% a month or part of a month. HRS §235-97(f).",
    status: 'unverified',
  },
  {
    state: 'HI', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
