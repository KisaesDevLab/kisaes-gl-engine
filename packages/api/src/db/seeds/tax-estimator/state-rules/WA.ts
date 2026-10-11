// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// WA state estimated-tax rules, tax years 2025 and 2026. Filled by the Phase 2 researcher:
// every row has year, key, value, a primary-source citation and an honest status.
export const WA_RULES: StateRuleSeedRow[] = [
  {
    state: 'WA', year: 2025, key: 'has_income_tax', value: false,
    citation: 'Washington Dept. of Revenue, Income tax https://dor.wa.gov/taxes-rates/income-tax (read 2026-10-11): "Washington does not currently have an individual income tax"; the new 9.9% tax on AGI over $1 million (ESSB 6346, ch. 238, Laws of 2026, signed 2026-03-30) starts Jan. 1, 2028, first return due 2029. Long-term capital gains excise tax (RCW 82.87.040: 7%, plus 2.9% above $1,000,000 from 2025) is a separate excise tax filed on its own return, not a wage/broad income tax; no estimated-payment regime (tax due with the return)',
    status: 'verified',
  },
  {
    state: 'WA', year: 2026, key: 'has_income_tax', value: false,
    citation: 'Washington Dept. of Revenue, Income tax https://dor.wa.gov/taxes-rates/income-tax (read 2026-10-11): "Washington does not currently have an individual income tax"; the new 9.9% tax on AGI over $1 million (ESSB 6346, ch. 238, Laws of 2026, signed 2026-03-30) starts Jan. 1, 2028, first return due 2029. Long-term capital gains excise tax (RCW 82.87.040: 7%, plus 2.9% above $1,000,000 from 2025) is a separate excise tax filed on its own return, not a wage/broad income tax; no estimated-payment regime (tax due with the return)',
    status: 'verified',
  },
];
