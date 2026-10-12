// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import type { EstimateResultDTO } from '@kis-books/shared';
import { applyPayments } from '@kis-books/shared';
import { toPortalEstimate } from './portal-estimates.service.js';

const inst = (label: string, dueDate: string, over: Record<string, string | null> = {}) => ({
  index: 0, label, dueDate, statutoryDueDate: dueDate, regularInstallment: '1000', annualizedInstallment: null, required: '1000',
  withholdingShare: '0', carriedIn: '0', netRequired: '1000', estimatesApplied: '0', unpaid: '1000', catchUpAmount: '1000',
  paidInFullOn: null, status: 'unpaid', ...over,
});
const jur = (jurisdiction: string, installments: ReturnType<typeof inst>[]) => ({
  jurisdiction, estimatesRequired: true, installments,
  totals: { required: '4000', withholding: '0', estimatesPaid: '0', unpaid: '4000' },
});
const result = (fed: ReturnType<typeof jur>, payments: Array<{ date: string | null; jurisdiction: string; amount: string }> = []) => ({
  taxYear: 2026, entities: [], summary: { total: '5000', federalTotal: '4000', stateTotal: '1000' },
  federalEstimates: fed, stateEstimates: [], payments,
}) as unknown as EstimateResultDTO;
const meta = (today: string) => ({ taxpayer: { id: 't', displayName: 'Rivera' }, source: 'live' as const, asOf: `${today}T12:00:00Z`, firmName: null, disclaimer: 'x', today });

describe('toPortalEstimate (QA D12 / D13)', () => {
  const four = [
    inst('Q1', '2026-04-15', { status: 'paid', unpaid: '0', catchUpAmount: '0', estimatesApplied: '1000' }),
    inst('Q2', '2026-06-15', { catchUpAmount: '1000' }),
    inst('Q3', '2026-09-15', { catchUpAmount: '2000' }),
    inst('Q4', '2027-01-15', { catchUpAmount: '3000' }),
  ];

  it('the next payment is the next UPCOMING due date (with the earlier unpaid balance), never a past one', () => {
    const p = toPortalEstimate(result(jur('federal', four)), meta('2026-10-12'));
    expect(p.jurisdictions[0]!.nextPayment).toEqual({ label: 'Q4', dueDate: '2027-01-15', amount: '3000' });
    // Past-due installments stay in the list as unpaid.
    expect(p.jurisdictions[0]!.installments.filter((i) => i.status === 'unpaid').map((i) => i.label)).toEqual(['Q2', 'Q3', 'Q4']);
  });

  it('a due date of today is still "next"; nothing upcoming and nothing owed → null', () => {
    expect(toPortalEstimate(result(jur('federal', four)), meta('2026-09-15')).jurisdictions[0]!.nextPayment!.label).toBe('Q3');
    const paid = four.map((i) => ({ ...i, status: 'paid', unpaid: '0', catchUpAmount: '0' }));
    expect(toPortalEstimate(result(jur('federal', paid)), meta('2026-10-12')).jurisdictions[0]!.nextPayment).toBeNull();
  });

  it('payments dated after today are not listed as on record', () => {
    const p = toPortalEstimate(result(jur('federal', four), [
      { date: '2026-04-15', jurisdiction: 'federal', amount: '1000' }, { date: '2027-01-15', jurisdiction: 'federal', amount: '5000' },
      { date: null, jurisdiction: 'federal', amount: '200' },
    ]), meta('2026-10-12'));
    expect(p.payments.map((x) => x.date)).toEqual([null, '2026-04-15']);
  });
});

// QA run 2 (QA2-01): Rivera-shaped federal schedule with the application record the engine
// keeps — the Jan 15, 2027 withholding share (and, in a snapshot, a post-dated payment)
// back-fills Q3, which the engine therefore reports as paid on 2027-01-15.
describe('toPortalEstimate as of today (QA2-01 / D13)', () => {
  const dues = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];
  const pays = (withFuture: boolean) => [
    ['p1', '2026-04-15', '6600'], ['p2', '2026-06-15', '6600'], ['p3', '2026-09-15', '6000'], ...(withFuture ? [['p4', '2027-01-15', '7046']] : []),
  ].map(([id, date, amount]) => ({ id: id!, date: date!, amount: amount!, source: 'gl' as const, jurisdiction: 'federal' as const, transactionId: null, memo: null }));
  const rivera = (withFuture: boolean) => {
    const ps = pays(withFuture);
    const app = applyPayments({ jurisdiction: 'federal', installments: dues.map((d, i) => ({ index: i, dueDate: d, required: '8061.5' })), withholdingShares: dues.map(() => '1500'), payments: ps, endDate: '2027-04-15' });
    let cum = '0';
    const installments = app.installments.map((a, i) => {
      cum = String(Number(cum) + Number(a.unpaidAtEnd));
      const est = a.applied.filter((x) => x.source !== 'withholding' && x.source !== 'carry').reduce((t, x) => t + Number(x.amount), 0);
      return inst(`Q${i + 1}`, a.dueDate, { netRequired: a.netRequired, estimatesApplied: String(Math.round(est)), unpaid: a.unpaidAtEnd, catchUpAmount: cum, paidInFullOn: a.paidInFullOn, status: Number(a.unpaidAtEnd) > 0 ? 'unpaid' : 'paid' });
    });
    const fed = { jurisdiction: 'federal', estimatesRequired: true, installments, payments: app,
      totals: { required: app.totalRequired, withholding: '6000', estimatesPaid: app.totalEstimates, unpaid: app.totalUnpaidAtEnd } };
    return result(fed as unknown as ReturnType<typeof jur>, ps);
  };

  it('live: Q3 is past due by the shortfall, not Paid on a 2027 date; totals agree with the rows', () => {
    const r = rivera(false);
    expect(r.federalEstimates.installments[2]!.status).toBe('paid'); // the engine's year-end view
    const p = toPortalEstimate(r, meta('2026-10-12')).jurisdictions[0]!;
    expect(p.installments.map((i) => [i.label, i.status, i.paid, i.remaining, i.paidOn])).toEqual([
      ['Q1', 'paid', '6562', '0', '2026-04-15'], ['Q2', 'paid', '6523', '0', '2026-06-15'],
      ['Q3', 'unpaid', '6000', '485', null], ['Q4', 'unpaid', '0', '6562', null],
    ]);
    expect(p.totals).toMatchObject({ estimatesPaid: '19200', remaining: '7046' });
    expect(p.nextPayment).toEqual({ label: 'Q4', dueDate: '2027-01-15', amount: '7046' });
  });

  it('snapshot with a post-dated payment: the frozen result stays as is, the projection applies the same as-of rule', () => {
    const r = rivera(true);
    expect(r.federalEstimates.installments[3]!.status).toBe('paid');
    const p = toPortalEstimate(r, { ...meta('2026-10-12'), source: 'snapshot' }).jurisdictions[0]!;
    expect(p.installments.map((i) => i.status)).toEqual(['paid', 'paid', 'unpaid', 'unpaid']);
    expect(p.installments.some((i) => i.paidOn === '2027-01-15')).toBe(false);
    expect(p.totals).toMatchObject({ estimatesPaid: '19200', remaining: '7046' });
    expect(p.nextPayment).toEqual({ label: 'Q4', dueDate: '2027-01-15', amount: '7046' });
    // The frozen payload itself is not modified.
    expect(r.federalEstimates.totals.estimatesPaid).toBe('26246');
  });
});

