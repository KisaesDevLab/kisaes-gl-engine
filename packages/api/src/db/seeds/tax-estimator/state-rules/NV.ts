// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// NV state estimated-tax rules, tax years 2025 and 2026. Filled by the Phase 2 researcher:
// every row has year, key, value, a primary-source citation and an honest status.
export const NV_RULES: StateRuleSeedRow[] = [
  {
    state: 'NV', year: 2025, key: 'has_income_tax', value: false,
    citation: 'Nevada Dept. of Taxation, \'Income Tax in Nevada\' https://tax.nv.gov/about-nevada-department-of-taxation/income-tax-in-nevada/ (read 2026-10-11): "No State Income Tax on Individuals: Nevada residents do not pay state tax on income earned from salaries, wages, or similar compensation"; the Commerce Tax applies to businesses with gross revenue over $4 million',
    status: 'verified',
  },
  {
    state: 'NV', year: 2026, key: 'has_income_tax', value: false,
    citation: 'Nevada Dept. of Taxation, \'Income Tax in Nevada\' https://tax.nv.gov/about-nevada-department-of-taxation/income-tax-in-nevada/ (read 2026-10-11): "No State Income Tax on Individuals: Nevada residents do not pay state tax on income earned from salaries, wages, or similar compensation"; the Commerce Tax applies to businesses with gross revenue over $4 million',
    status: 'verified',
  },
];
