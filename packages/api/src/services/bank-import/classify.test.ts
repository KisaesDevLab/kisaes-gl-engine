// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-06 row classification (pure): repeated FITIDs, FITID trust (±5 days,
// changed, bank_id_reused), row keys, the fuzzy rule (Q-P25c) and the
// amount and total limits.

import { describe, it, expect } from 'vitest';
import {
  classifyRows, validateBatch, descriptionsMatch, wouldInsert,
  type BatchInput, type BatchRowInput, type ExistingItem,
} from './import-batch.service.js';
import { fitidKey, keyRows, norm } from './keys.js';

let n = 0;
function existing(p: Partial<ExistingItem> & Pick<ExistingItem, 'date' | 'amount' | 'description'>): ExistingItem {
  n++;
  return {
    id: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`, connectionId: 'c', fitid: null, checkNumber: null,
    status: 'pending', createdAt: `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`, dedupeKey: null, rowKey: null, ...p,
  };
}

function run(rows: BatchRowInput[], items: ExistingItem[] = [], section: { start?: string; end?: string } = {}) {
  const keyed = keyRows(rows);
  const byFitid = new Map<string, ExistingItem[]>();
  const byKey = new Map<string, ExistingItem>();
  for (const e of items) {
    if (e.fitid) byFitid.set(e.fitid, [...(byFitid.get(e.fitid) ?? []), e]);
    for (const k of [e.dedupeKey, e.rowKey]) if (k && !byKey.has(k)) byKey.set(k, e);
  }
  return classifyRows(rows, keyed, byFitid, byKey, items, section);
}

const row = (line: number, date: string, amount: string, description: string, extra: Partial<BatchRowInput> = {}): BatchRowInput =>
  ({ line, date, amount, description, ...extra });

describe('classifyRows', () => {
  it('a FITID repeated in the request is ignored on every occurrence, in any order', () => {
    const a = row(1, '2026-11-01', '10.00', 'PARKING', { fitid: 'R1' });
    const b = row(2, '2026-11-02', '12.00', 'TOLL', { fitid: 'R1' });
    for (const rows of [[a, b], [b, a]]) {
      const out = run(rows);
      expect(out.map((o) => [o.status, o.reason, o.fitidUsed])).toEqual([['new', 'repeated_bank_id', null], ['new', 'repeated_bank_id', null]]);
    }
    // Identical rows sharing a FITID: both new (ordinals 1 and 2), like CSV.
    const out = run([a, { ...a, line: 2 }]);
    expect(out.map((o) => o.status)).toEqual(['new', 'new']);
    expect(out[0]!.dedupeKey).not.toBe(out[1]!.dedupeKey);
  });

  it('an existing FITID: same amount within 5 days is a duplicate; a date moved 2 days too', () => {
    const e = existing({ fitid: 'F1', date: '2026-11-03', amount: '45.1000', description: 'COFFEE' });
    expect(run([row(1, '2026-11-03', '45.10', 'COFFEE', { fitid: 'F1' })], [e])[0]).toMatchObject({ status: 'duplicate', reason: 'same_bank_id' });
    expect(run([row(1, '2026-11-05', '45.10', 'COFFEE', { fitid: 'F1' })], [e])[0]).toMatchObject({ status: 'duplicate', reason: 'same_bank_id' });
  });

  it('an existing FITID with another amount and a matching description is changed; "add" stores no FITID', () => {
    const e = existing({ fitid: 'F2', date: '2026-11-03', amount: '45.1000', description: 'COFFEE SHOP DOWNTOWN' });
    const r = row(1, '2026-11-04', '47.10', 'coffee shop downtown', { fitid: 'F2', changedAction: 'add' });
    const [c] = run([r], [e]);
    expect(c).toMatchObject({ status: 'changed', fitidUsed: null });
    expect(c!.existing!.id).toBe(e.id);
    expect(wouldInsert(r, c!)).toBe(true);
    expect(wouldInsert({ ...r, changedAction: 'replace' }, c!)).toBe(false);
  });

  it('a renumbering bank (FITIDs reused for other transactions) is bank_id_reused, never changed', () => {
    const nov = [existing({ fitid: '1', date: '2026-11-02', amount: '20.0000', description: 'GROCER' })];
    const [c] = run([row(1, '2026-12-02', '33.00', 'HARDWARE', { fitid: '1' })], nov);
    expect(c).toMatchObject({ status: 'new', reason: 'bank_id_reused', fitidUsed: null });
    // Another amount within 5 days but a different description: also reused.
    const [d] = run([row(1, '2026-11-03', '33.00', 'HARDWARE', { fitid: '1' })], nov);
    expect(d).toMatchObject({ status: 'new', reason: 'bank_id_reused' });
  });

  it('a row key equal to an existing dedupe or row key is a duplicate (same_row)', () => {
    const [k] = keyRows([row(1, '2026-11-01', '4.50', 'COFFEE')]);
    const e = existing({ date: '2026-11-01', amount: '4.5000', description: 'COFFEE', rowKey: k!.rowKey, dedupeKey: fitidKey('X') });
    expect(run([row(1, '2026-11-01', '4.50', 'Coffee ')], [e])[0]).toMatchObject({ status: 'duplicate', reason: 'same_row' });
  });

  describe('fuzzy (Q-P25c)', () => {
    it('flags a CSV row imported again from OFX (longer description, prefix of 8+)', () => {
      const e = existing({ date: '2026-11-02', amount: '120.0000', description: 'AMAZON MKTPLACE' });
      const [c] = run([row(1, '2026-11-03', '120.00', 'AMAZON MKTPLACE PMTS WA', { fitid: 'NEW-1' })], [e]);
      expect(c).toMatchObject({ status: 'possible_duplicate', reason: 'similar_existing' });
    });

    it('adds month-boundary coffee, Monday and Wednesday ATM, two transfers, two payroll checks', () => {
      // Coffee 4 days apart across a month boundary: outside ±3 days.
      expect(run([row(1, '2026-11-02', '4.50', 'COFFEE')], [existing({ date: '2026-10-29', amount: '4.5000', description: 'COFFEE' })])[0]!.status).toBe('new');
      // ATM Monday and Wednesday: the Wednesday row claims the Wednesday item; the Monday row claims Monday's.
      const atm = [
        existing({ date: '2026-11-02', amount: '100.0000', description: 'ATM WITHDRAWAL' }),
        existing({ date: '2026-11-04', amount: '100.0000', description: 'ATM WITHDRAWAL' }),
      ];
      const twoAtm = run([row(1, '2026-11-04', '100.00', 'ATM WITHDRAWAL #2'), row(2, '2026-11-06', '100.00', 'ATM WITHDRAWAL #3')], []);
      expect(twoAtm.map((c) => c.status)).toEqual(['new', 'new']);
      const claimed = run([row(1, '2026-11-02', '100.00', 'ATM WITHDRAWAL'), row(2, '2026-11-04', '100.00', 'ATM WITHDRAWAL')], atm);
      expect(claimed.map((c) => c.existing?.id)).toEqual([atm[0]!.id, atm[1]!.id]);
      // Two transfers the same day, one already in the feed: only one is flagged.
      const t = run([row(1, '2026-11-05', '500.00', 'TRANSFER TO SAVINGS'), row(2, '2026-11-05', '500.00', 'TRANSFER TO SAVINGS')],
        [existing({ date: '2026-11-05', amount: '500.0000', description: 'TRANSFER TO SAVINGS' })]);
      expect(t.map((c) => c.status).sort()).toEqual(['new', 'possible_duplicate']);
      // Two payroll checks of the same amount: different check numbers never match.
      const p = run([row(1, '2026-11-06', '1500.00', 'CHECK', { checkNumber: 1002 })],
        [existing({ date: '2026-11-06', amount: '1500.0000', description: 'CHECK', checkNumber: 1001 })]);
      expect(p[0]!.status).toBe('new');
    });

    it('never matches two different trusted FITIDs unless date, amount and description are identical', () => {
      const e = existing({ fitid: 'A', date: '2026-11-02', amount: '9.0000', description: 'SNACK BAR NORTH' });
      expect(run([row(1, '2026-11-03', '9.00', 'SNACK BAR NORTH', { fitid: 'B' })], [e])[0]!.status).toBe('new');
      expect(run([row(1, '2026-11-02', '9.00', 'SNACK BAR NORTH', { fitid: 'B' })], [e])[0]!.status).toBe('possible_duplicate');
    });

    it('respects the section date range and short prefixes', () => {
      const e = existing({ date: '2026-10-31', amount: '9.0000', description: 'SNACK' });
      expect(run([row(1, '2026-11-01', '9.00', 'SNACK')], [e], { start: '2026-11-01', end: '2026-11-30' })[0]!.status).toBe('new');
      expect(descriptionsMatch(norm('SNACK'), norm('SNACK BAR'))).toBe(false);
      expect(descriptionsMatch(norm('SNACKBAR'), norm('SNACKBAR 22'))).toBe(true);
    });
  });
});

describe('validateBatch', () => {
  const base = (rows: BatchRowInput[]): BatchInput => ({
    accountId: 'a', format: 'csv', fileName: 'f.csv', sourceFileSha256: '0'.repeat(64), sectionIndex: 0,
    amountsFlipped: false, dryRun: true, rows,
  });
  it('rejects 3 decimals, 13 integer digits, an exponent and zero with the line', () => {
    for (const amount of ['12.345', '1234567890123', '1e5', '0', '0.00', '+5', '5.']) {
      try {
        validateBatch(base([row(7, '2026-11-01', amount, 'X')]));
        expect.fail(`accepted ${amount}`);
      } catch (err: any) {
        expect(err.statusCode).toBe(422);
        expect(err.code).toBe('invalid_row');
        expect(err.details).toEqual({ line: 7, field: 'amount' });
      }
    }
    validateBatch(base([row(1, '2026-11-01', '0.01', 'X'), row(2, '2026-11-01', '-999999999999.99', 'X')]));
  });

  it('rejects a bad date, a long description and too many rows; 10^15 total is too large', () => {
    expect(() => validateBatch(base([row(3, '2026-02-30', '1.00', 'X')]))).toThrow(/Line 3/);
    expect(() => validateBatch(base([row(4, '2026-02-01', '1.00', 'x'.repeat(501))]))).toThrow(/Line 4/);
    const many = Array.from({ length: 20_001 }, (_, i) => row(i + 1, '2026-01-01', '1.00', 'X'));
    expect(() => validateBatch(base(many))).toThrow(expect.objectContaining({ code: 'too_many_rows' }));
    const big = Array.from({ length: 1001 }, (_, i) => row(i + 1, '2026-01-01', '999999999999.99', 'X'));
    expect(() => validateBatch(base(big))).toThrow(expect.objectContaining({ code: 'batch_total_too_large' }));
  });
});
