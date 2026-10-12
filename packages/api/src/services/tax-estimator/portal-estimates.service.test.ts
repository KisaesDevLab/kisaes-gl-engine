// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import type { EstimateResultDTO } from '@kis-books/shared';
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
