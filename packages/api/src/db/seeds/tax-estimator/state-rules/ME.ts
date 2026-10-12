// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// ME state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 4 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch4-sources.md. Rows marked 'unverified' say why in the citation.
// Audited 2026-10-11: features/tax-estimator/docs/reviews/phase2-audit-batches4-6.md.
export const ME_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------ 2025
  {
    state: 'ME', year: 2025, key: 'has_income_tax', value: true,
    citation: "36 M.R.S. 5111 (tax imposed on Maine taxable income of residents; separate paragraph for nonresidents on Maine adjusted gross income); Form 1040ES-ME 2025 instructions item 2 (tax rate schedules 5.8%/6.75%/7.15%)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'required_threshold', value: 1000,
    citation: "36 M.R.S. 5228(2)(C)-(D) (estimates waived if current-year liability net of withholding and allowable credits \"is less than $1,000\" OR the person \"had less than $1,000 tax liability ... for the preceding taxable year\"; the prior-year waiver \"does not apply with respect to an unusual event\"); Form 1040ES-ME 2025 Instructions item 1 (\"$1,000 or more and if your tax liability for the prior year was also $1,000 or more\"); Form 2210ME (2025) Instructions \"Who Must Pay the Underpayment Penalty?\" (prior-year liability measured \"before tax credits, income tax withholding or any other tax payment(s)\"). CAUTION: two-part test; the single-value key carries only the current-year $1,000 (audit 2026-10-11).",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form 1040ES-ME 2025 Instructions item 2(b) (\"An amount equal to 90% of the tax liability for the current taxable year\"); 36 M.R.S. 5228(3)(B)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form 1040ES-ME 2025 Instructions item 2(a) (\"An amount equal to the preceding year's tax liability, if the preceding year was a taxable year of 12 months\"; required payment is the smaller of (a) and (b)); 36 M.R.S. 5228(3)(A)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI variant: Form 1040ES-ME 2025 Instructions item 2 and 36 M.R.S. 5228(3) use 100% of prior-year tax with no income test (only the unusual-event-income rule, 90% on income that rises $500,000+ over the same quarter of the prior year, which this key cannot express)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "36 M.R.S. 5228(4) (15th day of the 4th, 6th, 9th and 13th months); Form 1040ES-ME 2025 Instructions item 3 (\"four equal installments on April 15, 2025, June 16, 2025, September 15, 2025, and January 15, 2026\"); Form 2210ME (2025) line 9 column dates (April 15, 2025; June 16, 2025; Sept. 15, 2025; Jan. 15, 2026); 36 M.R.S. 153(2) (Saturday/Sunday/legal-holiday roll). June 15, 2025 is a Sunday.",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form 1040ES-ME 2025 Instructions item 3 (\"pay in four equal installments\"); 36 M.R.S. 5228(4),(5)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-02"},
    citation: "36 M.R.S. 5228(1)(B-1) (farmer = IRC 6654(i)(2) test, two-thirds of gross income), 5228(3)(B) (66 2/3% of current-year tax), 5228(4) (single installment the 15th day of the 13th month), 5228(10) (no penalty if return filed and tax paid by the first day of the 3rd month after year end); Form 1040ES-ME 2025 Instructions item 4 (single installment by January 15, 2026; file and pay by March 1, 2026) and item 6 (66 2/3%); Form 2210ME (2025) line 2. March 1, 2026 is a Sunday: rolled to March 2, 2026 under 36 M.R.S. 153(2) (act due on a Saturday, Sunday or legal holiday is timely on the next succeeding day that is not). Ratio stored just under 2/3 (federal seed convention). Audit 2026-10-11 corrected file_by from 2026-03-01.",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "36 M.R.S. 5228(5) (penalty \"at the rate set under section 186\"); 36 M.R.S. 186 (rate = prime rate on Sept 1 of the preceding year rounded up to next whole percent, plus 1 point, for years beginning on or after Jan 1, 2018)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'penalty.rate', value: 0.1,
    citation: "Form 2210ME (2025) Underpayment of Estimated Tax by Individuals, Estates, or Trusts, Instructions \"Computation of Underpayment Penalty\" (\"The penalty rate for calendar year 2025 is .8333% per month or fraction thereof, compounded monthly. For calendar year 2026, the penalty rate is .75% per month\"; 12-month factor .101066); 36 M.R.S. 5228(5) (penalty at the rate provided pursuant to section 186) and 186 (prime rate on Sept 1 of the preceding year rounded up plus 1 point, compounded monthly). CAUTION: single-rate key; months falling in calendar 2026 accrue at 9%, and the statutory rate is monthly-compounded per month or fraction (not daily simple). Audit 2026-10-11 replaced the corporate Form 2220ME citation with the individual Form 2210ME.",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "36 M.R.S. 5217-A (as repealed and replaced by PL 2025, c. 650, Pt. N, sec. 4: resident credit for income tax imposed by another state, a political subdivision, DC or an analogous foreign jurisdiction on income derived from sources there, limited (sub-sec. 4) to Maine tax x other-jurisdiction-source Maine AGI / entire Maine AGI; sourcing per a section 5142 equivalent). Read 2026-10-11 on legislature.maine.gov.",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "36 M.R.S. 5111 (nonresident tax = tax computed as if a resident, multiplied by the ratio of the nonresident's Maine adjusted gross income to total adjusted gross income); 36 M.R.S. 5142 (Maine-source AGI)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-21", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-20", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-19", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "Corrected per R5 review m8 (Maine BHR holiday schedule: Friday after Thanksgiving added; July 4, 2026 observed July 3); not re-read in this task. Previous citation: 4 M.R.S. 1051 Legal holidays (read 2026-10-11: Jan 1; MLK 3rd Mon Jan; Washington's Birthday 3rd Mon Feb; Patriot's Day 3rd Mon Apr; Memorial Day last Mon May; Juneteenth June 19; July 4; Labor Day; Indigenous Peoples Day 2nd Mon Oct; Veterans Day Nov 11; Thanksgiving; Christmas; \"When any one of the holidays named in this section falls on Sunday, the Monday following must be observed\"). Saturday holidays not moved. Used by 36 M.R.S. 153(2) (\"legal holiday in this State\"). Calendar 2025-2027 computed from the statute and re-checked by the auditor.",
    status: 'unverified',
  },
  // ------------------------------------------------------------ 2026
  {
    state: 'ME', year: 2026, key: 'has_income_tax', value: true,
    citation: "36 M.R.S. 5111 (tax imposed on Maine taxable income of residents; separate paragraph for nonresidents on Maine adjusted gross income); Form 1040ES-ME 2026 instructions item 2 (tax rate schedules 5.8%/6.75%/7.15%)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'required_threshold', value: 1000,
    citation: "36 M.R.S. 5228(2)(C)-(D) (waived if current-year liability net of withholding/credits is less than $1,000 OR prior-year liability was less than $1,000; prior-year waiver not available for an unusual event); Form 1040ES-ME 2026 Instructions item 1 (\"$1,000 or more and if your tax liability for the prior year was also $1,000 or more\"). CAUTION: two-part test; the single-value key carries only the current-year $1,000 (audit 2026-10-11).",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form 1040ES-ME 2026 Instructions item 2(b) (\"An amount equal to 90% of the tax liability for the current taxable year\"); 36 M.R.S. 5228(3)(B)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form 1040ES-ME 2026 Instructions item 2(a) (\"An amount equal to the preceding year's tax liability, if the preceding year was a taxable year of 12 months\"; required payment is the smaller of (a) and (b)); 36 M.R.S. 5228(3)(A)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI variant: Form 1040ES-ME 2026 Instructions item 2 and 36 M.R.S. 5228(3) use 100% of prior-year tax with no income test (only the unusual-event-income rule, 90% on income that rises $500,000+ over the same quarter of the prior year, which this key cannot express)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Form 1040ES-ME 2026 Instructions item 3 (four equal installments April 15, June 15, September 15 and January 15) and the printed Estimated Tax Payment Vouchers; 36 M.R.S. 5228(4) (4th, 6th, 9th and 13th months). No date falls on a weekend or 4 M.R.S. 1051 holiday.",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form 1040ES-ME 2026 Instructions item 3 (\"pay in four equal installments\"); 36 M.R.S. 5228(4),(5)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'farmer.rule', value: {"ratio": 0.6666666666, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "36 M.R.S. 5228(1)(B-1), (3)(B), (4), (10); Form 1040ES-ME 2026 Instructions item 4 (\"a single installment due on or before January 15, 2027. If you file your 2026 individual income tax return on or before March 1, 2027, and pay the total tax at that time, you need not make an estimated tax payment\") and item 6 (66 2/3%). January 15, 2027 (Friday) and March 1, 2027 (Monday) need no roll under 36 M.R.S. 153(2). Ratio stored just under 2/3 (federal seed convention).",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "36 M.R.S. 5228(5) (penalty \"at the rate set under section 186\"); 36 M.R.S. 186 (rate = prime rate on Sept 1 of the preceding year rounded up to next whole percent, plus 1 point, for years beginning on or after Jan 1, 2018)",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'penalty.rate', value: 0.09,
    citation: "Form 2210ME (2025) Instructions (\"For calendar year 2026, the penalty rate is .75% per month or fraction thereof, compounded monthly\"), i.e. 9% a year; 36 M.R.S. 5228(5) and 186. CAUTION: the calendar-2027 rate (months of a TY2026 underpayment after Dec 31, 2026) is set from the Sept 1, 2026 prime rate and was not read; monthly compounding per month or fraction is not expressible. Audit 2026-10-11 replaced the corporate Form 2220ME citation with the individual Form 2210ME.",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "36 M.R.S. 5217-A (PL 2025, c. 650, Pt. N, sec. 4: resident credit for other-state/DC/subdivision income tax on income sourced there, plus distributive share of substantially similar pass-through entity tax; limited to Maine tax x that jurisdiction's share of Maine AGI). Read 2026-10-11 on legislature.maine.gov.",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "36 M.R.S. 5111(4) (\"the tax computed ... as if the nonresident individual were a resident individual, multiplied by the ratio of the nonresident individual's Maine adjusted gross income ... to the nonresident individual's entire federal adjusted gross income\"); 36 M.R.S. 5142 (Maine-source AGI). Note 5111(7): from TY2026 a 2% surcharge applies to Maine taxable income above a threshold (affects tax, not the method).",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-04-21", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-20", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-04-19", "2027-05-31", "2027-06-19", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-25"],
    citation: "Corrected per R5 review m8 (Maine BHR holiday schedule: Friday after Thanksgiving added; July 4, 2026 observed July 3); not re-read in this task. Previous citation: 4 M.R.S. 1051 Legal holidays (read 2026-10-11; same list as TY2025; Sunday -> following Monday, e.g. July 4, 2027 -> July 5, 2027; Saturday not moved). Used by 36 M.R.S. 153(2). Calendar 2025-2027 computed from the statute and re-checked by the auditor.",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2025, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2025 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'ME', year: 2025, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2025, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2025, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2025, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2025, key: 'penalty.method', value: "monthly_compound",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md Part B2 / D3: 2210ME .8333%/month (2025) and .75%/month (2026) per month or fraction, compounded monthly); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2025, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2026, key: 'estimates_required', value: true,
    citation: "Quarterly individual estimated-tax regime: the state's own installment schedule (same primary source as this state's 2026 installments.due_dates row). R5 key (2026-10-12).",
    status: 'verified',
  },
  {
    state: 'ME', year: 2026, key: 'threshold_comparison', value: null,
    citation: "No separate boundary wording recorded for this state; null = 'at least' (the required_threshold default). Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2026, key: 'installments.q4_file_and_pay_date', value: null,
    citation: "No January file-and-pay relief recorded for this state (not researched in R5); null = none applied, so an early filer may see a last-installment penalty the state would waive. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2026, key: 'return_due_date', value: null,
    citation: "Not separately researched; null = April 15 of the following year ends the penalty period. R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2026, key: 'penalty.rate_schedule', value: null,
    citation: "No dated rate schedule recorded; the single penalty.rate applies to every penalty day. Not confirmed that the state's rate is unchanged across Jan 1 / mid-year resets (R5 Part D3). R5 key (2026-10-12).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2026, key: 'penalty.method', value: "monthly_compound",
    citation: "Per R5 review (features/tax-estimator/docs/reviews/R5-state-rules-sample.md Part B2 / D3: 2210ME .8333%/month (2025) and .75%/month (2026) per month or fraction, compounded monthly); primary source not re-read in this task (agency page blocked or not reached).",
    status: 'unverified',
  },
  {
    state: 'ME', year: 2026, key: 'penalty.min_balance_due', value: null,
    citation: "No separate penalty floor found in the sources read for this state; null = the floor equals required_threshold. Not researched in R5. R5 key (2026-10-12).",
    status: 'unverified',
  },
];
