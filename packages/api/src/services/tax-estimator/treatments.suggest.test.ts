// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { suggestTreatmentFor } from './treatments.service.js';

describe('suggestTreatmentFor — meals vs entertainment (QA D15)', () => {
  it('Entertainment is 100% nondeductible (§274(a)), never 50%', () => {
    const s = suggestTreatmentFor('Entertainment', 'expense');
    expect(s).toMatchObject({ treatment: 'nondeductible_pct', pct: '100' });
    expect(s!.reason).toMatch(/not deductible/);
    expect(suggestTreatmentFor('Client entertainment', 'other_expense')).toMatchObject({ pct: '100' });
  });
  it('Meals stay 50%', () => {
    expect(suggestTreatmentFor('Meals', 'expense')).toMatchObject({ treatment: 'nondeductible_pct', pct: '50' });
    expect(suggestTreatmentFor('Business meal', 'expense')).toMatchObject({ pct: '50' });
  });
  it('a combined Meals & Entertainment account gets 50% and is told to split out the entertainment', () => {
    const s = suggestTreatmentFor('Meals & Entertainment', 'expense');
    expect(s).toMatchObject({ treatment: 'nondeductible_pct', pct: '50' });
    expect(s!.reason).toMatch(/split/);
  });
  it('a non-expense account is not suggested', () => {
    expect(suggestTreatmentFor('Entertainment', 'income')).toBeNull();
  });
});
