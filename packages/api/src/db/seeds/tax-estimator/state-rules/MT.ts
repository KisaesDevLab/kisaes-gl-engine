// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// MT state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 4 research, 2026-10-11).
// Every row cites the primary source it was read in; see
// features/tax-estimator/docs/reviews/phase2-batch4-sources.md. Rows marked 'unverified' say why in the citation.
export const MT_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------ 2025
  {
    state: 'MT', year: 2025, key: 'has_income_tax', value: true,
    citation: "Form EST-I (2025) 2025 Montana Income Tax Rates (4.7%/5.9% ordinary, 3.0%/4.1% net long-term capital gains)",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'required_threshold', value: 500,
    citation: "Form EST-I (2025) Instructions (\"Your 2025 income tax liability after tax credits and withholding is less than $500\" is an exception) and Montana \"Making Estimated Tax Payments\" page (\"estimate you will owe more than $500\")",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Form EST-I (2025) Instructions (\"at least 90% of your current year income tax liability\"); Part I line 2 (\"Multiply line 1 by 90%\")",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Form EST-I (2025) Instructions (\"or 100% of your previous year income tax liability\"); Part I line 5 (2024 tax liability)",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: Form EST-I (2025) Instructions and Montana Publication 1 (2026) use 100% of prior-year liability for all taxpayers",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'installments.due_dates', value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Form EST-I (2025) Instructions, Part II Line 4 (\"Column B ... through June 16, 2025\"; \"Column D ... through January 15, 2026\"); Montana \"Making Estimated Tax Payments\" page (\"If the due date falls on a weekend or holiday, payments are due on the next business day\")",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Form EST-I (2025) Part II line 1 (\"For most taxpayers, this is one-fourth of the required annual payment\")",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'farmer.rule', value: null,
    citation: "Montana has NO farmer installment/Jan-15 rule: Form EST-I (2025) Instructions list \"At least two-thirds of your gross income is derived from farming or ranching operations\" among the conditions under which \"You are not required to make estimated tax payments\"; Publication 1 (2026) says the same (\"Montana does not apply a lookback provision\"). The key set cannot express \"exempt from estimates entirely\", so null is stored; the engine should treat a farming/ranching taxpayer (>= 2/3 of gross income) as owing no Montana estimates.",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'penalty.rate_source', value: "state",
    citation: "Form EST-I (2025) \"2026 Interest Rate\" (rate set annually from the IRS IRC 6621 underpayment rate for the third quarter of the preceding year; interest accrues daily from the original due date); Montana Publication 1 (2026) \"Interest on the Underpayment of Estimated Tax\"",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'penalty.rate', value: 0.07,
    citation: "Form EST-I (2025) \"2026 Interest Rate\" (\"As of January 1, 2026, the interest rate is 7 percent ... daily rate is 0.0192 percent\"); Montana Publication 1 (2026) (\"interest on underpayment of estimated taxes for tax year 2026 will be calculated using the interest rate effective for 2027, because the 2026 income tax return is due in 2027\" -- i.e. TY2025 uses the 2026 rate)",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'credit_for_other_state', value: true,
    citation: "Montana Form 2 (2025) Schedule III Part II \"Credit For Income Taxes Paid to Another State or Country\" (separate computations for ordinary income and net long-term capital gains)",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'nonresident_method', value: "ratio",
    citation: "Montana Form 2 (2025) Schedule II \"Tax on Montana Source Income\" lines 17-25 (Montana source ordinary income ratio = line 15 / line 16 everywhere ordinary income; tax x ratio; same for net long-term capital gains)",
    status: 'verified',
  },
  {
    state: 'MT', year: 2025, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-31"],
    citation: "MCA 1-1-216 (2025) legal holidays: each Sunday; Jan 1; MLK 3rd Mon Jan; Presidents' Day 3rd Mon Feb; Memorial Day; July 4; Labor Day; Indigenous Peoples' Day and Columbus Day 2nd Mon Oct; Nov 11; Thanksgiving; Dec 25; state general election day; holiday on Sunday -> following Monday, on Saturday -> preceding Friday. The text read (amended by L. 2025 ch. 561) does not list Juneteenth. Calendar 2025-2027 computed (Nov 3, 2026 is general election day; Jan 1, 2028 Saturday -> Dec 31, 2027).",
    status: 'verified',
  },
  // ------------------------------------------------------------ 2026
  {
    state: 'MT', year: 2026, key: 'has_income_tax', value: true,
    citation: "Montana Publication 1 (2026) \"Prepaying Income Tax in Montana\"; Form EST-I (2025) rate tables",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'required_threshold', value: 500,
    citation: "Montana Publication 1 (2026) \"Who Must Pay Estimated Tax\" (\"when the amount of annual estimated taxes owed ... after any withholding and nonrefundable credits, is more than $500\")",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: "Montana Publication 1 (2026) \"Current Year Tax Method\" (\"pay 90 percent of this amount\")",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: "Montana Publication 1 (2026) \"Prior Year Tax Method\" (pay the full amount of tax owed in the previous year; 2025 Form 2 line 10)",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: "No high-AGI rule: Form EST-I (2025) Instructions and Montana Publication 1 (2026) use 100% of prior-year liability for all taxpayers",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'installments.due_dates', value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Montana Publication 1 (2026) \"Estimated Tax Payment Due Dates\" (\"April 15, June 15, and September 15 of that year, and January 15 of the next calendar year. If any of these dates fall on a weekend or a holiday, your payment is due on the next business day\"); none of the dates falls on a weekend or MCA 1-1-216 holiday.",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: "Montana Publication 1 (2026) (\"four equal installments of the amount of tax you owed in the prior year or four equal installments of 90 percent\")",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'farmer.rule', value: null,
    citation: "Montana has NO farmer installment/Jan-15 rule: Form EST-I (2025) Instructions list \"At least two-thirds of your gross income is derived from farming or ranching operations\" among the conditions under which \"You are not required to make estimated tax payments\"; Publication 1 (2026) says the same (\"Montana does not apply a lookback provision\"). The key set cannot express \"exempt from estimates entirely\", so null is stored; the engine should treat a farming/ranching taxpayer (>= 2/3 of gross income) as owing no Montana estimates.",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'penalty.rate_source', value: "state",
    citation: "Form EST-I (2025) \"2026 Interest Rate\" (rate set annually from the IRS IRC 6621 underpayment rate for the third quarter of the preceding year; interest accrues daily from the original due date); Montana Publication 1 (2026) \"Interest on the Underpayment of Estimated Tax\"",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: "MCA 15-1-216(7)(a)(i) (2025) (individual income tax interest rate for a calendar year \"is equal to the underpayment rate for individual taxpayers established ... pursuant to section 6621 ... for the third quarter of the preceding year\"); MCA 15-30-2512(5)(a) (estimated-tax underpayment interest \"as provided in 15-1-216\"); Montana Publication 1 (2026) (TY2026 underpayments use \"the interest rate effective for 2027, because the 2026 income tax return is due in 2027\"); IRS Quarterly interest rates page (3rd quarter 2026 underpayment rate 7%, IRB 2026-22). Calendar-2027 Montana rate therefore 7% by statutory formula (DOR's own 2027 announcement not yet read). Audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'credit_for_other_state', value: true,
    citation: "MCA 15-30-2302 (2025) (resident credit for income taxes imposed by and paid to another state or country on income derived from sources there; not allowed where the other state gives Montana residents a credit for Montana tax; formula prescribed by the department); Montana Form 2 (2025) Schedule III Part II. Audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'nonresident_method', value: "ratio",
    citation: "MCA 15-30-2104(1)(a) (2025) (nonresident tax = tax computed as if a full-year resident x ratio of Montana source income to total income from all sources); Montana Form 2 (2025) Schedule II lines 17-25. Audit 2026-10-11.",
    status: 'verified',
  },
  {
    state: 'MT', year: 2026, key: 'holidays', value: ["2025-01-01", "2025-01-20", "2025-02-17", "2025-05-26", "2025-07-04", "2025-09-01", "2025-10-13", "2025-11-11", "2025-11-27", "2025-12-25", "2026-01-01", "2026-01-19", "2026-02-16", "2026-05-25", "2026-07-03", "2026-09-07", "2026-10-12", "2026-11-03", "2026-11-11", "2026-11-26", "2026-12-25", "2027-01-01", "2027-01-18", "2027-02-15", "2027-05-31", "2027-07-05", "2027-09-06", "2027-10-11", "2027-11-11", "2027-11-25", "2027-12-24", "2027-12-31"],
    citation: "MCA 1-1-216 (2025) legal holidays: each Sunday; Jan 1; MLK 3rd Mon Jan; Presidents' Day 3rd Mon Feb; Memorial Day; July 4; Labor Day; Indigenous Peoples' Day and Columbus Day 2nd Mon Oct; Nov 11; Thanksgiving; Dec 25; state general election day; holiday on Sunday -> following Monday, on Saturday -> preceding Friday. The text read (amended by L. 2025 ch. 561) does not list Juneteenth. Calendar 2025-2027 computed (Nov 3, 2026 is general election day; Jan 1, 2028 Saturday -> Dec 31, 2027).",
    status: 'verified',
  },
];
