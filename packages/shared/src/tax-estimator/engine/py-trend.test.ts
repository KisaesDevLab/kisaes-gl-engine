// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q46 prior-year trend projection (engine/py-trend.ts + income.ts allocateEntity).

import { describe, it, expect } from 'vitest';
import { EngineContext } from './context.js';
import { characters, allocateEntity } from './income.js';
import { evaluatePriorYearTrend, priorYearTrendFor } from './py-trend.js';
import type { EngineEntity, EnginePriorYearTrend } from './types.js';
import type { PriorYearMonthlyFigures } from '../projection-method.js';

/** PY 2025: Jan–Sep 100,000 (seasonal), Oct–Dec 80,000; full year 180,000; every month active. */
const PY: PriorYearMonthlyFigures = {
  taxYear: 2025,
  recurringOrdinary: ['5000', '5000', '10000', '10000', '10000', '15000', '15000', '15000', '15000', '30000', '30000', '20000'],
  active: Array(12).fill(true) as boolean[],
};
// The worked example: CY YTD 120,000 through September, all recurring.
const CY = { ytdOrdinary: '120000', recurringOrdinary: '120000', monthsElapsed: 9, monthsRemaining: 3 };

const ctxOf = () => {
  const ctx = new EngineContext({}, 2026, 'single');
  ctx.setPersons([{ personId: 'p', role: 'primary' }]);
  return ctx;
};
const entity = (extra: Partial<EngineEntity>): EngineEntity => ({
  tenantId: 't', companyId: 'c', companyName: 'Seasonal Co', entityType: 'sch_c', monthsElapsed: 9, monthsRemaining: 3,
  ytd: characters({ ordinary: '120000', interest: '900' }), recurringYtd: characters({ ordinary: '120000', interest: '900' }),
  ownerItems: [], guaranteedPayments: [], officerWages: [], taxDepreciationBookYtd: '0',
  links: [{ linkId: 'l', personId: 'p', profitPct: null, lossPct: null, partnerSeStatus: null, isOfficer: false, activityType: 'active', activeParticipation: false, qbiEligible: null, allowedLossOverride: null }],
  isSstb: false, rentalQbiTradeOrBusiness: false, w2WagesEffective: null, ubia: null, warnings: [], ...extra,
});
const n = (v: string) => Number(v);

describe('priorYearTrendFor — split at the through month', () => {
  it('same months = Jan..through, remaining = the rest, activity counted', () => {
    const t = priorYearTrendFor('prior_year_scaled', PY, 9);
    expect(t.priorYear).toEqual({ taxYear: 2025, throughMonth: 9, sameMonthsOrdinary: '100000', remainingOrdinary: '80000', monthsWithActivity: 12 });
    expect(t.unavailableReason).toBeNull();
    expect(priorYearTrendFor('prior_year_dollar', PY, 12).priorYear!.remainingOrdinary).toBe('0');
  });
  it('no figures or a service reason → no PY block, with the reason', () => {
    expect(priorYearTrendFor('prior_year_scaled', null, 9)).toEqual({ method: 'prior_year_scaled', priorYear: null, unavailableReason: 'py_unreadable' });
    expect(priorYearTrendFor('prior_year_dollar', null, 9, 'not_supported_entity').unavailableReason).toBe('not_supported_entity');
  });
});

describe('evaluatePriorYearTrend — the worked example', () => {
  it('run rate 160,000; scaled 216,000 (×1.2); dollar 200,000', () => {
    const scaled = evaluatePriorYearTrend(CY, priorYearTrendFor('prior_year_scaled', PY, 9));
    expect(n(scaled.runRateOrdinary)).toBe(160000);
    expect(n(scaled.projectedOrdinary)).toBe(216000);
    expect(n(scaled.factor!)).toBe(1.2);
    expect(scaled).toMatchObject({ applied: 'prior_year_scaled', fallbackReason: null, capped: null });
    const dollar = evaluatePriorYearTrend(CY, priorYearTrendFor('prior_year_dollar', PY, 9));
    expect(n(dollar.projectedOrdinary)).toBe(200000);
    expect(dollar).toMatchObject({ applied: 'prior_year_dollar', factor: null, fallbackReason: null });
  });
  it('non-recurring YTD counts once: ordinary = YTD (incl. non-recurring) + PY remaining × recurring ratio', () => {
    const r = evaluatePriorYearTrend({ ...CY, ytdOrdinary: '130000' }, priorYearTrendFor('prior_year_scaled', PY, 9));
    expect(n(r.projectedOrdinary)).toBe(130000 + 80000 * 1.2);
  });
});

describe('evaluatePriorYearTrend — fallbacks to the run rate', () => {
  const fb = (t: EnginePriorYearTrend, cy = CY) => evaluatePriorYearTrend(cy, t);
  const withMonths = (f: Partial<PriorYearMonthlyFigures>): PriorYearMonthlyFigures => ({ ...PY, ...f });
  it.each([
    ['py_unreadable', priorYearTrendFor('prior_year_scaled', null, 9)],
    ['not_supported_entity', priorYearTrendFor('prior_year_scaled', null, 9, 'not_supported_entity')],
    ['py_books_missing', priorYearTrendFor('prior_year_scaled', withMonths({ active: Array(12).fill(false) as boolean[] }), 9)],
    ['py_books_incomplete', priorYearTrendFor('prior_year_dollar', withMonths({ active: [false, ...Array(11).fill(true) as boolean[]] }), 9)],
    ['py_same_months_not_positive', priorYearTrendFor('prior_year_scaled', withMonths({ recurringOrdinary: ['-1000', ...Array(8).fill('0') as string[], '30000', '30000', '20000'] }), 9)],
    // same 9,000 vs full 189,000: 4.8% < 10%
    ['py_same_months_small', priorYearTrendFor('prior_year_scaled', withMonths({ recurringOrdinary: ['1000', ...Array(8).fill('1000') as string[], '60000', '60000', '60000'] }), 9)],
  ] as const)('%s', (reason, t) => {
    const r = fb(t);
    expect(r).toMatchObject({ applied: 'run_rate', fallbackReason: reason, factor: null });
    expect(n(r.projectedOrdinary)).toBe(160000);
  });
  it('cy_recurring_not_positive (scaled only)', () => {
    const r = fb(priorYearTrendFor('prior_year_scaled', PY, 9), { ytdOrdinary: '-9000', recurringOrdinary: '-9000', monthsElapsed: 9, monthsRemaining: 3 });
    expect(r).toMatchObject({ applied: 'run_rate', fallbackReason: 'cy_recurring_not_positive' });
    expect(n(r.projectedOrdinary)).toBe(-12000);
  });
  it('the dollar method needs complete books only (the ratio guardrails do not apply)', () => {
    const t = priorYearTrendFor('prior_year_dollar', withMonths({ recurringOrdinary: ['-1000', ...Array(8).fill('0') as string[], '30000', '30000', '20000'] }), 9);
    expect(fb(t)).toMatchObject({ applied: 'prior_year_dollar', fallbackReason: null });
    expect(n(fb(t).projectedOrdinary)).toBe(200000);
  });
  it('a closed year projects nothing: YTD, method kept, no fallback', () => {
    const r = fb(priorYearTrendFor('prior_year_scaled', null, 12), { ytdOrdinary: '150000', recurringOrdinary: '150000', monthsElapsed: 12, monthsRemaining: 0 });
    expect(r).toMatchObject({ applied: 'prior_year_scaled', fallbackReason: null });
    expect(n(r.projectedOrdinary)).toBe(150000);
  });
});

describe('evaluatePriorYearTrend — the scale factor cap [0.25, 4]', () => {
  it('caps at 4 (CY 500,000 vs PY same 100,000 = 5)', () => {
    const r = evaluatePriorYearTrend({ ...CY, ytdOrdinary: '500000', recurringOrdinary: '500000' }, priorYearTrendFor('prior_year_scaled', PY, 9));
    expect(r).toMatchObject({ capped: 'max', factor: '4' });
    expect(n(r.rawFactor!)).toBe(5);
    expect(n(r.projectedOrdinary)).toBe(500000 + 80000 * 4);
  });
  it('caps at 0.25 (CY 10,000 vs 100,000 = 0.1)', () => {
    const r = evaluatePriorYearTrend({ ...CY, ytdOrdinary: '10000', recurringOrdinary: '10000' }, priorYearTrendFor('prior_year_scaled', PY, 9));
    expect(r).toMatchObject({ capped: 'min', factor: '0.25' });
    expect(n(r.projectedOrdinary)).toBe(10000 + 80000 * 0.25);
  });
  it('exactly at a bound is not capped', () => {
    const r = evaluatePriorYearTrend({ ...CY, ytdOrdinary: '400000', recurringOrdinary: '400000' }, priorYearTrendFor('prior_year_scaled', PY, 9));
    expect(r.capped).toBeNull();
    expect(n(r.factor!)).toBe(4);
  });
});

describe('allocateEntity with a prior-year trend', () => {
  it('ordinary follows the trend; other characters keep the run rate; trace + comparison', () => {
    const ctx = ctxOf();
    const a = allocateEntity(entity({ priorYearTrend: priorYearTrendFor('prior_year_scaled', PY, 9) }), [], ctx);
    expect(n(a.projected.ordinary)).toBe(216000);
    expect(n(a.projected.interest)).toBe(1200); // 900 + 900 / 9 × 3
    expect(n(a.projectedProfit)).toBe(217200);
    expect(n(a.runRateProjectedProfit!)).toBe(161200);
    const rows = ctx.trace.rows();
    expect(rows.find((r) => r.id === 'entity.t:c.ordinary')!.formula).toMatch(/PY 2025 months 10–12 80000 × 1\.2 \(CY recurring 120000 ÷ PY months 1–9 100000\)/);
    expect(rows.find((r) => r.id === 'entity.t:c.py_trend')).toMatchObject({ amount: '180000' });
    expect(rows.find((r) => r.id === 'entity.t:c.ordinary.run_rate')).toMatchObject({ amount: '160000' });
    expect(ctx.allWarnings()).toEqual([]);
  });
  it('fallback warns TE_PY_TREND_FALLBACK with the reason and projects the run rate', () => {
    const ctx = ctxOf();
    const a = allocateEntity(entity({ priorYearTrend: priorYearTrendFor('prior_year_dollar', { ...PY, active: Array(6).fill(true).concat(Array(6).fill(false)) as boolean[] }, 9) }), [], ctx);
    expect(n(a.projected.ordinary)).toBe(160000);
    expect(ctx.allWarnings()).toEqual([expect.objectContaining({ code: 'TE_PY_TREND_FALLBACK', severity: 'warning', details: expect.objectContaining({ reason: 'py_books_incomplete', method: 'prior_year_dollar' }) })]);
  });
  it('a capped factor emits TE_PY_TREND_CAPPED (info)', () => {
    const ctx = ctxOf();
    allocateEntity(entity({ ytd: characters({ ordinary: '500000' }), recurringYtd: characters({ ordinary: '500000' }), priorYearTrend: priorYearTrendFor('prior_year_scaled', PY, 9) }), [], ctx);
    expect(ctx.allWarnings()).toEqual([expect.objectContaining({ code: 'TE_PY_TREND_CAPPED', severity: 'info' })]);
  });
  it('no trend (run rate) → identical allocation, no trend fields, no extra trace rows', () => {
    const c1 = ctxOf();
    const c2 = ctxOf();
    const a = allocateEntity(entity({}), [], c1);
    const b = allocateEntity(entity({ priorYearTrend: undefined }), [], c2);
    expect(a).not.toHaveProperty('trend');
    expect(JSON.stringify({ ...b, entity: undefined })).toBe(JSON.stringify({ ...a, entity: undefined }));
    expect(c2.trace.rows()).toEqual(c1.trace.rows());
    expect(n(a.projected.ordinary)).toBe(160000);
  });
});
