// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Exact dashboard money and the dashboard's "today" (ClientLedger U-76,
// dashboard-exact-v1):
//   - exact=1 returns every money field as a decimal string with four
//     places; the default stays a JSON number, now summed with Decimal
//     (0.1 + 0.2 is 0.3, not 0.30000000000000004);
//   - asOf sets "today" for month-to-date, fiscal year-to-date, trend
//     months, overdue and due-soon windows; without it the database date;
//   - one overdue-invoice rule: /receivables overdueCount equals
//     /action-items overdueInvoiceCount (balance > 0, not paid or void,
//     due date before today, txn_date when there is no due date);
//   - cash-position entries carry accountNumber;
//   - payables dueWithinDays (1..90, default 7); bad query values are 400.

import 'express-async-errors';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, journalLines, transactions } from '../db/schema/index.js';
import { dashboardRouter } from './dashboard.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import * as dashboardService from '../services/dashboard.service.js';
import { makeCompany, cleanTenant, type Co } from '../services/templates/templates.test-helpers.js';

interface Res { status: number; json: ReturnType<typeof JSON.parse> }

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;
const ASOF = '2026-03-15';

function get(pathname: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/dashboard${pathname}`, method: 'GET',
      headers: { Authorization: `Bearer ${c.token}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function journal(date: string, debitAccount: string, creditAccount: string, amount: string) {
  const [t] = await db.insert(transactions).values({
    tenantId: c.tenantId, companyId: c.companyId, txnType: 'journal_entry', txnDate: date, status: 'posted', total: amount,
  }).returning();
  await db.insert(journalLines).values([
    { tenantId: c.tenantId, companyId: c.companyId, transactionId: t!.id, accountId: debitAccount, debit: amount, credit: '0' },
    { tenantId: c.tenantId, companyId: c.companyId, transactionId: t!.id, accountId: creditAccount, debit: '0', credit: amount },
  ]);
}

async function invoice(v: { txnDate: string; dueDate: string | null; balanceDue: string | null; total: string; invoiceStatus?: string; status?: string }) {
  await db.insert(transactions).values({
    tenantId: c.tenantId, companyId: c.companyId, txnType: 'invoice', txnDate: v.txnDate, dueDate: v.dueDate,
    status: v.status ?? 'posted', invoiceStatus: v.invoiceStatus ?? 'sent', total: v.total, balanceDue: v.balanceDue,
  });
}

async function bill(dueDate: string | null, balanceDue: string) {
  await db.insert(transactions).values({
    tenantId: c.tenantId, companyId: c.companyId, txnType: 'bill', txnDate: '2026-02-01', dueDate,
    status: 'posted', billStatus: 'unpaid', total: balanceDue, balanceDue,
  });
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany('dash-exact', tenantIds);

  // Two income types, so the JS-side sum used to be 0.1 + 0.2 in floats.
  const [otherIncome] = await db.insert(accounts).values({
    tenantId: c.tenantId, companyId: c.companyId, name: 'Interest earned', accountType: 'other_revenue',
  }).returning();
  await journal('2026-03-05', c.bank, c.income, '0.1000');
  await journal('2026-03-06', c.bank, otherIncome!.id, '0.2000');
  await journal('2026-02-10', c.expense, c.bank, '0.7000');
  // Outside the trend window and the fiscal year.
  await journal('2025-12-20', c.bank, c.income, '9.0000');

  // Stored balances for the cash position (0.1 + 0.2 again) and a number.
  await db.execute(sql`UPDATE accounts SET balance = 0 WHERE tenant_id = ${c.tenantId}`);
  await db.update(accounts).set({ balance: '0.1000', accountNumber: 'CL-1000' })
    .where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.id, c.bank)));
  await db.update(accounts).set({ balance: '0.2000' })
    .where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.id, c.savings)));

  // Invoices (asOf 2026-03-15):
  await invoice({ txnDate: '2026-02-01', dueDate: '2026-03-01', balanceDue: '100.1000', total: '100.1000' }); // overdue
  await invoice({ txnDate: '2026-02-01', dueDate: null, balanceDue: '50.2000', total: '50.2000' }); // overdue by txn_date
  await invoice({ txnDate: '2026-03-01', dueDate: '2026-04-01', balanceDue: '10.0000', total: '10.0000' }); // not yet due
  await invoice({ txnDate: '2026-01-01', dueDate: '2026-02-01', balanceDue: '0.0000', total: '80.0000', invoiceStatus: 'partial' }); // nothing open
  await invoice({ txnDate: '2026-01-01', dueDate: '2026-03-10', balanceDue: null, total: '5.0000' }); // overdue, total as open amount
  await invoice({ txnDate: '2026-01-01', dueDate: '2026-02-01', balanceDue: '70.0000', total: '70.0000', invoiceStatus: 'paid' }); // excluded
  await invoice({ txnDate: '2026-01-01', dueDate: '2026-02-01', balanceDue: '70.0000', total: '70.0000', status: 'void' }); // excluded

  // Bills (asOf 2026-03-15):
  await bill('2026-03-10', '20.0000'); // overdue
  await bill('2026-03-15', '30.0000'); // due today
  await bill('2026-03-22', '40.0000'); // due today + 7
  await bill('2026-04-04', '50.0000'); // due today + 20
  await bill(null, '60.0000'); // no due date
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('dashboard-exact-v1', () => {
  it('is advertised as a desktop capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('dashboard-exact-v1');
  });

  it('snapshot: month-to-date and fiscal year-to-date of asOf, exact strings and Decimal numbers', async () => {
    const exact = await get(`/snapshot?exact=1&asOf=${ASOF}`);
    expect(exact.status).toBe(200);
    expect(exact.json).toEqual({
      mtd: { revenue: '0.3000', expenses: '0.0000', netIncome: '0.3000' },
      ytd: { revenue: '0.3000', expenses: '0.7000', netIncome: '-0.4000' },
    });
    const legacy = await get(`/snapshot?asOf=${ASOF}`);
    expect(legacy.json.mtd.revenue).toBe(0.3);
    expect(legacy.json.ytd.netIncome).toBe(-0.4);
  });

  it('trend: calendar months ending at the month of asOf, with their dates', async () => {
    const r = await get(`/trend?exact=1&asOf=${ASOF}&months=3`);
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual([
      { month: 'Jan 26', startDate: '2026-01-01', endDate: '2026-01-31', revenue: '0.0000', expenses: '0.0000' },
      { month: 'Feb 26', startDate: '2026-02-01', endDate: '2026-02-28', revenue: '0.0000', expenses: '0.7000' },
      { month: 'Mar 26', startDate: '2026-03-01', endDate: '2026-03-31', revenue: '0.3000', expenses: '0.0000' },
    ]);
    const crossYear = await get('/trend?asOf=2026-01-31&months=2');
    expect(crossYear.json.data.map((m: { startDate: string }) => m.startDate)).toEqual(['2025-12-01', '2026-01-01']);
    expect(crossYear.json.data[0].revenue).toBe(9);
  });

  it('cash position: accountNumber on every entry, exact balances and totals', async () => {
    const r = await get('/cash-position?exact=1');
    expect(r.status).toBe(200);
    const bank = r.json.bankAccounts.find((a: { id: string }) => a.id === c.bank);
    expect(bank).toEqual({ id: c.bank, name: expect.any(String), accountNumber: 'CL-1000', balance: '0.1000' });
    for (const a of [...r.json.bankAccounts, ...r.json.creditCards]) {
      expect(a).toHaveProperty('accountNumber');
      expect(typeof a.balance).toBe('string');
    }
    expect(r.json.totalBank).toBe('0.3000');
    expect(r.json.totalCC).toBe('0.0000');
    expect((await get('/cash-position')).json.totalBank).toBe(0.3);
  });

  it('receivables and action items share one overdue rule', async () => {
    const r = await get(`/receivables?exact=1&asOf=${ASOF}`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ totalOutstanding: '165.3000', overdueCount: 3, overdueAmount: '155.3000', invoiceCount: 5 });
    const items = await get(`/action-items?exact=1&asOf=${ASOF}`);
    expect(items.status).toBe(200);
    expect(items.json.overdueInvoiceCount).toBe(3);
    expect(typeof items.json.pendingDepositAmount).toBe('string');
    expect(typeof items.json.printQueueAmount).toBe('string');

    // A due date equal to today is not overdue yet.
    const early = await get('/receivables?asOf=2026-03-01');
    expect(early.json.overdueCount).toBe(1);
    expect(early.json.overdueAmount).toBe(50.2);
    expect((await get('/action-items?asOf=2026-03-01')).json.overdueInvoiceCount).toBe(1);
  });

  it('payables: overdue before today, due soon today through today + dueWithinDays (default 7)', async () => {
    const r = await get(`/payables?exact=1&asOf=${ASOF}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      totalOwed: '200.0000', billCount: 5, overdueCount: 1, overdueAmount: '20.0000',
      dueThisWeekCount: 2, dueThisWeekAmount: '70.0000', dueWithinDays: 7,
    });
    expect(typeof r.json.creditAmount).toBe('string');
    expect(typeof r.json.apBalance).toBe('string');
    const wide = await get(`/payables?exact=1&asOf=${ASOF}&dueWithinDays=20`);
    expect(wide.json).toMatchObject({ dueThisWeekCount: 3, dueThisWeekAmount: '120.0000', dueWithinDays: 20 });
    const one = await get(`/payables?asOf=${ASOF}&dueWithinDays=1`);
    expect(one.json).toMatchObject({ dueThisWeekCount: 1, dueThisWeekAmount: 30, dueWithinDays: 1 });
  });

  it('refuses a bad asOf or dueWithinDays with 400 VALIDATION_ERROR', async () => {
    for (const p of ['/snapshot?asOf=2026-02-30', '/receivables?asOf=15-03-2026', '/payables?dueWithinDays=0', '/payables?dueWithinDays=91', '/payables?dueWithinDays=abc', '/summary?asOf=nope']) {
      const r = await get(p);
      expect(r.status, p).toBe(400);
      expect(r.json.error.code, p).toBe('VALIDATION_ERROR');
    }
  });

  it('summary: one asOf for every panel, the same overdue count twice, exact money', async () => {
    const r = await get(`/summary?exact=1&asOf=${ASOF}&months=2&dueWithinDays=20`);
    expect(r.status).toBe(200);
    expect(r.json.asOf).toBe(ASOF);
    expect(r.json.snapshot.mtd.revenue).toBe('0.3000');
    expect(r.json.trend.data.map((m: { startDate: string }) => m.startDate)).toEqual(['2026-02-01', '2026-03-01']);
    expect(r.json.cashPosition.totalBank).toBe('0.3000');
    expect(r.json.receivables.overdueCount).toBe(3);
    expect(r.json.actionItems.overdueInvoiceCount).toBe(3);
    expect(r.json.payables.dueWithinDays).toBe(20);
    expect(r.json.payables.dueThisWeekAmount).toBe('120.0000');
  });

  it("without asOf, today is the database's CURRENT_DATE", async () => {
    const dbToday = ((await db.execute(sql`SELECT CURRENT_DATE::text AS d`)).rows as Array<{ d: string }>)[0]!.d;
    expect(await dashboardService.resolveToday()).toBe(dbToday);
    const r = await get('/summary');
    expect(r.status).toBe(200);
    expect(r.json.asOf).toBe(dbToday);
    expect(typeof r.json.cashPosition.totalBank).toBe('number');
  });
});
