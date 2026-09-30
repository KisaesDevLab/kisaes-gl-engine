// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi } from 'vitest';

// toPair is pure; keep the DB out of it.
vi.mock('../db/index.js', () => ({ db: {} }));
vi.mock('./ledger.service.js', () => ({ voidTransaction: vi.fn() }));

import { toPair } from './duplicate-detection.service.js';

describe('duplicate-detection toPair', () => {
  it('nests the flat scan row into a/b transactions with days apart', () => {
    const p = toPair({
      id_a: 'a', id_b: 'b',
      type_a: 'expense', type_b: 'bill',
      number_a: null, number_b: 'B-1',
      date_a: '2026-09-01', date_b: '2026-09-03',
      amount: '42.0000',
      contact_a: 'Acme', contact_b: 'Acme',
      memo_a: 'x', memo_b: null,
    });
    expect(p).toEqual({
      a: { id: 'a', txnType: 'expense', txnNumber: null, txnDate: '2026-09-01', payee: 'Acme', total: '42.0000', memo: 'x' },
      b: { id: 'b', txnType: 'bill', txnNumber: 'B-1', txnDate: '2026-09-03', payee: 'Acme', total: '42.0000', memo: null },
      daysApart: 2,
    });
  });

  it('reports 0 days for same-day pairs and tolerates unparseable dates', () => {
    const base = { id_a: 'a', id_b: 'b', type_a: 'expense', type_b: 'expense', number_a: null, number_b: null, amount: '1', contact_a: null, contact_b: null, memo_a: null, memo_b: null };
    expect(toPair({ ...base, date_a: '2026-09-01', date_b: '2026-09-01' }).daysApart).toBe(0);
    expect(toPair({ ...base, date_a: 'nope', date_b: '2026-09-01' }).daysApart).toBe(0);
  });
});
