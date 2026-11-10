// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Report columns, tag split and drill targets (U-201, U-202;
// reports-columns-v1, reports-drill-v1). Guards:
//   - period_ranges (4-4-5), Total, YTD and prior columns equal the
//     standalone exact P&L / Balance Sheet for the same dates;
//   - columns by client and by tag group partition the Total column, and
//     the Total equals the standalone report;
//   - tag split: untagged + tags = account_total = the unsplit amount, on
//     P&L, Balance Sheet, Trial Balance and General Ledger; a line tagged
//     in another group counts as untagged; section totals are unchanged;
//   - every P&L / Balance Sheet / Trial Balance cell with a drill sums to
//     exactly the cell on the General Ledger, on both bases;
//   - % of income and % change: 1 place, half away from zero, null on 0;
//   - the drill lens (client, accounts, tag incl. untagged, amount,
//     cleared, types) on the General Ledger, Transaction List and Journal;
//   - errors: 400 INVALID_PARAM / INVALID_DATE_RANGE, 404 tag group.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, pool } from '../db/index.js';
import {
  accounts, contacts, paymentApplications, reconciliationLines, reconciliations, tagGroups, tags,
} from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { percent1 } from '../services/report-exact.js';
import { priorRange, rangeCaption, shiftYear } from '../services/report-columns.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

const Decimal = (DecimalLib.default || DecimalLib).clone({ precision: 80 });
const D = (x: unknown) => new Decimal(String(x ?? 0));

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let companyId = '';
const ids: Record<string, string> = {};

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    recurring_schedules, budget_lines, budgets, vendor_1099_account_mappings,
    bank_feed_items, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    transactions, contacts, tags, tag_groups, api_keys, sessions,
    accounts, companies, users, tenants
    CASCADE`);
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  return new Promise<void>((done) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      done();
    });
  });
}

function request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((res, rej) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      method, hostname: '127.0.0.1', port, path: `/api/v1/reports${path}`,
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* not json */ }
        res({ status: resp.statusCode!, body: parsed });
      });
    });
    r.on('error', rej);
    if (payload) r.write(payload);
    r.end();
  });
}
const get = (path: string) => request('GET', path);
const qsOf = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function mkAccount(values: Partial<typeof accounts.$inferInsert> & { name: string; accountType: string }) {
  const [a] = await db.insert(accounts).values({ tenantId, ...values } as typeof accounts.$inferInsert).returning();
  return a!;
}
async function mkContact(name: string, type = 'customer') {
  const [c] = await db.insert(contacts).values({ tenantId, companyId, contactType: type, displayName: name } as typeof contacts.$inferInsert).returning();
  return c!.id;
}
type Line = { accountId: string; debit?: string; credit?: string; tagId?: string | null; contactId?: string | null };
const post = (txnType: string, date: string, lines: Line[], extra: Record<string, unknown> = {}) =>
  ledger.postTransaction(tenantId, {
    txnType, txnDate: date, memo: txnType, ...extra,
    lines: lines.map((l) => ({ debit: '0', credit: '0', tagId: null, ...l })),
  } as Parameters<typeof ledger.postTransaction>[1], undefined, companyId);

beforeAll(async () => {
  await cleanDb();
  await startApp();
  const result = await authService.register({
    email: `reports-columns-${Date.now()}@example.com`, password: 'password123456', displayName: 'Columns Test', companyName: 'Columns Co',
  });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;
  const company = await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.tenantId, tenantId) });
  companyId = company!.id;

  const checking = await mkAccount({ name: 'Cols Checking', accountNumber: '1010', accountType: 'asset', detailType: 'bank' });
  const ar = (await db.query.accounts.findFirst({ where: (a, { and, eq }) => and(eq(a.tenantId, tenantId), eq(a.systemTag, 'accounts_receivable')) }))
    ?? await mkAccount({ name: 'Accounts Receivable', accountNumber: '1200', accountType: 'asset', detailType: 'accounts_receivable', systemTag: 'accounts_receivable', isSystem: true });
  const loan = await mkAccount({ name: 'Cols Loan', accountNumber: '2500', accountType: 'liability', detailType: 'other_current_liabilities' });
  const salesParent = await mkAccount({ name: 'Cols Sales', accountNumber: '4100', accountType: 'revenue', detailType: 'sales_of_product_income' });
  const salesA = await mkAccount({ name: 'Cols Sales A', accountNumber: '4110', accountType: 'revenue', detailType: 'sales_of_product_income', parentId: salesParent.id });
  const salesB = await mkAccount({ name: 'Cols Sales B', accountNumber: '4200', accountType: 'revenue', detailType: 'sales_of_product_income' });
  const cogs = await mkAccount({ name: 'Cols COGS', accountNumber: '5000', accountType: 'cogs', detailType: 'supplies_materials_cogs' });
  const repairs = await mkAccount({ name: 'Cols Repairs', accountNumber: '6100', accountType: 'expense', detailType: 'repair_maintenance' });
  const rent = await mkAccount({ name: 'Cols Rent', accountNumber: '6200', accountType: 'expense', detailType: 'rent_or_lease_of_buildings' });
  Object.assign(ids, { checking: checking.id, ar: ar.id, loan: loan.id, salesParent: salesParent.id, salesA: salesA.id, salesB: salesB.id,
    cogs: cogs.id, repairs: repairs.id, rent: rent.id });

  const [region] = await db.insert(tagGroups).values({ tenantId, name: 'Region' }).returning();
  const [other] = await db.insert(tagGroups).values({ tenantId, name: 'Fund' }).returning();
  const [lake] = await db.insert(tags).values({ tenantId, groupId: region!.id, name: 'Lake Area', tagNumber: '10', sortOrder: 1 }).returning();
  const [hill] = await db.insert(tags).values({ tenantId, groupId: region!.id, name: 'Hill Area', tagNumber: '20', sortOrder: 2 }).returning();
  const [idle] = await db.insert(tags).values({ tenantId, groupId: region!.id, name: 'Idle Area', tagNumber: '30', sortOrder: 3 }).returning();
  const [grant] = await db.insert(tags).values({ tenantId, groupId: other!.id, name: 'Grant', tagNumber: '90' }).returning();
  Object.assign(ids, { region: region!.id, other: other!.id, lake: lake!.id, hill: hill!.id, idle: idle!.id, grant: grant!.id });

  const ann = await mkContact('Ann Client');
  const bob = await mkContact('Bob Client');
  const vic = await mkContact('Vic Vendor', 'vendor');
  Object.assign(ids, { ann, bob, vic });

  // Opening money (2025), so the Balance Sheet has prior-year equity.
  await post('journal_entry', '2025-06-01', [
    { accountId: checking.id, debit: '10000.00' }, { accountId: loan.id, credit: '6000.00' }, { accountId: salesB.id, credit: '4000.00', contactId: bob },
  ]);
  // 4-4-5 periods of 2026: Jan 1-28, Jan 29-Feb 25, Feb 26-Mar 31.
  // Sales with per-line clients and tags (one line tagged in another group).
  await post('journal_entry', '2026-01-10', [
    { accountId: checking.id, debit: '1000.00' },
    { accountId: salesA.id, credit: '600.00', tagId: lake!.id, contactId: ann },
    { accountId: salesA.id, credit: '300.00', tagId: grant!.id, contactId: bob },
    { accountId: salesB.id, credit: '100.00' },
  ]);
  await post('journal_entry', '2026-02-10', [
    { accountId: checking.id, debit: '2000.00' },
    { accountId: salesA.id, credit: '1500.00', tagId: hill!.id, contactId: ann },
    { accountId: salesB.id, credit: '500.00', tagId: lake!.id },
  ]);
  // A split expense: two repairs lines on one account, different tag and client.
  await post('expense', '2026-02-12', [
    { accountId: repairs.id, debit: '100.00', tagId: lake!.id, contactId: vic },
    { accountId: repairs.id, debit: '50.00', tagId: grant!.id },
    { accountId: repairs.id, debit: '25.00' },
    { accountId: checking.id, credit: '175.00' },
  ], { contactId: vic, total: '175.00' });
  await post('expense', '2026-03-05', [{ accountId: rent.id, debit: '12.50' }, { accountId: checking.id, credit: '12.50' }], { contactId: vic, total: '12.50' });
  await post('journal_entry', '2026-03-20', [{ accountId: cogs.id, debit: '300.00', tagId: hill!.id }, { accountId: checking.id, credit: '300.00' }]);
  // An adjusting entry.
  await post('journal_entry', '2026-03-31', [{ accountId: rent.id, debit: '7.25' }, { accountId: loan.id, credit: '7.25' }], { isAdjusting: true });
  // Cash basis: an invoice paid in part, so its tagged lines are recognised as shares.
  const invoice = await post('invoice', '2026-02-01', [
    { accountId: ar.id, debit: '1000.00' },
    { accountId: salesA.id, credit: '600.00', tagId: lake!.id },
    { accountId: salesB.id, credit: '400.00' },
  ], { contactId: bob, total: '1000.00' });
  const payment = await post('customer_payment', '2026-03-03', [
    { accountId: checking.id, debit: '333.33' }, { accountId: ar.id, credit: '333.33' },
  ], { contactId: bob, total: '333.33' });
  await db.insert(paymentApplications).values({ tenantId, paymentId: payment.id, invoiceId: invoice.id, amount: '333.33' });
  ids['payment'] = payment.id;

  // A reconciled and a cleared bank line.
  const bankLines = (await db.execute(sql`
    SELECT jl.id, t.txn_date FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${checking.id} ORDER BY t.txn_date
  `)).rows as Array<{ id: string }>;
  const [done] = await db.insert(reconciliations).values({ tenantId, companyId, accountId: checking.id, statementDate: '2026-01-31',
    statementEndingBalance: '0', beginningBalance: '0', status: 'complete' }).returning();
  const [open] = await db.insert(reconciliations).values({ tenantId, companyId, accountId: checking.id, statementDate: '2026-02-28',
    statementEndingBalance: '0', beginningBalance: '0', status: 'in_progress' }).returning();
  await db.insert(reconciliationLines).values([
    { reconciliationId: done!.id, journalLineId: bankLines[1]!.id, isCleared: true },
    { reconciliationId: open!.id, journalLineId: bankLines[2]!.id, isCleared: true },
  ]);
  ids['reconciledLine'] = bankLines[1]!.id;
  ids['clearedLine'] = bankLines[2]!.id;
}, 120000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

const RANGES = '2026-01-01..2026-01-28,2026-01-29..2026-02-25,2026-02-26..2026-03-31';
const PL_SECTIONS = ['revenue', 'cogs', 'expenses', 'otherRevenue', 'otherExpenses'] as const;
const BS_SECTIONS = ['assets', 'liabilities', 'equity'] as const;

/** Standalone exact P&L amount per account for a range. */
async function plAmounts(from: string, to: string, extra = ''): Promise<{ byAccount: Map<string, string>; body: any }> {
  const r = await get(`/profit-loss?start_date=${from}&end_date=${to}&exact=1${extra}`);
  expect(r.status).toBe(200);
  const m = new Map<string, string>();
  for (const s of PL_SECTIONS) for (const e of r.body[s]) m.set(e.accountId, e.amountExact);
  return { byAccount: m, body: r.body };
}

/** Tag split: in every column, the untagged row + tag rows = the account_total row. */
function checkSplitIdentity(report: any, sections: readonly string[]) {
  let blocks = 0;
  for (const s of sections) {
    const rows = report[s];
    for (const [i, row] of rows.entries()) {
      if (row.rowKind !== 'account') continue;
      let acc = report.columns.map((_: unknown, c: number) => D(row.valuesExact[c]));
      let j = i + 1;
      for (; rows[j]?.rowKind === 'tag'; j++) acc = acc.map((a: any, c: number) => a.plus(D(rows[j].valuesExact[c])));
      expect(rows[j]?.rowKind, `${s} ${row.name}`).toBe('account_total');
      report.columns.forEach((col: any, c: number) => {
        if (col.valueType === 'amount') expect(acc[c].eq(D(rows[j].valuesExact[c])), `${s} ${row.name} ${col.key}`).toBe(true);
      });
      blocks++;
    }
  }
  return blocks;
}

/** Every drillable cell of a column report sums to the cell on the General Ledger. */
async function checkDrills(report: any, sections: readonly string[], glAmount: 'netChangeExact' | 'endingBalanceExact', glStart?: string) {
  let checked = 0;
  for (const s of sections) {
    for (const row of report[s]) {
      if (!row.drill) continue;
      for (const [i, col] of report.columns.entries()) {
        if (!col.drill || col.valueType !== 'amount') continue;
        const params: Record<string, string> = { ...report.drillTarget.params, ...col.drill, ...row.drill, exact: '1' };
        if (glAmount === 'endingBalanceExact') params['start_date'] = glStart ?? '2026-01-01';
        const gl = await get(`/general-ledger?${qsOf(params)}`);
        expect(gl.status, JSON.stringify(gl.body)).toBe(200);
        const acct = gl.body.accounts.find((a: any) => a.id === row.accountId);
        const glValue = acct ? acct[glAmount] : '0';
        expect(D(glValue).eq(D(row.valuesExact[i])), `${s} ${row.name} ${row.rowKind} ${row.tagName ?? ''} / ${col.key}: GL ${glValue} vs ${row.valuesExact[i]}`).toBe(true);
        checked++;
      }
    }
  }
  return checked;
}

describe('reports-columns-v1 / reports-drill-v1 (U-201, U-202)', () => {
  it('is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('reports-columns-v1');
    expect(DESKTOP_CAPABILITIES).toContain('reports-drill-v1');
  });

  it('percents: 1 place, half away from zero, null on a zero base; date helpers', () => {
    expect(percent1('12.5', '1000')).toBe('1.3');
    expect(percent1('-12.5', '1000')).toBe('-1.3');
    expect(percent1('12.4', '1000')).toBe('1.2');
    expect(percent1('5', '0')).toBeNull();
    expect(priorRange({ from: '2026-01-29', to: '2026-02-25' }, 'period')).toEqual({ from: '2026-01-01', to: '2026-01-28' });
    expect(priorRange({ from: '2024-02-01', to: '2024-02-29' }, 'year')).toEqual({ from: '2023-02-01', to: '2023-02-28' });
    expect(shiftYear('2024-02-29', -1)).toBe('2023-02-28');
    expect(rangeCaption({ from: '2026-10-01', to: '2026-10-31' })).toBe('Oct 2026');
    expect(rangeCaption({ from: '2026-01-01', to: '2026-12-31' })).toBe('2026');
  });

  for (const basis of ['accrual', 'cash'] as const) {
    it(`P&L 4-4-5 periods, Total, YTD, prior year, % of income equal the standalone report and drill exactly (${basis})`, async () => {
      const r = await get(`/profit-loss?exact=1&basis=${basis}&period_ranges=${RANGES}&ytd=1&prior=year&pct_of_income=1`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const rep = r.body;
      expect(rep.layout).toBe('columns');
      expect(rep.columns.map((c: any) => c.key)).toEqual([
        'p0', 'p0_prior', 'p0_change', 'p0_pct_change', 'p1', 'p1_prior', 'p1_change', 'p1_pct_change',
        'p2', 'p2_prior', 'p2_change', 'p2_pct_change', 'total', 'ytd', 'ytd_prior', 'ytd_change', 'ytd_pct_change',
      ]);
      expect(rep.columns.find((c: any) => c.key === 'ytd')).toMatchObject({ from: '2026-01-01', to: '2026-03-31' });
      expect(rep.meta).toMatchObject({ exact: true, basis, from: '2026-01-01', to: '2026-03-31' });
      for (const [i, col] of rep.columns.entries()) {
        if (!['period', 'total', 'ytd', 'prior'].includes(col.kind)) continue;
        const { byAccount, body } = await plAmounts(col.from, col.to, `&basis=${basis}`);
        for (const s of PL_SECTIONS) {
          for (const row of rep[s]) expect(D(row.valuesExact[i]).eq(D(byAccount.get(row.accountId) ?? '0')), `${row.name} ${col.key}`).toBe(true);
        }
        expect(D(rep.totalsExact.netIncome[i]).eq(D(body.netIncomeExact))).toBe(true);
        expect(D(rep.totalsExact.totalRevenue[i]).eq(D(body.totalRevenueExact))).toBe(true);
      }
      // Total = sum of the periods, exactly.
      const t = rep.columns.findIndex((c: any) => c.key === 'total');
      const p = [0, 4, 8];
      for (const s of PL_SECTIONS) {
        for (const row of rep[s]) expect(D(row.valuesExact[t]).eq(p.reduce((a, i) => a.plus(D(row.valuesExact[i])), new Decimal(0)))).toBe(true);
      }
      // $ change and % change; prior year (2025) has no income in Jan, so % change and % of income are null there.
      const rentRow = rep.expenses.find((e: any) => e.accountId === ids['rent']);
      expect(rentRow.valuesExact[1]).toBe('0.0000');
      expect(rentRow.valuesExact[3]).toBeNull();
      expect(rep.pctOfIncomeTotalsExact.totalRevenue[0]).toBe('100.0');
      expect(rentRow.pctOfIncomeExact[1]).toBeNull();
      expect(rentRow.pctOfIncomeExact[2]).toBeNull();
      // Parents carry per-column rollups.
      const parent = rep.revenue.find((e: any) => e.accountId === ids['salesParent']);
      expect(parent.rollupValuesExact[t]).toBe(rep.revenue.find((e: any) => e.accountId === ids['salesA']).valuesExact[t]);
      expect(await checkDrills(rep, PL_SECTIONS, 'netChangeExact')).toBeGreaterThan(20);
    });
  }

  it('% of income rounds half away from zero at x.x5', async () => {
    // Jan 10: income 1000, no rent; Mar 5: rent 12.50, no income; Total: 12.50 / 1000 = 1.25% -> 1.3.
    const m = await get('/profit-loss?exact=1&period_ranges=2026-01-10..2026-01-10,2026-03-05..2026-03-05&pct_of_income=1');
    expect(m.status).toBe(200);
    expect(m.body.totalsExact.totalRevenue).toEqual(['1000.0000', '0.0000', '1000.0000']);
    const rent = m.body.expenses.find((e: any) => e.accountId === ids['rent']);
    expect(rent.valuesExact).toEqual(['0.0000', '12.5000', '12.5000']);
    expect(rent.pctOfIncomeExact).toEqual(['0.0', null, '1.3']);
    expect(m.body.pctOfIncomeTotalsExact.totalRevenue).toEqual(['100.0', null, '100.0']);
  });

  for (const basis of ['accrual', 'cash'] as const) {
    it(`P&L tag split: untagged + tags = account total = the unsplit amount; other-group tags count as untagged (${basis})`, async () => {
      const r = await get(`/profit-loss?exact=1&basis=${basis}&start_date=2026-01-01&end_date=2026-03-31&tag_split=1&tag_group_id=${ids['region']}&period_ranges=${RANGES}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const rep = r.body;
      const { byAccount } = await plAmounts('2026-01-01', '2026-03-31', `&basis=${basis}`);
      const total = rep.columns.findIndex((c: any) => c.key === 'total');
      for (const s of PL_SECTIONS) {
        const rows = rep[s];
        for (const [i, row] of rows.entries()) {
          if (row.rowKind !== 'account') continue;
          const block = [];
          for (let j = i + 1; j < rows.length && rows[j].accountId === row.accountId && rows[j].rowKind !== 'account'; j++) block.push(rows[j]);
          const tot = block.find((b: any) => b.rowKind === 'account_total');
          expect(tot).toBeTruthy();
          for (let c = 0; c < rep.columns.length; c++) {
            const parts = [row, ...block.filter((b: any) => b.rowKind === 'tag')].reduce((a: any, b: any) => a.plus(D(b.valuesExact[c])), new Decimal(0));
            expect(parts.eq(D(tot.valuesExact[c])), `${row.name} col ${c}`).toBe(true);
          }
          expect(D(tot.valuesExact[total]).eq(D(byAccount.get(row.accountId) ?? '0'))).toBe(true);
        }
      }
      if (basis === 'accrual') {
        const a = rep.revenue.filter((e: any) => e.accountId === ids['salesA']);
        // Lake 600 + Hill 1500 tagged; the 300 tagged Grant (another group) is untagged here.
        expect(a.find((e: any) => e.rowKind === 'account').valuesExact[total]).toBe('300.0000');
        expect(a.find((e: any) => e.tagId === ids['lake']).valuesExact[total]).toBe('1200.0000');
        expect(a.find((e: any) => e.tagId === ids['hill']).valuesExact[total]).toBe('1500.0000');
        expect(a.some((e: any) => e.tagId === ids['idle'])).toBe(false);
        expect(rep.tagSplit.tags.map((t: any) => t.tagNumber)).toEqual(['10', '20', '30']);
      }
      expect(checkSplitIdentity(rep, PL_SECTIONS)).toBeGreaterThan(4);
      // Section totals unchanged.
      const plain = await get(`/profit-loss?exact=1&basis=${basis}&period_ranges=${RANGES}`);
      expect(rep.totalsExact).toEqual(plain.body.totalsExact);
      expect(await checkDrills(rep, PL_SECTIONS, 'netChangeExact')).toBeGreaterThan(10);
    });
  }

  it('P&L by client: client columns, All others, No client partition the Total; drills tie out', async () => {
    const r = await get('/profit-loss?exact=1&start_date=2026-01-01&end_date=2026-03-31&compare=by_contact');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rep = r.body;
    const keys = rep.columns.map((c: any) => c.key);
    expect(keys).toEqual([`c:${ids['ann']}`, `c:${ids['bob']}`, `c:${ids['vic']}`, 'no_contact', 'total']);
    const { byAccount, body } = await plAmounts('2026-01-01', '2026-03-31');
    const t = keys.indexOf('total');
    for (const s of PL_SECTIONS) {
      for (const row of rep[s]) {
        const parts = row.valuesExact.slice(0, t).reduce((a: any, v: string) => a.plus(D(v)), new Decimal(0));
        expect(parts.eq(D(row.valuesExact[t]))).toBe(true);
        expect(D(row.valuesExact[t]).eq(D(byAccount.get(row.accountId) ?? '0'))).toBe(true);
      }
    }
    expect(D(rep.totalsExact.netIncome[t]).eq(D(body.netIncomeExact))).toBe(true);
    // Repairs: Vic's line 100 + the 50 and 25 lines inherit the expense's client Vic.
    const repairs = rep.expenses.find((e: any) => e.accountId === ids['repairs']);
    expect(repairs.valuesExact[keys.indexOf(`c:${ids['vic']}`)]).toBe('175.0000');
    expect(await checkDrills(rep, PL_SECTIONS, 'netChangeExact')).toBeGreaterThan(10);
  });

  it('P&L by client: more than 36 clients adds an engine-summed All others column that drills exactly', async () => {
    const many: string[] = [];
    for (let i = 0; i < 38; i++) many.push(await mkContact(`Zed ${String(i).padStart(2, '0')}`));
    const lines: Line[] = many.map((c, i) => ({ accountId: ids['salesB']!, credit: `${i + 1}.00`, contactId: c }));
    const sum = (38 * 39) / 2;
    await post('journal_entry', '2026-04-15', [{ accountId: ids['checking']!, debit: `${sum}.00` }, ...lines]);
    const r = await get('/profit-loss?exact=1&start_date=2026-04-01&end_date=2026-04-30&compare=by_contact');
    expect(r.status).toBe(200);
    const contactCols = r.body.columns.filter((c: any) => c.kind === 'contact');
    expect(contactCols.length).toBe(36);
    const others = r.body.columns.findIndex((c: any) => c.key === 'others');
    const salesB = r.body.revenue.find((e: any) => e.accountId === ids['salesB']);
    // The two smallest (1 + 2) fall into All others.
    expect(salesB.valuesExact[others]).toBe('3.0000');
    expect(await checkDrills(r.body, PL_SECTIONS, 'netChangeExact')).toBeGreaterThan(36);
  }, 60000);

  it('P&L by tag group: one column per tag with activity, No tag in group, Total', async () => {
    const r = await get(`/profit-loss?exact=1&start_date=2026-01-01&end_date=2026-03-31&compare=by_tag&tag_group_id=${ids['region']}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.columns.map((c: any) => c.key)).toEqual([`t:${ids['lake']}`, `t:${ids['hill']}`, 'no_tag', 'total']);
    for (const s of PL_SECTIONS) {
      for (const row of r.body[s]) {
        expect(D(row.valuesExact[0]).plus(D(row.valuesExact[1])).plus(D(row.valuesExact[2])).eq(D(row.valuesExact[3]))).toBe(true);
      }
    }
    expect(await checkDrills(r.body, PL_SECTIONS, 'netChangeExact')).toBeGreaterThan(10);
  });

  it('P&L tag_id=untagged: only lines without a tag', async () => {
    const r = await get('/profit-loss?exact=1&start_date=2026-01-01&end_date=2026-03-31&tag_id=untagged');
    expect(r.status).toBe(200);
    expect(r.body.revenue.find((e: any) => e.accountId === ids['salesB']).valuesExact[0]).toBe('500.0000');
    expect(r.body.revenue.find((e: any) => e.accountId === ids['salesA'])).toBeUndefined();
    expect(r.body.drillTarget.params.tag_id).toBe('untagged');
    expect(await checkDrills(r.body, PL_SECTIONS, 'netChangeExact')).toBeGreaterThan(2);
  });

  for (const basis of ['accrual', 'cash'] as const) {
    it(`Balance Sheet: as-of columns, prior year, tag split equal the standalone sheet and drill exactly (${basis})`, async () => {
      const r = await get(`/balance-sheet?exact=1&basis=${basis}&period_ranges=${RANGES}&prior=year&tag_split=1&tag_group_id=${ids['region']}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const rep = r.body;
      for (const [i, col] of rep.columns.entries()) {
        if (col.valueType !== 'amount' || col.kind === 'change') continue;
        const bs = (await get(`/balance-sheet?exact=1&basis=${basis}&as_of_date=${col.asOf}`)).body;
        const want = new Map<string, string>();
        for (const s of BS_SECTIONS) for (const e of bs[s]) want.set(e.accountId ?? e.name, e.balanceExact);
        for (const s of BS_SECTIONS) {
          for (const row of rep[s]) {
            if (row.rowKind !== 'account_total') continue;
            expect(D(row.valuesExact[i]).eq(D(want.get(row.accountId ?? row.name) ?? '0')), `${row.name} ${col.key}`).toBe(true);
          }
        }
        expect(D(rep.totalsExact.totalAssets[i]).eq(D(bs.totalAssetsExact))).toBe(true);
        expect(D(rep.totalsExact.totalEquity[i]).eq(D(bs.totalEquityExact))).toBe(true);
        expect(D(rep.totalsExact.totalLiabilitiesAndEquity[i]).eq(D(bs.totalLiabilitiesAndEquityExact))).toBe(true);
      }
      expect(checkSplitIdentity(rep, BS_SECTIONS)).toBeGreaterThan(3);
      // Calculated equity rows are flagged and have no drill.
      const calc = rep.equity.filter((e: any) => e.calculated === true);
      expect(calc.length).toBeGreaterThan(0);
      expect(calc.every((e: any) => e.drill === null)).toBe(true);
      expect(await checkDrills(rep, BS_SECTIONS, 'endingBalanceExact', '2020-01-01')).toBeGreaterThan(5);
    });
  }

  for (const basis of ['accrual', 'cash'] as const) {
    it(`Trial Balance tag split: untagged + tags = account total; drills tie to the GL ending balance (${basis})`, async () => {
      const plain = (await get(`/trial-balance?exact=1&basis=${basis}&start_date=2026-01-01&end_date=2026-03-31`)).body;
      const r = await get(`/trial-balance?exact=1&basis=${basis}&start_date=2026-01-01&end_date=2026-03-31&tag_split=1&tag_group_id=${ids['region']}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.totalDebitsExact).toBe(plain.totalDebitsExact);
      const rows = r.body.data;
      for (const [i, row] of rows.entries()) {
        if (row.rowKind !== 'account') continue;
        let acc = D(row.netExact);
        let j = i + 1;
        for (; rows[j]?.rowKind === 'tag'; j++) acc = acc.plus(D(rows[j].netExact));
        expect(rows[j].rowKind).toBe('account_total');
        expect(acc.eq(D(rows[j].netExact)), row.name).toBe(true);
        const orig = plain.data.find((p: any) => (p.accountId ?? p.name) === (row.accountId ?? row.name));
        expect(D(rows[j].netExact).eq(D(orig.netExact))).toBe(true);
      }
      const dt = r.body.drillTarget;
      let checked = 0;
      for (const row of rows) {
        if (!row.drill) continue;
        const gl = (await get(`/general-ledger?${qsOf({ ...dt.params, ...row.drill, start_date: dt.startDate, end_date: dt.endDate, exact: '1' })}`)).body;
        const acct = gl.accounts.find((a: any) => a.id === row.accountId);
        const natural = acct?.normalBalance === 'credit' ? D(row.netExact).neg() : D(row.netExact);
        expect(D(acct?.endingBalanceExact ?? 0).eq(natural), `${row.name} ${row.rowKind}`).toBe(true);
        checked++;
      }
      expect(checked).toBeGreaterThan(5);
    });
  }

  it('General Ledger tag split per account: untagged + tags = total activity', async () => {
    const r = await get(`/general-ledger?exact=1&start_date=2026-01-01&end_date=2026-03-31&tag_split=1&tag_group_id=${ids['region']}`);
    expect(r.status).toBe(200);
    for (const a of r.body.accounts) {
      const parts = a.tagSplit.filter((x: any) => x.rowKind !== 'account_total').reduce((s: any, x: any) => s.plus(D(x.netChangeExact)), new Decimal(0));
      const total = a.tagSplit.find((x: any) => x.rowKind === 'account_total');
      expect(parts.eq(D(total.netChangeExact))).toBe(true);
      expect(D(total.netChangeExact).eq(D(a.netChangeExact))).toBe(true);
    }
    const repairs = r.body.accounts.find((a: any) => a.id === ids['repairs']);
    expect(repairs.tagSplit.map((x: any) => [x.rowKind, x.tagNumber, x.netChangeExact])).toEqual([
      ['account', null, '75.0000'], ['tag', '10', '100.0000'], ['account_total', null, '175.0000'],
    ]);
  });

  it('drill lens on the General Ledger and Transaction List: client, accounts, tag, amount, cleared, types', async () => {
    const base = 'exact=1&start_date=2026-01-01&end_date=2026-03-31';
    const glNet = async (q: string, account: string) => {
      const r = await get(`/general-ledger?${base}&${q}`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.accounts.find((a: any) => a.id === account)?.netChangeExact ?? '0.0000';
    };
    expect(await glNet(`contact_id=${ids['ann']}`, ids['salesA']!)).toBe('2100.0000');
    expect(await glNet('contact_id=none', ids['salesB']!)).toBe('600.0000');
    expect(await glNet(`contact_id=others&exclude_contact_ids=${ids['ann']}`, ids['salesA']!)).toBe('900.0000');
    expect(await glNet('tag_id=untagged', ids['repairs']!)).toBe('25.0000');
    expect(await glNet(`tag_scope=untagged_in_group&tag_group_id=${ids['region']}`, ids['repairs']!)).toBe('75.0000');
    expect(await glNet('amount_min=50&amount_max=100', ids['repairs']!)).toBe('150.0000');
    expect(await glNet('txn_types=expense', ids['rent']!)).toBe('12.5000');
    expect(await glNet('adjusting=only', ids['rent']!)).toBe('7.2500');
    const cleared = await get(`/general-ledger?${base}&account_ids=${ids['checking']}&cleared=cleared`);
    expect(cleared.body.accounts[0].lines.map((l: any) => l.lineId)).toEqual([ids['clearedLine']]);
    const rec = await get(`/general-ledger?${base}&account_ids=${ids['checking']}&cleared=reconciled`);
    expect(rec.body.accounts[0].lines.map((l: any) => l.lineId)).toEqual([ids['reconciledLine']]);
    const un = await get(`/general-ledger?${base}&account_ids=${ids['checking']}&cleared=uncleared`);
    expect(un.body.accounts[0].lines.some((l: any) => l.lineId === ids['clearedLine'] || l.lineId === ids['reconciledLine'])).toBe(false);
    // Several accounts; the Transaction List ties out with the GL for the same lens.
    for (const q of [`account_ids=${ids['repairs']},${ids['rent']}`, `account_ids=${ids['salesA']}&contact_id=${ids['bob']}`, 'tag_id=untagged', `cleared=uncleared&account_ids=${ids['checking']}`]) {
      for (const basis of ['accrual', 'cash']) {
        const gl = (await get(`/general-ledger?${base}&basis=${basis}&${q}`)).body;
        const tl = (await get(`/transaction-list?${base}&basis=${basis}&${q}`)).body;
        expect(tl.data.length).toBe(gl.rowCount);
        const glNetAll = gl.accounts.reduce((s: any, a: any) => s.plus(D(a.periodDebitsExact)).minus(D(a.periodCreditsExact)), new Decimal(0));
        expect(D(tl.totalsExact.amount).eq(glNetAll), `${q} ${basis}`).toBe(true);
      }
    }
    // Cash basis: pass-through lines carry their journal line id; shares of the invoice carry none.
    const cash = (await get(`/transaction-list?${base}&basis=cash&account_ids=${ids['salesA']},${ids['checking']}`)).body;
    const pay = cash.data.filter((d: any) => d.id === ids['payment']);
    expect(pay.some((d: any) => d.accountId === ids['checking'] && d.lineId)).toBe(true);
    expect(pay.some((d: any) => d.accountId === ids['salesA'] && d.lineId === null)).toBe(true);
  });

  it('POST takes the same parameters as a JSON body (500 account ids)', async () => {
    const list = [ids['repairs']!, ids['rent']!, ...Array.from({ length: 498 }, () => randomUUID())];
    const r = await request('POST', '/general-ledger', { start_date: '2026-01-01', end_date: '2026-03-31', account_ids: list });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.accounts.map((a: any) => a.id).sort()).toEqual([ids['repairs'], ids['rent']].sort());
    const t = await request('POST', '/transaction-list', { start_date: '2026-01-01', end_date: '2026-03-31', account_ids: list.join(',') });
    expect(t.status).toBe(200);
    expect(t.body.data.length).toBe(r.body.rowCount);
    const tooMany = await request('POST', '/general-ledger', { account_ids: [...list, randomUUID()] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error?.details?.param ?? tooMany.body.details?.param).toBe('account_ids');
  });

  it('Journal: group_by=transaction, balanced entries, totals equal the GL', async () => {
    const gl = (await get('/general-ledger?exact=1&start_date=2026-01-01&end_date=2026-03-31')).body;
    const j = await get('/general-ledger?exact=1&start_date=2026-01-01&end_date=2026-03-31&group_by=transaction');
    expect(j.status).toBe(200);
    expect(j.body.title).toBe('Journal');
    expect(j.body.totalDebitsExact).toBe(gl.totalDebitsExact);
    expect(j.body.rowCount).toBe(gl.rowCount);
    for (const t of j.body.transactions) expect(t.totalDebitsExact).toBe(t.totalCreditsExact);
    const dates = j.body.transactions.map((t: any) => t.date);
    expect([...dates].sort()).toEqual(dates);
    const lim = await get('/general-ledger?exact=1&start_date=2026-01-01&end_date=2026-03-31&group_by=transaction&limit=3');
    expect(lim.body.truncated).toBe(true);
    expect(lim.body.transactions.reduce((n: number, t: any) => n + t.lines.length, 0)).toBe(3);
  });

  it('Sales by Client and by Item: adjusting lens, ids and a grand total', async () => {
    const r = await get('/sales-by-customer?exact=1&start_date=2026-01-01&end_date=2026-03-31&adjusting=exclude');
    expect(r.status).toBe(200);
    expect(r.body.grandTotalExact).toBe(r.body.totalsExact.total);
    expect(r.body.data.every((d: any) => 'contact_id' in d)).toBe(true);
    const i = await get('/sales-by-item?exact=1&start_date=2026-01-01&end_date=2026-03-31&adjusting=only');
    expect(i.status).toBe(200);
    expect(i.body.grandTotalExact).toBe('0.0000');
  });

  it('errors: 400 INVALID_PARAM / INVALID_DATE_RANGE, 404 tag group; new options need exact=1', async () => {
    const bad = async (path: string, param: string, code = 'INVALID_PARAM') => {
      const r = await get(path);
      expect(r.status, `${path} ${JSON.stringify(r.body)}`).toBe(400);
      const err = r.body.error ?? r.body;
      expect(err.code).toBe(code);
      expect(err.details?.param).toBe(param);
    };
    await bad('/profit-loss?period_ranges=2026-01-01..2026-01-31', 'period_ranges');
    await bad('/profit-loss?exact=1&period_ranges=2026-01-01..2026-02-10,2026-02-01..2026-02-28', 'period_ranges');
    await bad('/profit-loss?exact=1&period_ranges=2026-02-01..2026-01-01', 'period_ranges', 'INVALID_DATE_RANGE');
    await bad(`/profit-loss?exact=1&period_ranges=${Array.from({ length: 37 }, (_, i) => `${2000 + i}-01-01..${2000 + i}-01-02`).join(',')}`, 'period_ranges');
    await bad('/profit-loss?exact=1&tag_split=1', 'tag_group_id');
    await bad('/profit-loss?exact=1&compare=by_contact&prior=year', 'compare');
    await bad(`/profit-loss?exact=1&tag_split=1&tag_group_id=${ids['region']}&tag_id=${ids['lake']}`, 'tag_id');
    await bad('/profit-loss?exact=1&compare=by_contact&format=csv', 'compare');
    await bad('/balance-sheet?exact=1&ytd=1', 'ytd');
    await bad('/balance-sheet?exact=1&prior=period', 'prior');
    await bad('/general-ledger?tag_id=untagged', 'tag_id');
    await bad('/general-ledger?exact=1&tag_id=nope', 'tag_id');
    await bad('/general-ledger?exact=1&account_ids=nope', 'account_ids');
    await bad('/general-ledger?exact=1&amount_min=5&amount_max=1', 'amount_max');
    await bad('/general-ledger?exact=1&amount_min=-1', 'amount_min');
    await bad('/general-ledger?exact=1&cleared=maybe', 'cleared');
    await bad('/transaction-list?contact_id=none', 'contact_id');
    await bad('/trial-balance?exact=1&tag_split=1', 'tag_group_id');
    const nf = await get(`/profit-loss?exact=1&tag_split=1&tag_group_id=${randomUUID()}`);
    expect(nf.status).toBe(404);
    // Without the new options the legacy and exact shapes are unchanged.
    const legacy = await get('/profit-loss?start_date=2026-01-01&end_date=2026-03-31');
    expect(legacy.body.columns).toBeUndefined();
    expect(legacy.body.meta).toBeUndefined();
  });
});
