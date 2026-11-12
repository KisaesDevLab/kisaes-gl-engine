// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Report Builder starters tie to the standard reports to the cent
// (U-119, report-builder-starters-v1; ClientLedger A07 PR-D, plan §6):
// each starter runs with the same dates, fiscal year starts and basis as
// its standard report; summary rows are keyed by entity id and compared as
// exact values, and every total is compared. Accrual and cash.
//
// The fixture has: a sale whose line client differs from its header
// client, an invoice with a negative income (discount) line, a journal
// entry crediting income with a client, two A/R items each open 10.005, a
// partial payment, a payment after the as-of date, a credit memo applied,
// a partly paid bill, a cash-only entry, a fiscal-year boundary, a NULL
// client and a NULL item, untagged lines; the Balance Sheet runs with and
// without a designated Retained Earnings account and on a 4-4-5 year start.

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { BUILDER_STARTERS, type BuilderDefinition } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts, contacts, items, paymentApplications, billPaymentApplications } from '../db/schema/index.js';
import { reportBuilderRouter } from './report-builder.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as ledger from '../services/ledger.service.js';
import * as reportService from '../services/report.service.js';
import * as openBalances from '../services/open-balances.service.js';
import { ReportDecimal as Decimal } from '../services/report-exact.js';
import { makeCompany, cleanTenant, suffix, type Co } from '../services/templates/templates.test-helpers.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;
let customer2 = '';
let customer3 = '';
let item = '';
let reAccount = '';
const FY = ['2025-01-01', '2026-01-01'];
const RANGE = { from: '2026-01-01', to: '2026-06-30' };
const AS_OF = '2026-06-30';

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

type Row = { kind: string; nodeId: string; path: string[]; caption: string; cells: Array<string | null> };
const starter = (key: string): BuilderDefinition => JSON.parse(JSON.stringify(BUILDER_STARTERS.find((s) => s.key === key)!.definition)) as BuilderDefinition;
async function run(key: string, extra: Record<string, unknown>): Promise<{ rows: Row[]; columns: Array<{ key: string; kind: string }> }> {
  const r = await call('POST', '/run', { definition: starter(key), fiscalYearStarts: FY, expandAll: true, ...extra });
  expect(r.status, `${key} ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
  return r.json;
}
const D = (x: string | number | null | undefined) => new Decimal(x ?? 0).toFixed(4);
/** Line rows of a section keyed by the id in their last path segment ("none" for a NULL key). */
const byKey = (rows: Row[], nodeId: string, col = 0) => Object.fromEntries(
  rows.filter((r) => r.kind === 'line' && r.nodeId === nodeId).map((r) => [r.path[r.path.length - 1]!.split(':')[1]!, D(r.cells[col])]),
);
const total = (rows: Row[], nodeId: string, col = 0) => D(rows.find((r) => r.kind === 'total' && r.nodeId === nodeId)!.cells[col]);
const dropZero = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, v]) => !new Decimal(v).isZero()));

type L = { accountId: string; debit: string; credit: string; contactId?: string; itemId?: string };
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
  c = await makeCompany(`rbt${suffix().slice(-4)}`, tenantIds);
  for (const [k, n] of [['c2', 'Line Client'], ['c3', 'Sub-cent Client']] as const) {
    const [x] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: `${n} ${suffix()}` }).returning();
    if (k === 'c2') customer2 = x!.id; else customer3 = x!.id;
  }
  const [it] = await db.insert(items).values({ tenantId: c.tenantId, companyId: c.companyId, name: `Visit ${suffix()}`, incomeAccountId: c.income }).returning();
  item = it!.id;
  reAccount = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'retained_earnings')) }))?.id ?? '';

  // Prior fiscal year income (the boundary).
  await post('journal_entry', '2025-06-30', [{ accountId: c.bank, debit: '500.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '500.00' }]);
  // An invoice: one line for another client, an item line, a discount (negative income) line.
  const inv1 = await post('invoice', '2026-02-01', [
    { accountId: c.ar, debit: '130.00', credit: '0' },
    { accountId: c.income, debit: '0', credit: '100.00', itemId: item },
    { accountId: c.income, debit: '0', credit: '40.00', contactId: customer2 },
    { accountId: c.income, debit: '10.00', credit: '0' },
  ], { contactId: c.customer, dueDate: '2026-03-03' });
  // A journal entry crediting income with a client (not a sale).
  await post('journal_entry', '2026-02-10', [{ accountId: c.bank, debit: '25.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '25.00', contactId: customer2 }]);
  // A sale with no client and no item.
  await post('cash_sale', '2026-03-01', [{ accountId: c.bank, debit: '60.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '60.00' }]);
  // Two A/R items each open 10.005.
  for (const d of ['2026-04-01', '2026-04-02']) {
    await post('invoice', d, [{ accountId: c.ar, debit: '10.005', credit: '0' }, { accountId: c.income, debit: '0', credit: '10.005' }], { contactId: customer3, dueDate: '2026-05-01' });
  }
  // A partial payment on the first invoice, and one after the as-of date.
  const pay1 = await post('customer_payment', '2026-03-15', [{ accountId: c.bank, debit: '50.00', credit: '0' }, { accountId: c.ar, debit: '0', credit: '50.00' }], { contactId: c.customer });
  await db.insert(paymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: pay1.id, invoiceId: inv1.id, amount: '50.0000' });
  const pay2 = await post('customer_payment', '2026-07-10', [{ accountId: c.bank, debit: '30.00', credit: '0' }, { accountId: c.ar, debit: '0', credit: '30.00' }], { contactId: c.customer });
  await db.insert(paymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: pay2.id, invoiceId: inv1.id, amount: '30.0000' });
  // A credit memo applied to the first invoice.
  const memo = await post('credit_memo', '2026-04-20', [{ accountId: c.income, debit: '20.00', credit: '0' }, { accountId: c.ar, debit: '0', credit: '20.00' }], { contactId: c.customer });
  await db.insert(paymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: memo.id, invoiceId: inv1.id, amount: '20.0000' });
  // Purchases: an expense, a bill paid in part.
  await post('expense', '2026-03-10', [{ accountId: c.expense, debit: '33.33', credit: '0' }, { accountId: c.bank, debit: '0', credit: '33.33' }], { contactId: c.vendor });
  const bill = await post('bill', '2026-03-12', [{ accountId: c.expense2, debit: '45.00', credit: '0' }, { accountId: c.ap, debit: '0', credit: '45.00' }], { contactId: c.vendor, dueDate: '2026-04-11' });
  const bp = await post('bill_payment', '2026-04-01', [{ accountId: c.ap, debit: '20.00', credit: '0' }, { accountId: c.bank, debit: '0', credit: '20.00' }], { contactId: c.vendor });
  await db.insert(billPaymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: bp.id, billId: bill.id, amount: '20.0000' });
  // A cash-only entry.
  await post('cash_sale', '2026-05-05', [{ accountId: c.bank, debit: '7.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '7.00' }], { contactId: c.customer, basis: 'cash' });
}, 120_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('starters tie to the standard reports (report-builder-starters-v1)', () => {
  it('GET /starters lists every starter with the standard report it ties to', async () => {
    const r = await call('GET', '/starters');
    expect(r.status).toBe(200);
    expect(r.json.starters.map((s: { key: string }) => s.key)).toEqual(BUILDER_STARTERS.map((s) => s.key));
  });

  for (const basis of ['accrual', 'cash'] as const) {
    it(`P&L, Revenue and Expenses by Category, Sales by Client and Item (${basis})`, async () => {
      const std = await reportService.buildProfitAndLoss(c.tenantId, RANGE.from, RANGE.to, basis, c.companyId, null, null, { exactAmounts: true }) as unknown as Record<string, unknown>;
      const pl = await run('profit_loss', { dates: RANGE, basis });
      const stdAccounts = (k: string) => dropZero(Object.fromEntries((std[k] as Array<{ accountId: string; amountExact: string }>).map((e) => [e.accountId, D(e.amountExact)])));
      expect(Object.keys(byKey(pl.rows, 'income')).length).toBeGreaterThan(0);
      expect(byKey(pl.rows, 'income')).toEqual(stdAccounts('revenue'));
      expect(byKey(pl.rows, 'expenses')).toEqual(stdAccounts('expenses'));
      expect(total(pl.rows, 'income')).toBe(D(std['totalRevenueExact'] as string));
      expect(total(pl.rows, 'expenses')).toBe(D(std['totalExpensesExact'] as string));
      expect(D(pl.rows.find((r) => r.nodeId === 'net_income')!.cells[0])).toBe(D(std['netIncomeExact'] as string));

      const rev = await run('revenue_by_category', { dates: RANGE, basis });
      expect(total(rev.rows, 'revenue')).toBe(new Decimal(std['totalRevenueExact'] as string).plus(std['totalOtherRevenueExact'] as string).toFixed(4));
      const exp = await run('expenses_by_category', { dates: RANGE, basis });
      expect(total(exp.rows, 'expenses')).toBe(new Decimal(std['totalCogsExact'] as string).plus(std['totalExpensesExact'] as string).plus(std['totalOtherExpensesExact'] as string).toFixed(4));

      const sc = await run('sales_by_client', { dates: RANGE, basis });
      const ssc = await reportService.buildSalesByCustomer(c.tenantId, RANGE.from, RANGE.to, c.companyId, null, basis);
      expect(byKey(sc.rows, 'sales')).toEqual(dropZero(Object.fromEntries((ssc.data as Array<{ contact_id: string | null; total: string }>).map((r) => [r.contact_id ?? 'none', D(r.total)]))));
      const si = await run('sales_by_item', { dates: RANGE, basis });
      const ssi = await reportService.buildSalesByItem(c.tenantId, RANGE.from, RANGE.to, c.companyId, null, basis);
      expect(Object.keys(byKey(si.rows, 'sales'))).toContain('none');
      expect(byKey(si.rows, 'sales')).toEqual(dropZero(Object.fromEntries((ssi.data as Array<{ item_id: string | null; total: string }>).map((r) => [r.item_id ?? 'none', D(r.total)]))));
      if (basis === 'accrual') {
        // The line client wins; the journal entry is not a sale; the discount reduces sales.
        expect(byKey(sc.rows, 'sales')[customer2]).toBe(D('40'));
      }
    });

    it(`Balance Sheet (with and without a Retained Earnings account, 4-4-5 year start) and Trial Balance (${basis})`, async () => {
      for (const reDesignated of [true, false]) {
        if (reAccount && !reDesignated) await db.update(accounts).set({ systemTag: null }).where(eq(accounts.id, reAccount));
        try {
          for (const fy of [FY, ['2024-12-29', '2025-12-28']]) {
            const fyStart = fy[1]!;
            const std = await reportService.buildBalanceSheet(c.tenantId, AS_OF, basis, c.companyId, null, null, { exactAmounts: true, fiscalYearStart: fyStart }) as unknown as Record<string, unknown>;
            const bs = await run('balance_sheet', { dates: { asOf: AS_OF }, basis, fiscalYearStarts: fy });
            expect(total(bs.rows, 'assets')).toBe(D(std['totalAssetsExact'] as string));
            expect(total(bs.rows, 'liabilities')).toBe(D(std['totalLiabilitiesExact'] as string));
            expect(total(bs.rows, 'equity')).toBe(D(std['totalEquityExact'] as string));
            // Per account; the designated RE account folds in the prior years' row.
            const stdAssets = dropZero(Object.fromEntries((std['assets'] as Array<{ accountId: string | null; balanceExact?: string }>).filter((e) => e.accountId).map((e) => [e.accountId!, D(e.balanceExact)])));
            expect(Object.keys(stdAssets).length).toBeGreaterThan(0);
            expect(byKey(bs.rows, 'assets')).toEqual(stdAssets);
            const prior = bs.rows.find((r) => r.kind === 'earnings' && r.path[1] === 'earnings:prior');
            const equityStd = std['equity'] as Array<{ accountId: string | null; balanceExact?: string; name: string }>;
            if (reDesignated && reAccount) {
              const stdRe = equityStd.find((e) => e.accountId === reAccount);
              const mine = new Decimal(byKey(bs.rows, 'equity')[reAccount] ?? 0).plus(prior?.cells[0] ?? 0);
              expect(mine.toFixed(4)).toBe(D(stdRe?.balanceExact));
            } else {
              const stdPrior = equityStd.find((e) => e.name === 'Retained Earnings (Prior Years)');
              expect(D(prior?.cells[0])).toBe(D(stdPrior?.balanceExact));
            }
          }
          const tbStd = await reportService.buildTrialBalance(c.tenantId, '2026-01-01', AS_OF, c.companyId, null, basis, { exactAmounts: true }) as unknown as Record<string, unknown>;
          const tb = await run('trial_balance', { dates: { asOf: AS_OF }, basis });
          const t = tb.rows.find((r) => r.kind === 'total' && r.nodeId === 'accounts')!;
          expect(D(t.cells[0])).toBe(D(tbStd['totalDebitsExact'] as string));
          expect(D(t.cells[1])).toBe(D(tbStd['totalCreditsExact'] as string));
          const tbStdRows = Object.fromEntries((tbStd['data'] as Array<{ accountId?: string | null; netExact?: string }>).filter((r) => r.accountId).map((r) => [r.accountId!, D(r.netExact)]));
          const mine = Object.fromEntries(tb.rows.filter((r) => r.kind === 'line').map((r) => [r.path[1]!.split(':')[1]!, new Decimal(r.cells[0] ?? 0).minus(r.cells[1] ?? 0).toFixed(4)]));
          expect(Object.keys(dropZero(mine)).length).toBeGreaterThan(3);
          expect(dropZero(mine)).toEqual(dropZero(tbStdRows));
        } finally {
          if (reAccount && !reDesignated) await db.update(accounts).set({ systemTag: 'retained_earnings' }).where(eq(accounts.id, reAccount));
        }
      }
    });

    it(`Bank Account Balances (${basis})`, async () => {
      const bb = await run('bank_balances', { dates: { asOf: AS_OF }, basis });
      const std = await reportService.buildBalanceSheet(c.tenantId, AS_OF, basis, c.companyId, null, null, { exactAmounts: true }) as unknown as Record<string, unknown>;
      const bankStd = (std['assets'] as Array<{ accountId: string | null; balanceExact?: string }>).find((e) => e.accountId === c.bank);
      expect(byKey(bb.rows, 'banks')[c.bank]).toBe(D(bankStd?.balanceExact));
    });
  }

  it('A/R and A/P aging summaries, open items and balance summaries (exact, as of the date)', async () => {
    for (const asOf of ['2026-04-30', AS_OF, '2026-07-31']) {
      const ar = await run('ar_aging_summary', { dates: { asOf } });
      const std = await reportService.buildARAgingSummary(c.tenantId, asOf, c.companyId);
      const cols = ['current', 'd1_30', 'd31_60', 'd61_90', 'over_90'];
      const stdKeys = ['current', 'days1to30', 'days31to60', 'days61to90', 'over90'] as const;
      expect(std.customers.length).toBeGreaterThan(0);
      for (const cust of std.customers) {
        const line = ar.rows.find((r) => r.kind === 'line' && r.path[1] === `contact:${cust.contactId ?? 'none'}`);
        cols.forEach((_, i) => expect(D(line?.cells[i]), `${asOf} ${cust.name} ${stdKeys[i]}`).toBe(D(cust.bucketsExact[stdKeys[i]!])));
      }
      expect(total(ar.rows, 'receivables', 5)).toBe(D(std.totalExact));
      const cb = await run('customer_balance_summary', { dates: { asOf } });
      const scb = await openBalances.buildCustomerBalanceAsOf(c.tenantId, asOf, c.companyId, null, false);
      expect(byKey(cb.rows, 'receivables')).toEqual(dropZero(Object.fromEntries(scb.data.map((r) => [r.id ?? 'none', D(r.balance)]))));
      const ap = await run('ap_aging_summary', { dates: { asOf } });
      const sap = await openBalances.buildApAgingAsOf(c.tenantId, asOf, c.companyId, null);
      expect(total(ap.rows, 'payables', 5)).toBe(D(sap.totalsExact.total));
      const vb = await run('vendor_balance_summary', { dates: { asOf } });
      const svb = await openBalances.buildVendorBalanceAsOf(c.tenantId, asOf, c.companyId, null, false);
      expect(byKey(vb.rows, 'payables')).toEqual(dropZero(Object.fromEntries(svb.data.map((r) => [r.id ?? 'none', D(r.balance)]))));
    }
    // Two items open 10.005: 20.0100 exact on the builder, the aging and the balance summary.
    const ar = await run('customer_balance_summary', { dates: { asOf: AS_OF } });
    expect(byKey(ar.rows, 'receivables')[customer3]).toBe('20.0100');
  });
});
