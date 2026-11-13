// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Report Builder formulas use each section's normal sign (U-218,
// report-builder-formula-sign-v1; ClientLedger A09, Q-A08ai). A section's
// polarity ("Show as positive") signs only the cells of its own rows and a
// group's shown subtotal; formulas, their $ / % change and every percent-of
// node base read the normal sign, so flipping a section changes nothing
// else in the report. Accrual and cash.

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BUILDER_STARTERS, type BuilderDefinition, type RbNode, type RbSectionNode } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts } from '../db/schema/index.js';
import { reportBuilderRouter } from './report-builder.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as ledger from '../services/ledger.service.js';
import * as reportService from '../services/report.service.js';
import { ReportDecimal as Decimal } from '../services/report-exact.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { makeCompany, cleanTenant, suffix, type Co } from '../services/templates/templates.test-helpers.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;
let cogs = '';
let equity = '';
const FY = ['2025-01-01', '2026-01-01'];
const RANGE = { from: '2026-01-01', to: '2026-06-30' };
const PRIOR = { from: '2025-01-01', to: '2025-06-30' };
const AS_OF = '2026-06-30';
const BASES = ['accrual', 'cash'] as const;

function call(body: unknown): Promise<{ status: number; json: ReturnType<typeof JSON.parse> }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/v1/report-builder/run', method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}`, 'X-Company-Id': c.companyId, 'Content-Length': String(data.length) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

type Row = { kind: string; nodeId: string; path: string[]; caption: string; cells: Array<string | null> };
type Col = { key: string; kind: string };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const starter = (key: string): BuilderDefinition => clone(BUILDER_STARTERS.find((s) => s.key === key)!.definition);
const D = (x: string | null | undefined) => new Decimal(x ?? 0).toFixed(4);
const neg = (x: string | null) => (x === null ? null : new Decimal(x).isZero() ? new Decimal(0).toFixed(4) : new Decimal(x).neg().toFixed(4));

async function run(definition: BuilderDefinition, extra: Record<string, unknown>): Promise<{ rows: Row[]; cols: Col[] }> {
  const r = await call({ definition, fiscalYearStarts: FY, expandAll: true, ...extra });
  expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
  return { rows: r.json.rows as Row[], cols: r.json.columns as Col[] };
}

function sectionOf(nodes: RbNode[], id: string): RbSectionNode {
  for (const n of nodes) {
    if (n.type === 'section' && n.id === id) return n;
    if (n.type === 'group') { const s = sectionOf(n.children, id); if (s) return s; }
  }
  return undefined as never;
}
const flip = (def: BuilderDefinition, id: string, polarity: 'debit' | 'credit'): BuilderDefinition => {
  const d = clone(def);
  sectionOf(d.nodes, id).polarity = polarity;
  return d;
};

/** Cells of the row kind/nodeId (first one). */
const cellsOf = (rows: Row[], kind: string, nodeId: string) => rows.find((r) => r.kind === kind && r.nodeId === nodeId)!.cells;
const colsOf = (cols: Col[], kinds: string[]) => cols.map((x, i) => (kinds.includes(x.kind) ? i : -1)).filter((i) => i >= 0);
const negPct = (x: string | null) => (x === null || x === '0.0' ? x : x.startsWith('-') ? x.slice(1) : `-${x}`);

/**
 * The flipped run equals the baseline except the cells of the flipped
 * section's own rows (lines, earnings, Total), which are all negated (amounts,
 * $ change, % change and % of follow the shown amounts), and the group
 * subtotals listed in `groups`, which hold the shown sum.
 */
function expectOnlySectionFlipped(base: { rows: Row[]; cols: Col[] }, flipped: { rows: Row[]; cols: Col[] }, sectionId: string, groups: string[] = []) {
  expect(flipped.cols).toEqual(base.cols);
  expect(flipped.rows.map((r) => [r.kind, r.nodeId, r.path.join('/')])).toEqual(base.rows.map((r) => [r.kind, r.nodeId, r.path.join('/')]));
  const money = colsOf(base.cols, ['total', 'period', 'prior', 'change']);
  const pcts = colsOf(base.cols, ['pct_change', 'percent']);
  base.rows.forEach((b, i) => {
    const f = flipped.rows[i]!;
    const mine = b.nodeId === sectionId && ['line', 'earnings', 'total'].includes(b.kind);
    if (!mine && !(b.kind === 'subtotal' && groups.includes(b.nodeId))) {
      expect(f.cells, `${b.kind} ${b.nodeId} ${b.caption}`).toEqual(b.cells);
      return;
    }
    if (!mine) return;
    for (const j of money) expect(f.cells[j], `${b.kind} ${b.caption} col ${j}`).toBe(b.cells[j] === null ? null : neg(b.cells[j]!));
    for (const j of pcts) expect(f.cells[j], `${b.kind} ${b.caption} col ${j}`).toBe(negPct(b.cells[j] ?? null));
  });
}

type L = { accountId: string; debit: string; credit: string };
const je = (date: string, lines: L[]) => ledger.postTransaction(c.tenantId, {
  txnType: 'journal_entry' as never, txnDate: date, memo: 'je', lines,
  total: lines.reduce((s, l) => s.plus(l.debit), new Decimal(0)).toFixed(4),
} as never, c.userId, c.companyId);
const dr = (accountId: string, amt: string): L => ({ accountId, debit: amt, credit: '0' });
const cr = (accountId: string, amt: string): L => ({ accountId, debit: '0', credit: amt });

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/report-builder', reportBuilderRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
  c = await makeCompany(`rbs${suffix().slice(-4)}`, tenantIds);
  const [g] = await db.insert(accounts).values({ tenantId: c.tenantId, name: `Materials ${suffix()}`, accountType: 'cogs', detailType: 'supplies_materials_cogs' }).returning();
  cogs = g!.id;
  const [e] = await db.insert(accounts).values({ tenantId: c.tenantId, name: `Owner capital ${suffix()}`, accountType: 'equity', detailType: 'owners_equity' }).returning();
  equity = e!.id;
  // Prior year (the compare range and the prior years' earnings).
  await je('2025-02-01', [dr(c.bank, '800.00'), cr(c.income, '800.00')]);
  await je('2025-03-01', [dr(cogs, '100.00'), cr(c.bank, '100.00')]);
  await je('2025-04-01', [dr(c.expense, '120.00'), cr(c.bank, '120.00')]);
  // This year.
  await je('2026-01-15', [dr(c.bank, '400.00'), cr(equity, '400.00')]);
  await je('2026-02-01', [dr(c.bank, '1000.00'), cr(c.income, '1000.00')]);
  await je('2026-02-10', [dr(cogs, '300.00'), cr(c.bank, '300.00')]);
  await je('2026-03-01', [dr(c.expense, '150.00'), cr(c.bank, '150.00')]);
  await je('2026-03-02', [dr(c.expense2, '50.00'), cr(c.bank, '50.00')]);
  // A refund to an expense account: a credit inside the debit-normal section.
  await je('2026-03-03', [dr(c.bank, '5.00'), cr(c.expense2, '5.00')]);
  await je('2026-04-01', [dr(c.bank, '45.00'), cr(c.ap, '45.00')]);
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('formulas use each section\'s normal sign (U-218, report-builder-formula-sign-v1)', () => {
  it('is listed as a desktop capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('report-builder-formula-sign-v1');
  });

  for (const basis of BASES) {
    it(`flipping Expenses leaves the P&L formulas, $ / % change and % of unchanged (${basis})`, async () => {
      const def = starter('profit_loss');
      def.columns.compare = [{ base: 'prior_year', amount: true, dollarChange: true, percentChange: true }];
      def.columns.percentOf = 'income';
      const extra = { dates: RANGE, basis, compareRanges: [[PRIOR]] };
      const base = await run(def, extra);
      const flipped = await run(flip(def, 'expenses', 'credit'), extra);
      expectOnlySectionFlipped(base, flipped, 'expenses');

      // The formulas are the normal-sign figures (and the standard P&L's net income).
      const total = base.cols.findIndex((x) => x.kind === 'total');
      const change = base.cols.findIndex((x) => x.kind === 'change');
      const pctChange = base.cols.findIndex((x) => x.kind === 'pct_change');
      const pct = base.cols.findIndex((x) => x.kind === 'percent');
      const ni = cellsOf(flipped.rows, 'formula', 'net_income');
      expect(D(ni[total])).toBe('505.0000');
      expect(D(cellsOf(flipped.rows, 'formula', 'gross_profit')[total])).toBe('700.0000');
      expect(D(ni[change])).toBe('-75.0000');
      expect(ni[pctChange]).toBe('-12.9');
      expect(ni[pct]).toBe('50.5');
      const pl = await reportService.buildProfitAndLoss(c.tenantId, RANGE.from, RANGE.to, basis, c.companyId, null, null, { exactAmounts: true }) as unknown as Record<string, unknown>;
      expect(D(ni[total])).toBe(D(pl['netIncomeExact'] as string));
      // The flipped section shows its own cells with the other sign; its change follows them.
      const exp = cellsOf(flipped.rows, 'total', 'expenses');
      expect(D(exp[total])).toBe('-195.0000');
      expect(D(exp[change])).toBe('-75.0000');
    });

    it(`flipping Income leaves formulas and the other sections' % of Income unchanged (${basis})`, async () => {
      const def = starter('profit_loss_pct_income');
      const extra = { dates: RANGE, basis };
      const base = await run(def, extra);
      const flipped = await run(flip(def, 'income', 'debit'), extra);
      const pct = base.cols.findIndex((x) => x.kind === 'percent');
      // Income's own % cells follow its shown cells over the normal-sign base (was +100.0 before U-218).
      expect(cellsOf(base.rows, 'total', 'income')[pct]).toBe('100.0');
      expect(cellsOf(flipped.rows, 'total', 'income')[pct]).toBe('-100.0');
      expectOnlySectionFlipped(base, flipped, 'income');
      expect(cellsOf(flipped.rows, 'formula', 'net_income')[pct]).toBe('50.5');
    });

    it(`a group between a flipped section and a formula: the formula is unchanged, the group subtotal is shown (${basis})`, async () => {
      const pl = starter('profit_loss');
      const sec = (id: string) => clone(sectionOf(pl.nodes, id));
      const def: BuilderDefinition = {
        ...pl,
        columns: { ...pl.columns, compare: [{ base: 'prior_year', amount: false, dollarChange: true, percentChange: true }] },
        nodes: [
          sec('income'),
          { type: 'group', id: 'costs', caption: 'Costs', children: [sec('cogs'), sec('expenses')], showTotal: true },
          { type: 'formula', id: 'net', caption: 'Net', terms: [{ nodeId: 'income', sign: 1 }, { nodeId: 'costs', sign: -1 }] },
        ],
      };
      const extra = { dates: RANGE, basis, compareRanges: [[PRIOR]] };
      const base = await run(def, extra);
      // A compare amount used only for a change is hidden (null cells), and stays so.
      expect(base.cols.some((x) => x.kind === 'hidden')).toBe(true);
      const flipped = await run(flip(def, 'expenses', 'credit'), extra);
      expectOnlySectionFlipped(base, flipped, 'expenses', ['costs']);
      const total = base.cols.findIndex((x) => x.kind === 'total');
      expect(D(cellsOf(flipped.rows, 'formula', 'net')[total])).toBe('505.0000');
      // The group's shown subtotal adds its children as shown: 300 + (-195).
      expect(D(cellsOf(flipped.rows, 'subtotal', 'costs')[total])).toBe('105.0000');
      expect(D(cellsOf(base.rows, 'subtotal', 'costs')[total])).toBe('495.0000');
    });

    it(`Balance Sheet: Equity shown debit-positive leaves Total Liabilities and Equity unchanged (${basis})`, async () => {
      const def = starter('balance_sheet');
      const extra = { dates: { asOf: AS_OF }, basis };
      const base = await run(def, extra);
      const flipped = await run(flip(def, 'equity', 'debit'), extra);
      expect(flipped.rows.some((r) => r.kind === 'earnings' && r.nodeId === 'equity')).toBe(true);
      expectOnlySectionFlipped(base, flipped, 'equity');
      const total = base.cols.findIndex((x) => x.kind === 'total');
      const bs = await reportService.buildBalanceSheet(c.tenantId, AS_OF, basis, c.companyId, null, null, { exactAmounts: true }) as unknown as Record<string, unknown>;
      expect(D(cellsOf(flipped.rows, 'formula', 'liabilities_equity')[total])).toBe(new Decimal(bs['totalLiabilitiesExact'] as string).plus(bs['totalEquityExact'] as string).toFixed(4));
    });
  }
});
