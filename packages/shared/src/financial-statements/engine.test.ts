// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  buildDefaultLayout, computeFsReport, FS_DEFAULT_STYLE, fsClientLayoutSchema, fsTemplateLayoutSchema,
  bindLayout, toPortableLayout, fsStatementTitle, fsFlowDateLine, fsIncludedTitlesPhrase,
  type FsLayout, type FsReportSettings, type FsRenderedStatement, type FsSourceData, type FsStyle,
} from '../index.js';

// ── Fixture: a small corporation, FY = calendar 2025 ──
const A = (id: string, number: string, name: string, accountType: string, detailType: string | null = null, systemTag: string | null = null) =>
  ({ id, number, name, accountType, detailType, systemTag, isVirtual: false });

const ACCOUNTS = [
  A('cash', '1000', 'Checking', 'asset', 'bank'),
  A('ar', '1100', 'Accounts Receivable', 'asset', 'accounts_receivable'),
  A('equip', '1500', 'Equipment', 'asset', 'fixed_asset'),
  A('accdep', '1510', 'Accumulated Depreciation', 'asset', 'accumulated_depreciation'),
  A('ap', '2000', 'Accounts Payable', 'liability', 'accounts_payable'),
  A('loan', '2500', 'Bank Loan', 'liability', 'note_payable'),
  A('cs', '3000', 'Common Stock', 'equity', 'capital_stock'),
  A('re', '3100', 'Retained Earnings', 'equity', 'retained_earnings', 'retained_earnings'),
  A('dist', '3200', 'Distributions', 'equity', 'distributions'),
  A('sales', '4000', 'Sales', 'revenue'),
  A('cogs', '5000', 'Cost of Goods Sold', 'cogs'),
  A('rent', '6000', 'Rent', 'expense'),
  A('depr', '6100', 'Depreciation Expense', 'expense'),
  A('office', '6200', 'Office Supplies', 'expense'),
  A('int', '7000', 'Interest Income', 'other_revenue'),
];

const G = (id: string, code: string, name: string, accountIds: string[], sortOrder: number) => ({ id, code, name, sortOrder, accountIds });
const GROUPINGS = [
  G('gA', 'A', 'Cash', ['cash'], 0), G('gB', 'B', 'Accounts Receivable', ['ar'], 10), G('gC', 'C', 'Inventory', [], 20),
  G('gD', 'D', 'Fixed Assets', ['equip', 'accdep'], 30), G('gE', 'E', 'Other Assets', [], 40),
  G('gF', 'F', 'Accounts Payable', ['ap'], 50), G('gG', 'G', 'Accrued Liabilities', [], 60), G('gH', 'H', 'Debt', ['loan'], 70),
  G('gI', 'I', 'Other Liabilities', [], 80), G('gJ', 'J', 'Equity', ['cs', 're', 'dist'], 90),
  G('gK', 'K', 'Revenue', ['sales'], 100), G('gL', 'L', 'Cost of Goods Sold', ['cogs'], 110),
  G('gM', 'M', 'Operating Expenses', ['rent', 'depr', 'office'], 120), G('gN', 'N', 'Other Income', ['int'], 130), G('gO', 'O', 'Other Expenses', [], 140),
];

const OPEN_2024 = { cash: 10000.40, ar: 5000.30, equip: 20000, accdep: -4000, ap: -3000.25, loan: -10000, cs: -1000, re: -9000, sales: -30000.45, cogs: 10000, rent: 12000 };
const CY_2025 = {
  cash: 13100.81, ar: 6200.10, equip: 25000, accdep: -6000, ap: -2500.33, loan: -8000, cs: -1000, re: -17000.45, dist: 3000,
  sales: -50000.49, cogs: 20000.11, rent: 12000, depr: 2000, office: 3300.25, int: -100,
};

function source(over: Partial<FsSourceData> = {}): FsSourceData {
  return {
    companyName: 'Acme Widgets, Inc.', entityKind: 'corporation', framework: 'gaap', basis: 'accrual', glVersionStamp: 7,
    periodEnd: '2025-12-31', fyStart: '2025-01-01',
    accounts: ACCOUNTS, groupings: GROUPINGS.map((g) => ({ ...g, accountIds: [...g.accountIds] })),
    periods: {
      cy: { date: '2025-12-31', fyStart: '2025-01-01', balances: CY_2025, hasData: true },
      cyOpen: { date: '2024-12-31', fyStart: '2024-01-01', balances: OPEN_2024, hasData: true },
    },
    reAccountId: 're',
    equityRoles: { cs: 'contributions', re: 'retained', dist: 'distributions' },
    cashFlowOverrides: [],
    ...over,
  };
}

const SETTINGS: FsReportSettings = {
  periodEnd: '2025-12-31', framework: 'gaap', bookBasis: 'accrual',
  columns: { mode: 'single', pctOfRevenue: false, varianceAmt: false, variancePct: false },
};

const run = (o: { settings?: Partial<FsReportSettings>; layout?: FsLayout; style?: FsStyle; source?: FsSourceData } = {}) =>
  computeFsReport({ ...SETTINGS, ...o.settings }, o.layout ?? buildDefaultLayout('corporation'), o.style ?? FS_DEFAULT_STYLE, o.source ?? source());

const rowBy = (st: FsRenderedStatement, caption: string) => {
  const r = st.rows.find((x) => x.caption === caption);
  if (!r) throw new Error(`row "${caption}" not found in ${st.kind}: ${st.rows.map((x) => x.caption).join(' | ')}`);
  return r;
};
const stmt = (rep: ReturnType<typeof run>, kind: string) => rep.statements.find((s) => s.kind === kind)!;

// Every row carrying a formula must equal its formula evaluated on the
// displayed (rounded, plugged) values — i.e. the statements foot.
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

describe('computeFsReport — default corporate layout', () => {
  const rep = run();
  const bs = stmt(rep, 'balance_sheet');
  const is = stmt(rep, 'income_statement');
  const eq = stmt(rep, 'equity');
  const cf = stmt(rep, 'cash_flows');

  it('has no blocking errors', () => {
    expect(rep.checks.filter((c) => c.severity === 'error')).toEqual([]);
  });

  it('balances and rounds to whole dollars', () => {
    expect(rowBy(bs, 'TOTAL ASSETS').values[0]).toBe(38301);
    expect(rowBy(bs, "TOTAL LIABILITIES AND STOCKHOLDERS' EQUITY").values[0]).toBe(38301);
    expect(rowBy(bs, 'Cash').values[0]).toBe(13101);
    // RE on the balance sheet is closed: prior RE + current income.
    expect(rowBy(bs, 'Retained Earnings').values[0]).toBe(29801);
    bs.rows.forEach((r) => r.values.forEach((v) => v !== null && expect(Number.isInteger(v)).toBe(true)));
  });

  it('income statement ties to the ledger and schedules operating expenses', () => {
    expect(rowBy(is, 'NET INCOME').values[0]).toBe(12801);
    // The $0.58 lost rounding beginning RE and income lands on the largest IS line.
    expect(rowBy(is, 'Revenue').values[0]).toBe(50001);
    const opex = rowBy(is, 'Operating expenses');
    expect(opex.scheduleRef).toBe('Schedule 1');
    expect(rep.schedules).toHaveLength(1);
    const sched = rep.schedules[0]!;
    expect(sched.title).toBe('Schedule of Operating Expenses');
    expect(rowBy(sched, 'Total operating expenses').values[0]).toBe(opex.values[0]);
    expect(sched.rows.map((r) => r.caption)).toEqual(['Rent', 'Depreciation Expense', 'Office Supplies', 'Total operating expenses']);
  });

  it('every statement and schedule foots', () => {
    for (const s of [...rep.statements, ...rep.schedules]) assertFoots(s);
  });

  it('equity statement rolls forward by account and ties to the balance sheet', () => {
    expect(eq.title).toBe("Statement of Changes in Stockholders' Equity");
    expect(eq.columns.map((c) => c.label)).toEqual(['Common Stock', 'Retained Earnings', 'Total']);
    expect(rowBy(eq, 'Balance, December 31, 2024').values).toEqual([1000, 17000, 18000]);
    expect(rowBy(eq, 'Net income').values).toEqual([0, 12801, 12801]);
    expect(rowBy(eq, 'Distributions to shareholders').values).toEqual([0, -3000, -3000]);
    const end = rowBy(eq, 'Balance, December 31, 2025');
    expect(end.values[2]).toBe(rowBy(bs, "Total stockholders' equity").values[0]);
  });

  it('cash flows reconcile to the balance sheet cash (indirect method)', () => {
    expect(rowBy(cf, 'Net income').values[0]).toBe(12801);
    expect(rowBy(cf, 'Depreciation and amortization').values[0]).toBe(2000);
    expect(rowBy(cf, '(Increase) decrease in accounts receivable').values[0]).toBe(-1200);
    expect(rowBy(cf, 'Purchase of fixed assets').values[0]).toBe(-5000);
    expect(rowBy(cf, 'Repayment of debt').values[0]).toBe(-2000);
    expect(rowBy(cf, 'Distributions paid').values[0]).toBe(-3000);
    expect(rowBy(cf, 'CASH, END OF YEAR').values[0]).toBe(rowBy(bs, 'Cash').values[0]);
    expect(rowBy(cf, 'Cash, beginning of year').values[0]).toBe(10000);
    expect(rep.checks.find((c) => c.code === 'TB_FS_CF_UNRECONCILED')).toBeUndefined();
  });

  it('puts dollar signs on the first line and double-ruled totals', () => {
    const first = bs.rows.find((r) => r.values.some((v) => v !== null))!;
    expect(first.dollarSign).toBe(true);
    expect(rowBy(bs, 'TOTAL ASSETS').dollarSign).toBe(true);
    expect(rowBy(bs, 'Accounts receivable').dollarSign).toBe(false);
  });

  it('hides zero lines (inventory, accrued, other income section keeps interest)', () => {
    expect(bs.rows.find((r) => r.caption === 'Inventory')).toBeUndefined();
    expect(bs.rows.find((r) => r.caption === 'Accrued liabilities')).toBeUndefined();
    expect(rowBy(is, 'Other income').values[0]).toBe(100);
  });
});

describe('checks', () => {
  it('flags accounts with balances that are not on any leadsheet', () => {
    const s = source({
      accounts: [...ACCOUNTS, A('stray', '1900', 'Suspense', 'asset')],
      periods: {
        cy: { date: '2025-12-31', fyStart: '2025-01-01', balances: { ...CY_2025, stray: 5, cash: CY_2025.cash - 5 }, hasData: true },
        cyOpen: { date: '2024-12-31', fyStart: '2024-01-01', balances: OPEN_2024, hasData: true },
      },
    });
    const rep = run({ source: s });
    const c = rep.checks.find((x) => x.code === 'TB_FS_UNASSIGNED');
    expect(c?.accountIds).toEqual(['stray']);
    expect(c?.message).toContain('1900 Suspense');
    expect(rep.checks.find((x) => x.code === 'TB_FS_BS_UNBALANCED')).toBeDefined();
  });

  it('flags a leadsheet the client does not have', () => {
    const layout = buildDefaultLayout('corporation');
    const is = layout.statements.find((s) => s.kind === 'income_statement')!;
    is.body.push({ type: 'leadsheet', id: 'x', ref: { leadsheetCode: 'ZZ' }, caption: 'Mystery', display: 'single_line' });
    const rep = run({ layout });
    expect(rep.checks.find((c) => c.code === 'TB_FS_UNBOUND_LEADSHEET')?.nodeId).toBe('x');
  });

  it('pulling an account out removes it from its leadsheet line', () => {
    const layout = buildDefaultLayout('corporation');
    const is = layout.statements.find((s) => s.kind === 'income_statement')!;
    is.body.splice(5, 0, { type: 'account', id: 'rent_line', refs: [{ accountId: 'rent' }], caption: 'Rent expense', polarity: 'debit' });
    // net income total must include the new line
    const ni = is.body.find((n) => n.id === 'is_operating_income');
    if (ni && ni.type === 'total') ni.terms.push({ nodeId: 'rent_line', sign: -1 });
    const rep = run({ layout });
    const st = stmt(rep, 'income_statement');
    expect(rowBy(st, 'Rent expense').values[0]).toBe(12000);
    expect(rep.schedules[0]!.rows.map((r) => r.caption)).not.toContain('Rent');
    expect(rowBy(st, 'NET INCOME').values[0]).toBe(12801);
    expect(rep.checks.filter((c) => c.severity === 'error')).toEqual([]);
  });

  it('combines accounts into one schedule line with a caption', () => {
    const layout = buildDefaultLayout('corporation');
    const is = layout.statements.find((s) => s.kind === 'income_statement')!;
    const opex = is.body.find((n) => n.id === 'is_opex');
    if (opex?.type === 'leadsheet') opex.scheduleLines = [{ id: 'occ', caption: 'Occupancy and office', accountRefs: [{ accountId: 'office' }, { accountId: 'rent' }] }];
    const rep = run({ layout });
    expect(rep.schedules[0]!.rows.map((r) => r.caption)).toEqual(['Occupancy and office', 'Depreciation Expense', 'Total operating expenses']);
    expect(rowBy(rep.schedules[0]!, 'Occupancy and office').values[0]).toBe(15300);
  });
});

describe('columns', () => {
  it('month + YTD derives the month from the prior month-end', () => {
    const nov = { ...CY_2025, sales: -45000, cogs: 18000, rent: 11000, depr: 2000, office: 3000, int: -100 };
    const s = source({
      periods: {
        ...source().periods,
        cyPriorMonth: { date: '2025-11-30', fyStart: '2025-01-01', balances: nov, hasData: true },
      },
    });
    const rep = run({ source: s, settings: { columns: { mode: 'month_ytd', pctOfRevenue: true, varianceAmt: false, variancePct: false } } });
    const is = stmt(rep, 'income_statement');
    expect(is.columns.map((c) => c.kind)).toEqual(['amount', 'pct', 'amount', 'pct']);
    expect(rowBy(is, 'Revenue').values).toEqual([5000, 100, 50001, 100]);
    expect(is.dateLine).toBe('For the One Month and Twelve Months Ended December 31, 2025'.replace('Twelve Months', 'Year'));
    assertFoots(is);
  });

  it('prior-year column is blank with an info check when the ledger has no PY', () => {
    const rep = run({ settings: { columns: { mode: 'cy_py', pctOfRevenue: false, varianceAmt: true, variancePct: true } } });
    const bs = stmt(rep, 'balance_sheet');
    expect(bs.title).toBe('Balance Sheets');
    expect(rowBy(bs, 'TOTAL ASSETS').values).toEqual([38301, null, null, null]);
    expect(rep.checks.find((c) => c.code === 'TB_FS_PY_NO_DATA')).toBeDefined();
  });

  it('a tag filter keeps the income statement only and warns', () => {
    const rep = run({ settings: { tagId: '00000000-0000-0000-0000-0000000000aa' }, source: source({ tagged: { cy: { date: '2025-12-31', fyStart: '2025-01-01', balances: { sales: -100, rent: 40 }, hasData: true } }, tagName: 'Farm' }) });
    expect(rep.statements.map((s) => s.kind)).toEqual(['balance_sheet', 'income_statement']);
    expect(rowBy(stmt(rep, 'income_statement'), 'NET INCOME').values[0]).toBe(60);
    expect(rep.checks.filter((c) => c.code === 'TB_FS_TAG_PARTIAL').length).toBeGreaterThan(0);
  });
});

describe('rounding property: random balanced trial balances always foot', () => {
  // Deterministic LCG so failures reproduce.
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const cents = (max: number) => Math.round((rnd() * 2 - 1) * max * 100) / 100;

  for (let t = 0; t < 40; t++) {
    it(`case ${t}`, () => {
      const mk = () => {
        const b: Record<string, number> = {};
        for (const a of ACCOUNTS) if (a.id !== 'cash') b[a.id] = cents(50000);
        let s = 0;
        for (const v of Object.values(b)) s += Math.round(v * 100);
        b['cash'] = -s / 100;
        return b;
      };
      const s = source({
        periods: {
          cy: { date: '2025-12-31', fyStart: '2025-01-01', balances: mk(), hasData: true },
          cyOpen: { date: '2024-12-31', fyStart: '2024-01-01', balances: mk(), hasData: true },
        },
      });
      const rep = run({ source: s });
      expect(rep.checks.filter((c) => c.severity === 'error'), JSON.stringify(rep.checks)).toEqual([]);
      for (const st of [...rep.statements, ...rep.schedules]) assertFoots(st);
      const bs = stmt(rep, 'balance_sheet');
      const is = stmt(rep, 'income_statement');
      const eq = stmt(rep, 'equity');
      const cf = stmt(rep, 'cash_flows');
      expect(rowBy(bs, 'TOTAL ASSETS').values[0]).toBe(rowBy(bs, "TOTAL LIABILITIES AND STOCKHOLDERS' EQUITY").values[0]);
      const ni = rowBy(is, 'NET INCOME').values[0];
      expect(rowBy(eq, 'Net income').values[1]).toBe(ni);
      expect(rowBy(cf, 'Net income').values[0]).toBe(ni);
      expect(rowBy(cf, 'CASH, END OF YEAR').values[0]).toBe(rowBy(bs, 'Cash').values[0]);
      expect(eq.rows[eq.rows.length - 1]!.values[2]).toBe(rowBy(bs, "Total stockholders' equity").values[0]);
    });
  }
});

describe('rounding property: comparative years stay consistent', () => {
  let seed = 777;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const mk = () => {
    const b: Record<string, number> = {};
    for (const a of ACCOUNTS) if (a.id !== 'cash') b[a.id] = Math.round((rnd() * 2 - 1) * 5_000_000) / 100;
    let t = 0;
    for (const v of Object.values(b)) t += Math.round(v * 100);
    b['cash'] = -t / 100;
    return b;
  };
  for (let t = 0; t < 25; t++) {
    it(`case ${t}`, () => {
      const open2023 = mk();
      const end2024 = mk();
      const end2025 = mk();
      const s = source({
        periods: {
          cy: { date: '2025-12-31', fyStart: '2025-01-01', balances: end2025, hasData: true },
          cyOpen: { date: '2024-12-31', fyStart: '2024-01-01', balances: end2024, hasData: true },
          py: { date: '2024-12-31', fyStart: '2024-01-01', balances: end2024, hasData: true },
          pyOpen: { date: '2023-12-31', fyStart: '2023-01-01', balances: open2023, hasData: true },
        },
      });
      const rep = run({ source: s, settings: { columns: { mode: 'cy_py', pctOfRevenue: true, varianceAmt: true, variancePct: true } } });
      expect(rep.checks.filter((c) => c.severity === 'error'), JSON.stringify(rep.checks)).toEqual([]);
      for (const st of [...rep.statements, ...rep.schedules]) assertFoots(st);
      const bs = stmt(rep, 'balance_sheet');
      const is = stmt(rep, 'income_statement');
      const eq = stmt(rep, 'equity');
      const cf = stmt(rep, 'cash_flows');
      const niIdx = [0, 2]; // amount columns of the IS (pct columns interleave)
      const [niCy, niPy] = niIdx.map((i) => rowBy(is, 'NET INCOME').values[i]);
      expect(rowBy(cf, 'Net income').values).toEqual([niCy, niPy]);
      expect(rowBy(cf, 'CASH, END OF YEAR').values).toEqual([rowBy(bs, 'Cash').values[0], rowBy(bs, 'Cash').values[1]]);
      // PY ending cash is CY beginning cash.
      expect(rowBy(cf, 'Cash, beginning of year').values[0]).toBe(rowBy(bs, 'Cash').values[1]);
      expect(rowBy(eq, 'Balance, December 31, 2024').values[2]).toBe(rowBy(bs, "Total stockholders' equity").values[1]);
      expect(rowBy(eq, 'Balance, December 31, 2025').values[2]).toBe(rowBy(bs, "Total stockholders' equity").values[0]);
      const eqNi = eq.rows.filter((r) => r.caption === 'Net income').map((r) => r.values[2]);
      expect(eqNi).toEqual([niPy, niCy]);
    });
  }
});

describe('schemas, titles, binding', () => {
  it('default layout is a valid template and client layout', () => {
    for (const k of ['corporation', 'partnership', 'llc', 'sole_prop'] as const) {
      expect(fsTemplateLayoutSchema.safeParse(buildDefaultLayout(k)).success).toBe(true);
    }
  });

  it('templates may not carry client ids', () => {
    const l = buildDefaultLayout('corporation');
    const bs = l.statements[0]!;
    bs.body.push({ type: 'account', id: 'p', refs: [{ accountId: '11111111-1111-4111-8111-111111111111' }], caption: 'x' });
    expect(fsTemplateLayoutSchema.safeParse(l).success).toBe(false);
    expect(fsClientLayoutSchema.safeParse(l).success).toBe(true);
  });

  it('binds codes to a client and strips back to portable', () => {
    const groupings = GROUPINGS.map((g) => ({ id: `11111111-1111-4111-8111-${String(g.sortOrder).padStart(12, '0')}`, code: g.code, name: g.name }))
      .filter((g) => g.code !== 'N');
    const { layout, unresolved } = bindLayout(buildDefaultLayout('corporation'), groupings);
    expect(unresolved.map((u) => u.leadsheetCode)).toEqual(['N']);
    const bound = JSON.stringify(layout);
    expect(bound).toContain(groupings[0]!.id);
    const dropped = bindLayout(buildDefaultLayout('corporation'), groupings, { is_other_income: null });
    expect(dropped.unresolved).toEqual([]);
    const portable = toPortableLayout(layout, groupings);
    expect(fsTemplateLayoutSchema.safeParse(portable).success).toBe(true);
  });

  it('titles follow framework and entity', () => {
    const o = { framework: 'tax' as const, entityKind: 'partnership' as const, comparative: false };
    expect(fsStatementTitle('balance_sheet', o)).toBe("Statement of Assets, Liabilities and Partners' Capital — Income Tax Basis");
    expect(fsStatementTitle('income_statement', { ...o, comparative: true })).toBe('Statements of Revenues and Expenses — Income Tax Basis');
    expect(fsStatementTitle('equity', { ...o, entityKind: 'corporation', equityColumns: 'single', framework: 'gaap' })).toBe('Statement of Retained Earnings');
    expect(fsFlowDateLine({ fyStart: '2025-01-01', periodEnd: '2025-06-30', mode: 'single' })).toBe('For the Six Months Ended June 30, 2025');
    expect(fsFlowDateLine({ fyStart: '2025-01-01', periodEnd: '2025-12-31', mode: 'cy_py', priorPeriodEnd: '2024-12-31' })).toBe('For the Years Ended December 31, 2025 and 2024');
    expect(fsIncludedTitlesPhrase(['balance_sheet', 'income_statement', 'equity', 'cash_flows'], { framework: 'gaap', entityKind: 'corporation', comparative: false }))
      .toBe("balance sheet, and the related statements of income, changes in stockholders' equity, and cash flows");
  });
});

describe('preview fonts', () => {
  it('requests preview fonts without a .ttf extension (nginx static rule)', async () => {
    const { fsDocumentCss } = await import('./render/html.js');
    const css = fsDocumentCss(FS_DEFAULT_STYLE, { mode: 'url', baseUrl: '/api/v1/fs-fonts' });
    expect(css).toContain("url('/api/v1/fs-fonts/LiberationSerif-Regular')");
    expect(css).not.toMatch(/fs-fonts\/[^')]+\.ttf/);
  });
});
