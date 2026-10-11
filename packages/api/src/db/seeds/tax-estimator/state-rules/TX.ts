// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// TX state estimated-tax rules, tax years 2025 and 2026. Filled by the Phase 2 researcher:
// every row has year, key, value, a primary-source citation and an honest status.
export const TX_RULES: StateRuleSeedRow[] = [
  {
    state: 'TX', year: 2025, key: 'has_income_tax', value: false,
    citation: 'Tex. Const. art. VIII, s.24-a (added by H.J.R. 38, 86th Leg., adopted at the Nov. 5, 2019 election as Prop. 4): "The legislature may not impose a tax on the net incomes of individuals, including an individual\'s share of partnership and unincorporated association income." Adoption confirmed in Texas Legislative Council, Amendments to the Texas Constitution Since 1876 (current through Nov. 4, 2025) https://tlc.texas.gov/docs/amendments/Constamend1876.pdf: art. VIII s.24-a \'Adopted\' 2019/11/05; text of H.J.R. 38 enrolled https://capitol.texas.gov/tlodocs/86R/billtext/html/HJ00038F.htm (both read 2026-10-11)',
    status: 'verified',
  },
  {
    state: 'TX', year: 2026, key: 'has_income_tax', value: false,
    citation: 'Tex. Const. art. VIII, s.24-a (added by H.J.R. 38, 86th Leg., adopted at the Nov. 5, 2019 election as Prop. 4): "The legislature may not impose a tax on the net incomes of individuals, including an individual\'s share of partnership and unincorporated association income." Adoption confirmed in Texas Legislative Council, Amendments to the Texas Constitution Since 1876 (current through Nov. 4, 2025) https://tlc.texas.gov/docs/amendments/Constamend1876.pdf: art. VIII s.24-a \'Adopted\' 2019/11/05; text of H.J.R. 38 enrolled https://capitol.texas.gov/tlodocs/86R/billtext/html/HJ00038F.htm (both read 2026-10-11)',
    status: 'verified',
  },
];
