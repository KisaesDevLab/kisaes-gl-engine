// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { ParameterSeedRow } from '@kis-books/shared';
import { FEDERAL_2025_SEEDS } from './2025.js';
import { FEDERAL_2026_SEEDS } from './2026.js';

/** Shipped federal parameter seeds by tax year. Adding a year = a new file + one line here. */
export const FEDERAL_SEEDS: Readonly<Record<number, readonly ParameterSeedRow[]>> = {
  2025: FEDERAL_2025_SEEDS,
  2026: FEDERAL_2026_SEEDS,
};
