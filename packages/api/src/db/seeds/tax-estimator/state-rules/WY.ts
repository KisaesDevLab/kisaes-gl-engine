// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// WY state estimated-tax rules, tax years 2025 and 2026. Filled by the Phase 2 researcher:
// every row has year, key, value, a primary-source citation and an honest status.
export const WY_RULES: StateRuleSeedRow[] = [
  {
    state: 'WY', year: 2025, key: 'has_income_tax', value: false,
    citation: 'Wyoming Business Council, Business Resources https://wyomingbusiness.org/?p=1222 (read 2026-10-11, undated state-agency page): "NO corporate state income tax"; "NO personal state income tax". Wyoming Dept. of Revenue Excise Tax Division https://excise-tax-div.wyo.gov/ lists no income tax program. NOTE: No Wyoming Department of Revenue or statute/constitution text stating that Wyoming has no individual income tax was retrievable; only an undated Wyoming Business Council page and the absence of an income tax program on the DOR excise page. Facts are widely uncontroversial, but need a primary statutory/DOR confirmation.',
    status: 'unverified',
  },
  {
    state: 'WY', year: 2026, key: 'has_income_tax', value: false,
    citation: 'Wyoming Business Council, Business Resources https://wyomingbusiness.org/?p=1222 (read 2026-10-11, undated state-agency page): "NO corporate state income tax"; "NO personal state income tax". Wyoming Dept. of Revenue Excise Tax Division https://excise-tax-div.wyo.gov/ lists no income tax program. NOTE: No Wyoming Department of Revenue or statute/constitution text stating that Wyoming has no individual income tax was retrievable; only an undated Wyoming Business Council page and the absence of an income tax program on the DOR excise page. Facts are widely uncontroversial, but need a primary statutory/DOR confirmation.',
    status: 'unverified',
  },
];
