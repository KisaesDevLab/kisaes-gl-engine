// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// AK state estimated-tax rules, tax years 2025 and 2026. Filled by the Phase 2 researcher:
// every row has year, key, value, a primary-source citation and an honest status.
export const AK_RULES: StateRuleSeedRow[] = [
  {
    state: 'AK', year: 2025, key: 'has_income_tax', value: false,
    citation: 'Alaska Dept. of Revenue, Tax Division, Personal Income Tax page https://tax.alaska.gov/programs/programs/index.aspx?10001 (read 2026-10-11: "The State of Alaska currently does not have an individual income tax"; no employee withholding required). Individual net income tax repealed by Ch. 2, SSSLA 1980 (retroactive to Jan. 1, 1979)',
    status: 'verified',
  },
  {
    state: 'AK', year: 2026, key: 'has_income_tax', value: false,
    citation: 'Alaska Dept. of Revenue, Tax Division, Personal Income Tax page https://tax.alaska.gov/programs/programs/index.aspx?10001 (read 2026-10-11: "The State of Alaska currently does not have an individual income tax"; no employee withholding required). Individual net income tax repealed by Ch. 2, SSSLA 1980 (retroactive to Jan. 1, 1979)',
    status: 'verified',
  },
];
