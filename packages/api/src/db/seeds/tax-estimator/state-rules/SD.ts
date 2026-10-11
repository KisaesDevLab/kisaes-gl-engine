// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// SD state estimated-tax rules, tax years 2025 and 2026. Filled by the Phase 2 researcher:
// every row has year, key, value, a primary-source citation and an honest status.
export const SD_RULES: StateRuleSeedRow[] = [
  {
    state: 'SD', year: 2025, key: 'has_income_tax', value: false,
    citation: 'South Dakota Dept. of Revenue, Individual Taxes page https://dor.sd.gov/individuals/taxes/ (read 2026-10-11): "South Dakota is one of seven states that does not impose a state income tax" (the count of seven is stale; the no-income-tax statement is current). S.D. Const. art. XI s.2 (not read)',
    status: 'verified',
  },
  {
    state: 'SD', year: 2026, key: 'has_income_tax', value: false,
    citation: 'South Dakota Dept. of Revenue, Individual Taxes page https://dor.sd.gov/individuals/taxes/ (read 2026-10-11): "South Dakota is one of seven states that does not impose a state income tax" (the count of seven is stale; the no-income-tax statement is current). S.D. Const. art. XI s.2 (not read)',
    status: 'verified',
  },
];
