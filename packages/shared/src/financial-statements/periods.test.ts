// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  buildDefaultLayout, computeFsReport, FS_DEFAULT_STYLE, fsPlanColumns, fsRangeComposition, fsResolvePeriod, fsReportSettingsSchema,
  normalizeFsSettings, fsNextPeriod, fsAddDays, fsFiscalYearStart,
  type FsColumnMode, type FsRenderedStatement, type FsReportSettings, type FsSourceData, type FsSourcePeriod,
} from './index.js';

const base = (over: Partial<FsReportSettings> = {}): FsReportSettings => ({
  periodEnd: '2026-09-30', framework: 'gaap', bookBasis: 'accrual',
  columns: { mode: 'single', pctOfRevenue: false, varianceAmt: false, variancePct: false },
  ...over,
});

describe('period resolution', () => {
  it('fiscal quarters follow the fiscal year start', () => {
    expect(fsResolvePeriod('quarter', '2026-09-15', 7)).toEqual({ type: 'quarter', start: '2026-07-01', end: '2026-09-30' });
    expect(fsResolvePeriod('quarter', '2026-03-10', 7)).toEqual({ type: 'quarter', start: '2026-01-01', end: '2026-03-31' });
    expect(fsResolvePeriod('annual', '2026-03-10', 7)).toEqual({ type: 'annual', start: '2025-07-01', end: '2026-06-30' });
    expect(fsResolvePeriod('month', '2024-02-10', 1)).toEqual({ type: 'month', start: '2024-02-01', end: '2024-02-29' });
    expect(fsResolvePeriod('ytd', '2026-09-30', 1)).toEqual({ type: 'ytd', start: '2026-01-01', end: '2026-09-30' });
  });

  it('rolls forward by one period', () => {
    expect(fsNextPeriod('quarter', '2026-07-01', '2026-09-30')).toEqual({ start: '2026-10-01', end: '2026-12-31' });
    expect(fsNextPeriod('month', '2026-01-01', '2026-01-31')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(fsNextPeriod('annual', '2025-01-01', '2025-12-31')).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });

  it('normalizes legacy settings', () => {
    expect(normalizeFsSettings(base({ periodEnd: '2025-12-31' }), 1).period).toEqual({ type: 'annual', start: '2025-01-01' });
    expect(normalizeFsSettings(base(), 1).period).toEqual({ type: 'ytd', start: '2026-01-01' });
    const m = normalizeFsSettings(base({ columns: { mode: 'month_ytd', pctOfRevenue: false, varianceAmt: false, variancePct: false } }), 1);
    expect(m.columns.mode).toBe('period_ytd');
    expect(m.period).toEqual({ type: 'month', start: '2026-09-01' });
  });

  it('validates tax basis and side-by-side bounds', () => {
    expect(fsReportSettingsSchema.safeParse(base({ framework: 'tax', period: { type: 'quarter', start: '2026-07-01' } })).success).toBe(false);
    expect(fsReportSettingsSchema.safeParse(base({ framework: 'tax', periodEnd: '2025-12-31', period: { type: 'annual', start: '2025-01-01' } })).success).toBe(true);
    const sbs = (start: string, sideBy: 'month' | 'quarter') => fsReportSettingsSchema.safeParse(base({ period: { type: 'custom', start }, columns: { mode: 'side_by_side', sideBy, pctOfRevenue: false, varianceAmt: false, variancePct: false } })).success;
    expect(sbs('2026-01-01', 'month')).toBe(true);
    expect(sbs('2025-01-01', 'month')).toBe(false); // 21 months
    expect(sbs('2025-01-01', 'quarter')).toBe(true);
    expect(sbs('2026-09-01', 'month')).toBe(false); // 1 month
  });
});

describe('range composition', () => {
  it('uses fiscal-YTD snapshots', () => {
    expect(fsRangeComposition('2026-01-01', '2026-09-30', 1)).toEqual([{ date: '2026-09-30', sign: 1 }]);
    expect(fsRangeComposition('2026-07-01', '2026-09-30', 1)).toEqual([{ date: '2026-09-30', sign: 1 }, { date: '2026-06-30', sign: -1 }]);
    expect(fsRangeComposition('2025-07-01', '2026-06-30', 1)).toEqual([
      { date: '2025-12-31', sign: 1 }, { date: '2025-06-30', sign: -1 }, { date: '2026-06-30', sign: 1 },
    ]);
    expect(fsRangeComposition('2024-03-01', '2026-02-28', 1).map((c) => c.date)).toEqual(['2024-12-31', '2024-02-29', '2025-12-31', '2026-02-28']);
  });
});

describe('column plans + date lines', () => {
  const plan = (mode: FsColumnMode, period: FsReportSettings['period'], extra: Partial<FsReportSettings['columns']> = {}) =>
    fsPlanColumns(base({ period, columns: { mode, pctOfRevenue: false, varianceAmt: false, variancePct: false, ...extra } }), 1);

  it('quarter + YTD vs prior year', () => {
    const p = plan('period_ytd_py', { type: 'quarter', start: '2026-07-01' });
    expect(p.isRanges.map((r) => [r.start, r.end, r.label, r.sublabel])).toEqual([
      ['2026-07-01', '2026-09-30', 'Three Months', '2026'],
      ['2025-07-01', '2025-09-30', 'Three Months', '2025'],
      ['2026-01-01', '2026-09-30', 'Nine Months', '2026'],
      ['2025-01-01', '2025-09-30', 'Nine Months', '2025'],
    ]);
    expect(p.bsPoints.map((x) => x.date)).toEqual(['2026-09-30', '2025-12-31']);
    const same = plan('period_ytd_py', { type: 'quarter', start: '2026-07-01' }, { bsCompare: 'same_date' });
    expect(same.bsPoints.map((x) => x.date)).toEqual(['2026-09-30', '2025-09-30']);
  });

  it('side-by-side months + total', () => {
    const p = plan('side_by_side', { type: 'custom', start: '2026-01-01' }, { sideBy: 'month' });
    expect(p.isRanges.map((r) => r.label)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Total']);
    expect(p.cfRanges.map((r) => [r.start, r.end])).toEqual([['2026-01-01', '2026-09-30']]);
    const q = plan('side_by_side', { type: 'ytd', start: '2026-01-01' }, { sideBy: 'quarter' });
    expect(q.isRanges.map((r) => r.label)).toEqual(['Q1', 'Q2', 'Q3', 'Total']);
  });
});

// ── Engine over a generated monthly ledger ─────────────────────────

const ACCOUNTS = [
  ['cash', '1000', 'Checking', 'asset', 'bank'], ['ar', '1100', 'Accounts Receivable', 'asset', 'accounts_receivable'],
  ['equip', '1500', 'Equipment', 'asset', 'fixed_asset'], ['accdep', '1510', 'Accumulated Depreciation', 'asset', 'accumulated_depreciation'],
  ['ap', '2000', 'Accounts Payable', 'liability', 'accounts_payable'], ['loan', '2500', 'Bank Loan', 'liability', 'note_payable'],
  ['cs', '3000', 'Common Stock', 'equity', 'capital_stock'], ['re', '3100', 'Retained Earnings', 'equity', 'retained_earnings'],
  ['dist', '3200', 'Distributions', 'equity', 'distributions'], ['sales', '4000', 'Sales', 'revenue', null],
  ['cogs', '5000', 'Cost of Goods Sold', 'cogs', null], ['rent', '6000', 'Rent', 'expense', null], ['office', '6200', 'Office', 'expense', null],
  ['int', '7000', 'Interest Income', 'other_revenue', null],
] as const;
const G = [
  ['gA', 'A', ['cash']], ['gB', 'B', ['ar']], ['gD', 'D', ['equip', 'accdep']], ['gF', 'F', ['ap']], ['gH', 'H', ['loan']],
  ['gJ', 'J', ['cs', 're', 'dist']], ['gK', 'K', ['sales']], ['gL', 'L', ['cogs']], ['gM', 'M', ['rent', 'office']], ['gN', 'N', ['int']],
  ['gC', 'C', []], ['gE', 'E', []], ['gG', 'G', []], ['gI', 'I', []], ['gO', 'O', []],
] as const;
const PL = new Set(['sales', 'cogs', 'rent', 'office', 'int']);

// monthly[YYYY-MM] = balanced activity (cents) per account.
function genLedger(seed: number) {
  let x = seed;
  const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const months: Record<string, Record<string, number>> = {};
  for (let y = 2024; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      const act: Record<string, number> = {};
      for (const [id] of ACCOUNTS) if (id !== 'cash' && id !== 're') act[id] = Math.round((rnd() * 2 - 1) * 400000);
      act['sales'] = -Math.round(rnd() * 3_000_000);
      let s = 0;
      for (const v of Object.values(act)) s += v;
      act['cash'] = -s;
      months[`${y}-${String(m).padStart(2, '0')}`] = act;
    }
  }
  return months;
}

function workpaper(months: Record<string, Record<string, number>>, date: string, fyStartMonth: number): FsSourcePeriod {
  const fyS = fsFiscalYearStart(date, fyStartMonth);
  const bal: Record<string, number> = {};
  const key = date.slice(0, 7);
  for (const [mk, act] of Object.entries(months)) {
    if (mk > key) continue;
    const inFy = `${mk}-01` >= fyS;
    for (const [id, c] of Object.entries(act)) {
      if (PL.has(id)) {
        const tgt = inFy ? id : 're'; // prior fiscal years fold into RE
        bal[tgt] = (bal[tgt] ?? 0) + c;
      } else bal[id] = (bal[id] ?? 0) + c;
    }
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(bal)) out[k] = v / 100;
  return { date, fyStart: fyS, balances: out, hasData: true };
}

function sourceFor(settings: FsReportSettings, months: Record<string, Record<string, number>>, fyStartMonth = 1): FsSourceData {
  const plan = fsPlanColumns(settings, fyStartMonth);
  const workpapers: Record<string, FsSourcePeriod> = {};
  for (const d of plan.workpaperDates) {
    if (d < '2024-01-31') continue; // before the books start: no data
    workpapers[d] = workpaper(months, d, fyStartMonth);
  }
  return {
    companyName: 'Gen Co', entityKind: 'corporation', framework: 'gaap', basis: 'accrual', glVersionStamp: 1,
    periodEnd: settings.periodEnd, fyStart: fsFiscalYearStart(settings.periodEnd, fyStartMonth), fyStartMonth,
    accounts: ACCOUNTS.map(([id, number, name, accountType, detailType]) => ({ id, number, name, accountType, detailType, systemTag: id === 're' ? 'retained_earnings' : null, isVirtual: false })),
    groupings: G.map(([id, code, ids], i) => ({ id, code, name: code, sortOrder: i, accountIds: [...ids] })),
    workpapers, reAccountId: 're', equityRoles: { cs: 'contributions', re: 'retained', dist: 'distributions' }, cashFlowOverrides: [],
  };
}

function assertFoots(st: FsRenderedStatement) {
  st.columns.forEach((c, ci) => {
    if (c.kind !== 'amount') return;
    for (const r of st.rows) {
      if (!r.formula || r.values[ci] === null) continue;
      const terms = r.formula.kind === 'sum' ? r.formula.rows.map((row) => ({ row, sign: 1 })) : r.formula.terms;
      const s = terms.reduce((acc, t) => acc + t.sign * (st.rows[t.row]!.values[ci] ?? 0), 0);
      expect(Math.round(s * 100) / 100, `${st.kind} "${r.caption}" col ${c.key}`).toBe(r.values[ci]);
    }
  });
}

const row = (st: FsRenderedStatement, caption: string) => {
  const r = st.rows.find((x) => x.caption === caption);
  if (!r) throw new Error(`no row ${caption} in ${st.kind}: ${st.rows.map((x) => x.caption).join('|')}`);
  return r;
};

// Exact P&L activity for a range straight from the monthly ledger.
function directNi(months: Record<string, Record<string, number>>, start: string, end: string): number {
  let s = 0;
  for (const [mk, act] of Object.entries(months)) {
    if (`${mk}-01` < start.slice(0, 7) + '-01' || mk > end.slice(0, 7)) continue;
    for (const id of PL) s -= act[id] ?? 0;
  }
  return s / 100;
}

describe('engine across reporting periods (generated ledger)', () => {
  const cases: Array<{ name: string; settings: FsReportSettings; fy?: number }> = [
    { name: 'quarter + YTD vs PY', settings: base({ period: { type: 'quarter', start: '2026-07-01' }, columns: { mode: 'period_ytd_py', pctOfRevenue: true, varianceAmt: false, variancePct: false } }) },
    { name: 'quarter vs PY (same-date BS)', settings: base({ period: { type: 'quarter', start: '2026-07-01' }, columns: { mode: 'cy_py', bsCompare: 'same_date', pctOfRevenue: false, varianceAmt: true, variancePct: true } }) },
    { name: 'month + YTD', settings: base({ period: { type: 'month', start: '2026-09-01' }, columns: { mode: 'period_ytd', pctOfRevenue: false, varianceAmt: false, variancePct: false } }) },
    { name: 'side-by-side months', settings: base({ period: { type: 'ytd', start: '2026-01-01' }, columns: { mode: 'side_by_side', sideBy: 'month', pctOfRevenue: false, varianceAmt: false, variancePct: false } }) },
    { name: 'custom range across FY-end', settings: base({ periodEnd: '2026-06-30', period: { type: 'custom', start: '2025-07-01' } }) },
    { name: 'custom range across FY-end vs PY', settings: base({ periodEnd: '2026-06-30', period: { type: 'custom', start: '2025-07-01' }, columns: { mode: 'cy_py', pctOfRevenue: false, varianceAmt: false, variancePct: false } }) },
    { name: 'July fiscal year, Q1 + YTD', fy: 7, settings: base({ period: { type: 'quarter', start: '2026-07-01' }, columns: { mode: 'period_ytd', pctOfRevenue: false, varianceAmt: false, variancePct: false } }) },
  ];

  for (const c of cases) {
    for (const seed of [11, 29, 47, 83]) {
      it(`${c.name} (seed ${seed})`, () => {
        const months = genLedger(seed);
        const fy = c.fy ?? 1;
        const settings = fsReportSettingsSchema.parse(c.settings);
        const src = sourceFor(settings, months, fy);
        const rep = computeFsReport(settings, buildDefaultLayout('corporation'), FS_DEFAULT_STYLE, src);
        expect(rep.checks.filter((k) => k.severity === 'error'), JSON.stringify(rep.checks)).toEqual([]);
        for (const st of [...rep.statements, ...rep.schedules]) assertFoots(st);
        const bs = rep.statements.find((s) => s.kind === 'balance_sheet')!;
        const is = rep.statements.find((s) => s.kind === 'income_statement')!;
        const eq = rep.statements.find((s) => s.kind === 'equity')!;
        const cf = rep.statements.find((s) => s.kind === 'cash_flows')!;
        const plan = fsPlanColumns(settings, fy);

        // Balance sheet balances in every column.
        expect(row(bs, 'TOTAL ASSETS').values.slice(0, plan.bsPoints.length)).toEqual(row(bs, "TOTAL LIABILITIES AND STOCKHOLDERS' EQUITY").values.slice(0, plan.bsPoints.length));

        // Income statement net income ≈ ledger net income for each range.
        const niRow = row(is, 'NET INCOME');
        const amountIdx = is.columns.map((col, i) => (col.kind === 'amount' ? i : -1)).filter((i) => i >= 0);
        plan.isRanges.forEach((r, k) => {
          const v = niRow.values[amountIdx[k]!] as number;
          expect(Math.abs(v - directNi(months, r.start, r.end))).toBeLessThanOrEqual(3);
        });

        // Side-by-side slices sum to the total.
        if (plan.mode === 'side_by_side') {
          for (const r of is.rows) {
            const vals = amountIdx.map((i) => r.values[i]);
            if (vals.some((v) => v === null)) continue;
            const slices = vals.slice(0, -1).reduce((a, b) => (a as number) + (b as number), 0) as number;
            expect(Math.abs(slices - (vals[vals.length - 1] as number))).toBeLessThanOrEqual(plan.isRanges.length);
          }
        }

        // Cash flows: one column per range, ending cash ties to the balance
        // sheet whenever the range ends on a balance-sheet date.
        const endCash = row(cf, cf.rows[cf.rows.length - 1]!.caption);
        plan.cfRanges.forEach((r, k) => {
          const bsIdx = plan.bsPoints.findIndex((p) => p.date === r.end);
          if (bsIdx >= 0) expect(endCash.values[k]).toBe(row(bs, 'Cash').values[bsIdx]);
          // CF net income = income statement net income for the same range.
          const isIdx = plan.isRanges.findIndex((x) => x.start === r.start && x.end === r.end);
          if (isIdx >= 0) expect(row(cf, 'Net income').values[k]).toBe(niRow.values[amountIdx[isIdx]!]);
        });

        // Equity: the last block ends on the balance sheet's equity.
        const lastEq = eq.rows[eq.rows.length - 1]!;
        const lastBlock = plan.equityBlocks[plan.equityBlocks.length - 1]!;
        const bsIdx = plan.bsPoints.findIndex((p) => p.date === lastBlock.end);
        if (bsIdx >= 0) expect(lastEq.values[lastEq.values.length - 1]).toBe(row(bs, "Total stockholders' equity").values[bsIdx]);
        void fsAddDays;
      });
    }
  }

  it('titles and date lines for interim layouts', () => {
    const months = genLedger(5);
    const settings = fsReportSettingsSchema.parse(base({ period: { type: 'quarter', start: '2026-07-01' }, columns: { mode: 'period_ytd_py', pctOfRevenue: false, varianceAmt: false, variancePct: false } }));
    const rep = computeFsReport(settings, buildDefaultLayout('corporation'), FS_DEFAULT_STYLE, sourceFor(settings, months));
    const is = rep.statements.find((s) => s.kind === 'income_statement')!;
    const bs = rep.statements.find((s) => s.kind === 'balance_sheet')!;
    expect(is.dateLine).toBe('For the Three and Nine Months Ended September 30, 2026 and 2025');
    expect(bs.dateLine).toBe('September 30, 2026 and December 31, 2025');
    expect(bs.title).toBe('Balance Sheets');
    expect(is.columns.filter((c) => c.kind === 'amount').map((c) => `${c.label}/${c.sublabel}`)).toEqual(['Three Months/2026', 'Three Months/2025', 'Nine Months/2026', 'Nine Months/2025']);

    const custom = fsReportSettingsSchema.parse(base({ periodEnd: '2026-06-15', period: { type: 'custom', start: '2026-02-10' } }));
    const rep2 = computeFsReport(custom, buildDefaultLayout('corporation'), FS_DEFAULT_STYLE, sourceFor(custom, months));
    expect(rep2.statements.find((s) => s.kind === 'income_statement')!.dateLine).toBe('For the Period from February 10, 2026 to June 15, 2026');

    const sbs = fsReportSettingsSchema.parse(base({ period: { type: 'ytd', start: '2026-01-01' }, columns: { mode: 'side_by_side', sideBy: 'month', pctOfRevenue: false, varianceAmt: false, variancePct: false } }));
    const rep3 = computeFsReport(sbs, buildDefaultLayout('corporation'), FS_DEFAULT_STYLE, sourceFor(sbs, months));
    const is3 = rep3.statements.find((s) => s.kind === 'income_statement')!;
    expect(is3.dateLine).toBe('For the Nine Months Ended September 30, 2026');
    expect(is3.pageSetup.orientation).toBe('landscape');
    expect(rep3.statements.find((s) => s.kind === 'balance_sheet')!.pageSetup.orientation).toBe('portrait');
  });
});

describe('letterhead layouts', async () => {
  const { fsBuildSections } = await import('./render/html.js');
  const settings = fsReportSettingsSchema.parse(base({ periodEnd: '2025-12-31', period: { type: 'annual', start: '2025-01-01' } }));
  const report = computeFsReport(settings, buildDefaultLayout('corporation'), FS_DEFAULT_STYLE, sourceFor(settings, genLedger(3)));
  const lhBase = { displayName: 'Smith & Co., CPAs', addressLine1: '1 Main St', logoDataUri: 'data:image/png;base64,AAAA', logoAspect: 0.2 };
  const letterSection = (lh: Record<string, unknown>) => fsBuildSections({
    report, style: FS_DEFAULT_STYLE, fonts: { mode: 'none' },
    frontMatter: { cover: { enabled: false }, toc: { enabled: false }, letter: { enabled: true, letterId: null } },
    letterhead: { ...lhBase, ...lh } as never, letter: { title: 'Report', bodyHtml: '<p>x</p>' },
  }).find((x) => x.kind === 'letter')!;

  it('edge to edge reserves space and hands the logo to the PDF step', () => {
    const s = letterSection({ logoSize: 'full_bleed', letterheadContent: 'logo' });
    expect(s.bleedLogo?.heightIn).toBeCloseTo(8.5 * 0.2);
    expect(s.extraCss).toContain('@page :first{margin-top:0}');
    expect(s.bodyHtml).not.toContain('Smith &amp; Co.');
  });
  it('text only omits the logo; logo only omits the text', () => {
    expect(letterSection({ letterheadContent: 'text' }).bodyHtml).not.toContain('<img');
    expect(letterSection({ letterheadContent: 'text' }).bodyHtml).toContain('Smith &amp; Co.');
    const logoOnly = letterSection({ letterheadContent: 'logo', logoSize: 'content_width' });
    expect(logoOnly.bodyHtml).toContain('width:100%');
    expect(logoOnly.bleedLogo).toBeNull();
  });
});
