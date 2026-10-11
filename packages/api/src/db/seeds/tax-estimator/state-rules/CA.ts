// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// CA state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11).
// Every row cites the primary source it was read in; unverified rows say why. See
// features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const CA_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'CA', year: 2025, key: 'has_income_tax', value: true,
    citation: '2025 Instructions for Form 540-ES and 540-ES California Estimated Tax Worksheet (California income tax on residents and nonresidents)',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'required_threshold', value: 500,
    citation: '2025 Instructions for Form 540-ES, Section B "Who Must Make Estimated Tax Payments" (expect to owe at least $500, $250 if married/RDP filing separately); Worksheet line 21. MFS $250 threshold not expressible.',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2025 Instructions for Form 540-ES, Section B item 1 (90% of tax shown on the current-year return); Worksheet line 19a',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2025 Instructions for Form 540-ES, Section B item 2 (100% of prior-year tax including AMT); Worksheet line 19b',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: '2025 Instructions for Form 540-ES, Section C "Limit on the Use of Prior Year\'s Tax" and Worksheet lines 19c-19f (prior-year AGI over $150,000, $75,000 if MFS: lesser of 90% current or 110% prior; farmers/fishermen exempt; AGI of $1,000,000 or more ($500,000 MFS) must use current-year tax only). The $1M current-year-only rule and the MFS threshold are not expressible.',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: '2025 Instructions for Form 540-ES, Section D (April 15, 2025; June 16, 2025; September 15, 2025; January 15, 2026; "If the due date falls on a weekend or legal holiday, use the next business day"). A zero third installment keeps the 2025-09-15 date for the list index.',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'installments.pcts', value: [0.3, 0.4, 0, 0.3],
    citation: '2025 Instructions for Form 540-ES, "Installment Payments" (30% / 40% / no third installment / 30%); Worksheet line 22',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6667, due_date: '2026-01-15', file_by: '2026-03-02' },
    citation: '2025 Instructions for Form 540-ES, "Farmers and Fishermen" (at least 2/3 of 2024 or 2025 gross income from farming/fishing: pay all by January 15, 2026, or file by March 2, 2026 and pay in full); Worksheet line 19a ("Farmers and fishermen, multiply line 18 by 66 2/3% (.6667)"). March 2, 2026 is printed in the form (March 1 is a Sunday).',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'Form FTB 5805 (2025) instructions and Part II (penalty computed at a California-set rate, "Multiply line 10 by .05028767", daily factor .00019); FTB Interest and estimate penalty rates page',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'penalty.rate', value: 0.07,
    citation: 'FTB interest and estimate penalty rates page: 8% for 01/01/2025-06/30/2025, 7% for 07/01/2025-06/30/2026; form FTB 5805 (2025) daily factor .00019 (about 7%). CAUTION: single-rate key; underpayment days in 1H2025 accrue at 8%.',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'credit_for_other_state', value: true,
    citation: '2025 Instructions for Form 540-ES, Estimated Tax Worksheet line 13 ("Other credits (such as other state tax credit)")',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'nonresident_method', value: 'ratio',
    citation: '2025 Instructions for Form 540-ES, Estimated Tax Worksheet lines 5a-5c (California Tax Rate = tax on total taxable income / total taxable income, multiplied by California-source taxable income) and 6b (credit proration)',
    status: 'verified',
  },
  {
    state: 'CA', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-03-31', '2025-05-26', '2025-07-04', '2025-09-01', '2025-11-11', '2025-11-27', '2025-11-28', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-03-31', '2026-05-25', '2026-07-04', '2026-09-07', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25'],
    citation: 'California Secretary of State "State Holidays" page (sos.ca.gov/state-holidays), 2025 and 2026 lists read as printed (including Day after Thanksgiving, Cesar Chavez Day/Farmworkers Day on March 31). Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'CA', year: 2026, key: 'has_income_tax', value: true,
    citation: '2026 Instructions for Form 540-ES (ftb.ca.gov/forms/2026/2026-540-es-instructions.pdf) and 540-ES California Estimated Tax Worksheet (California income tax on residents and nonresidents)',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'required_threshold', value: 500,
    citation: '2026 Instructions for Form 540-ES (ftb.ca.gov/forms/2026/2026-540-es-instructions.pdf), Section B "Who Must Make Estimated Tax Payments" (expect to owe at least $500, $250 if married/RDP filing separately); Worksheet line 21. MFS $250 threshold not expressible.',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: '2026 Instructions for Form 540-ES (ftb.ca.gov/forms/2026/2026-540-es-instructions.pdf), Section B item 1 (90% of tax shown on the current-year return); Worksheet line 19a',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'safe_harbor.prior_pct', value: 1.0,
    citation: '2026 Instructions for Form 540-ES (ftb.ca.gov/forms/2026/2026-540-es-instructions.pdf), Section B item 2 (100% of prior-year tax including AMT); Worksheet line 19b',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'safe_harbor.high_agi_rule', value: { threshold: 150000, pct: 1.1 },
    citation: '2026 Instructions for Form 540-ES (ftb.ca.gov/forms/2026/2026-540-es-instructions.pdf), Section C "Limit on the Use of Prior Year\'s Tax" and Worksheet lines 19c-19f (prior-year AGI over $150,000, $75,000 if MFS: lesser of 90% current or 110% prior; farmers/fishermen exempt; AGI of $1,000,000 or more ($500,000 MFS) must use current-year tax only). The $1M current-year-only rule and the MFS threshold are not expressible.',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: '2026 Instructions for Form 540-ES, Section D (April 15, June 15, September 15, 2026; January 15, 2027; next business day rule). Third date is a placeholder: no 3rd installment is due (0%).',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'installments.pcts', value: [0.3, 0.4, 0, 0.3],
    citation: '2026 Instructions for Form 540-ES (ftb.ca.gov/forms/2026/2026-540-es-instructions.pdf), "Installment Payments" (30% / 40% / no third installment / 30%); Worksheet line 22',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'farmer.rule', value: { ratio: 0.6666666666, current_pct: 0.6667, due_date: '2027-01-15', file_by: '2027-03-01' },
    citation: '2026 Instructions for Form 540-ES, "Farmers and Fishermen" (pay all by January 15, 2027, or file by March 1, 2027 and pay in full); Worksheet line 19a (66 2/3% = .6667)',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'FTB Interest and estimate penalty rates page (ftb.ca.gov/pay/penalties-and-interest/interest-and-estimate-penalty-rates.html): California sets estimate-penalty rate semiannually',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'penalty.rate', value: 0.07,
    citation: 'FTB interest and estimate penalty rates page: 7% for 07/01/2026-12/31/2026 (estimate penalties) and 7% for 07/01/2025-06/30/2026. CAUTION: rates for 2027 periods are set semiannually and were not published at research time.',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'credit_for_other_state', value: true,
    citation: '2026 Instructions for Form 540-ES (ftb.ca.gov/forms/2026/2026-540-es-instructions.pdf), Estimated Tax Worksheet line 13 ("Other credits (such as other state tax credit)")',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'nonresident_method', value: 'ratio',
    citation: '2026 Instructions for Form 540-ES (ftb.ca.gov/forms/2026/2026-540-es-instructions.pdf), Estimated Tax Worksheet lines 5a-5c (California Tax Rate = tax on total taxable income / total taxable income, multiplied by California-source taxable income) and 6b (credit proration)',
    status: 'verified',
  },
  {
    state: 'CA', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-03-31', '2026-05-25', '2026-07-04', '2026-09-07', '2026-11-11', '2026-11-26', '2026-11-27', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-31', '2027-05-31', '2027-07-04', '2027-07-05', '2027-09-06', '2027-11-11', '2027-11-25', '2027-11-26', '2027-12-25'],
    citation: 'UNVERIFIED for 2027 dates: California Secretary of State "State Holidays" page lists 2026 as printed; the 2027 dates are computed from the same pattern (no official 2027 list retrieved). Calendar years 2026-2027.',
    status: 'unverified',
  },
];
