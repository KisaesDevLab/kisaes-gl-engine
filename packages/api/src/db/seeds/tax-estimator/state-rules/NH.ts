// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StateRuleSeedRow } from '@kis-books/shared';

// NH state estimated-tax rules, tax years 2025 and 2026. Filled by the Phase 2 researcher:
// every row has year, key, value, a primary-source citation and an honest status.
export const NH_RULES: StateRuleSeedRow[] = [
  {
    state: 'NH', year: 2025, key: 'has_income_tax', value: false,
    citation: 'N.H. RSA ch. 77 (Taxation of Incomes, the Interest and Dividends Tax) https://gc.nh.gov/rsa/html/V/77/77-mrg.htm (read 2026-10-11): "Entire Chapter was repealed. [Repealed by 2021, 91:99, II, eff. Jan. 1, 2025.]" Taxable periods beginning on or after Jan. 1, 2025 carry no I&D tax; NH has no wage income tax. Advanced by 2023 HB 2 (ch. 79, ss. 85-88) per NH DRA notice 2023-003 (not retrievable; 403)',
    status: 'verified',
  },
  {
    state: 'NH', year: 2026, key: 'has_income_tax', value: false,
    citation: 'N.H. RSA ch. 77 (Taxation of Incomes, the Interest and Dividends Tax) https://gc.nh.gov/rsa/html/V/77/77-mrg.htm (read 2026-10-11): "Entire Chapter was repealed. [Repealed by 2021, 91:99, II, eff. Jan. 1, 2025.]" Taxable periods beginning on or after Jan. 1, 2025 carry no I&D tax; NH has no wage income tax. Advanced by 2023 HB 2 (ch. 79, ss. 85-88) per NH DRA notice 2023-003 (not retrievable; 403)',
    status: 'verified',
  },
];
