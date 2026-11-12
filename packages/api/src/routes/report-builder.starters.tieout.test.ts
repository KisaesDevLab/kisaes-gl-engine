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
import { accounts, contacts, items, paymentApplications, billPaymentApplications, tags } from '../db/schema/index.js';
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
/** A starter's run with its detail-field columns cut off: cell 0 is the first value column. */
async function run(key: string, extra: Record<string, unknown>): Promise<{ rows: Row[]; columns: Array<{ key: string; kind: string }> }> {
  const r = await call('POST', '/run', { definition: starter(key), fiscalYearStarts: FY, expandAll: true, ...extra });
  expect(r.status, `${key} ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
  const cols = r.json.columns as Array<{ key: string; kind: string }>;
  const fv = cols.findIndex((x) => x.kind !== 'field');
  return { columns: cols.slice(fv), rows: (r.json.rows as Row[]).map((x) => ({ ...x, cells: x.cells.slice(fv) })) };
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
  // Journal entries on A/R and A/P with a name: open items, but not invoices or bills (U-119f).
  await post('journal_entry', '2026-04-05', [{ accountId: c.ar, debit: '15.00', credit: '0', contactId: customer2 }, { accountId: c.income, debit: '0', credit: '15.00' }]);
  await post('journal_entry', '2026-04-06', [{ accountId: c.expense2, debit: '8.00', credit: '0' }, { accountId: c.ap, debit: '0', credit: '8.00', contactId: c.vendor }]);
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

    it(`Transaction Detail by Account lists the standard General Ledger's accounts, signed as there (${basis})`, async () => {
      let openingOnly = 0;
      for (const dates of [RANGE, { from: '2026-05-01', to: AS_OF }]) {
        const r = await call('POST', '/run', { definition: starter('transaction_detail_by_account'), fiscalYearStarts: FY, dates, basis, expandAll: true });
        expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
        const cols = r.json.columns as Col[];
        const rows = r.json.rows as DRow[];
        const tot = cols.findIndex((x) => x.key === 'total');
        const bal = cols.findIndex((x) => x.key === 'f:running_balance');
        expect(cols.some((x) => x.key === 'f:amount')).toBe(false);
        const std = await reportService.buildGeneralLedger(c.tenantId, dates.from, dates.to, c.companyId, null, basis, null, { exactAmounts: true, fiscalYearStart: '2026-01-01' });
        const accts = (std.accounts as Array<{ accountId: string; beginningBalanceExact: string; endingBalanceExact: string; netChangeExact: string } | null>).filter((a) => a !== null);
        const lines = rows.filter((x) => x.kind === 'line');
        expect(lines.map((l) => l.path[1]!.split(':')[1]).sort(), `${dates.from} accounts`).toEqual(accts.map((a) => a.accountId).sort());
        for (const a of accts) {
          const line = lines.find((l) => l.path[1] === `account:${a.accountId}`)!;
          expect(D(line.cells[tot]), `${dates.from} ${a.accountId} net`).toBe(D(a.netChangeExact));
          const under = rows.filter((x) => (x.kind === 'opening' || x.kind === 'detail') && x.path.join('/') === line.path.join('/'));
          expect(under[0]!.kind).toBe('opening');
          expect(D(under[0]!.cells[bal]), `${dates.from} ${a.accountId} opening`).toBe(D(a.beginningBalanceExact));
          expect(D(under[under.length - 1]!.cells[bal]), `${dates.from} ${a.accountId} ending`).toBe(D(a.endingBalanceExact));
          if (under.length === 1) openingOnly++;
        }
        if (dates === RANGE) {
          // Credit-balance accounts read positive, as on the standard report.
          const income = lines.find((l) => l.path[1] === `account:${c.income}`)!;
          expect(new Decimal(income.cells[tot]!).gt(0)).toBe(true);
          expect(income.nodeId).toBe('income');
        }
      }
      expect(openingOnly).toBeGreaterThan(0);
    });

    it(`Open Invoices and Unpaid Bills list the standard reports' documents, row by row (${basis})`, async () => {
      let seen = 0;
      for (const asOf of ['2026-04-30', AS_OF, '2026-07-31']) {
        const detailRows = (x: { rows: Row[] }) => (x.rows as DRow[]).filter((r) => r.kind === 'detail');
        const byTxn = (x: { rows: Row[] }) => Object.fromEntries(detailRows(x).map((r) => [(r as unknown as { fields: { txnId: string } }).fields.txnId, D(r.cells[0])]));
        const oi = await run('open_invoices', { dates: { asOf }, basis });
        const soi = await openBalances.buildOpenInvoicesAsOf(c.tenantId, asOf, {}, c.companyId);
        expect(byTxn(oi), `open invoices ${asOf}`).toEqual(Object.fromEntries(soi.data.map((d) => [d.id, D(d.balance_due)])));
        expect(total(oi.rows, 'receivables')).toBe(soi.data.reduce((acc, d) => acc.plus(d.balance_due), new Decimal(0)).toFixed(4));
        const ub = await run('unpaid_bills', { dates: { asOf }, basis });
        const sub = await openBalances.buildUnpaidBillsAsOf(c.tenantId, asOf, {}, c.companyId);
        expect(byTxn(ub), `unpaid bills ${asOf}`).toEqual(Object.fromEntries(sub.data.map((d) => [d.id, D(d.balance_due)])));
        expect(total(ub.rows, 'payables')).toBe(sub.data.reduce((acc, d) => acc.plus(d.balance_due), new Decimal(0)).toFixed(4));
        seen += soi.data.length + sub.data.length;
        // The journal entries on A/R and A/P are open items (the agings list them) but not documents of these reports.
        for (const key of ['ar_aging_detail', 'ap_aging_detail']) {
          const ag = await run(key, { dates: { asOf }, basis });
          expect(detailRows(ag).some((r) => (r as unknown as { fields: { txnType: string } }).fields.txnType === 'journal_entry'), `${key} ${asOf}`).toBe(true);
        }
      }
      expect(seen).toBeGreaterThan(3);
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

// ── Drills (A07 PR-E) ──────────────────────────────────────────────
// /run/detail drills every row it gives a drill: a section Total (every line of
// the section plus its earnings lines), an outer group-by line, an earnings
// row; `range` limits rows and subtotal to one column. Aging columns take no
// other dates; open-item detail rows keep their line's path.

type Col = { key: string; kind: string; range?: { from: string | null; to: string } };
type DRow = Row & { drill?: { type: string; nodeId?: string; path?: string[]; tagIds?: string[] } | null };
type RunJson = { rows: DRow[]; columns: Col[]; fingerprint: string; stamp: number };
const MONTHS_H1 = ['01', '02', '03', '04', '05', '06'].map((m) => ({ from: `2026-${m}-01`, to: `2026-${m}-${new Date(Date.UTC(2026, Number(m), 0)).getUTCDate()}` }));
/** Value columns a subtotal echoes (percent cells need the report's base, so they are null there). */
const valueCols = (cols: Col[]) => cols.map((x, i) => (['field', 'percent', 'hidden'].includes(x.kind) ? -1 : i)).filter((i) => i >= 0);

async function runDef(definition: unknown, ref: Record<string, unknown>): Promise<RunJson> {
  const r = await call('POST', '/run', { definition, fiscalYearStarts: FY, expandAll: true, ...ref });
  expect(r.status, JSON.stringify(r.json).slice(0, 300)).toBe(200);
  return r.json;
}
/** Every page of a drill (page size 500): the subtotal and each column's sum of the detail rows. */
async function drill(definition: unknown, ref: Record<string, unknown>, run: RunJson, nodeId: string, path: string[], range?: unknown) {
  const sums = run.columns.map(() => new Decimal(0));
  const rows: DRow[] = [];
  let subtotal: Array<string | null> = [];
  let cursor: string | null = null;
  do {
    const r = await call('POST', '/run/detail', { definition, fiscalYearStarts: FY, ...ref, nodeId, path, fingerprint: run.fingerprint, stamp: run.stamp, ...(range ? { range } : {}), ...(cursor ? { cursor } : {}) });
    expect(r.status, `${nodeId} ${path.join('/')} ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
    subtotal = r.json.subtotal;
    for (const row of r.json.rows as DRow[]) {
      if (row.kind !== 'detail') continue;
      rows.push(row);
      for (const i of valueCols(run.columns)) { const x = row.cells[i]; if (x !== null && x !== undefined) sums[i] = sums[i]!.plus(x); }
    }
    cursor = r.json.cursor;
  } while (cursor);
  return { subtotal, sums, rows };
}
const refFor = (key: string, basis: 'accrual' | 'cash') => {
  const d = starter(key);
  return { ...(d.dates.mode === 'range' ? { dates: RANGE } : { dates: { asOf: AS_OF } }), basis, ...(key === 'profit_loss_by_month' ? { periodRanges: MONTHS_H1 } : {}) };
};

describe('drills (A07 PR-E)', () => {
  for (const basis of ['accrual', 'cash'] as const) {
    it(`every starter's section Total drills: the detail subtotal = the Total cells = the sum of the rows (${basis})`, async () => {
      const drilled: string[] = [];
      const noDrill: string[] = [];
      const noTotal: string[] = [];
      let nonZero = 0;
      for (const { key } of BUILDER_STARTERS) {
        const def = starter(key);
        const ref = refFor(key, basis);
        const run = await runDef(def, ref);
        const totals = run.rows.filter((r) => r.kind === 'total');
        if (totals.length === 0) { noTotal.push(key); continue; }
        if (totals.every((t) => !t.drill)) { noDrill.push(key); continue; }
        drilled.push(key);
        for (const t of totals) {
          expect(t.drill).toMatchObject({ type: 'detail', nodeId: t.nodeId, path: [`n:${t.nodeId}`] });
          const d = await drill(def, ref, run, t.nodeId, t.drill!.path!);
          for (const i of valueCols(run.columns)) {
            expect(D(d.subtotal[i]), `${key} ${t.nodeId} ${run.columns[i]!.key} subtotal`).toBe(D(t.cells[i]));
            expect(d.sums[i]!.toFixed(4), `${key} ${t.nodeId} ${run.columns[i]!.key} rows`).toBe(D(t.cells[i]));
          }
          if (t.cells.some((x) => x !== null && !new Decimal(x).isZero())) nonZero++;
        }
      }
      expect(noTotal.sort()).toEqual(['check_register', 'transaction_detail_by_account']);
      expect(noDrill).toEqual(['trial_balance']);
      expect(drilled).toHaveLength(BUILDER_STARTERS.length - 3);
      expect(nonZero).toBeGreaterThan(20);
    });

    it(`earnings rows drill to their lines; the current-year row = the P&L net income (${basis})`, async () => {
      for (const key of ['balance_sheet', 'trial_balance']) {
        const def = starter(key);
        const ref = refFor(key, basis);
        const run = await runDef(def, ref);
        const earnings = run.rows.filter((r) => r.kind === 'earnings');
        expect(earnings.length).toBeGreaterThan(0);
        for (const e of earnings) {
          const d = await drill(def, ref, run, e.nodeId, e.path);
          for (const i of valueCols(run.columns)) {
            expect(D(d.subtotal[i]), `${key} ${e.path[1]} subtotal`).toBe(D(e.cells[i]));
            if (key === 'balance_sheet') expect(d.sums[i]!.toFixed(4), `${key} ${e.path[1]} rows`).toBe(D(e.cells[i]));
          }
          expect(d.rows.length).toBeGreaterThan(0);
          if (e.path[1] === 'earnings:current') {
            const pl = await reportService.buildProfitAndLoss(c.tenantId, '2026-01-01', AS_OF, basis, c.companyId, null, null, { exactAmounts: true });
            expect(D(e.cells[valueCols(run.columns)[0]!])).toBe(D(pl.netIncomeExact));
          }
        }
      }
    });

    it(`outer group-by lines drill (two levels, a "none" key, lines and open items) (${basis})`, async () => {
      const lineDef = starter('profit_loss');
      for (const n of lineDef.nodes) if (n.type === 'section') n.groupBy = [{ key: 'contact' }, { key: 'account' }];
      const openDef = starter('ar_aging_detail');
      for (const n of openDef.nodes) if (n.type === 'section') n.groupBy = [{ key: 'contact' }, { key: 'due_status' }];
      let sawNone = false;
      const cases: Array<[BuilderDefinition, Record<string, unknown>]> = [[lineDef, { dates: RANGE, basis }], [openDef, { dates: { asOf: AS_OF }, basis }]];
      for (const [def, ref] of cases) {
        const run = await runDef(def, ref);
        const outer = run.rows.filter((r) => r.kind === 'line' && r.path.length === 2);
        expect(outer.length).toBeGreaterThan(1);
        for (const l of outer) {
          if (l.path[1]!.endsWith(':none')) sawNone = true;
          const d = await drill(def, ref, run, l.nodeId, l.path);
          const inner = run.rows.filter((r) => r.kind === 'line' && r.path.length === 3 && r.path[0] === l.path[0] && r.path[1] === l.path[1]);
          for (const i of valueCols(run.columns)) {
            expect(D(d.subtotal[i])).toBe(D(l.cells[i]));
            expect(d.sums[i]!.toFixed(4)).toBe(D(l.cells[i]));
            expect(inner.reduce((acc, r) => acc.plus(r.cells[i] ?? 0), new Decimal(0)).toFixed(4)).toBe(D(l.cells[i]));
          }
        }
      }
      expect(sawNone).toBe(true);
      // A path that is not a prefix of the group-bys, or an earnings path on a section without earnings, is refused.
      const run = await runDef(lineDef, { dates: RANGE, basis });
      const bad = await call('POST', '/run/detail', { definition: lineDef, fiscalYearStarts: FY, dates: RANGE, basis, nodeId: 'income', path: ['n:income', `account:${c.income}`], fingerprint: run.fingerprint, stamp: run.stamp });
      expect(bad.status).toBe(400);
      const bad2 = await call('POST', '/run/detail', { definition: lineDef, fiscalYearStarts: FY, dates: RANGE, basis, nodeId: 'income', path: ['n:income', 'earnings:prior'], fingerprint: run.fingerprint, stamp: run.stamp });
      expect(bad2.status).toBe(400);
    });

    it(`a period column drills to its own dates only (P&L by month, Balance Sheet as of two dates) (${basis})`, async () => {
      const def = starter('profit_loss_by_month');
      const ref = refFor('profit_loss_by_month', basis);
      const run = await runDef(def, ref);
      const marchCol = run.columns.findIndex((x) => x.kind === 'period' && x.range?.from === '2026-03-01');
      const totalCol = run.columns.findIndex((x) => x.key === 'total');
      expect(marchCol).toBeGreaterThan(-1);
      const inc = run.rows.find((r) => r.kind === 'total' && r.nodeId === 'income')!;
      expect(D(inc.cells[marchCol])).not.toBe(D(inc.cells[totalCol]));
      for (const row of [inc, ...run.rows.filter((r) => r.kind === 'line' && r.nodeId === 'income')]) {
        const d = await drill(def, ref, run, row.nodeId, row.kind === 'total' ? [`n:${row.nodeId}`] : row.path, run.columns[marchCol]!.range);
        expect(D(d.subtotal[marchCol])).toBe(D(row.cells[marchCol]));
        expect(D(d.subtotal[totalCol])).toBe(D(row.cells[marchCol]));
        expect(d.sums[marchCol]!.toFixed(4)).toBe(D(row.cells[marchCol]));
        run.columns.forEach((x, i) => { if (x.kind === 'period' && i !== marchCol) expect(d.subtotal[i]).toBeNull(); });
        for (const r of d.rows) expect(r.cells.filter((x, i) => x !== null && run.columns[i]!.kind === 'period' && i !== marchCol)).toEqual([]);
      }
      const notACol = await call('POST', '/run/detail', { definition: def, fiscalYearStarts: FY, ...ref, nodeId: 'income', path: ['n:income'], range: { from: '2026-03-01', to: '2026-03-15' }, fingerprint: run.fingerprint, stamp: run.stamp });
      expect(notACol.status).toBe(400);

      // As-of columns ({from: null, to}): each date's balances, including the equity section's earnings, across a fiscal year start.
      const bs = starter('balance_sheet');
      const bref = { dates: { asOf: AS_OF }, basis, periodRanges: [{ from: '2025-12-31', to: '2025-12-31' }, { from: AS_OF, to: AS_OF }] };
      const brun = await runDef(bs, bref);
      const cols = brun.columns.map((x, i) => (x.kind === 'period' ? i : -1)).filter((i) => i >= 0);
      expect(cols).toHaveLength(2);
      for (const t of brun.rows.filter((r) => r.kind === 'total' || r.kind === 'earnings')) {
        for (const ci of cols) {
          expect(brun.columns[ci]!.range!.from).toBeNull();
          const d = await drill(bs, bref, brun, t.nodeId, t.kind === 'total' ? [`n:${t.nodeId}`] : t.path, brun.columns[ci]!.range);
          expect(D(d.subtotal[ci]), `${t.nodeId} ${t.path.join('/')} ${brun.columns[ci]!.key}`).toBe(D(t.cells[ci]));
          expect(d.sums[ci]!.toFixed(4)).toBe(D(t.cells[ci]));
        }
      }
    });
  }

  it('aging columns refuse other dates; open-item detail rows keep their line path', async () => {
    const def = starter('ar_aging_summary');
    const two = await call('POST', '/run', { definition: def, fiscalYearStarts: FY, dates: { asOf: AS_OF }, periodRanges: [{ from: '2026-04-30', to: '2026-04-30' }, { from: AS_OF, to: AS_OF }] });
    expect(two.status).toBe(400);
    expect(two.json.error).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'periodRanges' } });
    const other = await call('POST', '/run', { definition: def, fiscalYearStarts: FY, dates: { asOf: AS_OF }, periodRanges: [{ from: '2026-04-30', to: '2026-04-30' }] });
    expect(other.status).toBe(400);
    const cmp = await call('POST', '/run', { definition: def, fiscalYearStarts: FY, dates: { asOf: AS_OF }, compareRanges: [[{ from: '2025-06-30', to: '2025-06-30' }]] });
    expect(cmp.status).toBe(400);
    expect(cmp.json.error).toMatchObject({ code: 'INVALID_PARAM', details: { field: 'compareRanges' } });
    const same = await call('POST', '/run', { definition: def, fiscalYearStarts: FY, dates: { asOf: AS_OF }, periodRanges: [{ from: AS_OF, to: AS_OF }] });
    expect(same.status).toBe(200);

    for (const key of ['ar_aging_detail', 'open_invoices', 'unpaid_bills']) {
      const run = await runDef(starter(key), { dates: { asOf: AS_OF } });
      const details = run.rows.filter((r) => r.kind === 'detail');
      expect(details.length, key).toBeGreaterThan(0);
      for (const r of details) {
        const parent = [...run.rows.slice(0, run.rows.indexOf(r))].reverse().find((x) => x.kind === 'line')!;
        expect(r.path).toEqual(parent.path);
        expect(r.path.length).toBe(2);
      }
    }
  });

  it('a tag-filtered Balance Sheet drills its earnings to a P&L of the same tag (tagIds)', async () => {
    const [tag] = await db.insert(tags).values({ tenantId: c.tenantId, companyId: c.companyId, name: `Job ${suffix()}` }).returning();
    await post('journal_entry', '2026-05-20', [{ accountId: c.bank, debit: '12.00', credit: '0', tagId: tag!.id } as L, { accountId: c.income, debit: '0', credit: '12.00', tagId: tag!.id } as L]);
    const def = starter('balance_sheet');
    for (const n of def.nodes) if (n.type === 'section') n.filters.push({ field: 'tag', op: 'in', ids: [tag!.id] });
    const ref = { dates: { asOf: AS_OF } };
    const run = await runDef(def, ref);
    const cur = run.rows.find((r) => r.kind === 'earnings' && r.path[1] === 'earnings:current')!;
    expect(cur.drill).toMatchObject({ type: 'profit_loss', from: '2026-01-01', to: AS_OF, tagIds: [tag!.id] });
    const v0 = valueCols(run.columns)[0]!;
    expect(D(cur.cells[v0])).toBe('12.0000');
    const d = await drill(def, ref, run, cur.nodeId, cur.path);
    expect(D(d.subtotal[v0])).toBe('12.0000');
    expect(d.rows).toHaveLength(1);
    // Untagged sections keep their drills without tagIds.
    const plain = await runDef(starter('balance_sheet'), ref);
    expect(plain.rows.find((r) => r.kind === 'earnings')!.drill).not.toHaveProperty('tagIds');
  });
});
