// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 10 §6654 penalty (D7): event-driven accrual on each installment's unpaid
// balance from its due date to the earlier of payment or the return due date;
// payment before the due date → nothing; late payment → days at the quarterly
// rate (segments split at rate changes and year ends); overpayment carry; state
// monthly methods; tiered_flat not computed; waivers; unpublished rates verify.

import { describe, it, expect } from 'vitest';
import { accruePenalty, flatRateLookup, scheduleRateLookup, type PenaltyPolicy } from './penalty.js';
import { applyPayments, withholdingShares, type EstimatePayment } from './payments.js';
import type { InstallmentDue } from './estimate-types.js';
import { dMul, dDiv } from '../decimal.js';

const DUE = ['2026-04-15', '2026-06-15', '2026-09-15', '2027-01-15'];
const END = '2027-04-15';
const RATES = [
  { from: '2026-01-01', to: '2026-03-31', rate: '0.07' }, { from: '2026-04-01', to: '2026-06-30', rate: '0.06' },
  { from: '2026-07-01', to: '2026-09-30', rate: '0.07' }, { from: '2026-10-01', to: '2026-12-31', rate: '0.07' },
  { from: '2027-01-01', to: '2027-03-31', rate: '0.07' }, { from: '2027-04-01', to: '2027-06-30', rate: '0.07' },
];
const lookup = scheduleRateLookup(RATES, ['penalty.underpayment_rate']);
const inst = (required: string): InstallmentDue[] => DUE.map((d, i) => ({ index: i, dueDate: d, required }));
const pay = (id: string, date: string, amount: string): EstimatePayment => ({ id, date, amount, source: 'manual', jurisdiction: 'federal' });
const applied = (installments: InstallmentDue[], payments: EstimatePayment[], withholding = '0') =>
  applyPayments({ jurisdiction: 'federal', installments, withholdingShares: withholdingShares(withholding, installments.map(() => '0.25')), payments, endDate: END });
const policy = (over: Partial<PenaltyPolicy> = {}): PenaltyPolicy => ({ jurisdiction: 'federal', method: 'daily_simple', rateOn: lookup, returnDueDate: END, waiver: null, lastInstallmentReliefDate: '2027-02-01', verify: false, ...over });

describe('accruePenalty — daily_simple (federal)', () => {
  it('Rivera: Q3 short 484.575 from Sep 15 to the Jan 15 payment at 7% → 11; everything else 0 (oracle ≈ $11)', () => {
    const a = applied(inst('8061.525'), [pay('q1', DUE[0]!, '6600'), pay('q2', DUE[1]!, '6600'), pay('q3', DUE[2]!, '6000'), pay('q4', DUE[3]!, '7046.1')], '6000');
    const r = accruePenalty(a, policy());
    expect(r.installments.map((i) => i.penalty)).toEqual(['0', '0', '11', '0']);
    expect(r.total).toBe('11');
    const q3 = r.installments[2]!;
    expect(q3.accruedTo).toBe(DUE[3]);
    // 122 days Sep 15 → Jan 15 at 7% throughout; both calendar years have 365 days so the run is one segment.
    expect(q3.segments.map((s) => [s.from, s.to, s.units, s.daysInYear, s.rate])).toEqual([[DUE[2], DUE[3], 122, 365, '0.07']]);
    expect(Number(r.exact.total)).toBeCloseTo(484.575 * 0.07 * 122 / 365, 6);
    expect(r.verify).toBe(false);
    expect(r.notes.some((n) => n.includes('2027-02-01'))).toBe(true);
  });

  it('payment before the due date → no penalty; payment on the due date → no penalty', () => {
    const early = accruePenalty(applied(inst('1000'), [pay('e', '2026-03-01', '4000')]), policy());
    expect(early.total).toBe('0');
    expect(early.installments.every((i) => i.segments.length === 0)).toBe(true);
    const onTime = accruePenalty(applied(inst('1000'), DUE.map((d, i) => pay(`p${i}`, d, '1000'))), policy());
    expect(onTime.total).toBe('0');
  });

  it('late payment: Q1 1,000 paid Jul 1 accrues 6% for the 77 days Apr 15 → Jul 1 in one segment', () => {
    const r = accruePenalty(applied(inst('1000'), [pay('late', '2026-07-01', '1000')]), policy());
    const q1 = r.installments[0]!;
    expect(q1.segments.map((s) => [s.from, s.to, s.units, s.rate])).toEqual([[DUE[0], '2026-07-01', 77, '0.06']]);
    expect(q1.exact).toBe(dDiv(dMul(dMul('1000', '0.06'), '77'), '365'));
    expect(r.installments.slice(1).every((i) => i.accruedTo === END)).toBe(true);
    expect(r.installments.map((i) => i.segments.length)).toEqual([1, 2, 1, 1]); // Q2 spans the Jun 30 → Jul 1 rate change
    expect(r.installments[3]!.segments[0]!.units).toBe(90); // Jan 15 → Apr 15, 2027
  });

  it('late payment across a rate change splits the accrual at the quarter boundary', () => {
    const r = accruePenalty(applied(inst('1000'), [pay('late', '2026-08-01', '1000')]), policy());
    const q1 = r.installments[0]!;
    expect(q1.segments.map((s) => [s.from, s.to, s.units, s.rate])).toEqual([[DUE[0], '2026-07-01', 77, '0.06'], ['2026-07-01', '2026-08-01', 31, '0.07']]);
  });

  it('overpayment carry: a big Q1 payment leaves nothing to accrue on Q2 even though no Q2 payment was made', () => {
    const r = accruePenalty(applied(inst('1000'), [pay('big', DUE[0]!, '2000')]), policy());
    expect(r.installments[0]!.penalty).toBe('0');
    expect(r.installments[1]!.penalty).toBe('0');
    expect(r.installments[2]!.segments.length).toBe(1);
  });

  it('a partial payment reduces the accruing balance from its date (two balance segments)', () => {
    const r = accruePenalty(applied(inst('1000'), [pay('half', '2026-05-15', '500'), pay('rest', '2026-06-15', '500')]), policy());
    const q1 = r.installments[0]!;
    expect(q1.segments.map((s) => [s.balance, s.units])).toEqual([['1000', 30], ['500', 31]]);
    expect(q1.accruedTo).toBe('2026-06-15');
  });

  it('accrual stops at the return due date even when a payment comes later', () => {
    const r = accruePenalty(applied(inst('1000'), [pay('verylate', '2027-06-01', '4000')]), policy());
    expect(r.installments.every((i) => i.accruedTo === END)).toBe(true);
    expect(r.installments[0]!.segments[r.installments[0]!.segments.length - 1]!.to).toBe(END);
  });

  it('a day without a published rate uses the latest published rate and flags verify', () => {
    const short = scheduleRateLookup(RATES.slice(0, 4), ['penalty.underpayment_rate']);
    const r = accruePenalty(applied(inst('1000'), []), policy({ rateOn: short }));
    expect(r.verify).toBe(true);
    expect(r.installments[3]!.segments[0]!.rateUncovered).toBe(true);
    expect(r.installments[3]!.segments[0]!.rate).toBe('0.07');
  });

  it('waiver zeroes the total but keeps the before-waiver figure and schedule', () => {
    const r = accruePenalty(applied(inst('1000'), []), policy({ waiver: { reason: 'prior_year_zero_tax', detail: 'the prior-year tax was zero.' } }));
    expect(r.total).toBe('0');
    expect(Number(r.totalBeforeWaiver)).toBeGreaterThan(0);
    expect(r.notes[0]).toMatch(/No underpayment penalty/);
  });

  it('leap-year days divide by 366', () => {
    const leap = accruePenalty(
      applyPayments({ jurisdiction: 'federal', installments: [{ index: 0, dueDate: '2028-04-17', required: '1000' }], withholdingShares: ['0'], payments: [pay('p', '2028-05-17', '1000')], endDate: '2029-04-16' }),
      policy({ rateOn: flatRateLookup('0.07'), returnDueDate: '2029-04-16' }),
    );
    expect(leap.installments[0]!.segments[0]!.daysInYear).toBe(366);
    expect(leap.installments[0]!.exact).toBe(dDiv(dMul(dMul('1000', '0.07'), '30'), '366'));
  });
});

describe('accruePenalty — state methods', () => {
  const one = (): InstallmentDue[] => [{ index: 0, dueDate: '2026-04-15', required: '1200' }];
  const unpaidUntil = (date: string) => applyPayments({ jurisdiction: 'HI', installments: one(), withholdingShares: ['0'], payments: [{ id: 'p', date, amount: '1200', source: 'manual', jurisdiction: 'HI' }], endDate: END });

  it('monthly_or_fraction (HI): rate/12 per month or part — Apr 15 → Jun 20 is 3 months', () => {
    const r = accruePenalty(unpaidUntil('2026-06-20'), policy({ jurisdiction: 'HI', method: 'monthly_or_fraction', rateOn: flatRateLookup('0.08') }));
    expect(r.installments[0]!.segments[0]!.units).toBe(3);
    expect(r.installments[0]!.exact).toBe(dMul(dMul('1200', dDiv('0.08', '12')), '3'));
    expect(r.total).toBe('24');
  });

  it('monthly_compound (ME): (1 + rate/12)^months − 1', () => {
    const r = accruePenalty(unpaidUntil('2026-06-15'), policy({ jurisdiction: 'ME', method: 'monthly_compound', rateOn: flatRateLookup('0.12') }));
    expect(r.installments[0]!.segments[0]!.units).toBe(2);
    expect(Number(r.installments[0]!.exact)).toBeCloseTo(1200 * (1.01 ** 2 - 1), 8);
  });

  it('tiered_flat (IL): nothing computed, verify, warning note', () => {
    const r = accruePenalty(unpaidUntil('2027-01-15'), policy({ jurisdiction: 'IL', method: 'tiered_flat', rateOn: () => ({ rate: null, covered: true, keys: [] }) }));
    expect(r.computed).toBe(false);
    expect(r.total).toBe('0');
    expect(r.verify).toBe(true);
    expect(r.installments[0]!.segments).toEqual([]);
  });
});
