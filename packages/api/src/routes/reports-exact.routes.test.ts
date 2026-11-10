// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Exact reports (U-14, U-205, reports-exact-v1). Guards:
//   - every catalog route answers ?exact=1 with meta and *Exact strings,
//     and each total equals the Decimal sum of its rows;
//   - the 0.1 + 0.2 regression (section totals summed in Decimal);
//   - Customer Deposits reads credit-positive on the Balance Sheet;
//   - parentAccountId / depth / rollupExact on account rows;
//   - GL lineId, limit, rowCount, truncated; transaction-list lineId;
//   - dates are YYYY-MM-DD; INVALID_PARAM / INVALID_DATE_RANGE;
//   - the 1099 Summary by box matches the 1099 Center's mapping totals;
//   - no parseFloat / += on money in the exact report modules;
//   - without exact=1 the legacy responses carry no meta.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, pool } from '../db/index.js';
import { accounts, contacts, paymentApplications, vendor1099AccountMappings } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { ytdTotalsByBox } from '../services/portal-1099.service.js';
import { exactStr, percent1, applyAccountTree } from '../services/report-exact.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

// The test sums at 80 digits so a cash-basis share is never rounded here.
const Decimal = (DecimalLib.default || DecimalLib).clone({ precision: 80 });

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let companyId = '';
const ids: Record<string, string> = {};

const testEmail = `reports-exact-${Date.now()}@example.com`;

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

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((res, rej) => {
    const r = http.request({
      method: 'GET', hostname: '127.0.0.1', port, path: `/api/v1/reports${path}`,
      headers: { Authorization: `Bearer ${token}` },
    }, (resp) => {
      let data = '';
      resp.on('data', (c) => (data += c));
      resp.on('end', () => {
        let body: unknown = data;
        try { body = JSON.parse(data); } catch { /* csv / pdf */ }
        res({ status: resp.statusCode!, body });
      });
    });
    r.on('error', rej);
    r.end();
  });
}

const D = (x: unknown) => new Decimal(String(x ?? 0));
const sumOf = (rows: any[], key: string) => rows.reduce((acc: InstanceType<typeof Decimal>, r) => acc.plus(D(r[key])), new Decimal(0));
const EXACT_RE = /^-?\d+\.\d{4,}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function mkAccount(values: Partial<typeof accounts.$inferInsert> & { name: string; accountType: string }) {
  const [a] = await db.insert(accounts).values({ tenantId, ...values } as typeof accounts.$inferInsert).returning();
  return a!;
}

beforeAll(async () => {
  await cleanDb();
  await startApp();
  const result = await authService.register({
    email: testEmail, password: 'password123456', displayName: 'Exact Reports Test', companyName: 'Exact Reports Co',
  });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;
  const company = await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.tenantId, tenantId) });
  companyId = company!.id;

  const checking = await mkAccount({ name: 'Exact Checking', accountNumber: '1011', accountType: 'asset', detailType: 'bank' });
  const salesParent = await mkAccount({ name: 'Sales (parent)', accountNumber: '4100', accountType: 'revenue', detailType: 'sales_of_product_income' });
  const salesA = await mkAccount({ name: 'Sales A', accountNumber: '4110', accountType: 'revenue', detailType: 'sales_of_product_income', parentId: salesParent.id });
  const salesB = await mkAccount({ name: 'Sales B', accountNumber: '4120', accountType: 'revenue', detailType: 'sales_of_product_income', parentId: salesParent.id });
  const otherSales = await mkAccount({ name: 'Other Sales', accountNumber: '4200', accountType: 'revenue', detailType: 'sales_of_product_income' });
  const contractors = await mkAccount({ name: 'Contract Labor', accountNumber: '6110', accountType: 'expense', detailType: 'other_business_expenses' });
  const royalties = await mkAccount({ name: 'Royalties Paid', accountNumber: '6120', accountType: 'expense', detailType: 'other_business_expenses' });
  const deposits = (await db.query.accounts.findFirst({
    where: (a, { and, eq }) => and(eq(a.tenantId, tenantId), eq(a.systemTag, 'customer_deposits')),
  })) ?? await mkAccount({ name: 'Customer Deposits', accountNumber: '2300', accountType: 'liability', detailType: 'other_current_liabilities' });
  Object.assign(ids, {
    checking: checking.id, salesParent: salesParent.id, salesA: salesA.id, salesB: salesB.id,
    contractors: contractors.id, royalties: royalties.id, deposits: deposits.id, otherSales: otherSales.id,
  });

  const [vendor] = await db.insert(contacts).values({
    tenantId, companyId, contactType: 'vendor', displayName: 'Ada Contractor', taxId: '12-3456789', is1099Eligible: true,
  } as typeof contacts.$inferInsert).returning();
  const [author] = await db.insert(contacts).values({
    tenantId, companyId, contactType: 'vendor', displayName: 'Bo Author', taxId: null, is1099Eligible: true,
  } as typeof contacts.$inferInsert).returning();
  ids['vendor'] = vendor!.id;
  ids['author'] = author!.id;
  await db.insert(vendor1099AccountMappings).values([
    { tenantId, accountId: contractors.id, formBox: 'NEC-1' },
    { tenantId, accountId: royalties.id, formBox: 'MISC-2' },
  ]);

  const je = (date: string, memo: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
    ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines }, undefined, companyId);
  // 0.1 + 0.2: two sub-account sales whose float sum is 0.30000000000000004.
  await je('2026-03-02', 'Sale A', [
    { accountId: checking.id, debit: '0.10', credit: '0' },
    { accountId: salesA.id, debit: '0', credit: '0.10' },
  ]);
  await je('2026-03-03', 'Sale B', [
    { accountId: checking.id, debit: '0.20', credit: '0' },
    { accountId: salesB.id, debit: '0', credit: '0.20' },
  ]);
  // A customer deposit held as a liability.
  await je('2026-03-04', 'Customer deposit', [
    { accountId: checking.id, debit: '500.00', credit: '0' },
    { accountId: deposits.id, debit: '0', credit: '500.00' },
  ]);
  const expense = (date: string, contactId: string, accountId: string, amount: string) =>
    ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: date, contactId, total: amount, memo: 'Paid',
      lines: [
        { accountId, debit: amount, credit: '0' },
        { accountId: checking.id, debit: '0', credit: amount },
      ],
    }, undefined, companyId);
  await expense('2026-04-01', vendor!.id, contractors.id, '600.10');
  await expense('2026-04-02', vendor!.id, contractors.id, '0.20');
  await expense('2026-04-03', author!.id, royalties.id, '9.99');
  // A root revenue account after the (posting-free) parent in number order.
  await je('2026-06-10', 'Other sale', [
    { accountId: checking.id, debit: '5.00', credit: '0' },
    { accountId: otherSales.id, debit: '0', credit: '5.00' },
  ]);

  // Cash basis (2027): an invoice over three income lines, paid in part,
  // so each line's cash share is an unrounded quotient with more than 20
  // significant digits.
  const ar = (await db.query.accounts.findFirst({
    where: (a, { and, eq }) => and(eq(a.tenantId, tenantId), eq(a.systemTag, 'accounts_receivable')),
  })) ?? await mkAccount({ name: 'Accounts Receivable', accountNumber: '1200', accountType: 'asset', detailType: 'accounts_receivable', systemTag: 'accounts_receivable', isSystem: true });
  const [customer] = await db.insert(contacts).values({
    tenantId, companyId, contactType: 'customer', displayName: 'Cy Customer',
  } as typeof contacts.$inferInsert).returning();
  const invoice = await ledger.postTransaction(tenantId, {
    txnType: 'invoice', txnDate: '2027-02-01', contactId: customer!.id, total: '3000000.00', memo: 'Big invoice',
    lines: [
      { accountId: ar.id, debit: '3000000.00', credit: '0' },
      { accountId: salesA.id, debit: '0', credit: '1000000.00' },
      { accountId: salesB.id, debit: '0', credit: '1000000.00' },
      { accountId: otherSales.id, debit: '0', credit: '1000000.00' },
    ],
  } as Parameters<typeof ledger.postTransaction>[1], undefined, companyId);
  const payment = await ledger.postTransaction(tenantId, {
    txnType: 'customer_payment', txnDate: '2027-02-15', contactId: customer!.id, total: '1000000.01', memo: 'Part payment',
    lines: [
      { accountId: checking.id, debit: '1000000.01', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '1000000.01' },
    ],
  } as Parameters<typeof ledger.postTransaction>[1], undefined, companyId);
  await db.insert(paymentApplications).values({ tenantId, paymentId: payment.id, invoiceId: invoice.id, amount: '1000000.01' });
}, 60000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('reports-exact-v1 (U-14, U-205)', () => {
  it('is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('reports-exact-v1');
  });

  it('formats exact values at the stored scale, never -0', () => {
    expect(exactStr('100')).toBe('100.0000');
    expect(exactStr('-0')).toBe('0.0000');
    expect(exactStr('1.123456')).toBe('1.123456');
    expect(percent1('1', '3')).toBe('33.3');
    expect(percent1('-2', '3')).toBe('-66.7');
    expect(percent1('1', '0')).toBeNull();
  });

  it('P&L: the 0.1 + 0.2 regression, exact sections, account tree', async () => {
    const r = await get('/profit-loss?start_date=2026-01-01&end_date=2026-03-31&exact=1');
    expect(r.status).toBe(200);
    const pl = r.body;
    expect(pl.meta).toMatchObject({ exact: true, basis: 'accrual', cashBasisRules: null, from: '2026-01-01', to: '2026-03-31', reportSchemaVersion: '2' });
    expect(pl.totalRevenueExact).toBe('0.3000');
    expect(pl.totalRevenue).toBe(0.3);
    const own = pl.revenue.filter((e: any) => e.accountId !== ids['salesParent']);
    expect(D(pl.totalRevenueExact).eq(sumOf(pl.revenue, 'amountExact'))).toBe(true);
    expect(own.length).toBe(2);
    const parent = pl.revenue.find((e: any) => e.accountId === ids['salesParent']);
    expect(parent).toMatchObject({ amountExact: '0.0000', depth: 0, parentAccountId: null, rollupExact: '0.3000' });
    const a = pl.revenue.find((e: any) => e.accountId === ids['salesA']);
    expect(a).toMatchObject({ amountExact: '0.1000', depth: 1, parentAccountId: ids['salesParent'] });
    // Parent first, then its children.
    expect(pl.revenue.findIndex((e: any) => e.accountId === ids['salesParent']))
      .toBeLessThan(pl.revenue.findIndex((e: any) => e.accountId === ids['salesA']));
    const net = D(pl.totalRevenueExact).plus(D(pl.totalOtherRevenueExact)).minus(D(pl.totalCogsExact))
      .minus(D(pl.totalExpensesExact)).minus(D(pl.totalOtherExpensesExact));
    expect(D(pl.netIncomeExact).eq(net)).toBe(true);
    for (const k of ['expenses', 'cogs', 'otherRevenue', 'otherExpenses']) {
      expect(D(pl[`total${k[0]!.toUpperCase()}${k.slice(1)}Exact`]).eq(sumOf(pl[k], 'amountExact'))).toBe(true);
    }
    // Same sign for the number and the exact string.
    for (const e of [...pl.revenue, ...pl.expenses]) expect(Math.sign(e.amount)).toBe(D(e.amountExact).isZero() ? 0 : D(e.amountExact).s);
    // An added parent sits where its first child was, ahead of a later root.
    const year = (await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&exact=1')).body;
    expect(year.revenue.map((e: any) => e.accountId)).toEqual([ids['salesParent'], ids['salesA'], ids['salesB'], ids['otherSales']]);
    expect(year.totalRevenueExact).toBe('5.3000');
  });

  it('cash basis: unrounded allocation shares, totals still equal the rows', async () => {
    const q = 'start_date=2027-01-01&end_date=2027-12-31&basis=cash&exact=1';
    const pl = (await get(`/profit-loss?${q}`)).body;
    expect(pl.meta.basis).toBe('cash');
    const shares = pl.revenue.filter((e: any) => !e.rollupExact);
    expect(shares.length).toBe(3);
    // More places than the stored scale: the share is not rounded.
    expect(shares.some((e: any) => e.amountExact.split('.')[1].length > 4)).toBe(true);
    expect(D(pl.totalRevenueExact).eq(sumOf(pl.revenue, 'amountExact'))).toBe(true);
    expect(D(pl.netIncomeExact).eq(D(pl.totalRevenueExact).minus(D(pl.totalExpensesExact)))).toBe(true);
    const gl = (await get(`/general-ledger?${q}`)).body;
    for (const a of gl.accounts) {
      expect(D(a.periodCreditsExact).eq(sumOf(a.lines, 'creditExact')), a.name).toBe(true);
      expect(D(a.periodDebitsExact).eq(sumOf(a.lines, 'debitExact')), a.name).toBe(true);
    }
    expect(D(gl.totalCreditsExact).eq(sumOf(gl.accounts, 'periodCreditsExact'))).toBe(true);
    const tb = (await get('/trial-balance?start_date=2027-01-01&end_date=2027-12-31&basis=cash&exact=1')).body;
    expect(D(tb.totalDebitsExact).eq(sumOf(tb.data, 'debitExact'))).toBe(true);
    expect(D(tb.totalCreditsExact).eq(sumOf(tb.data, 'creditExact'))).toBe(true);
    const parent = tb.data.find((r: any) => r.accountId === ids['salesParent']);
    const kids = tb.data.filter((r: any) => r.parentAccountId === ids['salesParent']);
    expect(D(parent.rollupExact).eq(sumOf(kids, 'netExact'))).toBe(true);
  });

  it('P&L grouped and comparative carry exact subtotals and columns', async () => {
    const g = (await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&group_by=detail_type&exact=1')).body;
    for (const grp of g.groups.revenue) expect(D(grp.subtotalExact).eq(sumOf(grp.entries, 'amountExact'))).toBe(true);
    const c = (await get('/profit-loss?start_date=2026-03-01&end_date=2026-04-30&compare=multi_period&period_type=month&exact=1')).body;
    expect(c.columns.length).toBe(3);
    for (const row of c.rows) {
      const vals = row.valuesExact as string[];
      expect(D(vals[vals.length - 1]).eq(vals.slice(0, -1).reduce((acc, v) => acc.plus(D(v)), new Decimal(0)))).toBe(true);
    }
    expect(c.totalRevenueExact).toEqual(['0.3000', '0.0000', '0.3000']);
    const p = (await get('/profit-loss?start_date=2026-04-01&end_date=2026-04-30&compare=previous_period&exact=1')).body;
    const exp = p.rows.find((r: any) => r.accountId === ids['contractors']);
    // Cost rows flip: spending more is a negative change; % null on a zero prior.
    expect(exp.valuesExact).toEqual(['600.3000', '0.0000', '-600.3000', null]);
  });

  it('Balance Sheet: Customer Deposits is credit-positive and totals tie', async () => {
    const r = await get('/balance-sheet?as_of_date=2026-12-31&exact=1');
    expect(r.status).toBe(200);
    const bs = r.body;
    expect(bs.meta).toMatchObject({ exact: true, asOf: '2026-12-31', basis: 'accrual' });
    const dep = bs.liabilities.find((e: any) => e.accountId === ids['deposits']);
    expect(dep.balanceExact).toBe('500.0000');
    expect(dep.balance).toBe(500);
    for (const k of ['assets', 'liabilities', 'equity']) {
      expect(D(bs[`total${k[0]!.toUpperCase()}${k.slice(1)}Exact`]).eq(sumOf(bs[k], 'balanceExact'))).toBe(true);
    }
    expect(D(bs.totalAssetsExact).eq(D(bs.totalLiabilitiesAndEquityExact))).toBe(true);
    const cmp = (await get('/balance-sheet?as_of_date=2026-12-31&compare=previous_year&exact=1')).body;
    expect(cmp.totalAssetsExact[0]).toBe(bs.totalAssetsExact);
  });

  it('Trial Balance: exact columns, debits equal credits', async () => {
    const tb = (await get('/trial-balance?start_date=2026-01-01&end_date=2026-12-31&exact=1')).body;
    expect(D(tb.totalDebitsExact).eq(sumOf(tb.data, 'debitExact'))).toBe(true);
    expect(D(tb.totalCreditsExact).eq(sumOf(tb.data, 'creditExact'))).toBe(true);
    expect(tb.totalDebitsExact).toBe(tb.totalCreditsExact);
    const parent = tb.data.find((r: any) => r.accountId === ids['salesParent']);
    expect(parent).toMatchObject({ rollupExact: '-0.3000', depth: 0 });
  });

  it('General Ledger: lineId, exact running balances, limit / truncated / rowCount', async () => {
    const full = (await get('/general-ledger?start_date=2026-01-01&end_date=2026-12-31&exact=1')).body;
    const lines = full.accounts.flatMap((a: any) => a.lines);
    expect(full.rowCount).toBe(lines.length);
    expect(full.truncated).toBe(false);
    for (const l of lines) {
      expect(l.lineId).toBeTruthy();
      expect(l.debitExact).toMatch(EXACT_RE);
      expect(l.date).toMatch(DATE_RE);
    }
    expect(D(full.totalDebitsExact).eq(sumOf(full.accounts, 'periodDebitsExact'))).toBe(true);
    for (const a of full.accounts) {
      expect(D(a.periodDebitsExact).eq(sumOf(a.lines, 'debitExact'))).toBe(true);
      const last = a.lines[a.lines.length - 1];
      if (last) expect(last.runningBalanceExact).toBe(a.endingBalanceExact);
    }
    const cut = (await get('/general-ledger?start_date=2026-01-01&end_date=2026-12-31&exact=1&limit=2')).body;
    expect(cut.truncated).toBe(true);
    expect(cut.rowCount).toBe(full.rowCount);
    expect(cut.accounts.flatMap((a: any) => a.lines).length).toBe(2);
    expect(cut.totalDebitsExact).toBe(full.totalDebitsExact);
  });

  it('every catalog list route: *Exact rows, Decimal totals, YYYY-MM-DD dates, meta', async () => {
    const lists: Array<[string, string[]]> = [
      ['/transaction-list?start_date=2026-01-01&end_date=2026-12-31', ['debit', 'credit', 'amount']],
      ['/journal-entry-report?start_date=2026-01-01&end_date=2026-12-31', ['debit', 'credit', 'amount']],
      ['/invoice-list?start_date=2026-01-01&end_date=2026-12-31', ['total', 'amount_paid', 'balance_due']],
      ['/customer-balance-summary', ['balance']],
      ['/customer-balance-detail', ['balance']],
      ['/vendor-balance-summary', ['total_spent']],
      ['/unpaid-bills', ['total', 'amount_paid', 'credits_applied', 'balance_due']],
      ['/bill-payment-history?start_date=2026-01-01&end_date=2026-12-31', ['total']],
      [`/transaction-list-by-vendor?vendor_id=${ids['vendor']}&start_date=2026-01-01&end_date=2026-12-31`, ['total']],
      ['/sales-by-customer?start_date=2026-01-01&end_date=2026-12-31', ['total']],
      ['/sales-by-item?start_date=2026-01-01&end_date=2026-12-31', ['total']],
      ['/expense-by-vendor?start_date=2026-01-01&end_date=2026-12-31', ['total']],
      ['/expense-by-category?start_date=2026-01-01&end_date=2026-12-31', ['total']],
      ['/revenue-by-category?start_date=2026-01-01&end_date=2026-12-31', ['total']],
      ['/deposit-detail?start_date=2026-01-01&end_date=2026-12-31', ['total']],
      [`/check-register?account_id=${ids['checking']}&start_date=2026-01-01&end_date=2026-12-31`, ['debit', 'credit']],
    ];
    for (const [path, fields] of lists) {
      const r = await get(`${path}${path.includes('?') ? '&' : '?'}exact=1`);
      expect(r.status, path).toBe(200);
      expect(r.body.meta?.exact, path).toBe(true);
      for (const f of fields) {
        for (const row of r.body.data) {
          if (row[f] !== null && row[f] !== undefined) expect(row[`${f}Exact`], `${path} ${f}`).toMatch(EXACT_RE);
          for (const [k, v] of Object.entries(row)) if (k === 'txn_date' || k === 'due_date') if (v !== null) expect(v, `${path} ${k}`).toMatch(DATE_RE);
        }
        expect(D(r.body.totalsExact[f]).eq(sumOf(r.body.data, `${f}Exact`)), `${path} total ${f}`).toBe(true);
      }
      // Legacy shape untouched.
      const legacy = await get(path);
      expect(legacy.status, path).toBe(200);
      expect(legacy.body.meta, path).toBeUndefined();
      expect(legacy.body.totalsExact, path).toBeUndefined();
    }
    const tl = (await get('/transaction-list?start_date=2026-01-01&end_date=2026-12-31&exact=1')).body;
    expect(tl.data.every((r: any) => typeof r.lineId === 'string')).toBe(true);
    expect(new Set(tl.data.map((r: any) => r.lineId)).size).toBe(tl.data.length);
  });

  it('detail and summary reports with their own totals', async () => {
    const ebc = (await get('/expense-by-category?start_date=2026-01-01&end_date=2026-12-31&display=detail&exact=1')).body;
    expect(D(ebc.grandTotalExact).eq(sumOf(ebc.groups, 'subtotalExact'))).toBe(true);
    for (const g of ebc.groups) expect(D(g.totalDebitsExact).eq(sumOf(g.lines, 'debitExact'))).toBe(true);
    const rev = (await get('/revenue-by-category?start_date=2026-01-01&end_date=2026-12-31&display=detail&exact=1')).body;
    expect(rev.grandTotalExact).toBe('5.3000');
    const ap = (await get('/ap-aging-summary?as_of_date=2026-12-31&exact=1')).body;
    expect(ap.meta.asOf).toBe('2026-12-31');
    expect(D(ap.totalsExact.total).eq(sumOf(ap.vendors, 'totalExact'))).toBe(true);
    const vs = (await get(`/vendor-statement?vendor_id=${ids['vendor']}&start_date=2026-01-01&end_date=2026-12-31&exact=1`)).body;
    expect(D(vs.closingBalanceExact).eq(D(vs.openingBalanceExact).plus(D(vs.totalChargesExact)).minus(D(vs.totalPaymentsExact)))).toBe(true);
    const bb = (await get('/bank-balances?as_of_date=2026-12-31&exact=1')).body;
    expect(D(bb.totalBalanceExact).eq(sumOf(bb.accounts, 'balanceExact'))).toBe(true);
    const aas = (await get('/account-activity-summary?start_date=2026-01-01&end_date=2026-12-31&exact=1')).body;
    expect(D(aas.totalDebitsExact).eq(sumOf(aas.data, 'total_debitExact'))).toBe(true);
    const prep = (await get('/ap-1099-prep?tax_year=2026&exact=1')).body;
    expect(D(prep.totalPaidExact).eq(sumOf(prep.data, 'total_paidExact'))).toBe(true);
    // Cash basis carries the rules note.
    const cash = (await get('/profit-loss?start_date=2026-01-01&end_date=2026-12-31&basis=cash&exact=1')).body;
    expect(cash.meta.basis).toBe('cash');
    expect(typeof cash.meta.cashBasisRules).toBe('string');
    expect(D(cash.totalExpensesExact).eq(sumOf(cash.expenses, 'amountExact'))).toBe(true);
  });

  it('1099 Summary by box matches the 1099 Center mapping totals', async () => {
    const r = await get('/vendor-1099-summary?year=2026&exact=1');
    expect(r.status).toBe(200);
    const s = r.body;
    const ada = s.rows.find((x: any) => x.contactId === ids['vendor']);
    expect(ada).toMatchObject({ name: 'Ada Contractor', tinLast4: '6789', boxes: { 'NEC-1': '600.3000' }, totalExact: '600.3000', meetsThreshold: true });
    const bo = s.rows.find((x: any) => x.contactId === ids['author']);
    expect(bo).toMatchObject({ tinLast4: null, boxes: { 'MISC-2': '9.9900' }, meetsThreshold: false });
    expect(JSON.stringify(s)).not.toContain('3456789');
    expect(s.totalsExact).toEqual({ 'NEC-1': '600.3000', 'MISC-2': '9.9900', total: '610.2900' });
    // One source: the portal's per-box totals (single-company tenant).
    const portal = await ytdTotalsByBox(tenantId, 2026);
    for (const p of portal) {
      const row = s.rows.find((x: any) => x.contactId === p.contactId);
      expect(D(row.boxes[p.formBox]).eq(D(p.total))).toBe(true);
    }
    expect(portal.length).toBe(s.rows.reduce((n: number, x: any) => n + Object.keys(x.boxes).length, 0));
    // Legacy shape without exact.
    const legacy = (await get('/vendor-1099-summary?year=2026')).body;
    expect(Array.isArray(legacy.data)).toBe(true);
    expect(legacy.rows).toBeUndefined();
  });

  it('rejects bad parameters with INVALID_PARAM / INVALID_DATE_RANGE', async () => {
    const cases: Array<[string, string, string]> = [
      ['/profit-loss?exact=2', 'INVALID_PARAM', 'exact'],
      ['/profit-loss?exact=1&start_date=2026-13-01', 'INVALID_PARAM', 'start_date'],
      ['/profit-loss?exact=1&start_date=2026-05-01&end_date=2026-04-01', 'INVALID_DATE_RANGE', 'end_date'],
      ['/profit-loss?exact=1&basis=modified', 'INVALID_PARAM', 'basis'],
      ['/profit-loss?exact=1&compare=sideways', 'INVALID_PARAM', 'compare'],
      ['/general-ledger?exact=1&limit=0', 'INVALID_PARAM', 'limit'],
      ['/balance-sheet?exact=1&as_of_date=yesterday', 'INVALID_PARAM', 'as_of_date'],
      ['/vendor-statement?exact=1', 'INVALID_PARAM', 'vendor_id'],
      ['/vendor-1099-summary?exact=1&year=abc', 'INVALID_PARAM', 'year'],
    ];
    for (const [path, code, param] of cases) {
      const r = await get(path);
      expect(r.status, path).toBe(400);
      expect(r.body.error.code, path).toBe(code);
      expect(r.body.error.details?.param, path).toBe(param);
    }
  });

  it('exact is ignored for csv export', async () => {
    const r = await get('/trial-balance?start_date=2026-01-01&end_date=2026-12-31&exact=1&format=csv');
    expect(r.status).toBe(200);
    expect(typeof r.body).toBe('string');
  });

  it('account tree: missing ancestors are added, cycles do not loop', () => {
    const tree = new Map([
      ['a', { id: 'a', parentId: 'b', name: 'A', accountNumber: '1', accountType: 'expense' }],
      ['b', { id: 'b', parentId: 'a', name: 'B', accountNumber: '2', accountType: 'expense' }],
      ['c', { id: 'c', parentId: 'd', name: 'C', accountNumber: '3', accountType: 'expense' }],
      ['d', { id: 'd', parentId: null, name: 'D', accountNumber: '4', accountType: 'expense' }],
    ]);
    const out = applyAccountTree(
      [{ accountId: 'a', v: '1' }, { accountId: 'c', v: '2' }],
      tree, (e) => D(e.v), (n) => ({ accountId: n.id, v: '0' }),
    );
    expect(out.map((r) => r.accountId).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(out.find((r) => r.accountId === 'd')).toMatchObject({ depth: 0, rollupExact: '2.0000' });
    expect(out.find((r) => r.accountId === 'c')).toMatchObject({ depth: 1, parentAccountId: 'd' });
  });
});

describe('no float money in the exact report modules', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const files = [
    '../services/report-exact.ts',
    '../services/vendor-1099-summary.service.ts',
    './reports-exact.routes.ts',
    '../services/report.service.ts',
    '../services/ap-report.service.ts',
    '../services/report-comparison.service.ts',
    '../services/report-lens.ts',
    '../services/report-columns.service.ts',
  ];
  // Non-money counters that may use +=, by exact line text.
  const ALLOW = new Set(['rowCount += reportLines.length;', 'rowCount += t.lines.length;']);
  it.each(files)('%s has no parseFloat and no += outside the allowlist', (file) => {
    const src = readFileSync(resolve(here, file), 'utf8');
    const code = src.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '').trim()).filter((l) => l && !l.startsWith('*'));
    expect(code.filter((l) => /\bparseFloat\s*\(/.test(l))).toEqual([]);
    expect(code.filter((l) => /\+=/.test(l) && !ALLOW.has(l))).toEqual([]);
  });
});
