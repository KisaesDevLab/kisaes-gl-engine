// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// DC state estimated-tax rules, tax years 2025 and 2026 (Phase 2 batch 2 research, 2026-10-11).
// Every row cites the primary source it was read in; unverified rows say why. See
// features/tax-estimator/docs/reviews/phase2-batch2-sources.md.
export const DC_RULES: StateRuleSeedRow[] = [
  // ------------------------------------------------------------------ 2025
  {
    state: 'DC', year: 2025, key: 'has_income_tax', value: true,
    citation: 'D.C. Code 47-1806.01 (tax on the entire net income of every resident) and 47-1812.08(i)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'required_threshold', value: 100,
    citation: 'D.C. Code 47-1812.08(i)(1) (declaration required if expected non-withheld income results in "a tax liability of more than $100"); OTR D-2210 (rev. 09/2024) instructions ("more than $100"); D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) (expected DC tax above $100.00)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) (no interest if 90% of the current year\'s liability is paid); D-2210 (rev. 09/2024) line 2',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'safe_harbor.prior_pct', value: 1.1,
    citation: 'D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) (110% of the prior year\'s liability, full-year DC residents only); D-2210 (rev. 09/2024) line 4 ("Multiply Line 3 amount by 110%"). Applies at all income levels (no AGI test). TY2025 D-2210 itself not retrieved; 2024 form and current OTR page used.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'DC has no separate high-AGI variant: the 110% prior-year test applies to every full-year DC resident (see safe_harbor.prior_pct); D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11); D-2210 (rev. 09/2024)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'installments.due_dates', value: ['2025-04-15', '2025-06-16', '2025-09-15', '2026-01-15'],
    citation: 'OTR Individual Income Tax Forms page, 2025 D-40ES: "Voucher #1 due April 15, 2025 ... #2 June 15, 2025 ... #3 September 15, 2025 ... #4 January 15, 2026". June 15, 2025 is a Sunday -> 2025-06-16 (roll to next business day assumed; D.C. Code 47-1812.08(i)(4) dates).',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'UNVERIFIED for TY2025: D-2210 (rev. 09/2024) line 6 ("Multiply Line 5 amount by 25%") and D.C. Code 47-4203 (via search summary) give four 25% installments; TY2025 D-2210 not retrieved.',
    status: 'unverified',
  },
  {
    state: 'DC', year: 2025, key: 'farmer.rule', value: null,
    citation: 'UNVERIFIED absence: D.C. Code 47-1812.08(i) (read via excerpt) contains no farmer/fisherman provision; D-2210 (rev. 09/2024) lists no farmer rule.',
    status: 'unverified',
  },
  {
    state: 'DC', year: 2025, key: 'penalty.rate_source', value: 'state',
    citation: 'D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) ("OTR will automatically charge 10 percent interest, compounded daily, on any underpayment of estimated taxes")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'penalty.rate', value: 0.1,
    citation: 'D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) (10 percent interest, compounded daily). D-2210 uses precomputed per-period factors. CAUTION: compounding daily is not captured by a simple annual rate.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'credit_for_other_state', value: true,
    citation: 'D.C. Code 47-1806.04(a) (credit against DC tax for individual income tax a resident is required to pay to another jurisdiction, limited proportionally)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'nonresident_method', value: 'other',
    citation: 'D.C. Code 47-1806.01 (nonresidents taxed only on income subject to tax under 47-1808.01 to 47-1808.06, i.e. unincorporated business franchise tax); DC does not impose its individual income tax on nonresident wages. Nothing in the three allowed values fits.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2025, key: 'holidays', value: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-16', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-10-13', '2025-11-11', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25'],
    citation: 'D.C. Code 1-612.02(a)-(b) (code.dccouncil.gov): New Year, MLK (3rd Mon Jan), Washington\'s Birthday (3rd Mon Feb), DC Emancipation Day (April 16), Memorial Day, Juneteenth, July 4, Labor Day, Indigenous Peoples\' Day (2nd Mon Oct), Veterans Day, Thanksgiving, Christmas; Saturday -> preceding Friday and Sunday -> following Monday (employee observance rule, included conservatively). Inauguration Day not read. Calendar years 2025-2026.',
    status: 'verified',
  },
  // ------------------------------------------------------------------ 2026
  {
    state: 'DC', year: 2026, key: 'has_income_tax', value: true,
    citation: 'D.C. Code 47-1806.01 (tax on the entire net income of every resident) and 47-1812.08(i)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'required_threshold', value: 100,
    citation: 'D.C. Code 47-1812.08(i)(1) (declaration required if expected non-withheld income results in "a tax liability of more than $100"); OTR D-2210 (rev. 09/2024) instructions ("more than $100"); D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) (expected DC tax above $100.00)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'safe_harbor.current_pct', value: 0.9,
    citation: 'D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) (no interest if 90% of the current year\'s liability is paid); D-2210 (rev. 09/2024) line 2',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'safe_harbor.prior_pct', value: 1.1,
    citation: 'D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) (110% of the prior year\'s liability, full-year DC residents only); D-2210 (rev. 09/2024) line 4 ("Multiply Line 3 amount by 110%"). Applies at all income levels (no AGI test). TY2026 D-2210 itself not retrieved; 2024 form and current OTR page used.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'safe_harbor.high_agi_rule', value: null,
    citation: 'DC has no separate high-AGI variant: the 110% prior-year test applies to every full-year DC resident (see safe_harbor.prior_pct); D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11); D-2210 (rev. 09/2024)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'installments.due_dates', value: ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'],
    citation: 'OTR Individual Income Tax Forms page, 2026 D-40ES: "Voucher #1 due April 15, 2026 ... #2 June 15, 2026 ... #3 September 15, 2026 ... #4 January 15, 2027"; D.C. Code 47-1812.08(i)(4)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'installments.pcts', value: [0.25, 0.25, 0.25, 0.25],
    citation: 'UNVERIFIED for TY2026: D-2210 (rev. 09/2024) line 6 ("Multiply Line 5 amount by 25%") and D.C. Code 47-4203 (via search summary) give four 25% installments; TY2026 D-2210 not retrieved.',
    status: 'unverified',
  },
  {
    state: 'DC', year: 2026, key: 'farmer.rule', value: null,
    citation: 'UNVERIFIED absence: D.C. Code 47-1812.08(i) (read via excerpt) contains no farmer/fisherman provision; D-2210 (rev. 09/2024) lists no farmer rule.',
    status: 'unverified',
  },
  {
    state: 'DC', year: 2026, key: 'penalty.rate_source', value: 'state',
    citation: 'D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) ("OTR will automatically charge 10 percent interest, compounded daily, on any underpayment of estimated taxes")',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'penalty.rate', value: 0.1,
    citation: 'D.C. OTR "Underpayment of Estimated Tax Interest" page (otr.cfo.dc.gov/page/underpayment-estimated-tax-interest, read 2026-10-11) (10 percent interest, compounded daily). D-2210 uses precomputed per-period factors. CAUTION: compounding daily is not captured by a simple annual rate.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'credit_for_other_state', value: true,
    citation: 'D.C. Code 47-1806.04(a) (credit against DC tax for individual income tax a resident is required to pay to another jurisdiction, limited proportionally)',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'nonresident_method', value: 'other',
    citation: 'D.C. Code 47-1806.01 (nonresidents taxed only on income subject to tax under 47-1808.01 to 47-1808.06, i.e. unincorporated business franchise tax); DC does not impose its individual income tax on nonresident wages. Nothing in the three allowed values fits.',
    status: 'verified',
  },
  {
    state: 'DC', year: 2026, key: 'holidays', value: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-07-04', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25', '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-16', '2027-05-31', '2027-06-18', '2027-06-19', '2027-07-04', '2027-07-05', '2027-09-06', '2027-10-11', '2027-11-11', '2027-11-25', '2027-12-24', '2027-12-25'],
    citation: 'D.C. Code 1-612.02(a)-(b) (code.dccouncil.gov); observance rule included conservatively. Calendar years 2026-2027.',
    status: 'verified',
  },
];
