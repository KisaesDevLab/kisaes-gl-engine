// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Report Builder runs (U-119, report-builder-v1; ClientLedger A07 PR-C):
//   - starters run and tie to the standard reports on a small company, on
//     both bases (P&L, Balance Sheet, Trial Balance, Sales by Client);
//   - every group-by line equals the sum of its paged /run/detail rows
//     (page size 2 through the cursor), and a count subtotal = Σ children;
//   - expansion: expandable sections return level-1 lines only until a path
//     is open; defaultExpanded with collapsed exceptions; expandAll;
//   - periods: 36 accepted, 37 refused; compare columns with $ and % change;
//   - 409 RUN_CHANGED {params | books}; 403 / denied rows for a role without
//     bills; the 30 s deadline gives 503 REPORT_TIMEOUT (pg_sleep);
//   - RB_WRITE_FIXTURES=1 writes request/response samples for the desktop to
//     packages/shared/src/report-builder/fixtures/run/.

import 'express-async-errors';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { BUILDER_STARTERS, type BuilderDefinition } from '@kis-books/shared';
import { db } from '../db/index.js';
import { userPermissions, users, userTenantAccess } from '../db/schema/index.js';
import { reportBuilderRouter } from './report-builder.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as reportService from '../services/report.service.js';
import { inSnapshot } from '../services/report-builder/limits.js';
import { ReportDecimal as Decimal } from '../services/report-exact.js';
import { makeCompany, cleanTenant, suffix, type Co } from '../services/templates/templates.test-helpers.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../shared/src/report-builder/fixtures/run');
const WRITE = process.env['RB_WRITE_FIXTURES'] === '1';
let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;
const FY = ['2025-01-01', '2026-01-01'];

interface Res { status: number; json: ReturnType<typeof JSON.parse> }
function call(method: string, p: string, body?: unknown, token = c.token): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/report-builder${p}`, method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Company-Id': c.companyId, ...(data ? { 'Content-Length': String(data.length) } : {}) },
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

const starter = (key: string): BuilderDefinition => JSON.parse(JSON.stringify(BUILDER_STARTERS.find((s) => s.key === key)!.definition)) as BuilderDefinition;
const run = (definition: unknown, extra: Record<string, unknown> = {}, token?: string) =>
  call('POST', '/run', { definition, fiscalYearStarts: FY, ...extra }, token);
const sample = (name: string, request: unknown, response: unknown) => {
  if (!WRITE) return;
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(path.join(FIXTURES, `${name}.json`), `${JSON.stringify({ request, response }, null, 2)}\n`);
};
// Uuids and stamps differ between runs: samples keep their shape, not their ids.
const scrub = (v: unknown) => JSON.parse(JSON.stringify(v).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '00000000-0000-4000-8000-000000000000'));

type L = { accountId: string; debit: string; credit: string; contactId?: string };
const post = (txnType: string, date: string, lines: L[], extra: Record<string, unknown> = {}) =>
  ledger.postTransaction(c.tenantId, {
    txnType: txnType as never, txnDate: date, memo: txnType, lines,
    total: lines.reduce((s, l) => s + Number(l.debit), 0).toFixed(2), ...extra,
  } as never, c.userId, c.companyId);

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/report-builder', reportBuilderRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
  c = await makeCompany(`rbr${suffix().slice(-4)}`, tenantIds);
  // Prior year income, this year's sales (one with a discount line), expenses and a bill.
  await post('journal_entry', '2025-06-30', [{ accountId: c.bank, debit: '500.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '500.00' }]);
  await post('invoice', '2026-02-01', [
    { accountId: c.ar, debit: '90.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '100.00' }, { accountId: c.expense, debit: '10.00', credit: '0' },
  ], { contactId: c.customer });
  for (let i = 0; i < 5; i++) {
    await post('cash_sale', `2026-03-0${i + 1}`, [{ accountId: c.bank, debit: '20.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '20.00' }], { contactId: c.customer });
  }
  await post('expense', '2026-03-10', [{ accountId: c.expense, debit: '33.33', credit: '0' }, { accountId: c.bank, debit: '0', credit: '33.33' }], { contactId: c.vendor });
  await post('bill', '2026-03-12', [{ accountId: c.expense2, debit: '45.00', credit: '0' }, { accountId: c.ap, debit: '0', credit: '45.00' }], { contactId: c.vendor });
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const cell = (r: { cells: Array<string | null> }, i: number) => new Decimal(r.cells[i] ?? '0');
type Row = { kind: string; nodeId: string; cells: Array<string | null> };
const totalRow = (rows: Row[], nodeId: string) => rows.find((r) => r.kind === 'total' && r.nodeId === nodeId)!;

describe('report-builder-v1 runs (U-119)', () => {
  for (const basis of ['accrual', 'cash'] as const) {
    it(`P&L, Balance Sheet, Trial Balance and Sales by Client starters tie to the standard reports (${basis})`, async () => {
      const dates = { from: '2026-01-01', to: '2026-12-31' };
      const pl = await run(starter('profit_loss'), { dates, basis });
      expect(pl.status, JSON.stringify(pl.json).slice(0, 400)).toBe(200);
      sample(`profit_loss_${basis}`, { definition: '<starters/profit_loss.json>', dates, basis, fiscalYearStarts: FY }, scrub(pl.json));
      const std = await reportService.buildProfitAndLoss(c.tenantId, dates.from, dates.to, basis, c.companyId, null, null, { exactAmounts: true });
      const ni = pl.json.rows.find((r: { kind: string; nodeId: string }) => r.kind === 'formula' && r.nodeId === 'net_income');
      expect(cell(ni, 0).toFixed(4)).toBe(new Decimal(std.netIncomeExact!).toFixed(4));

      const asOf = '2026-12-31';
      const bs = await run(starter('balance_sheet'), { dates: { asOf }, basis });
      expect(bs.status, JSON.stringify(bs.json).slice(0, 400)).toBe(200);
      sample(`balance_sheet_${basis}`, { definition: '<starters/balance_sheet.json>', dates: { asOf }, basis, fiscalYearStarts: FY }, scrub(bs.json));
      const sbs = await reportService.buildBalanceSheet(c.tenantId, asOf, basis, c.companyId, null, null, { exactAmounts: true }) as Record<string, unknown>;
      expect(cell(totalRow(bs.json.rows, 'assets'), 0).toFixed(4)).toBe(new Decimal(sbs['totalAssetsExact'] as string).toFixed(4));
      expect(cell(totalRow(bs.json.rows, 'equity'), 0).toFixed(4)).toBe(new Decimal(sbs['totalEquityExact'] as string).toFixed(4));
      const earnings = bs.json.rows.filter((r: { kind: string }) => r.kind === 'earnings');
      expect(earnings.map((r: { caption: string }) => r.caption)).toEqual(['Prior years\' net income', 'Net income this year']);

      const tb = await run(starter('trial_balance'), { dates: { asOf }, basis });
      expect(tb.status, JSON.stringify(tb.json).slice(0, 400)).toBe(200);
      const stb = await reportService.buildTrialBalance(c.tenantId, '2026-01-01', asOf, c.companyId, null, basis, { exactAmounts: true }) as Record<string, unknown>;
      const t = totalRow(tb.json.rows, 'accounts');
      expect(cell(t, 0).toFixed(4)).toBe(new Decimal(stb['totalDebitsExact'] as string).toFixed(4));
      expect(cell(t, 1).toFixed(4)).toBe(new Decimal(stb['totalCreditsExact'] as string).toFixed(4));
      expect(cell(t, 0).toFixed(4)).toBe(cell(t, 1).toFixed(4));

      const sc = await run(starter('sales_by_client'), { dates, basis });
      const ssc = await reportService.buildSalesByCustomer(c.tenantId, dates.from, dates.to, c.companyId, null, basis);
      const stdTotal = (ssc.data as Array<{ total: string }>).reduce((s, r) => s.plus(r.total), new Decimal(0));
      expect(cell(totalRow(sc.json.rows, 'sales'), 0).toFixed(4)).toBe(stdTotal.toFixed(4));
    });
  }

  it('every line equals the sum of its paged detail rows (page size by cursor); count subtotal = Σ children', async () => {
    const d = starter('transaction_detail_by_account');
    const dates = { from: '2026-01-01', to: '2026-12-31' };
    const r = await run(d, { dates, purpose: 'screen' });
    expect(r.status, JSON.stringify(r.json).slice(0, 400)).toBe(200);
    sample('transaction_detail_by_account', { definition: '<starters/transaction_detail_by_account.json>', dates, fiscalYearStarts: FY }, scrub(r.json));
    const valueCol = r.json.columns.findIndex((col: { kind: string }) => col.kind === 'total');
    const lines = r.json.rows.filter((x: { kind: string }) => x.kind === 'line');
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      let sum = new Decimal(0);
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const page = await call('POST', '/run/detail', { definition: d, dates, fiscalYearStarts: FY, nodeId: line.nodeId, path: line.path, fingerprint: r.json.fingerprint, stamp: r.json.stamp, ...(cursor ? { cursor } : {}) });
        expect(page.status, JSON.stringify(page.json).slice(0, 300)).toBe(200);
        if (pages === 0) sample('run_detail_page', { nodeId: line.nodeId, path: '<a line path>', fingerprint: '<run fingerprint>', stamp: '<run stamp>' }, scrub(page.json));
        expect(page.json.subtotal[valueCol]).toBe(line.cells[valueCol]);
        for (const row of page.json.rows.filter((x: { kind: string }) => x.kind === 'detail')) sum = sum.plus(row.cells[valueCol] ?? '0');
        cursor = page.json.cursor;
        pages++;
      } while (cursor);
      expect(sum.toFixed(4)).toBe(new Decimal(line.cells[valueCol]).toFixed(4));
    }
    // The bank's running balance continues across rows: its last row = the line amount (no opening balance this year besides the JE).
    const count = starter('sales_by_client');
    (count.nodes[0] as { measure: string }).measure = 'count';
    (count.nodes[0] as { groupBy: Array<{ key: string }> }).groupBy = [{ key: 'contact' }, { key: 'txn_type' }];
    const rc = await run(count, { dates, expandAll: true });
    const lvl1 = rc.json.rows.filter((x: { kind: string; path: string[] }) => x.kind === 'line' && x.path.length === 2);
    for (const l of lvl1) {
      const kids = rc.json.rows.filter((x: { kind: string; path: string[] }) => x.kind === 'line' && x.path.length === 3 && x.path[1] === l.path[1]);
      expect(kids.reduce((s: InstanceType<typeof Decimal>, k: { cells: string[] }) => s.plus(k.cells[0]!), new Decimal(0)).toFixed(4)).toBe(new Decimal(l.cells[0]).toFixed(4));
    }
  });

  it('expansion: level-1 only until opened; defaultExpanded with collapsed; expandAll', async () => {
    const d = starter('sales_by_client');
    const s = d.nodes[0] as { display: string; groupBy: Array<{ key: string }>; defaultExpanded: boolean };
    s.display = 'expandable';
    s.groupBy = [{ key: 'contact' }, { key: 'txn_type' }];
    const dates = { from: '2026-01-01', to: '2026-12-31' };
    const closed = await run(d, { dates });
    const l1 = closed.json.rows.filter((x: { kind: string }) => x.kind === 'line');
    expect(l1.every((x: { path: string[]; expandable: boolean; expanded: boolean }) => x.path.length === 2 && x.expandable && !x.expanded)).toBe(true);
    const opened = await run(d, { dates, open: [l1[0].path] });
    expect(opened.json.rows.some((x: { path: string[] }) => x.path.length === 3)).toBe(true);
    sample('expandable_open', { definition: '<sales_by_client, expandable, contact > txn_type>', dates, open: ['<a level-1 path>'] }, scrub(opened.json));
    s.defaultExpanded = true;
    const dflt = await run(d, { dates });
    expect(dflt.json.rows.some((x: { path: string[] }) => x.path.length === 3)).toBe(true);
    const coll = await run(d, { dates, collapsed: l1.map((x: { path: string[] }) => x.path) });
    expect(coll.json.rows.some((x: { path: string[] }) => x.path.length === 3)).toBe(false);
    s.defaultExpanded = false;
    const all = await run(d, { dates, expandAll: true });
    expect(all.json.rows.filter((x: { path: string[] }) => x.path.length === 3).length).toBeGreaterThan(0);
    // Paths are capped at 1,000.
    const many = await run(d, { dates, open: Array.from({ length: 1001 }, () => ['n:sales']) });
    expect(many.status).toBe(400);
  });

  it('periods: 36 accepted, 37 refused; compare gives $ and % change', async () => {
    const months = (n: number) => Array.from({ length: n }, (_, i) => {
      const y = 2024 + Math.floor(i / 12), m = (i % 12) + 1;
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${last}` };
    });
    const d = starter('profit_loss_by_month');
    const ok = await run(d, { dates: { from: '2024-01-01', to: '2026-12-31' }, periodRanges: months(36), fiscalYearStarts: ['2024-01-01', '2025-01-01', '2026-01-01'] });
    expect(ok.status, JSON.stringify(ok.json).slice(0, 300)).toBe(200);
    expect(ok.json.columns.filter((col: { kind: string }) => col.kind === 'period')).toHaveLength(36);
    const bad = await run(d, { dates: { from: '2024-01-01', to: '2027-01-31' }, periodRanges: [...months(36), { from: '2027-01-01', to: '2027-01-31' }] });
    expect(bad.status).toBe(400);
    const cmp = starter('profit_loss');
    cmp.columns.compare = [{ base: 'prior_year', amount: true, dollarChange: true, percentChange: true }];
    const r = await run(cmp, { dates: { from: '2026-01-01', to: '2026-12-31' } });
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    sample('profit_loss_compare_prior_year', { definition: '<profit_loss + compare prior_year>', dates: { from: '2026-01-01', to: '2026-12-31' } }, scrub(r.json));
    expect(r.json.columns.map((col: { kind: string }) => col.kind)).toEqual(['total', 'prior', 'change', 'pct_change']);
    const inc = totalRow(r.json.rows, 'income');
    expect(new Decimal(inc.cells[2]!).toFixed(4)).toBe(new Decimal(inc.cells[0]!).minus(inc.cells[1]!).toFixed(4));
  });

  it('409 RUN_CHANGED: params, then books after a posting', async () => {
    const d = starter('transaction_detail_by_account');
    const dates = { from: '2026-01-01', to: '2026-12-31' };
    const r = await run(d, { dates });
    const line = r.json.rows.find((x: { kind: string }) => x.kind === 'line');
    const base = { definition: d, dates, fiscalYearStarts: FY, nodeId: line.nodeId, path: line.path, stamp: r.json.stamp };
    const p = await call('POST', '/run/detail', { ...base, fingerprint: '0'.repeat(64) });
    expect(p.json.error).toMatchObject({ code: 'RUN_CHANGED', details: { reason: 'params' } });
    await post('expense', '2026-04-01', [{ accountId: c.expense, debit: '1.00', credit: '0' }, { accountId: c.bank, debit: '0', credit: '1.00' }]);
    const b = await call('POST', '/run/detail', { ...base, fingerprint: r.json.fingerprint });
    expect(b.status).toBe(409);
    expect(b.json.error).toMatchObject({ code: 'RUN_CHANGED', details: { reason: 'books' } });
  });

  it('a role without bills sees a denied row for purchases; formulas over it show null; /run/detail is 403', async () => {
    const [u] = await db.insert(users).values({ tenantId: c.tenantId, email: `rb-bk-${suffix()}@example.com`, passwordHash: 'x', displayName: 'BK', role: 'bookkeeper' }).returning();
    await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper' });
    await db.insert(userPermissions).values({ tenantId: c.tenantId, userId: u!.id, overrides: { bills: 'none', reports: 'view', invoices: 'view' } as never });
    const token = (await authService.issueSession({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
    const d = starter('sales_by_client');
    d.nodes.push(
      { type: 'section', id: 'purch', caption: 'Purchases', source: 'purchases', measure: 'amount', filters: [], groupBy: [{ key: 'contact' }], display: 'summary', defaultExpanded: false, showTotal: true, hideZero: true },
      { type: 'formula', id: 'net', caption: 'Net', terms: [{ nodeId: 'sales', sign: 1 }, { nodeId: 'purch', sign: -1 }] },
    );
    const dates = { from: '2026-01-01', to: '2026-12-31' };
    const r = await run(d, { dates }, token);
    expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
    sample('denied_section', { definition: '<sales_by_client + purchases + formula>', dates, role: 'no bills' }, scrub(r.json));
    expect(r.json.meta.denied).toEqual(['purch']);
    expect(r.json.rows.find((x: { kind: string }) => x.kind === 'denied')).toMatchObject({ nodeId: 'purch', caption: 'Your role can\'t see this part of the report' });
    expect(r.json.rows.find((x: { kind: string }) => x.kind === 'formula').cells.every((x: unknown) => x === null)).toBe(true);
    const det = await call('POST', '/run/detail', { definition: d, dates, fiscalYearStarts: FY, nodeId: 'purch', path: ['n:purch', 'contact:none'], fingerprint: r.json.fingerprint, stamp: r.json.stamp }, token);
    expect(det.status).toBe(403);
  });

  it('the deadline cancels a long statement: 503 REPORT_TIMEOUT', async () => {
    await expect(inSnapshot((exec) => exec.execute(sql`SELECT pg_sleep(2)`), { deadlineMs: 300 })).rejects.toMatchObject({ statusCode: 503, code: 'REPORT_TIMEOUT' });
    // A client that goes away cancels the backend.
    const ac = new AbortController();
    const p = inSnapshot((exec) => exec.execute(sql`SELECT pg_sleep(5)`), { signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    await expect(p).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it('GET /fields returns the catalogue', async () => {
    const r = await call('GET', '/fields');
    expect(r.status).toBe(200);
    expect(Object.keys(r.json.sources)).toContain('ar_open');
  });
});
