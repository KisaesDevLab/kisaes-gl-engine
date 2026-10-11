// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// TN state estimated-tax rules, tax years 2025 and 2026. Filled by the Phase 2 researcher:
// every row has year, key, value, a primary-source citation and an honest status.
export const TN_RULES: StateRuleSeedRow[] = [
  {
    state: 'TN', year: 2025, key: 'has_income_tax', value: false,
    citation: 'Tennessee Dept. of Revenue, Hall Income Tax https://tn.gov/revenue/taxes/hall-income-tax.html (read 2026-10-11): "The Hall Income tax was repealed for tax periods that begin on January 1, 2021, or later"; "Please do not file a return for any tax year that begins on or after January 1, 2021." Tennessee has no wage income tax. Repeal enacted by 2017 IMPROVE Act (Tenn. Code Ann. s.67-2-102 phase-out)',
    status: 'verified',
  },
  {
    state: 'TN', year: 2026, key: 'has_income_tax', value: false,
    citation: 'Tennessee Dept. of Revenue, Hall Income Tax https://tn.gov/revenue/taxes/hall-income-tax.html (read 2026-10-11): "The Hall Income tax was repealed for tax periods that begin on January 1, 2021, or later"; "Please do not file a return for any tax year that begins on or after January 1, 2021." Tennessee has no wage income tax. Repeal enacted by 2017 IMPROVE Act (Tenn. Code Ann. s.67-2-102 phase-out)',
    status: 'verified',
  },
];
