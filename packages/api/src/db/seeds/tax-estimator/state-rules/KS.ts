// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// KS state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 3 research, 2026-10-11).
// Every row cites the primary source it was read in; see features/tax-estimator/docs/reviews/phase2-batch3-sources.md.
export const KS_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'KS', year: 2025, key: 'has_income_tax',
    value: true,
    citation: "2025 Kansas Individual Income Tax booklet (ip25), ksrevenue.gov/pdf/ip25.pdf (Kansas individual income tax; Form K-40 line 18 tax); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 1 ('Amount from line 18, 2025 Form K-40')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'required_threshold',
    value: 500,
    citation: "Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf ('You must make estimated tax payments if your estimated Kansas income tax after withholding and credits is $500 or more'); worksheet line 8 ('If the amount is less than $500, estimated tax payments are not required'); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf Who may use ('2025 tax due ... less withholding and tax credits ... is $500 or more'). Nonresidents consider only Kansas-source income.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf ('90% of the tax on your tax return for tax year 2025'); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 2 ('Multiply line 1 by 90% (farmers and fishers multiply by 66 2/3%)')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf ('100% of the tax shown on your 2024 tax return'); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 3 and line 9 (lesser of line 2 or line 3)",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule: Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf and Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 9 use only 90% of current / 100% of prior-year tax",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'installments.due_dates',
    value: ["2025-04-15", "2025-06-16", "2025-09-15", "2026-01-15"],
    citation: "Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf 'When to file' (April 15, 2025, June 15, 2025, September 15, 2025 and January 15, 2026; 'When the due date falls on a Saturday, Sunday, or legal holiday, substitute the next regular workday'); Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 12. June 15, 2025 was a Sunday -> Monday June 16, 2025. The Jan. 15, 2026 installment is waived if the return is filed and tax fully paid by Jan. 31, 2026.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf Part I (cumulative 25%/50%/75%/100% of line 4 by each due date); Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf worksheet line 9 ('enter 1/4 of line 8')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.6666666667, "due_date": "2026-01-15", "file_by": "2026-03-01"},
    citation: "Kansas 2025 K-40ES (Rev. 7-24), ksrevenue.gov/pdf/k-40es25.pdf 'Farmers and Fishers - Payment is due on or before January 15, 2026 unless your return for the 2025 tax year is filed and tax fully paid on or before March 1, 2026'; Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf line 2 and line 10b (66 2/3% / 66.66% of tax) and instructions ('If at least two-thirds of your annual gross income is from farming or fishing and you filed Form K-40 and paid the tax on or before March 1, 2026, you may be exempt'). file_by stored as stated (March 1, 2026 is a Sunday).",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'penalty.rate_source',
    value: "state",
    citation: "Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf lines 15-16 (Kansas computes its own interest-rate penalty, 9% to 12/31/25 and 8% from 1/1/26)",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'penalty.rate',
    value: 0.09,
    citation: "Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf lines 15-16 and instructions ('Penalty is computed to 12/31/25 at 9% and from 1/1/26 to the date the tax was paid or 4/15/26, whichever is earlier, at 8%'). CAUTION: single-rate key; underpayment days falling in 2026 accrue at 8%, not 9%.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'credit_for_other_state',
    value: true,
    citation: "2025 Kansas Individual Income Tax booklet (ip25), ksrevenue.gov/pdf/ip25.pdf Form K-40 line 13 ('Credit for taxes paid to other states') and 'Taxes Paid to Other States by Kansas Residents' worksheet",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'nonresident_method',
    value: "ratio",
    citation: "2025 Kansas Individual Income Tax booklet (ip25), ksrevenue.gov/pdf/ip25.pdf Form K-40 line 9 ('Nonresident percentage ... from Schedule S, line B23') and line 10 ('Multiply line 8 by the percentage on line 9')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2025, key: 'holidays',
    value: ["2025-01-01", "2025-01-20", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-11", "2025-11-27", "2025-11-28", "2025-12-25", "2026-01-01", "2026-01-19", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25"],
    citation: "Kansas Department of Administration 'Holidays for 2025' and 'Holidays for 2026' (State of Kansas executive branch employees), admin.ks.gov/offices/personnel-services/agency-information/holidays-for-state-of-kansas-executive-branch-employees/holidays-for-2025 and holidays-for-2026. Used as the proxy for the 'legal holiday' in the K-40ES/K-210 roll rule (the instructions do not define it). The 'discretionary day' is not dated. Calendar years 2025-2026. Dates exactly as listed (Juneteenth, Independence Day observed, Thanksgiving and the day after, Christmas Eve 2026).",
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'KS', year: 2026, key: 'has_income_tax',
    value: true,
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf worksheet lines 5-6 ('Estimated Kansas tax liability (use the Tax Computation Schedules below)')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'required_threshold',
    value: 500,
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf ('estimated Kansas income tax after withholding and credits is $500 or more'; worksheet line 8 'If the amount is less than $500, estimated tax payments are not required')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'safe_harbor.current_pct',
    value: 0.9,
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf ('90% of the tax on your tax return for tax year 2026')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'safe_harbor.prior_pct',
    value: 1.0,
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf ('100% of the tax shown on your 2025 tax return')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'safe_harbor.high_agi_rule',
    value: null,
    citation: "No high-AGI rule in Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf (only 90% of 2026 tax, 100% of 2025 tax, or 90% of annualized income)",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'installments.due_dates',
    value: ["2026-04-15", "2026-06-15", "2026-09-15", "2027-01-15"],
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf 'When to file your estimated tax vouchers' (April 15, 2026, June 15, 2026, September 15, 2026 and January 15, 2027; weekend/legal-holiday roll to the next regular workday). None falls on a weekend (Wed/Mon/Tue/Fri) or Kansas holiday.",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'installments.pcts',
    value: [0.25, 0.25, 0.25, 0.25],
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf worksheet line 9 ('Amount of each quarterly payment (enter 1/4 of line 8 ...)')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'farmer.rule',
    value: {"ratio": 0.6666666667, "current_pct": 0.6666666667, "due_date": "2027-01-15", "file_by": "2027-03-01"},
    citation: "Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf ('Farmers and Fishers - Payment is due on or before January 15, 2027 unless your return for the 2026 tax year is filed and tax fully paid on or before March 1, 2027'; penalty test '66 2/3% for farmers and fishers of the tax shown on your return for tax year 2026')",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'penalty.rate_source',
    value: "state",
    citation: "Kansas computes its own penalty rate: Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf lines 15-16; Kansas 2026 K-40ES, ksrevenue.gov/pdf/k-40es26.pdf 'Estimated tax penalty' (Schedule K-210)",
    status: 'verified',
  },
  {
    state: 'KS', year: 2026, key: 'penalty.rate',
    value: 0.08,
    citation: "Kansas 2025 Schedule K-210 and instructions, ksrevenue.gov/pdf/k-21025.pdf lines 15-16 give 8% for days from 1/1/26. The 2026 Schedule K-210 is not yet published, so the rate for days in 2027 (TY2026 underpayments run to April 15, 2027) is unknown.",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2026, key: 'credit_for_other_state',
    value: true,
    citation: "Verified for 2025 on Form K-40 line 13 and the credit worksheet; 2026 K-40 not yet published, carried forward",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2026, key: 'nonresident_method',
    value: "ratio",
    citation: "Verified for 2025 on Form K-40 lines 9-10 and Schedule S Part B; 2026 K-40 not yet published, carried forward",
    status: 'unverified',
  },
  {
    state: 'KS', year: 2026, key: 'holidays',
    value: ["2026-01-01", "2026-01-19", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-11", "2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25"],
    citation: "Kansas Department of Administration 'Holidays for 2025' and 'Holidays for 2026' (State of Kansas executive branch employees), admin.ks.gov/offices/personnel-services/agency-information/holidays-for-state-of-kansas-executive-branch-employees/holidays-for-2025 and holidays-for-2026. Used as the proxy for the 'legal holiday' in the K-40ES/K-210 roll rule (the instructions do not define it). The 'discretionary day' is not dated. Calendar year 2026 only: the 2027 holiday page (admin.ks.gov .../holidays-for-2027) returned 'Not Found' (not yet published), so no 2027 dates are listed; the TY2026 Jan. 15, 2027 (Friday) and Mar. 1, 2027 (Monday) dates are not affected.",
    status: 'verified',
  },
];
