// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  REPORT_CATALOG,
  getReportDef,
  resolvePreset,
  resolveReportDates,
  reportPackItemOptionsSchema,
  PACK_MAX_COUNT,
  PACK_WARN_COUNT,
  type ReportDef,
} from './registry.js';

// Fixed "today": Tuesday 2026-07-07 (July, Q3).
const TODAY = new Date(2026, 6, 7);

describe('resolvePreset', () => {
  it('this-month → first..last day of the current month', () => {
    expect(resolvePreset('this-month', TODAY)).toEqual({ start: '2026-07-01', end: '2026-07-31' });
  });

  it('last-month → first..last day of the prior month', () => {
    expect(resolvePreset('last-month', TODAY)).toEqual({ start: '2026-06-01', end: '2026-06-30' });
  });

  it('qtd → first day of current quarter .. today', () => {
    // July is in Q3 (Jul-Sep), which starts 2026-07-01.
    expect(resolvePreset('qtd', TODAY)).toEqual({ start: '2026-07-01', end: '2026-07-07' });
  });

  it('last-quarter → the previous full quarter', () => {
    // Current quarter Q3 starts Jul; previous full quarter is Q2 (Apr-Jun).
    expect(resolvePreset('last-quarter', TODAY)).toEqual({ start: '2026-04-01', end: '2026-06-30' });
  });

  it('last-quarter crosses the year boundary correctly', () => {
    const jan = new Date(2026, 0, 15); // Q1 → previous full quarter is Q4 2025
    expect(resolvePreset('last-quarter', jan)).toEqual({ start: '2025-10-01', end: '2025-12-31' });
  });

  it('ytd → Jan 1 .. today', () => {
    expect(resolvePreset('ytd', TODAY)).toEqual({ start: '2026-01-01', end: '2026-07-07' });
  });

  it('last-year → full prior calendar year', () => {
    expect(resolvePreset('last-year', TODAY)).toEqual({ start: '2025-01-01', end: '2025-12-31' });
  });

  it('custom → empty strings (caller supplies dates)', () => {
    expect(resolvePreset('custom', TODAY)).toEqual({ start: '', end: '' });
  });
});

describe('resolveReportDates', () => {
  const range = { start: '2026-01-01', end: '2026-03-31' };
  const dateRangeDef = getReportDef('profit-loss') as ReportDef;
  const asOfDef = getReportDef('balance-sheet') as ReportDef;

  it('date-range → start_date + end_date', () => {
    expect(resolveReportDates(dateRangeDef, range)).toEqual({
      start_date: '2026-01-01',
      end_date: '2026-03-31',
    });
  });

  it('as-of → as_of_date defaults to range end', () => {
    expect(resolveReportDates(asOfDef, range)).toEqual({ as_of_date: '2026-03-31' });
  });

  it('as-of → as_of_date honors an explicit override', () => {
    expect(resolveReportDates(asOfDef, range, '2026-02-15')).toEqual({ as_of_date: '2026-02-15' });
  });

  it('current-state → empty params', () => {
    const csDef: ReportDef = { ...dateRangeDef, temporal: 'current-state' };
    expect(resolveReportDates(csDef, range)).toEqual({});
  });
});

describe('REPORT_CATALOG', () => {
  it('has unique ids that equal their endpoint', () => {
    const ids = REPORT_CATALOG.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const def of REPORT_CATALOG) expect(def.endpoint).toBe(def.id);
  });

  it('general-ledger renders landscape', () => {
    expect(getReportDef('general-ledger')?.orientation).toBe('landscape');
  });

  it('exposes sane pack count bounds', () => {
    expect(PACK_WARN_COUNT).toBeLessThan(PACK_MAX_COUNT);
    expect(PACK_MAX_COUNT).toBe(30);
  });
});

describe('reportPackItemOptionsSchema', () => {
  it('accepts a valid options object', () => {
    const parsed = reportPackItemOptionsSchema.parse({
      basis: 'cash',
      compare: true,
      tagId: '11111111-1111-4111-8111-111111111111',
      groupBy: 'detail_type',
      showPct: true,
    });
    expect(parsed.basis).toBe('cash');
    expect(parsed.compare).toBe(true);
  });

  it('exposes compare on the comparative-capable reports', () => {
    expect(getReportDef('profit-loss')?.options.compare).toBe(true);
    expect(getReportDef('balance-sheet')?.options.compare).toBe(true);
    // Non-comparative reports do not offer it.
    expect(getReportDef('cash-flow')?.options.compare).toBeUndefined();
  });

  it('accepts an empty object', () => {
    expect(reportPackItemOptionsSchema.parse({})).toEqual({});
  });

  it('rejects unknown keys', () => {
    expect(() => reportPackItemOptionsSchema.parse({ nope: 1 })).toThrow();
  });

  it('rejects a non-uuid tagId', () => {
    expect(() => reportPackItemOptionsSchema.parse({ tagId: 'not-a-uuid' })).toThrow();
  });
});
