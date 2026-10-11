// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// FL state estimated-tax rules, tax years 2025 and 2026. Filled by the Phase 2 researcher:
// every row has year, key, value, a primary-source citation and an honest status.
export const FL_RULES: StateRuleSeedRow[] = [
  {
    state: 'FL', year: 2025, key: 'has_income_tax', value: false,
    citation: 'Fla. Const. art. VII, s.5(a) (flsenate.gov/Laws/Constitution, read 2026-10-11): no tax on the income of natural persons who are residents or citizens may be levied by the state in excess of amounts creditable against a similar federal or state tax; since the federal credit no longer exists, the allowable personal income tax is zero. Repeal needs a constitutional amendment. NOTE: Art. VII s.5(a) caps a personal income tax at the (now nonexistent) federal-credit amount; zero follows from that reading plus the absence of any Florida individual income tax statute/return, not from an express \'no income tax\' sentence.',
    status: 'verified',
  },
  {
    state: 'FL', year: 2026, key: 'has_income_tax', value: false,
    citation: 'Fla. Const. art. VII, s.5(a) (flsenate.gov/Laws/Constitution, read 2026-10-11): no tax on the income of natural persons who are residents or citizens may be levied by the state in excess of amounts creditable against a similar federal or state tax; since the federal credit no longer exists, the allowable personal income tax is zero. Repeal needs a constitutional amendment. NOTE: Art. VII s.5(a) caps a personal income tax at the (now nonexistent) federal-credit amount; zero follows from that reading plus the absence of any Florida individual income tax statute/return, not from an express \'no income tax\' sentence.',
    status: 'verified',
  },
];
