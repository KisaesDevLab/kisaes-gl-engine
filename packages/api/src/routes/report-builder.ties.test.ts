// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Report Builder ties beyond the starters (U-225, ClientLedger PR-A2 process
// checkpoint, findings 1-B1, 1-B2, 1-S1):
//   - a balance in a range report drills to an opening row + rows that sum to
//     the line in every column, with and without range and running balance;
//     a report of balances only has no multi-period Total, and in a report
//     that mixes flows and balances a balance's Total is its last period;
//   - a Trial Balance section with two group-bys totals its debit and credit
//     once, per account, in every display mode, = the one-level TB and
//     buildTrialBalance; outer lines never net across accounts (every other
//     group-by: report-builder.tb-sides.test.ts, B-1);
//   - a drill without range fills no compare / change cell its rows don't.
// Books: Savings 1,000.00 on 2025-12-15 and 250.00 on 2026-02-10 (income);
// A/R 70.00 on 2025-02-10 and 40.00 on 2026-03-05 (income); later dates add
// an open invoice (2026-04-15, 100.00) and an overdrawn bank (2026-04-20).

import 'express-async-errors';
import express from 'express';
import type { AddressInfo } from 'net';
import http from 'http';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BUILDER_STARTERS, type BuilderDefinition, type RbNode, type RbSectionNode } from '@kis-books/shared';
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
const FY = ['2025-01-01', '2026-01-01'];
const Q1 = { from: '2026-01-01', to: '2026-03-31' };
const MONTHS_Q1 = [{ from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-01', to: '2026-02-28' }, { from: '2026-03-01', to: '2026-03-31' }];

function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: ReturnType<typeof JSON.parse> }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/report-builder${p}`, method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}`, 'X-Company-Id': c.companyId, ...(data ? { 'Content-Length': String(data.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

type Col = { key: string; kind: string; range?: { from: string | null; to: string } };
type Row = { kind: string; nodeId: string; path: string[]; caption: string; cells: Array<string | null>; drill?: { type: string; path?: string[] } | null; expanded?: boolean };
type RunJson = { rows: Row[]; columns: Col[]; fingerprint: string; stamp: number };

const starter = (key: string): BuilderDefinition => JSON.parse(JSON.stringify(BUILDER_STARTERS.find((s) => s.key === key)!.definition)) as BuilderDefinition;
const sectionOf = (d: BuilderDefinition, id: string) => d.nodes.find((n) => n.type === 'section' && n.id === id) as RbSectionNode;
const D = (x: string | number | null | undefined) => new Decimal(x ?? 0).toFixed(4);
const Dn = (x: string | null | undefined) => (x === null || x === undefined ? null : new Decimal(x).toFixed(4));
const valueCols = (cols: Col[]) => cols.map((x, i) => (['field', 'percent', 'hidden'].includes(x.kind) ? -1 : i)).filter((i) => i >= 0);

async function runDef(definition: unknown, ref: Record<string, unknown>): Promise<RunJson> {
  const r = await call('POST', '/run', { definition, fiscalYearStarts: FY, ...ref });
  expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
  return r.json;
}

/** Every page of a drill: the subtotal, the rows, and per column the sum of its detail AND opening rows. */
async function drill(definition: unknown, ref: Record<string, unknown>, run: RunJson, nodeId: string, path: string[], range?: unknown) {
  const sums = run.columns.map(() => new Decimal(0));
  const rows: Row[] = [];
  let subtotal: Array<string | null> = [];
  let cursor: string | null = null;
  let page = 0;
  do {
    const r = await call('POST', '/run/detail', { definition, fiscalYearStarts: FY, ...ref, nodeId, path, fingerprint: run.fingerprint, stamp: run.stamp, ...(range ? { range } : {}), ...(cursor ? { cursor } : {}) });
    expect(r.status, `${nodeId} ${path.join('/')} ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
    subtotal = r.json.subtotal;
    for (const row of r.json.rows as Row[]) {
      if (row.kind === 'opening') expect(page, 'the opening row comes on the first page only').toBe(0);
      if (row.kind !== 'detail' && row.kind !== 'opening') continue;
      rows.push(row);
      for (const i of valueCols(run.columns)) { const x = row.cells[i]; if (x !== null && x !== undefined) sums[i] = sums[i]!.plus(x); }
    }
    cursor = r.json.cursor;
    page++;
  } while (cursor);
  return { subtotal, sums, rows };
}

/** No cell of a run or drill is the summed balance (the review's 3,500.00). */
const noCell = (rows: Array<{ cells: Array<string | null> }>, figure: string) => {
  for (const r of rows) for (const x of r.cells) if (x !== null && /^-?\d+(\.\d+)?$/.test(x)) expect(D(x)).not.toBe(D(figure));
};

type L = { accountId: string; debit: string; credit: string; contactId?: string };
const post = (txnType: string, date: string, lines: L[], extra: Record<string, unknown> = {}) =>
  ledger.postTransaction(c.tenantId, {
    txnType: txnType as never, txnDate: date, memo: txnType, lines,
    total: lines.reduce((s, l) => s.plus(l.debit), new Decimal(0)).toFixed(4), ...extra,
  } as never, c.userId, c.companyId);

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/report-builder', reportBuilderRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
  c = await makeCompany(`rbtie${suffix().slice(-4)}`, tenantIds);
  await post('journal_entry', '2025-02-10', [{ accountId: c.ar, debit: '70.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '70.00' }]);
  await post('journal_entry', '2025-12-15', [{ accountId: c.savings, debit: '1000.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '1000.00' }]);
  await post('journal_entry', '2026-02-10', [{ accountId: c.savings, debit: '250.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '250.00' }]);
  await post('journal_entry', '2026-03-05', [{ accountId: c.ar, debit: '40.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '40.00' }]);
  // After the first quarter: an open invoice and an overdrawn bank (a credit-balance asset).
  await post('invoice', '2026-04-15', [{ accountId: c.ar, debit: '100.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '100.00' }], { contactId: c.customer, dueDate: '2026-05-15' });
  await post('expense', '2026-04-20', [{ accountId: c.expense, debit: '30.00', credit: '0' }, { accountId: c.bank, debit: '0', credit: '30.00' }], { contactId: c.vendor });
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

/** Bank Account Balances switched to a date range (the editor's Range / As of switch). */
const bankRange = (fields?: string[]) => {
  const d = starter('bank_balances');
  d.dates = { mode: 'range', preset: 'this_year_to_date' } as BuilderDefinition['dates'];
  if (fields) d.columns.detailFields = fields as BuilderDefinition['columns']['detailFields'];
  return d;
};

describe('a balance in a range report (1-B1)', () => {
  it('is listed as a desktop capability (report-builder-ties-v1)', () => {
    expect(DESKTOP_CAPABILITIES).toContain('report-builder-ties-v1');
  });

  for (const basis of ['accrual', 'cash'] as const) {
    it(`drills to an opening row + rows that sum to the line, with and without range and running balance; ties to the Balance Sheet (${basis})`, async () => {
      const bsEnd = await reportService.buildBalanceSheet(c.tenantId, Q1.to, basis, c.companyId, null, null, { exactAmounts: true }) as unknown as Record<string, unknown>;
      const bsOpen = await reportService.buildBalanceSheet(c.tenantId, '2025-12-31', basis, c.companyId, null, null, { exactAmounts: true }) as unknown as Record<string, unknown>;
      const savingsAt = (bs: Record<string, unknown>) => D((bs['assets'] as Array<{ accountId: string | null; balanceExact?: string }>).find((e) => e.accountId === c.savings)?.balanceExact);
      expect(savingsAt(bsEnd)).toBe(D('1250'));
      expect(savingsAt(bsOpen)).toBe(D('1000'));

      for (const fields of [undefined, ['date', 'txn_type', 'memo', 'running_balance']]) {
        const def = bankRange(fields);
        const ref = { dates: Q1, basis };
        const run = await runDef(def, ref);
        const v = run.columns.findIndex((x) => x.key === 'total');
        expect(run.columns[v]!.range).toEqual(Q1);
        const line = run.rows.find((r) => r.kind === 'line' && r.path[1] === `account:${c.savings}`)!;
        expect(D(line.cells[v])).toBe(savingsAt(bsEnd));
        const tot = run.rows.find((r) => r.kind === 'total' && r.nodeId === 'banks')!;
        expect(D(tot.cells[v])).toBe(D('1250'));
        for (const [target, path] of [[line, line.path], [tot, ['n:banks']]] as Array<[Row, string[]]>) {
          for (const range of [undefined, run.columns[v]!.range]) {
            const d = await drill(def, ref, run, 'banks', path, range);
            const opening = d.rows.filter((r) => r.kind === 'opening');
            expect(opening, `${path.join('/')} opening`).toHaveLength(1);
            expect(d.rows[0]!.kind).toBe('opening');
            expect(opening[0]!.caption).toBe('Balance before Jan 1, 2026');            expect(D(opening[0]!.cells[v])).toBe(savingsAt(bsOpen));
            expect(d.rows.filter((r) => r.kind === 'detail').map((r) => D(r.cells[v]))).toEqual([D('250')]);
            expect(d.sums[v]!.toFixed(4), 'opening + rows = the figure').toBe(D(target.cells[v]));
            expect(D(d.subtotal[v])).toBe(D(target.cells[v]));
            if (fields && path.length === 2) {
              const bal = run.columns.findIndex((x) => x.key === 'f:running_balance');
              expect(D(opening[0]!.cells[bal])).toBe(D('1000'));
              expect(D(d.rows[d.rows.length - 1]!.cells[bal]), 'the running balance ends at the line').toBe(D(line.cells[v]));
            }
          }
        }
        // The run's own detail rows (expanded) carry the same opening row.
        const open = JSON.parse(JSON.stringify(def)) as BuilderDefinition;
        (open.nodes[0] as RbSectionNode).display = 'expandable';
        const shown = await runDef(open, { ...ref, expandAll: true });
        {
          const under = shown.rows.filter((r) => (r.kind === 'opening' || r.kind === 'detail') && r.path[1] === `account:${c.savings}`);
          expect(under.map((r) => r.kind)).toEqual(['opening', 'detail']);
          expect(under.reduce((acc, r) => acc.plus(r.cells[v] ?? 0), new Decimal(0)).toFixed(4)).toBe(D('1250'));
        }
      }
    });

    it(`by month: 1,000.00 · 1,250.00 · 1,250.00, no summed Total; every column drills to its figure (${basis})`, async () => {
      const def = bankRange();
      def.columns.periods = 'month';
      const ref = { dates: Q1, basis, periodRanges: MONTHS_Q1 };
      const run = await runDef(def, ref);
      expect(run.columns.some((x) => x.key === 'total'), 'a report of balances only has no Total column').toBe(false);
      const periods = run.columns.map((x, i) => (x.kind === 'period' ? i : -1)).filter((i) => i >= 0);
      expect(periods).toHaveLength(3);
      const line = run.rows.find((r) => r.kind === 'line' && r.path[1] === `account:${c.savings}`)!;
      expect(periods.map((i) => D(line.cells[i]))).toEqual([D('1000'), D('1250'), D('1250')]);
      noCell(run.rows, '3500');
      for (const path of [line.path, ['n:banks']]) {
        // Without range: one opening row (1,000.00 in each column) and the 250.00 row in February and March.
        const all = await drill(def, ref, run, 'banks', path);
        const op = all.rows.find((r) => r.kind === 'opening')!;
        expect(periods.map((i) => D(op.cells[i]))).toEqual([D('1000'), D('1000'), D('1000')]);
        for (const i of periods) {
          expect(all.sums[i]!.toFixed(4)).toBe(D(line.cells[i]));
          expect(D(all.subtotal[i])).toBe(D(line.cells[i]));
        }
        noCell([...all.rows, { cells: all.subtotal }], '3500');
        // Each month's own range: the balance before that month + that month's rows.
        for (const i of periods) {
          const one = await drill(def, ref, run, 'banks', path, run.columns[i]!.range);
          expect(one.sums[i]!.toFixed(4), `${run.columns[i]!.key}`).toBe(D(line.cells[i]));
          expect(D(one.subtotal[i])).toBe(D(line.cells[i]));
          for (const j of periods) if (j !== i) expect(one.subtotal[j]).toBeNull();
        }
      }
    });

    it(`a report mixing a flow and a balance keeps the Total: the flow's sum, the balance's last month; groups and formulas follow (${basis})`, async () => {
      const def = bankRange();
      def.columns.periods = 'month';
      const income = sectionOf(starter('profit_loss_by_month'), 'income');
      const banks = def.nodes[0] as RbSectionNode;
      def.nodes = [
        { type: 'group', id: 'both', caption: 'Both', showTotal: true, children: [banks, income] } as RbNode,
        { type: 'formula', id: 'sum', caption: 'Banks plus income', terms: [{ nodeId: 'banks', sign: 1 }, { nodeId: 'income', sign: 1 }] } as RbNode,
      ];
      const ref = { dates: Q1, basis, periodRanges: MONTHS_Q1 };
      const run = await runDef(def, ref);
      const t = run.columns.findIndex((x) => x.key === 'total');
      expect(t).toBeGreaterThan(-1);
      const cellAt = (kind: string, nodeId: string) => D(run.rows.find((r) => r.kind === kind && r.nodeId === nodeId)!.cells[t]);
      expect(cellAt('total', 'banks'), 'a balance\'s Total = its last month').toBe(D('1250'));
      expect(cellAt('total', 'income'), 'a flow\'s Total = its sum').toBe(D('290'));
      expect(cellAt('subtotal', 'both')).toBe(D('1540'));
      expect(cellAt('formula', 'sum')).toBe(D('1540'));
      noCell(run.rows, '3500');
      noCell(run.rows, '3790');
      // The Total cell drills (no range): the opening (last column's) + the rows in the last column = 1,250.00.
      const line = run.rows.find((r) => r.kind === 'line' && r.path[1] === `account:${c.savings}`)!;
      expect(D(line.cells[t])).toBe(D('1250'));
      const d = await drill(def, ref, run, 'banks', line.path);
      expect(d.sums[t]!.toFixed(4)).toBe(D('1250'));
      expect(D(d.subtotal[t])).toBe(D('1250'));
      // A monthly drill is not part of the Total of a balance (its last month's is).
      const feb = await drill(def, ref, run, 'banks', line.path, MONTHS_Q1[1]);
      expect(feb.subtotal[t]).toBeNull();
      const mar = await drill(def, ref, run, 'banks', line.path, MONTHS_Q1[2]);
      expect(D(mar.subtotal[t])).toBe(D('1250'));
      expect(mar.sums[t]!.toFixed(4)).toBe(D('1250'));
    });
  }

  const DEC_FEB = [{ from: '2025-12-01', to: '2025-12-31' }, { from: '2026-01-01', to: '2026-01-31' }, { from: '2026-02-01', to: '2026-02-28' }];
  /** Every line, Total and earnings row drills to opening + rows = its cells, in every column, with and without range. */
  const drillsTie = async (def: BuilderDefinition, ref: Record<string, unknown>, run: RunJson, periods: number[]) => {
    let checked = 0;
    for (const r of run.rows.filter((x) => x.drill?.type === 'detail' || x.kind === 'earnings')) {
      const path = r.kind === 'total' ? [`n:${r.nodeId}`] : r.path;
      for (const range of [undefined, ...periods.map((i) => run.columns[i]!.range)]) {
        const d = await drill(def, ref, run, r.nodeId, path, range);
        for (const i of periods) {
          if (range && run.columns[i]!.range !== range) { expect(d.subtotal[i]).toBeNull(); continue; }
          expect(d.sums[i]!.toFixed(4), `${path.join('/')} ${run.columns[i]!.key} ${range ? 'range' : 'all'}`).toBe(D(r.cells[i]));
          expect(D(d.subtotal[i])).toBe(D(r.cells[i]));
          checked++;
        }
      }
    }
    return checked;
  };

  for (const basis of ['accrual', 'cash'] as const) {
    it(`each column's fiscal-year rule: revenue balances across a year end, and the Balance Sheet by month in a range report (${basis})`, async () => {
      const ref = { dates: { from: '2025-12-01', to: '2026-02-28' }, basis, periodRanges: DEC_FEB };
      // A revenue balance: from each column's fiscal year start (Dec 2025: the 2025 income; Jan 2026: nothing yet).
      const rev = bankRange();
      rev.columns.periods = 'month';
      rev.nodes = [{ ...sectionOf(starter('profit_loss_by_month'), 'income'), id: 'rev', measure: 'balance' } as RbSectionNode];
      const rrun = await runDef(rev, ref);
      const periods = rrun.columns.map((x, i) => (x.kind === 'period' ? i : -1)).filter((i) => i >= 0);
      const line = rrun.rows.find((r) => r.kind === 'line' && r.path[1] === `account:${c.income}`)!;
      expect(periods.map((i) => D(line.cells[i]))).toEqual([D('1070'), D('0'), D('250')]);
      const all = await drill(rev, ref, rrun, 'rev', line.path);
      expect(periods.map((i) => D(all.rows.find((r) => r.kind === 'opening')!.cells[i]))).toEqual([D('70'), D('0'), D('0')]);
      expect(await drillsTie(rev, ref, rrun, periods)).toBeGreaterThan(0);

      // The Balance Sheet switched to a range, by month: totals = the standard Balance Sheet at each month's end; every
      // line, Total and earnings row drills to opening + rows.
      const bs = starter('balance_sheet');
      bs.dates = { mode: 'range', preset: 'this_year_to_date' } as BuilderDefinition['dates'];
      bs.columns.periods = 'month';
      const brun = await runDef(bs, ref);
      expect(brun.columns.some((x) => x.key === 'total')).toBe(false);
      const bp = brun.columns.map((x, i) => (x.kind === 'period' ? i : -1)).filter((i) => i >= 0);
      for (const [j, i] of bp.entries()) {
        const std = await reportService.buildBalanceSheet(c.tenantId, DEC_FEB[j]!.to, basis, c.companyId, null, null, { exactAmounts: true, fiscalYearStart: j === 0 ? '2025-01-01' : '2026-01-01' }) as unknown as Record<string, string>;
        const at = (id: string) => D(brun.rows.find((r) => r.kind === 'total' && r.nodeId === id)!.cells[i]);
        expect(at('assets'), `${DEC_FEB[j]!.to} assets`).toBe(D(std['totalAssetsExact']));
        expect(at('liabilities')).toBe(D(std['totalLiabilitiesExact']));
        expect(at('equity'), `${DEC_FEB[j]!.to} equity`).toBe(D(std['totalEquityExact']));
      }
      expect(brun.rows.some((r) => r.kind === 'earnings')).toBe(true);
      expect(await drillsTie(bs, ref, brun, bp)).toBeGreaterThan(20);
    });
  }

  it('open items in a range report by month: no summed Total; a drill without range fills only the last month', async () => {
    const def = starter('customer_balance_summary');
    def.dates = { mode: 'range', preset: 'this_year_to_date' } as BuilderDefinition['dates'];
    def.columns.periods = 'month';
    const months = [{ from: '2026-04-01', to: '2026-04-30' }, { from: '2026-05-01', to: '2026-05-31' }, { from: '2026-06-01', to: '2026-06-30' }];
    const ref = { dates: { from: '2026-04-01', to: '2026-06-30' }, periodRanges: months };
    const run = await runDef(def, ref);
    expect(run.columns.some((x) => x.key === 'total')).toBe(false);
    const periods = run.columns.map((x, i) => (x.kind === 'period' ? i : -1)).filter((i) => i >= 0);
    const line = run.rows.find((r) => r.kind === 'line' && r.path[1] === `contact:${c.customer}`)!;
    expect(periods.map((i) => D(line.cells[i]))).toEqual([D('100'), D('100'), D('100')]);
    noCell(run.rows, '300');
    const all = await drill(def, ref, run, line.nodeId, line.path);
    expect(periods.map((i) => Dn(all.subtotal[i]))).toEqual([null, null, D('100')]);
    for (const i of periods) expect(all.sums[i]!.toFixed(4)).toBe(D(all.subtotal[i]));
    for (const i of periods) {
      const one = await drill(def, ref, run, line.nodeId, line.path, run.columns[i]!.range);
      expect(D(one.subtotal[i])).toBe(D(line.cells[i]));
      expect(one.sums[i]!.toFixed(4)).toBe(D(line.cells[i]));
    }
  });
});

// ── Trial Balance with two group-bys (1-B2) ────────────────────────

const tbDef = (groupBy: string[], display: 'summary' | 'expandable' | 'detail', earnings: boolean) => {
  const d = starter('trial_balance');
  const s = d.nodes[0] as RbSectionNode;
  s.groupBy = groupBy.map((key) => ({ key })) as RbSectionNode['groupBy'];
  s.display = display;
  if (!earnings) delete (s as { earnings?: string }).earnings;
  return d;
};
const pair = (r: Row, v: number) => [Dn(r.cells[v]), Dn(r.cells[v + 1])];

describe('a Trial Balance section with two group-bys (1-B2)', () => {
  for (const basis of ['accrual', 'cash'] as const) {
    it(`totals its debit and credit once, from the innermost lines, in every mode (${basis})`, async () => {
      for (const [asOf, earnings] of [['2026-03-31', false], ['2026-03-31', true], ['2026-04-30', false], ['2026-04-30', true]] as const) {
        const ref = { dates: { asOf }, basis };
        const one = await runDef(tbDef(['account'], 'summary', earnings), ref);
        const v = one.columns.findIndex((x) => x.kind !== 'field');
        const oneTotal = pair(one.rows.find((r) => r.kind === 'total')!, v);
        if (asOf === '2026-03-31' && !earnings) expect(oneTotal, 'the review\'s figures').toEqual([D('1360'), D('290')]);
        if (earnings) {
          const std = await reportService.buildTrialBalance(c.tenantId, '2026-01-01', asOf, c.companyId, null, basis, { exactAmounts: true }) as unknown as Record<string, string>;
          expect(oneTotal).toEqual([D(std['totalDebitsExact']), D(std['totalCreditsExact'])]);
        }
        // No group-by: still each account's TB figure on its side (B-1), so the same Total as by account.
        const none = pair((await runDef(tbDef([], 'summary', earnings), ref)).rows.find((r) => r.kind === 'total')!, v);
        expect(none).toEqual(oneTotal);
        const leaf = Object.fromEntries(one.rows.filter((r) => r.kind === 'line').map((r) => [r.path[1]!, pair(r, v)]));
        const two = tbDef(['account_type', 'account'], 'summary', earnings);
        const modes: Array<[string, BuilderDefinition, Record<string, unknown>]> = [
          ['summary', two, {}],
          ['expandable collapsed', tbDef(['account_type', 'account'], 'expandable', earnings), {}],
          ['expandable, one open', tbDef(['account_type', 'account'], 'expandable', earnings), { open: [['n:accounts', 'account_type:asset']] }],
          ['expandAll', tbDef(['account_type', 'account'], 'expandable', earnings), { expandAll: true }],
          ['detail', tbDef(['account_type', 'account'], 'detail', earnings), {}],
          ['export', tbDef(['account_type', 'account'], 'expandable', earnings), { expandAll: true, purpose: 'export' }],
        ];
        for (const [mode, def, extra] of modes) {
          const run = await runDef(def, { ...ref, ...extra });
          expect(pair(run.rows.find((r) => r.kind === 'total')!, v), `${asOf} ${earnings} ${mode} Total`).toEqual(oneTotal);
          for (const outer of run.rows.filter((r) => r.kind === 'line' && r.path.length === 2)) {
            // An outer line: the sums of its accounts' debit and credit (one-level TB lines), never their net.
            const type = outer.path[1]!;
            const inner = (await runDef(def, { ...ref, expandAll: true })).rows.filter((r) => r.kind === 'line' && r.path.length === 3 && r.path[1] === type);
            const sum = (k: 0 | 1) => inner.reduce((acc, r) => acc.plus(leaf[r.path[2]!]?.[k] ?? 0), new Decimal(0));
            expect(pair(outer, v).map((x) => x ?? D(0)), `${asOf} ${mode} ${type}`).toEqual([sum(0).toFixed(4), sum(1).toFixed(4)]);
          }
        }
        // The drill of an outer line: its subtotal = the line's cells.
        const run = await runDef(two, ref);
        for (const outer of run.rows.filter((r) => r.kind === 'line')) {
          const d = await drill(two, ref, run, 'accounts', outer.path);
          expect([Dn(d.subtotal[v]), Dn(d.subtotal[v + 1])], `${asOf} drill ${outer.path[1]}`).toEqual(pair(outer, v));
        }
        if (asOf === '2026-04-30') {
          // The asset type holds a debit-balance (Savings, A/R) and a credit-balance (the overdrawn bank) account.
          const asset = run.rows.find((r) => r.kind === 'line' && r.path[1] === 'account_type:asset')!;
          // (The unpaid invoice's 100.00 of A/R is not on the cash basis.)
          expect(pair(asset, v)).toEqual([D(basis === 'accrual' ? '1460' : '1360'), D('30')]);
        }
      }
    });
  }
});

// ── A drill without range (1-S1) ───────────────────────────────────

describe('a drill without range (1-S1)', () => {
  it('echoes no compare or change cell its rows never fill; the Total column ties', async () => {
    const def = starter('profit_loss_by_month');
    def.columns.compare = [{ base: 'prior_year', amount: true, dollarChange: true, percentChange: false }];
    const months = MONTHS_Q1.slice(1);
    const ref = { dates: { from: '2026-02-01', to: '2026-03-31' }, periodRanges: months };
    const run = await runDef(def, ref);
    const t = run.columns.findIndex((x) => x.key === 'total');
    const line = run.rows.find((r) => r.kind === 'line' && r.nodeId === 'income' && r.path[1] === `account:${c.income}`)!;
    expect(D(line.cells[t])).toBe(D('290'));
    const prior = run.columns.map((x, i) => (x.kind === 'prior' ? i : -1)).filter((i) => i >= 0);
    expect(prior.map((i) => D(line.cells[i]))).toEqual([D('70'), D('0')]);
    for (const path of [line.path, ['n:income']]) {
      const d = await drill(def, ref, run, 'income', path);
      expect(d.rows.filter((r) => r.kind === 'detail').map((r) => D(r.cells[t]))).toEqual([D('250'), D('40')]);
      expect(D(d.subtotal[t])).toBe(D('290'));
      expect(d.sums[t]!.toFixed(4)).toBe(D('290'));
      run.columns.forEach((col, i) => {
        if (col.kind === 'prior' || col.kind === 'change' || col.kind === 'pct_change') expect(d.subtotal[i], `${col.key}`).toBeNull();
        // Every value the subtotal shows is the sum of the rows in that column.
        if (d.subtotal[i] !== null && valueCols(run.columns).includes(i)) expect(d.sums[i]!.toFixed(4), col.key).toBe(D(d.subtotal[i]));
      });
    }
    // A compare column drilled with its own range is filled by its own rows.
    const pc = run.columns[prior[0]!]!;
    const d = await drill(def, ref, run, 'income', line.path, pc.range);
    expect(D(d.subtotal[prior[0]!])).toBe(D('70'));
    expect(d.sums[prior[0]!]!.toFixed(4)).toBe(D('70'));
  });
});
