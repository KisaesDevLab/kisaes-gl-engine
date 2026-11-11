// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Exact budgets and Budget vs. Actual (U-203, budgets-exact-v1; ClientLedger
// P28 PR-C). Guards:
//   - the hand fixture __fixtures__/bva_hand.json (shared with the desktop):
//     every cell on accrual and cash basis and under tag split, 4-4-5
//     ranges, an account with activity and no budget, a budget with no
//     activity, two accounts with the same name, another company's entry;
//   - each actual cell equals the P&L column (period_ranges) and its GL
//     drill (netChangeExact);
//   - company scope: another company's budget is 404, a budget saved
//     before budgets had a company is visible to every company;
//   - version: writes bump it, a stale version is 409 STALE_VERSION
//     {current}, no version = last write wins; Idempotency-Key replays;
//   - PUT lines validation (BUDGET_LINE_INVALID): 3 places, a Balance
//     Sheet account, an unknown period key; "100.5000" is accepted;
//   - fill from actuals and adjust % round each cell to the cent, half
//     away from zero, in Decimal;
//   - errors on vs-actual; without exact=1 the legacy shape is unchanged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo, Server } from 'net';
import { and, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import { accounts, budgetLines, budgets, companies, contacts, tagGroups, tags } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { budgetsRouter } from './budgets.routes.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { cleanTenant } from '../services/templates/templates.test-helpers.js';

const Decimal = (DecimalLib.default || DecimalLib).clone({ precision: 80 });
const D = (x: unknown) => new Decimal(String(x ?? 0));

type Cells = { actual: Array<string | null>; budget: Array<string | null>; over?: Array<string | null>; pct?: Array<string | null> };
interface Fixture {
  fiscalYearStart: string;
  accounts: Array<{ number: string; name: string; type: string; detailType: string; parent?: string }>;
  tagGroups: Array<{ name: string; tags: Array<{ key: string; name: string; number: string }> }>;
  budget: { name: string; fiscalYear: number; lines: Record<string, string[]> };
  entries: Array<{ date: string; txnType?: string; company?: string; total?: string; lines: Array<{ account: string; debit?: string; credit?: string; tag?: string }> }>;
  request: { periodRanges: string[]; firstPeriod: number };
  expected: {
    accrual: { rows: Record<string, Cells>; rollups: Record<string, Cells>; parents: Record<string, string>; totals: Record<string, Cells> };
    cash: { rows: Record<string, Cells>; totals: Record<string, Cells> };
    tagSplit: { group: string; rows: Array<{ account: string; rowKind: string; tag: string | null; actual: Array<string | null>; budget: Array<string | null> }> };
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(resolve(here, '__fixtures__/bva_hand.json'), 'utf8')) as Fixture;

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let companyId = '';
let otherCompanyId = '';
let budgetId = '';
const acct: Record<string, string> = {};
const tagIds: Record<string, string> = {};
const groupIds: Record<string, string> = {};

function call(method: string, path: string, body?: unknown, opts: { co?: string; key?: string } = {}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((res, rej) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      method, hostname: '127.0.0.1', port, path: `/api/v1${path}`,
      headers: {
        Authorization: `Bearer ${token}`, 'X-Company-Id': opts.co ?? companyId,
        ...(opts.key ? { 'Idempotency-Key': opts.key } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* not json */ }
        res({ status: resp.statusCode!, body: parsed, headers: resp.headers });
      });
    });
    r.on('error', rej);
    if (payload) r.write(payload);
    r.end();
  });
}
const get = (path: string, opts: { co?: string } = {}) => call('GET', path, undefined, opts);

const linesBody = (lines: Record<string, string[]>) => Object.entries(lines).map(([num, cells]) => ({
  accountId: acct[num]!, ...Object.fromEntries(cells.map((c, i) => [`month${i + 1}`, c])),
}));

async function cleanup() {
  if (!tenantId) return;
  const ids = (await db.select({ id: budgets.id }).from(budgets).where(eq(budgets.tenantId, tenantId))).map((r) => r.id);
  if (ids.length) await db.delete(budgetLines).where(inArray(budgetLines.budgetId, ids));
  await db.delete(budgets).where(eq(budgets.tenantId, tenantId));
  await db.execute(sql`DELETE FROM idempotency_keys WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM payment_applications WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM transaction_tags WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM journal_lines WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM transactions WHERE tenant_id = ${tenantId}`);
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(tagGroups).where(eq(tagGroups.tenantId, tenantId));
  await cleanTenant(tenantId);
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/budgets', budgetsRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((done) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; done(); }); });

  const reg = await authService.register({
    email: `bva-${Date.now()}@example.com`, password: 'password123456', displayName: 'BvA Test', companyName: 'BvA Co',
  });
  token = reg.tokens.accessToken;
  tenantId = reg.user.tenantId;
  const [co] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  companyId = co!.id;
  await db.update(companies).set({ fiscalYearStartMonth: 1 } as never).where(eq(companies.id, companyId));
  const [other] = await db.insert(companies).values({ tenantId, businessName: 'BvA Other Co', setupComplete: true } as never).returning();
  otherCompanyId = other!.id;

  for (const a of FX.accounts) {
    const [row] = await db.insert(accounts).values({
      tenantId, name: a.name, accountNumber: a.number, accountType: a.type, detailType: a.detailType,
      ...(a.parent ? { parentId: acct[a.parent] } : {}),
    } as typeof accounts.$inferInsert).returning();
    acct[a.number] = row!.id;
  }
  for (const g of FX.tagGroups) {
    const [grp] = await db.insert(tagGroups).values({ tenantId, name: g.name }).returning();
    groupIds[g.name] = grp!.id;
    for (const [i, t] of g.tags.entries()) {
      const [tag] = await db.insert(tags).values({ tenantId, groupId: grp!.id, name: t.name, tagNumber: t.number, sortOrder: i + 1 }).returning();
      tagIds[t.key] = tag!.id;
    }
  }
  const [client] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'BvA Client' } as typeof contacts.$inferInsert).returning();

  for (const e of FX.entries) {
    await ledger.postTransaction(tenantId, {
      txnType: e.txnType ?? 'journal_entry', txnDate: e.date, memo: 'bva fixture',
      ...(e.txnType === 'invoice' ? { contactId: client!.id, total: e.total } : {}),
      lines: e.lines.map((l) => ({
        accountId: acct[l.account]!, debit: l.debit ?? '0', credit: l.credit ?? '0', tagId: l.tag ? tagIds[l.tag]! : null,
      })),
    } as Parameters<typeof ledger.postTransaction>[1], undefined, e.company === 'other' ? otherCompanyId : companyId);
  }

  const created = await call('POST', '/budgets', { name: FX.budget.name, fiscalYear: FX.budget.fiscalYear });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  budgetId = created.body.budget.id;
  expect(created.body.budget.companyId).toBe(companyId);
  expect(String(created.body.budget.fiscalYearStart).slice(0, 10)).toBe(FX.fiscalYearStart);
  const saved = await call('PUT', `/budgets/${budgetId}/lines`, { version: 1, lines: linesBody(FX.budget.lines) });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
}, 120000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanup();
});

const RANGES = () => FX.request.periodRanges.join(',');
const bva = (extra = '') => get(`/budgets/${budgetId}/vs-actual?exact=1&period_ranges=${RANGES()}&first_period=${FX.request.firstPeriod}${extra}`);
const SECTIONS = ['revenue', 'cogs', 'expenses', 'otherRevenue', 'otherExpenses'] as const;
const allRows = (body: any): any[] => SECTIONS.flatMap((s) => body[s] as any[]);
const numberOf = (id: string) => Object.entries(acct).find(([, v]) => v === id)?.[0];

/** Compares engine cells with expected values by decimal value (null = null). */
function expectCells(cells: any[], exp: Cells, label: string) {
  const eq = (got: string | null, want: string | null, what: string, i: number) => {
    if (want === null) expect(got, `${label} ${what}[${i}]`).toBeNull();
    else {
      expect(got, `${label} ${what}[${i}]`).not.toBeNull();
      expect(D(got).eq(D(want)), `${label} ${what}[${i}] ${got} != ${want}`).toBe(true);
    }
  };
  expect(cells.length, label).toBe(exp.actual.length);
  cells.forEach((c, i) => {
    eq(c.actualExact, exp.actual[i]!, 'actual', i);
    eq(c.budgetExact, exp.budget[i]!, 'budget', i);
    if (exp.over) eq(c.overExact, exp.over[i]!, 'over', i);
    // Percents are compared as the exact 1-place strings.
    if (exp.pct) expect(c.pctOfBudgetExact, `${label} pct[${i}]`).toBe(exp.pct[i]);
  });
}

describe('budgets-exact-v1 (U-203)', () => {
  it('is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('budgets-exact-v1');
  });

  it('matches the hand fixture on accrual basis (4-4-5 ranges)', async () => {
    const r = await bva();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const b = r.body;
    expect(b.layout).toBe('budget_vs_actual');
    expect(b.columns.map((c: any) => c.key)).toEqual(['p0', 'p1', 'p2', 'total']);
    expect(b.columns.map((c: any) => c.periodIndex)).toEqual([1, 2, 3, null]);
    expect(b.columns[3]).toMatchObject({ from: '2026-01-01', to: '2026-04-01', drill: { start_date: '2026-01-01', end_date: '2026-04-01' } });
    expect(b.meta).toMatchObject({ exact: true, basis: 'accrual', from: '2026-01-01', to: '2026-04-01' });
    expect(b.budget).toMatchObject({ id: budgetId, version: 2, fiscalYearStart: FX.fiscalYearStart });

    const rows = allRows(b);
    // Exactly the fixture accounts: budgeted or with activity (the default chart has neither).
    expect(rows.map((x) => numberOf(x.accountId)).sort()).toEqual(Object.keys(FX.expected.accrual.rows).sort());
    for (const [num, exp] of Object.entries(FX.expected.accrual.rows)) {
      const row = rows.find((x) => x.accountId === acct[num]);
      expect(row, num).toBeDefined();
      expect(row.rowKind).toBe('account');
      expectCells(row.cells, exp, num);
      expect(row.drill).toEqual({ account_ids: acct[num] });
    }
    for (const [num, exp] of Object.entries(FX.expected.accrual.rollups)) {
      expectCells(rows.find((x) => x.accountId === acct[num]).rollupCells, exp, `rollup ${num}`);
    }
    for (const [child, parent] of Object.entries(FX.expected.accrual.parents)) {
      const row = rows.find((x) => x.accountId === acct[child]);
      expect(row.parentAccountId).toBe(acct[parent]);
      expect(row.depth).toBe(1);
    }
    // Two accounts named "Rent" stay apart.
    expect(rows.filter((x) => x.name === 'Rent')).toHaveLength(2);
    for (const [key, exp] of Object.entries(FX.expected.accrual.totals)) expectCells(b.totalsExact[key], exp, key);
  });

  it('matches the hand fixture on cash basis', async () => {
    const r = await bva('&basis=cash');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.meta.basis).toBe('cash');
    expect(r.body.meta.cashBasisRules).toEqual(expect.any(String));
    const rows = allRows(r.body);
    for (const [num, exp] of Object.entries(FX.expected.cash.rows)) expectCells(rows.find((x) => x.accountId === acct[num]).cells, exp, `cash ${num}`);
    for (const [key, exp] of Object.entries(FX.expected.cash.totals)) expectCells(r.body.totalsExact[key], exp, `cash ${key}`);
    expect(r.body.drillTarget.params).toMatchObject({ basis: 'cash', adjusting: 'include' });
  });

  it('tag split: untagged + tags = account_total; budget only on account_total', async () => {
    const r = await bva(`&tag_split=1&tag_group_id=${groupIds[FX.expected.tagSplit.group]}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = allRows(r.body);
    for (const exp of FX.expected.tagSplit.rows) {
      const row = rows.find((x) => x.accountId === acct[exp.account] && x.rowKind === exp.rowKind && (x.tagId ?? null) === (exp.tag ? tagIds[exp.tag] : null));
      expect(row, `${exp.account} ${exp.rowKind} ${exp.tag}`).toBeDefined();
      expectCells(row.cells, { actual: exp.actual, budget: exp.budget }, `${exp.account} ${exp.rowKind} ${exp.tag}`);
    }
    // Identity for every account: untagged + tags = account_total, per column.
    const byAccount = new Map<string, any[]>();
    for (const x of rows) byAccount.set(x.accountId, [...(byAccount.get(x.accountId) ?? []), x]);
    for (const [id, group] of byAccount) {
      const total = group.find((x) => x.rowKind === 'account_total');
      const parts = group.filter((x) => x.rowKind !== 'account_total');
      total.cells.forEach((c: any, i: number) => {
        const sum = parts.reduce((s, p) => s.plus(D(p.cells[i].actualExact)), D(0));
        expect(sum.eq(D(c.actualExact)), `${numberOf(id)} col ${i}`).toBe(true);
      });
    }
    // Section totals are unchanged by the split.
    const plain = await bva();
    expect(r.body.totalsExact).toEqual(plain.body.totalsExact);
  });

  it('every actual cell equals the P&L column and its General Ledger drill', async () => {
    const b = (await bva()).body;
    const pl = (await get(`/reports/profit-loss?exact=1&period_ranges=${RANGES()}`)).body;
    expect(pl.layout).toBe('columns');
    const plRows = SECTIONS.flatMap((s) => pl[s] as any[]);
    for (const row of allRows(b)) {
      const plRow = plRows.find((x) => x.accountId === row.accountId);
      for (let i = 0; i < 4; i++) {
        const plVal = plRow ? D(plRow.valuesExact[i]) : D(0);
        expect(plVal.eq(D(row.cells[i].actualExact)), `${row.name} col ${i}`).toBe(true);
      }
    }
    // Drill a few cells to the GL (drillTarget.params + column.drill + row.drill).
    for (const num of ['4000', '6300', '6100']) {
      const row = allRows(b).find((x) => x.accountId === acct[num]);
      for (const ci of [0, 1, 3]) {
        const params = { ...b.drillTarget.params, ...b.columns[ci].drill, ...row.drill, exact: '1' };
        const q = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
        const gl = (await get(`/reports/general-ledger?${q}`)).body;
        const a = (gl.accounts as any[]).find((x) => x.id === acct[num]);
        expect(D(a?.netChangeExact ?? 0).eq(D(row.cells[ci].actualExact)), `${num} col ${ci}`).toBe(true);
      }
    }
  });

  it('company scope: another company\'s budget is 404; a budget without a company is visible to all', async () => {
    const otherBudget = await call('POST', '/budgets', { name: 'Other FY2027', fiscalYear: 2027 }, { co: otherCompanyId });
    expect(otherBudget.status).toBe(201);
    expect(otherBudget.body.budget.companyId).toBe(otherCompanyId);
    const id = otherBudget.body.budget.id;
    expect((await get(`/budgets/${id}`)).status).toBe(404);
    expect((await get(`/budgets/${id}/lines`)).status).toBe(404);
    expect((await get(`/budgets/${id}/vs-actual?exact=1`)).status).toBe(404);
    expect((await call('PUT', `/budgets/${id}/lines`, { lines: [] })).status).toBe(404);
    expect((await call('PUT', `/budgets/${id}`, { name: 'x' })).status).toBe(404);
    const list = (await get('/budgets')).body.budgets.map((x: any) => x.id);
    expect(list).toContain(budgetId);
    expect(list).not.toContain(id);
    expect((await get('/budgets', { co: otherCompanyId })).body.budgets.map((x: any) => x.id)).toEqual([id]);

    // A budget saved before budgets had a company (MyBooks Online's so far).
    const [legacy] = await db.insert(budgets).values({ tenantId, name: 'Legacy 2028', fiscalYear: 2028, fiscalYearStart: '2028-01-01' }).returning();
    expect((await get(`/budgets/${legacy!.id}`)).status).toBe(200);
    expect((await get(`/budgets/${legacy!.id}`, { co: otherCompanyId })).status).toBe(200);
    // Its actuals are the requesting company's: the other company's 999.99 counts only there.
    const ranges = 'period_ranges=2026-01-29..2026-02-25&first_period=2';
    await db.update(budgets).set({ fiscalYear: 2029, fiscalYearStart: '2026-01-01' }).where(eq(budgets.id, legacy!.id));
    const mine = (await get(`/budgets/${legacy!.id}/vs-actual?exact=1&${ranges}`)).body;
    const theirs = (await get(`/budgets/${legacy!.id}/vs-actual?exact=1&${ranges}`, { co: otherCompanyId })).body;
    const all = (await get(`/budgets/${legacy!.id}/vs-actual?exact=1&${ranges}&scope=consolidated`)).body;
    const sales = (b: any) => D(b.revenue.find((x: any) => x.accountId === acct['4000'])?.cells[0].actualExact ?? 0);
    expect(sales(mine).eq(D('900'))).toBe(true);
    expect(sales(theirs).eq(D('999.99'))).toBe(true);
    expect(sales(all).eq(D('1899.99'))).toBe(true);
    expect(all.drillTarget.params.scope).toBe('consolidated');
  });

  it('version: writes bump it, a stale version is 409, no version is last write wins; Idempotency-Key replays', async () => {
    const c = await call('POST', '/budgets', { name: 'Versioned 2030', fiscalYear: 2030 });
    const id = c.body.budget.id;
    expect(c.body.budget.version).toBe(1);
    const line = (v: string) => [{ accountId: acct['6000'], month1: v }];

    const ok = await call('PUT', `/budgets/${id}/lines`, { version: 1, lines: line('10.00') });
    expect(ok.status).toBe(200);
    expect(ok.body.version).toBe(2);
    expect(ok.body.lines[0]).toMatchObject({ account_id: acct['6000'], totalExact: '10.0000' });
    expect(ok.body.lines[0].periodsExact).toHaveLength(12);
    expect(ok.body.totalsExact.expenses.totalExact).toBe('10.0000');
    expect(ok.body.totalsExact.netIncome.periodsExact[0]).toBe('-10.0000');

    const staleLines = await call('PUT', `/budgets/${id}/lines`, { version: 1, lines: line('20.00') });
    expect(staleLines.status).toBe(409);
    expect(staleLines.body.error).toMatchObject({ code: 'STALE_VERSION', details: { current: 2 } });
    const stalePut = await call('PUT', `/budgets/${id}`, { version: 1, name: 'x' });
    expect(stalePut.status).toBe(409);
    expect(stalePut.body.error.code).toBe('STALE_VERSION');

    const renamed = await call('PUT', `/budgets/${id}`, { version: 2, name: 'Versioned renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.budget.version).toBe(3);
    const legacyWrite = await call('PUT', `/budgets/${id}/lines`, { lines: line('30.00') });
    expect(legacyWrite.status).toBe(200);
    expect(legacyWrite.body.version).toBe(4);

    // Idempotency-Key: the retry replays and the version moves once.
    const key = `bva-idem-${Date.now()}`;
    const first = await call('PUT', `/budgets/${id}/lines`, { version: 4, lines: line('40.00') }, { key });
    const again = await call('PUT', `/budgets/${id}/lines`, { version: 4, lines: line('40.00') }, { key });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect((await get(`/budgets/${id}`)).body.budget.version).toBe(5);
    for (const op of ['fill-from-actuals', 'adjust-by-percent', `copy-from/${budgetId}`]) {
      const body = op === 'adjust-by-percent' ? { version: 1, percent: '5' } : { version: 1 };
      const r = await call('POST', `/budgets/${id}/${op}`, body);
      expect(r.status, op).toBe(409);
      expect(r.body.error.code).toBe('STALE_VERSION');
    }
  });

  it('PUT lines is validated: BUDGET_LINE_INVALID', async () => {
    const c = await call('POST', '/budgets', { name: 'Validated 2031', fiscalYear: 2031 });
    const id = c.body.budget.id;
    const put = (lines: unknown) => call('PUT', `/budgets/${id}/lines`, { lines });
    const bad = async (lines: unknown, field: string) => {
      const r = await put(lines);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body.error.code).toBe('BUDGET_LINE_INVALID');
      expect(r.body.error.details.field).toBe(field);
    };
    await bad([{ accountId: acct['6000'], month1: '10.005' }], 'month1');
    await bad([{ accountId: acct['6000'], month2: 'ten' }], 'month2');
    await bad([{ accountId: acct['6000'], month13: '1.00' }], 'month13');
    await bad([{ accountId: acct['1000'], month1: '1.00' }], 'accountId');
    await bad([{ accountId: acct['6000'] }, { accountId: acct['6000'] }], 'accountId');
    await bad([{ accountId: 'nope' }], 'accountId');
    // Nothing was written by the refused requests.
    expect((await get(`/budgets/${id}/lines`)).body.lines).toEqual([]);
    expect((await get(`/budgets/${id}`)).body.budget.version).toBe(1);
    // Trailing zeros are fine (stored cells read back at 4 places); numbers too.
    const ok = await put([{ accountId: acct['6000'], month1: '100.5000', month2: 12.5, month3: '-3.10' }]);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.lines[0].periodsExact.slice(0, 3)).toEqual(['100.5000', '12.5000', '-3.1000']);
  });

  it('fill from actuals and adjust % round each cell to the cent, half away from zero', async () => {
    // Prior-year activity at 4 places for a FY2032 budget (actuals from 2031).
    const post = (date: string, account: string, amount: string, debitAccount = true) => ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: date, memo: 'fill',
      lines: debitAccount
        ? [{ accountId: acct[account]!, debit: amount, credit: '0', tagId: null }, { accountId: acct['1000']!, debit: '0', credit: amount, tagId: null }]
        : [{ accountId: acct['1000']!, debit: amount, credit: '0', tagId: null }, { accountId: acct[account]!, debit: '0', credit: amount, tagId: null }],
    } as Parameters<typeof ledger.postTransaction>[1], undefined, companyId);
    await post('2031-01-10', '6100', '10.0050');
    await post('2031-01-11', '6100', '0.0025');
    await post('2031-02-10', '6100', '20.0049');
    await post('2031-03-10', '4000', '100.1250', false);
    await post('2031-03-11', '6200', '5.0050');
    await post('2031-03-12', '6200', '10.0100', false);
    const c = await call('POST', '/budgets', { name: 'Filled 2032', fiscalYear: 2032 });
    const id = c.body.budget.id;
    const filled = await call('POST', `/budgets/${id}/fill-from-actuals`, { version: 1 });
    expect(filled.status, JSON.stringify(filled.body)).toBe(200);
    expect(filled.body.version).toBe(2);
    const line = (body: any, num: string) => body.lines.find((l: any) => l.account_id === acct[num]);
    // 10.0050 + 0.0025 = 10.0075 -> 10.01; 20.0049 -> 20.00; income 100.1250 -> 100.13; 5.0050 - 10.0100 = -5.0050 -> -5.01.
    expect(line(filled.body, '6100').periodsExact.slice(0, 3)).toEqual(['10.0100', '20.0000', '0.0000']);
    expect(line(filled.body, '4000').periodsExact[2]).toBe('100.1300');
    expect(line(filled.body, '6200').periodsExact[2]).toBe('-5.0100');

    const set = await call('PUT', `/budgets/${id}/lines`, { lines: [{ accountId: acct['6000'], month1: '10.10', month2: '-10.10', month3: '0.01' }] });
    expect(set.status).toBe(200);
    const adj = await call('POST', `/budgets/${id}/adjust-by-percent`, { percent: '5' });
    expect(adj.status, JSON.stringify(adj.body)).toBe(200);
    // 10.10 x 1.05 = 10.605 -> 10.61 (binary floating point gives 10.60); -10.605 -> -10.61; 0.0105 -> 0.01.
    expect(line(adj.body, '6000').periodsExact.slice(0, 3)).toEqual(['10.6100', '-10.6100', '0.0100']);
    expect(line(adj.body, '6100').periodsExact[0]).toBe('10.5100'); // 10.01 x 1.05 = 10.5105
    const badPct = await call('POST', `/budgets/${id}/adjust-by-percent`, { percent: 'abc' });
    expect(badPct.status).toBe(400);
    expect((await call('POST', `/budgets/${id}/adjust-by-percent`, { percent: '-101' })).status).toBe(400);
  });

  it('vs-actual errors; without exact=1 the legacy response is unchanged', async () => {
    const err = async (q: string, param: string, status = 400) => {
      const r = await get(`/budgets/${budgetId}/vs-actual?${q}`);
      expect(r.status, `${q} ${JSON.stringify(r.body)}`).toBe(status);
      if (status === 400) expect(r.body.error.details.param).toBe(param);
    };
    await err(`exact=1&period_ranges=${RANGES()}&first_period=11`, 'period_ranges');
    await err('exact=1&first_period=2', 'first_period');
    await err('exact=1&first_period=13', 'first_period');
    await err('exact=1&start_date=2026-01-01', 'start_date');
    await err('exact=1&tag_split=1', 'tag_group_id');
    await err(`period_ranges=${RANGES()}`, 'period_ranges');
    await err('exact=1&period_ranges=2026-02-01..2026-01-01', 'period_ranges');
    await err(`exact=1&tag_split=1&tag_group_id=${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, '', 404);

    // A budget for one tag: actuals of that tag only; no tag split.
    const tagged = await call('POST', '/budgets', { name: 'East 2033', fiscalYear: 2033, tagId: tagIds['east'] });
    await db.update(budgets).set({ fiscalYearStart: '2026-01-01' }).where(and(eq(budgets.id, tagged.body.budget.id), eq(budgets.tenantId, tenantId)));
    const t = (await get(`/budgets/${tagged.body.budget.id}/vs-actual?exact=1&period_ranges=${RANGES()}`)).body;
    expect(t.revenue.find((x: any) => x.accountId === acct['4000']).cells[3].actualExact).toBe('1234.5600');
    expect(t.drillTarget.params.tag_id).toBe(tagIds['east']);
    const ts = await get(`/budgets/${tagged.body.budget.id}/vs-actual?exact=1&tag_split=1&tag_group_id=${groupIds['Region']}`);
    expect(ts.status).toBe(400);
    expect(ts.body.error.details.param).toBe('tag_split');

    // Default periods: the budget year's twelve calendar months.
    const d = (await get(`/budgets/${budgetId}/vs-actual?exact=1`)).body;
    expect(d.columns).toHaveLength(13);
    expect(d.columns[1]).toMatchObject({ from: '2026-02-01', to: '2026-02-28', periodIndex: 2, caption: 'Feb 2026' });

    const legacy = await get(`/budgets/${budgetId}/vs-actual?start_date=2026-01-01&end_date=2026-01-31`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.title).toBe('Budget vs Actual');
    expect(typeof legacy.body.netIncomeBudget).toBe('number');
    expect(legacy.body.meta).toBeUndefined();
  });
});
