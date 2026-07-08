// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Unit test for the report-pack render map: proves each pack item's options
// map onto the correct report builder + params. Service/route deps are mocked
// so the map is exercised without a DB or Chromium.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const buildProfitAndLoss = vi.fn(async (..._args: unknown[]) => ({ kind: 'pl' as const }));
const buildBalanceSheet = vi.fn(async (..._args: unknown[]) => ({ kind: 'bs' as const }));
const buildComparativePL = vi.fn(async (..._args: unknown[]) => ({ kind: 'cmp-pl' as const }));
const buildComparativeBS = vi.fn(async (..._args: unknown[]) => ({ kind: 'cmp-bs' as const }));

vi.mock('./report.service.js', () => ({
  buildProfitAndLoss: (...args: unknown[]) => buildProfitAndLoss(...args),
  buildBalanceSheet: (...args: unknown[]) => buildBalanceSheet(...args),
  buildCashFlowStatement: vi.fn(),
  buildTrialBalance: vi.fn(),
  buildGeneralLedger: vi.fn(),
  buildARAgingSummary: vi.fn(),
  buildExpenseByCategory: vi.fn(),
}));
vi.mock('./report-comparison.service.js', () => ({
  buildComparativePL: (...args: unknown[]) => buildComparativePL(...args),
  buildComparativeBS: (...args: unknown[]) => buildComparativeBS(...args),
}));
vi.mock('./ap-report.service.js', () => ({ buildApAgingSummary: vi.fn() }));
// Avoid loading the heavy routes graph (DB, other services) just for the two
// export helpers the render map re-exports.
vi.mock('../routes/reports.routes.js', () => ({
  extractDataAndColumns: vi.fn(() => ({ rows: [], columns: [] })),
  buildHtmlTable: vi.fn(() => ''),
}));

import { REPORT_PACK_RENDERERS, type PackRenderOpts } from './report-pack-render.js';

const TENANT = 't1';
const COMPANY = 'c1';
const PARAMS = { start_date: '2026-01-01', end_date: '2026-03-31', as_of_date: '2026-03-31' };

function opts(over: Partial<PackRenderOpts> = {}): PackRenderOpts {
  return { basis: 'accrual', tagId: null, groupBy: null, showPct: false, compare: false, ...over };
}

describe('REPORT_PACK_RENDERERS profit-loss', () => {
  beforeEach(() => {
    buildProfitAndLoss.mockClear();
    buildComparativePL.mockClear();
  });

  it('renders the standard P&L when compare is off', async () => {
    const out = await REPORT_PACK_RENDERERS['profit-loss']!(
      TENANT, COMPANY, PARAMS, opts({ basis: 'cash', tagId: 'tag-1', groupBy: 'detail_type' }),
    );
    expect(buildComparativePL).not.toHaveBeenCalled();
    expect(buildProfitAndLoss).toHaveBeenCalledWith(
      TENANT, '2026-01-01', '2026-03-31', 'cash', COMPANY, 'tag-1', 'detail_type',
    );
    expect(out).toEqual({ kind: 'pl' });
  });

  it('renders a cash-basis, grouped, %-of-income, comparative P&L when compare is on', async () => {
    const out = await REPORT_PACK_RENDERERS['profit-loss']!(
      TENANT, COMPANY, PARAMS, opts({ basis: 'cash', groupBy: 'detail_type', showPct: true, compare: true }),
    );
    expect(buildProfitAndLoss).not.toHaveBeenCalled();
    expect(buildComparativePL).toHaveBeenCalledWith(
      TENANT, '2026-01-01', '2026-03-31', 'cash', 'previous_period', 6, 'month', COMPANY, 'detail_type',
    );
    // showPct rides along so the export gains the % companion columns.
    expect(out).toEqual({ kind: 'cmp-pl', showPct: true });
  });
});

describe('REPORT_PACK_RENDERERS balance-sheet', () => {
  beforeEach(() => {
    buildBalanceSheet.mockClear();
    buildComparativeBS.mockClear();
  });

  it('renders the standard balance sheet when compare is off', async () => {
    await REPORT_PACK_RENDERERS['balance-sheet']!(TENANT, COMPANY, PARAMS, opts({ groupBy: 'detail_type' }));
    expect(buildComparativeBS).not.toHaveBeenCalled();
    expect(buildBalanceSheet).toHaveBeenCalledWith(
      TENANT, '2026-03-31', 'accrual', COMPANY, null, 'detail_type',
    );
  });

  it('renders the comparative balance sheet when compare is on', async () => {
    await REPORT_PACK_RENDERERS['balance-sheet']!(TENANT, COMPANY, PARAMS, opts({ compare: true }));
    expect(buildBalanceSheet).not.toHaveBeenCalled();
    expect(buildComparativeBS).toHaveBeenCalledWith(
      TENANT, '2026-03-31', 'accrual', 'previous_period', COMPANY, null,
    );
  });
});
