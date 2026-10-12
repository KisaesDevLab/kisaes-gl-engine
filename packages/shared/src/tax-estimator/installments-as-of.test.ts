// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { applyPayments, type EstimatePayment } from './engine/payments.js';
import { installmentsAsOf, type AsOfLedgerPayment } from './installments-as-of.js';

// Rivera-shaped federal schedule (QA run 2): four installments of 8,061.50, withholding
// 6,000 credited evenly (1,500 on each due date), estimates Apr 15 6,600 / Jun 15 6,600 /
// Sep 15 6,000, and (snapshot case) a post-dated Jan 15, 2027 payment of 7,046.
const DUES = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];
const pay = (id: string, date: string, amount: string): EstimatePayment => ({ id, date, amount, source: 'gl', jurisdiction: 'federal', transactionId: null, memo: null });
const BASE = [pay('p1', '2026-04-15', '6600'), pay('p2', '2026-06-15', '6600'), pay('p3', '2026-09-15', '6000')];

function estimate(payments: EstimatePayment[]) {
  const applied = applyPayments({
    jurisdiction: 'federal', installments: DUES.map((d, i) => ({ index: i, dueDate: d, required: '8061.5' })),
    withholdingShares: DUES.map(() => '1500'), payments, endDate: '2027-04-15',
  });
  return {
    jurisdiction: 'federal', payments: applied, installments: [],
    totals: { required: applied.totalRequired, withholding: '6000', estimatesPaid: applied.totalEstimates, unpaid: applied.totalUnpaidAtEnd, excess: applied.excessAfterLast },
  };
}
const ledger = (ps: EstimatePayment[]): AsOfLedgerPayment[] => ps.map((p) => ({ id: p.id, jurisdiction: p.jurisdiction, date: p.date, amount: p.amount }));

describe('installmentsAsOf (QA2-01 / D13)', () => {
  it('engine baseline: the Jan 15 withholding share back-fills Q3, so the year-end view calls Q3 paid on 2027-01-15', () => {
    const e = estimate(BASE);
    expect(e.payments.installments[2]!.paidInFullOn).toBe('2027-01-15');
    expect(e.payments.installments[2]!.unpaidAtEnd).toBe('0');
  });

  it('live (no future payments): Q3 is short as of today, Q4 keeps its own share; totals agree with the rows', () => {
    const r = installmentsAsOf(estimate(BASE), ledger(BASE), '2026-10-12');
    expect(r.installments.map((i) => i.status)).toEqual(['paid', 'paid', 'unpaid', 'unpaid']);
    expect(r.installments[2]).toMatchObject({ paid: '6000', remaining: '485', paidOn: null });
    expect(r.installments[3]).toMatchObject({ paid: '0', remaining: '6562', paidOn: null, catchUpAmount: '7046' });
    expect(r.installments[0]!.paidOn).toBe('2026-04-15');
    expect(r).toMatchObject({ estimatesPaid: '19200', remaining: '7046', scheduled: '0' });
  });

  it('snapshot with a post-dated payment: the same as-of figures; the payment is only "scheduled"', () => {
    const all = [...BASE, pay('p4', '2027-01-15', '7046')];
    const r = installmentsAsOf(estimate(all), ledger(all), '2026-10-12');
    expect(r.installments.map((i) => [i.status, i.remaining, i.paidOn])).toEqual([
      ['paid', '0', '2026-04-15'], ['paid', '0', '2026-06-15'], ['unpaid', '485', null], ['unpaid', '6562', null],
    ]);
    expect(r).toMatchObject({ estimatesPaid: '19200', remaining: '7046', scheduled: '7046' });
    // After the payment date everything is paid, exactly as the engine says.
    const later = installmentsAsOf(estimate(all), ledger(all), '2027-01-15');
    expect(later.installments.every((i) => i.status === 'paid')).toBe(true);
    expect(later).toMatchObject({ estimatesPaid: '26246', remaining: '0', scheduled: '0' });
  });

  it('a future-dated payment that reaches an upcoming installment only as a carry is not credited', () => {
    const ps = [pay('p1', '2026-04-15', '6562'), pay('p2', '2026-06-15', '6562'), pay('p3', '2026-09-15', '6562'), pay('p4', '2026-12-01', '5000')];
    const r = installmentsAsOf(estimate(ps), ledger(ps), '2026-10-12');
    expect(r.installments.map((i) => i.status)).toEqual(['paid', 'paid', 'paid', 'unpaid']);
    // 6,561.50 less the 1.50 carried in from the (past) small overpayments; the Dec 1 5,000 is not counted.
    expect(r.installments[3]!.remaining).toBe('6560');
    expect(r.scheduled).toBe('5000');
  });

  it('an early payment dated on or before today still covers an upcoming installment', () => {
    const ps = [...BASE, pay('p4', '2026-10-01', '485'), pay('p5', '2026-10-02', '6562')];
    const r = installmentsAsOf(estimate(ps), ledger(ps), '2026-10-12');
    expect(r.installments.map((i) => i.status)).toEqual(['paid', 'paid', 'paid', 'paid']);
    expect(r.installments[3]).toMatchObject({ paid: '0', remaining: '0', paidOn: null });
    expect(r.remaining).toBe('0');
  });

  it('estimates not required: no rows, totals passed through', () => {
    const r = installmentsAsOf({ jurisdiction: 'AR', installments: [], payments: null, totals: { required: '0', withholding: '0', estimatesPaid: '0', unpaid: '0', excess: '0' } }, [], '2026-10-12');
    expect(r).toEqual({ installments: [], estimatesPaid: '0', remaining: '0', scheduled: '0' });
  });
});
