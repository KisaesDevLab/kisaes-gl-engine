// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// As-of A/P aging and open balances (U-121 A/P half; ap-aging-exact-v1,
// open-balances-asof-v1; ClientLedger P28 PR-D). Guards:
//   - a payment dated after the as-of date doesn't count (A/P and A/R);
//   - a vendor credit partly applied after the date, then refunded;
//   - an early-payment discount settles the bill with the cash;
//   - a voided bill payment never counts;
//   - every report's total is the Decimal sum of its rows and the A/P or
//     A/R ledger balance on the date (aging = balance summary = ledger);
//   - A/R and A/P agree on a mirrored story (buckets, balances);
//   - Open Invoices and Unpaid Bills as of a date;
//   - new parameters need exact=1; legacy responses are unchanged.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, pool } from '../db/index.js';
import { accounts, contacts, paymentApplications } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as billService from '../services/bill.service.js';
import * as vendorCreditService from '../services/vendor-credit.service.js';
import * as billPaymentService from '../services/bill-payment.service.js';
import * as depositService from '../services/deposit.service.js';
import { apOpenItemsAsOf } from '../services/ap-open-items.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

const Decimal = DecimalLib.default || DecimalLib;
const D = (x: unknown) => new Decimal(String(x ?? 0));
const sumOf = (rows: any[], key: string) => rows.reduce((acc: InstanceType<typeof Decimal>, r) => acc.plus(D(r[key])), new Decimal(0));
const EXACT_RE = /^-?\d+\.\d{4,}$/;

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let companyId = '';
const ids: Record<string, string> = {};

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    bill_payment_applications, vendor_credit_applications,
    transactions, contacts, tags, tag_groups, api_keys, sessions,
    accounts, companies, users, tenants
    CASCADE`);
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
        try { body = JSON.parse(data); } catch { /* csv */ }
        res({ status: resp.statusCode!, body });
      });
    });
    r.on('error', rej);
    r.end();
  });
}

async function systemAccount(tag: string, name: string, number: string, accountType: string, detailType: string) {
  const found = await db.query.accounts.findFirst({ where: (a, { and, eq }) => and(eq(a.tenantId, tenantId), eq(a.systemTag, tag)) });
  if (found) return found;
  const [a] = await db.insert(accounts).values({ tenantId, name, accountNumber: number, accountType, detailType, systemTag: tag, isSystem: true } as typeof accounts.$inferInsert).returning();
  return a!;
}
async function mkAccount(name: string, accountNumber: string, accountType: string, detailType: string) {
  const [a] = await db.insert(accounts).values({ tenantId, name, accountNumber, accountType, detailType } as typeof accounts.$inferInsert).returning();
  return a!;
}
async function mkContact(displayName: string, contactType: 'vendor' | 'customer') {
  const [c] = await db.insert(contacts).values({ tenantId, companyId, contactType, displayName } as typeof contacts.$inferInsert).returning();
  return c!.id;
}

/** The A/P (credit - debit) or A/R (debit - credit) ledger balance on a date. */
async function ledgerBalance(tag: 'accounts_payable' | 'accounts_receivable', asOf: string) {
  const sign = tag === 'accounts_payable' ? sql`jl.credit - jl.debit` : sql`jl.debit - jl.credit`;
  const r = await db.execute(sql`
    SELECT COALESCE(SUM(${sign}), 0)::text AS bal FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND t.company_id = ${companyId} AND t.status = 'posted'
      AND a.system_tag = ${tag} AND t.txn_date <= ${asOf}::date`);
  return D((r.rows[0] as { bal: string }).bal);
}

beforeAll(async () => {
  await cleanDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((done) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; done(); }); });

  const reg = await authService.register({
    email: `open-balances-${Date.now()}@example.com`, password: 'password123456', displayName: 'Open Balances', companyName: 'Open Balances Co',
  });
  token = reg.tokens.accessToken;
  tenantId = reg.user.tenantId;
  companyId = (await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.tenantId, tenantId) }))!.id;

  const ap = await systemAccount('accounts_payable', 'Accounts Payable', '2000', 'liability', 'accounts_payable');
  const ar = await systemAccount('accounts_receivable', 'Accounts Receivable', '1200', 'asset', 'accounts_receivable');
  const bank = await mkAccount('OB Checking', '1010', 'asset', 'bank');
  const supplies = await mkAccount('OB Supplies', '6010', 'expense', 'other_business_expenses');
  const discountsTaken = await mkAccount('OB Discounts Taken', '4910', 'revenue', 'other_primary_income');
  const sales = await mkAccount('OB Sales', '4010', 'revenue', 'sales_of_product_income');
  const discountsGiven = await mkAccount('OB Discounts Given', '6910', 'expense', 'other_business_expenses');
  Object.assign(ids, { ap: ap.id, ar: ar.id, bank: bank.id });

  // ── A/P story (vendor Ada) ──
  const ada = await mkContact('Ada Supply', 'vendor');
  const bo = await mkContact('Bo Parts', 'vendor');
  ids['ada'] = ada; ids['bo'] = bo;
  const bill = (contactId: string, txnDate: string, dueDate: string, amount: string) =>
    billService.createBill(tenantId, { contactId, txnDate, dueDate, lines: [{ accountId: supplies.id, amount }] }, undefined, companyId);
  const b1 = await bill(ada, '2026-09-01', '2026-10-01', '1000.00');
  const b2 = await bill(ada, '2026-10-15', '2026-11-14', '300.00');
  // 0.1 + 0.2 on another vendor, current on every date tested.
  await bill(bo, '2026-11-01', '2027-01-31', '0.10');
  await bill(bo, '2026-11-02', '2027-01-31', '0.20');
  const vc1 = await vendorCreditService.createVendorCredit(tenantId, {
    contactId: ada, txnDate: '2026-10-20', lines: [{ accountId: supplies.id, amount: '100.00', description: 'Returned' }],
  }, undefined, companyId);
  ids['b1'] = b1.id; ids['b2'] = b2.id; ids['vc1'] = vc1.id;
  const pay = (input: Partial<Parameters<typeof billPaymentService.payBills>[1]>) =>
    billPaymentService.payBills(tenantId, { bankAccountId: bank.id, method: 'ach', bills: [], ...input } as Parameters<typeof billPaymentService.payBills>[1], undefined, companyId);
  // 10-10: 400 on B1.
  await pay({ txnDate: '2026-10-10', bills: [{ billId: b1.id, amount: '400.00' }] });
  // 11-20: 300 on B2, voided later: never counts.
  const voided = await pay({ txnDate: '2026-11-20', bills: [{ billId: b2.id, amount: '300.00' }] });
  await billPaymentService.voidBillPayment(tenantId, voided.payments[0]!.id, 'entered by mistake');
  // 12-05 (after the 11-30 as-of): the rest of B1 = 500 cash + 10 discount + 90 of the credit.
  await pay({
    txnDate: '2026-12-05', discountAccountId: discountsTaken.id,
    bills: [{ billId: b1.id, amount: '590.00', discountAmount: '10.00' }],
    credits: [{ creditId: vc1.id, billId: b1.id, amount: '90.00' }],
  });
  // 12-10: the vendor refunds the last 10 of the credit.
  await depositService.createDeposit(tenantId, {
    txnDate: '2026-12-10', depositToAccountId: bank.id,
    lines: [{ accountId: ap.id, amount: '10.00', sourceTransactionId: vc1.id }],
  }, undefined, companyId);

  // ── A/R mirror (customer Cy): same amounts and dates, no refund ──
  const cy = await mkContact('Cy Customer', 'customer');
  ids['cy'] = cy;
  const post = (input: Record<string, unknown>) =>
    ledger.postTransaction(tenantId, input as unknown as Parameters<typeof ledger.postTransaction>[1], undefined, companyId);
  const invoice = (txnDate: string, dueDate: string, amount: string) => post({
    txnType: 'invoice', txnDate, dueDate, contactId: cy, total: amount, memo: 'Invoice',
    lines: [{ accountId: ar.id, debit: amount, credit: '0' }, { accountId: sales.id, debit: '0', credit: amount }],
  });
  const i1 = await invoice('2026-09-01', '2026-10-01', '1000.00');
  await invoice('2026-10-15', '2026-11-14', '300.00');
  const cm = await post({
    txnType: 'credit_memo', txnDate: '2026-10-20', contactId: cy, total: '100.00', memo: 'Credit',
    lines: [{ accountId: sales.id, debit: '100.00', credit: '0' }, { accountId: ar.id, debit: '0', credit: '100.00' }],
  });
  ids['i1'] = i1.id; ids['cm'] = cm.id;
  const p1 = await post({
    txnType: 'customer_payment', txnDate: '2026-10-10', contactId: cy, total: '400.00', memo: 'Pay',
    lines: [{ accountId: bank.id, debit: '400.00', credit: '0' }, { accountId: ar.id, debit: '0', credit: '400.00' }],
  });
  await db.insert(paymentApplications).values({ tenantId, companyId, paymentId: p1.id, invoiceId: i1.id, amount: '400.00' });
  const p2 = await post({
    txnType: 'customer_payment', txnDate: '2026-12-05', contactId: cy, total: '500.00', memo: 'Pay',
    lines: [
      { accountId: bank.id, debit: '500.00', credit: '0' },
      { accountId: discountsGiven.id, debit: '10.00', credit: '0' },
      { accountId: ar.id, debit: '0', credit: '510.00' },
    ],
  });
  await db.insert(paymentApplications).values({ tenantId, companyId, paymentId: p2.id, invoiceId: i1.id, amount: '500.00', discountAmount: '10.00' });
  await db.insert(paymentApplications).values({ tenantId, companyId, paymentId: cm.id, invoiceId: i1.id, amount: '90.00', appliedDate: '2026-12-05' });
}, 60000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('U-121 A/P half and as-of open balances', () => {
  it('advertises both capabilities', () => {
    expect(DESKTOP_CAPABILITIES).toContain('ap-aging-exact-v1');
    expect(DESKTOP_CAPABILITIES).toContain('open-balances-asof-v1');
  });

  it('A/P aging as of 11-30: a later payment, discount and credit do not count; a voided payment never does', async () => {
    const r = await get('/ap-aging-summary?as_of_date=2026-11-30&exact=1');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.meta).toMatchObject({ exact: true, asOf: '2026-11-30' });
    const ada = r.body.vendors.find((v: any) => v.contact_id === ids['ada']);
    // B1 600 (31-60, due 10-01), B2 300 (1-30, due 11-14), VC1 -100 (dated 10-20: 31-60).
    expect(ada).toMatchObject({
      currentExact: '0.0000', bucket1to30Exact: '300.0000', bucket31to60Exact: '500.0000', bucket61to90Exact: '0.0000',
      bucketOver90Exact: '0.0000', totalExact: '800.0000',
    });
    const b1 = r.body.details.find((d: any) => d.bill_id === ids['b1']);
    expect(b1).toMatchObject({ txn_date: '2026-09-01', due_date: '2026-10-01' });
    expect(b1).toMatchObject({ kind: 'bill', txn_type: 'bill', totalExact: '1000.0000', paidExact: '400.0000', balanceExact: '600.0000', bucket: '31_60', days_overdue: 60 });
    const credit = r.body.details.find((d: any) => d.bill_id === ids['vc1']);
    expect(credit).toMatchObject({ kind: 'credit', txn_type: 'vendor_credit', balanceExact: '-100.0000' });
    // 0.1 + 0.2 exact.
    expect(r.body.vendors.find((v: any) => v.contact_id === ids['bo']).totalExact).toBe('0.3000');
    for (const k of ['current', 'bucket1to30', 'bucket31to60', 'bucket61to90', 'bucketOver90', 'total']) {
      expect(D(r.body.totalsExact[k]).eq(sumOf(r.body.vendors, `${k}Exact`)), k).toBe(true);
    }
    expect(D(r.body.totalsExact.total).eq(sumOf(r.body.details, 'balanceExact'))).toBe(true);
    expect(r.body.totalsExact.total).toBe('800.3000');
    expect(D(r.body.totalsExact.total).eq(await ledgerBalance('accounts_payable', '2026-11-30'))).toBe(true);
    // Detail answers the same.
    const detail = (await get('/ap-aging-detail?as_of_date=2026-11-30&exact=1')).body;
    expect(detail.totalsExact).toEqual(r.body.totalsExact);
  });

  it('A/P aging after the payment and the refund: the bill and the credit are settled', async () => {
    const mid = (await get('/ap-aging-summary?as_of_date=2026-12-06&exact=1')).body;
    // B1 paid (500 + 10 discount + 90 credit); 10 of the credit left until the 12-10 refund.
    expect(mid.details.find((d: any) => d.bill_id === ids['b1'])).toBeUndefined();
    expect(mid.details.find((d: any) => d.bill_id === ids['vc1']).balanceExact).toBe('-10.0000');
    expect(mid.vendors.find((v: any) => v.contact_id === ids['ada']).totalExact).toBe('290.0000');
    const end = (await get('/ap-aging-summary?as_of_date=2026-12-31&exact=1')).body;
    expect(end.details.find((d: any) => d.bill_id === ids['vc1'])).toBeUndefined();
    expect(end.vendors.find((v: any) => v.contact_id === ids['ada']).totalExact).toBe('300.0000');
    for (const [body, date] of [[mid, '2026-12-06'], [end, '2026-12-31']] as const) {
      expect(D(body.totalsExact.total).eq(await ledgerBalance('accounts_payable', date)), date).toBe(true);
    }
    // Before any bill: empty, zero totals.
    const before = (await get('/ap-aging-summary?as_of_date=2026-01-01&exact=1')).body;
    expect(before.vendors).toEqual([]);
    expect(before.totalsExact.total).toBe('0.0000');
  });

  it('the open items move each application exactly once (vendor sums = ledger per vendor)', async () => {
    for (const asOf of ['2026-10-10', '2026-11-30', '2026-12-05', '2026-12-10']) {
      const items = await apOpenItemsAsOf(db, { tenantId, companyId, asOf, contactIds: [ids['ada']!] });
      const r = await db.execute(sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS bal FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id JOIN accounts a ON a.id = jl.account_id
        WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted' AND a.system_tag = 'accounts_payable'
          AND COALESCE(jl.contact_id, t.contact_id) = ${ids['ada']} AND t.txn_date <= ${asOf}::date`);
      expect(sumOf(items, 'openExact').eq(D((r.rows[0] as { bal: string }).bal)), asOf).toBe(true);
    }
  });

  it('Unpaid Bills as of a date', async () => {
    const r = await get('/unpaid-bills?as_of_date=2026-11-30&exact=1');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.meta.asOf).toBe('2026-11-30');
    const b1 = r.body.data.find((d: any) => d.id === ids['b1']);
    expect(b1).toMatchObject({
      bill_status: 'partial', totalExact: '1000.0000', amount_paidExact: '400.0000', discount_amountExact: '0.0000',
      credits_appliedExact: '0.0000', balance_dueExact: '600.0000',
    });
    expect(r.body.data.find((d: any) => d.id === ids['b2'])).toMatchObject({ bill_status: 'unpaid', balance_dueExact: '300.0000' });
    expect(r.body.data.every((d: any) => d.id !== ids['vc1'])).toBe(true);
    for (const f of ['total', 'amount_paid', 'discount_amount', 'credits_applied', 'balance_due']) {
      expect(D(r.body.totalsExact[f]).eq(sumOf(r.body.data, `${f}Exact`)), f).toBe(true);
    }
    expect(r.body.totalsExact.balance_due).toBe('900.3000');
    // On 12-06 B1 is settled; overdue_only means due before the as-of date.
    const later = (await get(`/unpaid-bills?as_of_date=2026-12-06&overdue_only=true&contact_id=${ids['ada']}&exact=1`)).body;
    expect(later.data.map((d: any) => d.id)).toEqual([ids['b2']]);
    // A bill paid today but open on 11-30 shows its as-of payments.
    const partial = (await get('/unpaid-bills?as_of_date=2026-10-09&exact=1')).body;
    expect(partial.data.find((d: any) => d.id === ids['b1']).balance_dueExact).toBe('1000.0000');
  });

  it('Vendor Balance Summary / Detail: open balances with credits, total = aging total = ledger', async () => {
    const s = (await get('/vendor-balance-summary?as_of_date=2026-11-30&exact=1')).body;
    expect(s.meta.asOf).toBe('2026-11-30');
    expect(s.data.find((r: any) => r.id === ids['ada'])).toMatchObject({ display_name: 'Ada Supply', balanceExact: '800.0000' });
    expect(D(s.totalsExact.balance).eq(sumOf(s.data, 'balanceExact'))).toBe(true);
    const aging = (await get('/ap-aging-summary?as_of_date=2026-11-30&exact=1')).body;
    expect(s.totalsExact.balance).toBe(aging.totalsExact.total);
    const d = (await get('/vendor-balance-detail?as_of_date=2026-11-30&exact=1')).body;
    const ada = d.data.find((r: any) => r.id === ids['ada']);
    expect(ada.items.map((i: any) => [i.txnId, i.openExact])).toEqual([
      [ids['b1'], '600.0000'], [ids['b2'], '300.0000'], [ids['vc1'], '-100.0000'],
    ]);
    expect(ada.items.at(-1).runningBalanceExact).toBe(ada.balanceExact);
    expect(ada.items[0]).toMatchObject({ date: '2026-09-01', dueDate: '2026-10-01' });
    expect(ada.items[2]).toMatchObject({ date: '2026-10-20', dueDate: null });
    expect(D(ada.balanceExact).eq(sumOf(ada.items, 'openExact'))).toBe(true);
    expect((await get('/vendor-balance-detail?as_of_date=2026-11-30')).status).toBe(400);
  });

  it('Customer Balance Summary / Detail and Open Invoices as of a date (A/R)', async () => {
    const s = (await get('/customer-balance-summary?as_of_date=2026-11-30&exact=1')).body;
    // I1 600 + I2 300 - CM 100 (its 90 applies on 12-05).
    expect(s.data.find((r: any) => r.id === ids['cy']).balanceExact).toBe('800.0000');
    const arAging = (await get('/ar-aging-summary?as_of_date=2026-11-30')).body;
    expect(D(s.totalsExact.balance).eq(D(arAging.totalExact))).toBe(true);
    expect(D(s.totalsExact.balance).eq(await ledgerBalance('accounts_receivable', '2026-11-30'))).toBe(true);
    const d = (await get('/customer-balance-detail?as_of_date=2026-11-30&exact=1')).body;
    const cy = d.data.find((r: any) => r.id === ids['cy']);
    expect(cy.items.map((i: any) => i.openExact)).toEqual(['600.0000', '300.0000', '-100.0000']);
    expect(cy.items.find((i: any) => i.txnId === ids['cm']).kind).toBe('credit');
    const oi = (await get('/invoice-list?open=1&as_of_date=2026-11-30&exact=1')).body;
    expect(oi.meta.asOf).toBe('2026-11-30');
    expect(oi.data.find((r: any) => r.id === ids['i1'])).toMatchObject({ txn_date: '2026-09-01', due_date: '2026-10-01', totalExact: '1000.0000', amount_paidExact: '400.0000', balance_dueExact: '600.0000', days_overdue: 60 });
    expect(D(oi.totalsExact.balance_due).eq(sumOf(oi.data, 'balance_dueExact'))).toBe(true);
    expect(oi.totalsExact.balance_due).toBe('900.0000');
    // After 12-05, I1 is settled (500 + 10 discount + 90 credit).
    const later = (await get('/invoice-list?open=1&as_of_date=2026-12-31&exact=1')).body;
    expect(later.data.map((r: any) => r.id)).not.toContain(ids['i1']);
    // The invoice-date range still applies.
    const ranged = (await get('/invoice-list?open=1&as_of_date=2026-11-30&start_date=2026-10-01&end_date=2026-10-31&exact=1')).body;
    expect(ranged.data.map((r: any) => r.id)).not.toContain(ids['i1']);
    expect(ranged.data).toHaveLength(1);
  });

  it('A/R and A/P agree on the mirrored story', async () => {
    for (const asOf of ['2026-10-31', '2026-11-30', '2026-12-06']) {
      const ap = (await get(`/ap-aging-summary?as_of_date=${asOf}&exact=1`)).body.vendors.find((v: any) => v.contact_id === ids['ada']);
      const ar = (await get(`/ar-aging-summary?as_of_date=${asOf}`)).body.customers.find((c: any) => c.contactId === ids['cy']);
      const pairs: Array<[string, string]> = [['currentExact', 'current'], ['bucket1to30Exact', 'days1to30'], ['bucket31to60Exact', 'days31to60'],
        ['bucket61to90Exact', 'days61to90'], ['bucketOver90Exact', 'over90']];
      for (const [apKey, arKey] of pairs) expect(D(ap[apKey]).eq(D(ar.buckets[arKey])), `${asOf} ${apKey}`).toBe(true);
      const vb = (await get(`/vendor-balance-summary?as_of_date=${asOf}&exact=1`)).body.data.find((r: any) => r.id === ids['ada']);
      const cb = (await get(`/customer-balance-summary?as_of_date=${asOf}&exact=1`)).body.data.find((r: any) => r.id === ids['cy']);
      expect(vb.balanceExact, asOf).toBe(cb.balanceExact);
    }
  });

  it('every amount is an exact string', async () => {
    const r = (await get('/ap-aging-detail?as_of_date=2026-11-30&exact=1')).body;
    for (const d of r.details) for (const k of ['totalExact', 'paidExact', 'balanceExact']) expect(d[k], k).toMatch(EXACT_RE);
  });

  it('new parameters need exact=1; legacy responses are unchanged', async () => {
    for (const path of [
      '/customer-balance-summary?as_of_date=2026-11-30', '/vendor-balance-summary?as_of_date=2026-11-30',
      '/unpaid-bills?as_of_date=2026-11-30', '/invoice-list?open=1', '/invoice-list?as_of_date=2026-11-30&exact=1',
      '/invoice-list?open=1&status=paid&exact=1', '/customer-balance-summary?as_of_date=11/30/2026&exact=1',
    ]) {
      const r = await get(path);
      expect(r.status, path).toBe(400);
      expect(r.body.error.code, path).toBe('INVALID_PARAM');
    }
    const legacyVendors = (await get('/vendor-balance-summary')).body;
    expect(legacyVendors.meta).toBeUndefined();
    expect(legacyVendors.data[0]).toHaveProperty('total_spent');
    const legacyAging = (await get('/ap-aging-summary?as_of_date=2026-11-30')).body;
    expect(legacyAging.totalsExact).toBeUndefined();
    // Legacy A/P aging still reads today's bill balances (B2 300 + 0.10 + 0.20).
    expect(legacyAging.totals.total).toBe(300.3);
    const legacyUnpaid = (await get('/unpaid-bills')).body;
    expect(legacyUnpaid.meta).toBeUndefined();
  });
});
