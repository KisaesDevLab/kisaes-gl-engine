// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 10 payment ledger: earliest-unpaid application, even withholding, early
// payments and overpayment carry, late payments, January payments of the next
// year toward Q4 (PROGRESS.md R-note), deduplication by transaction id.

import { describe, it, expect } from 'vitest';
import { applyPayments, dedupePayments, withholdingShares, type EstimatePayment } from './payments.js';
import type { InstallmentDue } from './estimate-types.js';

const DUE = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];
const END = '2027-04-15';
const inst = (required: string): InstallmentDue[] => DUE.map((d, i) => ({ index: i, dueDate: d, required }));
const pay = (id: string, date: string, amount: string, extra: Partial<EstimatePayment> = {}): EstimatePayment => ({ id, date, amount, source: 'manual', jurisdiction: 'federal', ...extra });
const apply = (installments: InstallmentDue[], payments: EstimatePayment[], withholding = '0') =>
  applyPayments({ jurisdiction: 'federal', installments, withholdingShares: withholdingShares(withholding, ['0.25', '0.25', '0.25', '0.25']), payments, endDate: END });

describe('withholdingShares', () => {
  it('splits evenly by installment percentage; empty list → no shares', () => {
    expect(withholdingShares('6000', ['0.25', '0.25', '0.25', '0.25'])).toEqual(['1500', '1500', '1500', '1500']);
    expect(withholdingShares('6000', ['1'])).toEqual(['6000']);
    expect(withholdingShares('6000', [])).toEqual([]);
  });
});

describe('dedupePayments', () => {
  it('keeps the first row per (jurisdiction, transaction id) and never merges rows without one', () => {
    const rows = [pay('m1', '2026-04-10', '100', { transactionId: 't1' }), pay('g1', '2026-04-10', '100', { source: 'gl', transactionId: 't1' }), pay('g2', '2026-04-10', '100', { source: 'gl', transactionId: 't1', jurisdiction: 'MO' }), pay('x', '2026-04-10', '5'), pay('y', '2026-04-10', '5')];
    expect(dedupePayments(rows).map((p) => p.id)).toEqual(['m1', 'g2', 'x', 'y']);
  });
});

describe('applyPayments', () => {
  it('Rivera pattern: 6,600 / 6,600 / 6,000 estimates + 1,500 withholding per quarter against 8,061.525 — Q1 over 38, Q2 over 77, Q3 short 485 cured on Jan 15', () => {
    const r = apply(inst('8061.525'), [pay('q1', DUE[0]!, '6600'), pay('q2', DUE[1]!, '6600'), pay('q3', DUE[2]!, '6000'), pay('q4', DUE[3]!, '7046.1')], '6000');
    const [q1, q2, q3, q4] = r.installments;
    expect(q1!.unpaidAtEnd).toBe('0'); expect(q1!.paidInFullOn).toBe(DUE[0]);
    expect(q2!.carriedIn).toBe('38'); expect(q2!.exact.carriedIn).toBe('38.475'); expect(q2!.netRequired).toBe('6523'); expect(q2!.paidInFullOn).toBe(DUE[1]);
    expect(q3!.carriedIn).toBe('77'); expect(q3!.netRequired).toBe('6485');
    expect(q3!.timeline.map((t) => [t.date, t.balance])).toEqual([[DUE[2], '7984.575'], [DUE[2], '6484.575'], [DUE[2], '484.575'], [DUE[3], '0']]);
    expect(q3!.paidInFullOn).toBe(DUE[3]);
    expect(q4!.netRequired).toBe('6562'); expect(q4!.unpaidAtEnd).toBe('0'); expect(q4!.paidInFullOn).toBe(DUE[3]);
    expect(r.excessAfterLast).toBe('0');
    expect(r.totalEstimates).toBe('26246');
    expect(r.totalRequired).toBe('32246');
  });

  it('a payment BEFORE the first due date waits for the installment and counts as paid on the due date', () => {
    const r = apply(inst('1000'), [pay('early', '2026-02-01', '1000')]);
    const q1 = r.installments[0]!;
    expect(q1.carriedIn).toBe('1000');
    expect(q1.paidInFullOn).toBe(DUE[0]);
    expect(q1.timeline).toEqual([{ date: DUE[0], balance: '0' }]);
    expect(r.installments[1]!.unpaidAtEnd).toBe('1000');
  });

  it('a late payment goes to the earliest unpaid installment and the timeline records the date', () => {
    const r = apply(inst('1000'), [pay('late', '2026-05-20', '1000')]);
    const q1 = r.installments[0]!;
    expect(q1.paidInFullOn).toBe('2026-05-20');
    expect(q1.timeline).toEqual([{ date: DUE[0], balance: '1000' }, { date: '2026-05-20', balance: '0' }]);
    expect(q1.applied.map((a) => [a.paymentId, a.amount])).toEqual([['late', '1000']]);
  });

  it('an overpayment carries to the next installment, then the next; a partial payment splits across installments', () => {
    const r = apply(inst('1000'), [pay('big', DUE[0]!, '2500'), pay('split', DUE[2]!, '1200')]);
    const [q1, q2, q3, q4] = r.installments;
    expect(q1!.paidInFullOn).toBe(DUE[0]);
    expect(q2!.carriedIn).toBe('1000'); expect(q2!.paidInFullOn).toBe(DUE[1]); expect(q2!.netRequired).toBe('0');
    expect(q3!.carriedIn).toBe('500'); expect(q3!.applied.map((a) => a.source)).toEqual(['carry', 'manual']); expect(q3!.paidInFullOn).toBe(DUE[2]);
    expect(q4!.carriedIn).toBe('700'); expect(q4!.unpaidAtEnd).toBe('300');
    expect(r.totalUnpaidAtEnd).toBe('300');
  });

  it('January payment of the NEXT year is applied to Q4 (and any earlier shortfall first)', () => {
    const r = apply(inst('1000'), [pay('q1', DUE[0]!, '1000'), pay('q2', DUE[1]!, '1000'), pay('q3short', DUE[2]!, '600'), pay('jan', '2027-01-12', '1400')]);
    const q3 = r.installments[2]!; const q4 = r.installments[3]!;
    expect(q3.paidInFullOn).toBe('2027-01-12');
    expect(q4.carriedIn).toBe('1000');
    expect(q4.paidInFullOn).toBe(DUE[3]);
    expect(q4.applied[0]!.source).toBe('carry');
  });

  it('excess beyond every installment is reported; payments after the return due date still reduce balances', () => {
    const r = apply(inst('1000'), [pay('all', DUE[0]!, '5000')]);
    expect(r.excessAfterLast).toBe('1000');
    expect(r.installments.every((i) => i.unpaidAtEnd === '0')).toBe(true);
    const late = apply(inst('1000'), [pay('after', '2027-05-01', '4000')]);
    expect(late.installments.every((i) => i.unpaidAtEnd === '0')).toBe(true);
    expect(late.installments[0]!.paidInFullOn).toBe('2027-05-01');
  });

  it('withholding shares flow to the earliest unpaid installment like any payment', () => {
    const r = apply(inst('1000'), [], '2000');
    const [q1, q2, q3, q4] = r.installments;
    // Q2's share finishes Q1 (Form 2210 Part III: later payments cover earlier underpayments first); Q3 + Q4 shares finish Q2.
    expect(q1!.unpaidAtEnd).toBe('0');
    expect(q1!.timeline.map((t) => t.balance)).toEqual(['1000', '500', '0']);
    expect(q1!.paidInFullOn).toBe(DUE[1]);
    expect(q2!.unpaidAtEnd).toBe('0'); expect(q2!.paidInFullOn).toBe(DUE[3]);
    expect(q3!.unpaidAtEnd).toBe('1000');
    expect(q4!.unpaidAtEnd).toBe('1000');
  });

  it('rejects a withholding-share list of the wrong length', () => {
    expect(() => applyPayments({ jurisdiction: 'federal', installments: inst('1'), withholdingShares: ['1'], payments: [], endDate: END })).toThrow(/TE_PAYMENTS_SHAPE/);
  });
});
