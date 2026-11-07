// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Pure walk cases the golden file can't state (the demo orders by entry
// sequence, so a return never sorts before its sale there): a re-walk after
// a tenant import where a linked return ties with its sale on date and
// created_at and its new id sorts it first (PR #230 residual).

import { describe, it, expect } from 'vitest';
import { Decimal, walk, ZERO_STATE, type WalkRow } from './inventory-walk.js';

const dec = (v: string) => new Decimal(v);
const row = (id: string, kind: WalkRow['kind'], q: string, mode: WalkRow['valueMode'], given: string | null, sourceId: string | null = null): WalkRow => ({
  id, transactionId: id, date: '2026-02-03', kind, quantity: dec(q), valueMode: mode, given: given === null ? null : dec(given), sourceId, fallbackCost: null,
});

describe('walk: a linked return that sorts before its sale', () => {
  it('keeps the units and value it took back when the sale registers, so every unit back brings exactly R', () => {
    const rows = [
      row('B1', 'receipt', '1', 'given', '4.00'),
      row('I1', 'sale', '-1', 'derived', null),
      // The return of 1 unit of TS comes first (a tie on date and created_at, its id sorts first).
      row('M1', 'customer_return', '1', 'linked', null, 'TS'),
      row('TS', 'sale', '-2', 'derived', null),
      row('B2', 'receipt', '1', 'given', '10.00'),
      row('M2', 'customer_return', '1', 'linked', null, 'TS'),
    ];
    // rewalkCompany registers every sale from its stored row first: relief 8.00 + correction_share 6.00 for 2 units.
    const res = walk(ZERO_STATE, rows, new Map([['TS', { r: dec('14'), s: dec('2'), n: dec('0'), b: dec('0') }]]));
    const value = (id: string) => res.rows[rows.findIndex((r) => r.id === id)]!.fig.value.toFixed(2);
    expect(value('M1'), 'round2(14.00 x 1 / 2)').toBe('7.00');
    expect(value('TS'), 'on hand 1 at 7.00, 1 more at L 7.00').toBe('-14.00');
    expect(res.shares.get('TS')!.toFixed(2), 'B2 cures the unit sold short: 10.00 - 7.00').toBe('3.00');
    // R = 14.00 + 3.00; M1 already brought 7.00 for 1 of 2 units: round2(17.00 x 2 / 2) - 7.00.
    expect(value('M2')).toBe('10.00');
    expect(dec(value('M1')).plus(dec(value('M2'))).toFixed(2), 'every unit back = R').toBe('17.00');
  });
});
