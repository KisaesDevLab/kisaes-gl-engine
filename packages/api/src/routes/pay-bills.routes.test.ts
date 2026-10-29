// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Pay Bills (U-101 bill-discounts-v1, U-102 idempotency-pay-bills-v1,
// U-103 bill-payment-check-number-v1, U-104 company scope) through the
// HTTP routes:
//   - the penny case: 1,286.40 + 1,412.06 + 218.44 (2 % -> 4.37) + 3,915.00
//     with a 250.00 credit; net cash 6,577.53; bank 84,210.55 -> 77,633.02;
//   - discountAvailable on /bills/payable?paymentDate=, the company setting
//     billDiscountAccountId, DISCOUNT_ACCOUNT_REQUIRED / _INVALID;
//   - partial payments, a bill settled by a credit plus a discount (no cash),
//     void reversing the discount, a credits-only bill reopening on void;
//   - Idempotency-Key replay; check numbers and CHECK_NUMBER_IN_USE;
//   - company scope on /bills/payable and GET /bill-payments(/:id).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, depositLines, transactionTags, tags, vendorCreditApplications, billPaymentApplications, userPermissions,
  idempotencyKeys,
} from '../db/schema/index.js';
import { billsRouter } from './bills.routes.js';
import { vendorCreditsRouter } from './vendor-credits.routes.js';
import { billPaymentsRouter } from './bill-payments.routes.js';
import { companyRouter } from './company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as billPaymentService from '../services/bill-payment.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

function request(method: string, pathname: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null, headers: res.headers }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanTenant(tid: string) {
  const txnIds = (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, tid))).map((r) => r.id);
  if (txnIds.length) await db.delete(depositLines).where(inArray(depositLines.depositId, txnIds));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tid));
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tid));
  await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(tags).where(eq(tags.tenantId, tid));
  await db.delete(contacts).where(eq(contacts.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

interface Co {
  tenantId: string; token: string; companyId: string;
  bank: string; ap: string; expense: string; discount: string;
  vendors: string[];
}

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `paybills-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `Pay Bills ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const ap = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_payable')) });
  const [expense] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1);
  const [discount] = await db.insert(accounts).values({
    tenantId, companyId: company!.id, name: 'Purchase Discounts', accountType: 'revenue', accountNumber: '4950',
  }).returning();
  const vendors: string[] = [];
  for (const name of ['Ozark Lumber', 'Branson Electric', 'Midwest Equipment Rental', 'Table Rock Supply']) {
    const [v] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: name }).returning();
    vendors.push(v!.id);
  }
  return {
    tenantId, token: reg.tokens.accessToken, companyId: company!.id,
    bank: bank!.id, ap: ap!.id, expense: expense!.id, discount: discount!.id, vendors,
  };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/bills', billsRouter);
  app.use('/api/v1/vendor-credits', vendorCreditsRouter);
  app.use('/api/v1/bill-payments', billPaymentsRouter);
  app.use('/api/v1/company', companyRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany('a');
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const row = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)).limit(1))[0]!;
const balanceOf = async (accountId: string) =>
  Number((await db.select({ b: accounts.balance }).from(accounts).where(eq(accounts.id, accountId)))[0]!.b).toFixed(2);

async function postBill(vendor: string, amount: string, extra: Record<string, unknown> = {}) {
  const r = await request('POST', '/api/v1/bills', c.token, {
    contactId: vendor, txnDate: '2026-11-01', paymentTerms: 'net_30',
    lines: [{ accountId: c.expense, amount }], ...extra,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.bill as { id: string };
}

async function postCredit(vendor: string, amount: string) {
  const r = await request('POST', '/api/v1/vendor-credits', c.token, {
    contactId: vendor, txnDate: '2026-11-02', vendorInvoiceNumber: 'CM-114', lines: [{ accountId: c.expense, amount }],
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.credit as { id: string };
}

const pay = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  request('POST', '/api/v1/bill-payments', c.token, {
    bankAccountId: c.bank, txnDate: '2026-11-04', method: 'check', printLater: true, ...body,
  }, headers);

const setDiscountAccount = (id: string | null) =>
  request('PUT', '/api/v1/company/settings', c.token, { billDiscountAccountId: id });

/** The 2 % / 5 net 15 bill of the mockup: dated 11/01, discount date 11/06. */
const discountTerms = { paymentTerms: 'custom', termsDays: 15, discountPercent: '2', discountDays: 5 };

describe('Pay Bills discounts (U-101, bill-discounts-v1)', () => {
  it('advertises the capabilities', () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining([
      'bill-discounts-v1', 'idempotency-pay-bills-v1', 'bill-payment-check-number-v1',
    ]));
  });

  it('penny case: 4 vendors, 2 % discount 4.37, credit 250.00, net cash 6,577.53, bank 84,210.55 -> 77,633.02, checks numbered', async () => {
    const [v1, v2, v3, v4] = c.vendors as [string, string, string, string];
    const b1 = await postBill(v1, '1286.40');
    const b2 = await postBill(v2, '1412.06');
    const b3 = await postBill(v3, '218.44', discountTerms);
    const b4 = await postBill(v4, '3915.00');
    const cm = await postCredit(v4, '250.00');
    await db.update(accounts).set({ balance: '84210.5500' }).where(eq(accounts.id, c.bank));

    // The engine rounds the discount (218.44 x 2 % = 4.3688 -> 4.37).
    const payable = await request('GET', '/api/v1/bills/payable?paymentDate=2026-11-04', c.token);
    expect(payable.status).toBe(200);
    const byId = new Map((payable.json.bills as Array<{ id: string; discountAvailable: string; updatedAt: string | null }>).map((b) => [b.id, b]));
    expect(byId.get(b3.id)!.discountAvailable).toBe('4.37');
    expect(byId.get(b1.id)!.discountAvailable).toBe('0.00');
    expect(byId.get(b3.id)!.updatedAt).toBeTruthy();
    expect((payable.json.credits as Array<{ id: string }>).map((x) => x.id)).toContain(cm.id);
    // After the discount date: nothing.
    const late = await request('GET', '/api/v1/bills/payable?paymentDate=2026-11-07', c.token);
    expect((late.json.bills as Array<{ id: string; discountAvailable: string }>).find((b) => b.id === b3.id)!.discountAvailable).toBe('0.00');

    // Company default discount account, readable after the write.
    expect((await setDiscountAccount(c.discount)).status).toBe(200);
    const settings = await request('GET', '/api/v1/company/settings', c.token);
    expect(settings.json.settings.billDiscountAccountId).toBe(c.discount);

    const r = await pay({
      printLater: false, checkNumber: '5001',
      bills: [
        { billId: b1.id, amount: '1286.40' },
        { billId: b2.id, amount: '1412.06' },
        { billId: b3.id, amount: '214.07', discountAmount: '4.37' },
        { billId: b4.id, amount: '3915.00' },
      ],
      credits: [{ creditId: cm.id, billId: b4.id, amount: '250.00' }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const payments = r.json.payments as Array<{ id: string; contactId: string; netPayment: string; discountTotal: string; checkNumber: number; printStatus: string }>;
    expect(payments.map((p) => p.contactId)).toEqual([v1, v2, v3, v4]);
    expect(payments.map((p) => p.netPayment)).toEqual(['1286.4000', '1412.0600', '214.0700', '3665.0000']);
    expect(payments.map((p) => p.discountTotal)).toEqual(['0.0000', '0.0000', '4.3700', '0.0000']);
    expect(payments.map((p) => p.checkNumber)).toEqual([5001, 5002, 5003, 5004]);
    expect(payments.every((p) => p.printStatus === 'hand_written')).toBe(true);
    const net = payments.reduce((s, p) => s + Math.round(Number(p.netPayment) * 100), 0);
    expect(net).toBe(657753);
    expect(await balanceOf(c.bank)).toBe('77633.02');
    expect(await balanceOf(c.discount)).toBe('-4.37');

    for (const b of [b1, b2, b3, b4]) {
      const bill = await row(b.id);
      expect(bill.billStatus).toBe('paid');
      expect(Number(bill.balanceDue)).toBe(0);
    }
    // The discount bill: cash 214.07 + discount 4.37 on its application row.
    const [app] = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.billId, b3.id));
    expect([app!.amount, app!.discountAmount]).toEqual(['214.0700', '4.3700']);
    // DR A/P 218.44 / CR bank 214.07 / CR discount 4.37.
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, payments[2]!.id));
    const pick = (acct: string) => lines.filter((l) => l.accountId === acct).map((l) => [l.debit, l.credit]);
    expect(pick(c.ap)).toEqual([['218.4400', '0.0000']]);
    expect(pick(c.bank)).toEqual([['0.0000', '214.0700']]);
    expect(pick(c.discount)).toEqual([['0.0000', '4.3700']]);
    // The bank account's counter moved past the last number.
    const [co] = await db.select({ s: companies.checkSettings }).from(companies).where(eq(companies.id, c.companyId));
    expect(Number((co!.s as { nextCheckNumbers?: Record<string, number> }).nextCheckNumbers?.[c.bank])).toBe(5005);
    // GET /bill-payments/:id carries the discount.
    const got = await request('GET', `/api/v1/bill-payments/${payments[2]!.id}`, c.token);
    expect(got.json.payment.billApplications[0].discountAmount).toBe('4.3700');
  });

  it('partial payments leave the right balance, with and without a discount', async () => {
    await setDiscountAccount(c.discount);
    const bill = await postBill(c.vendors[0]!, '1000.00');
    let r = await pay({ bills: [{ billId: bill.id, amount: '400.00' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect([(await row(bill.id)).balanceDue, (await row(bill.id)).billStatus]).toEqual(['600.0000', 'partial']);
    r = await pay({ bills: [{ billId: bill.id, amount: '500.00', discountAmount: '20.00' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect([(await row(bill.id)).balanceDue, (await row(bill.id)).billStatus]).toEqual(['80.0000', 'partial']);
    // amount + discount may not exceed the balance due.
    r = await pay({ bills: [{ billId: bill.id, amount: '70.00', discountAmount: '10.01' }] });
    expect(r.status).toBe(400);
    expect(r.json.error.message).toContain('exceeds balance due');
    // Amount 0 needs a discount.
    r = await pay({ bills: [{ billId: bill.id, amount: '0' }] });
    expect(r.status).toBe(400);
    // More than 2 places is refused by the schema.
    r = await pay({ bills: [{ billId: bill.id, amount: '10.00', discountAmount: '1.005' }] });
    expect(r.status).toBe(400);
    expect(await balanceOf(c.discount)).toBe('-20.00');
  });

  it('DISCOUNT_ACCOUNT_REQUIRED without a setting or request account; DISCOUNT_ACCOUNT_INVALID for A/P, the bank or another company', async () => {
    const bill = await postBill(c.vendors[0]!, '500.00');
    const body = { bills: [{ billId: bill.id, amount: '490.00', discountAmount: '10.00' }] };
    let r = await pay(body);
    expect([r.status, r.json.error.code]).toEqual([400, 'DISCOUNT_ACCOUNT_REQUIRED']);
    r = await pay({ ...body, discountAccountId: c.ap });
    expect([r.status, r.json.error.code]).toEqual([400, 'DISCOUNT_ACCOUNT_INVALID']);
    r = await pay({ ...body, discountAccountId: c.bank });
    expect([r.status, r.json.error.code]).toEqual([400, 'DISCOUNT_ACCOUNT_INVALID']);
    // Nothing posted by the refusals.
    expect((await row(bill.id)).balanceDue).toBe('500.0000');

    // The setting refuses A/P and another company's account.
    expect((await setDiscountAccount(c.ap)).json.error.code).toBe('DISCOUNT_ACCOUNT_INVALID');
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Other Co' }).returning();
    const [foreign] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: other!.id, name: 'Other discounts', accountType: 'revenue', accountNumber: '4951',
    }).returning();
    expect((await setDiscountAccount(foreign!.id)).json.error.code).toBe('DISCOUNT_ACCOUNT_INVALID');
    r = await pay({ ...body, discountAccountId: foreign!.id });
    expect([r.status, r.json.error.code]).toEqual([400, 'DISCOUNT_ACCOUNT_INVALID']);

    // A request account works without the setting; the setting clears with null.
    r = await pay({ ...body, discountAccountId: c.discount });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((await setDiscountAccount(c.discount)).status).toBe(200);
    expect((await setDiscountAccount(null)).json.settings.billDiscountAccountId).toBeNull();
  });

  it('a bill settled by a credit plus a discount (no cash) gets its application row; void reverses the discount and reopens it', async () => {
    await setDiscountAccount(c.discount);
    const vendor = c.vendors[3]!;
    const bill = await postBill(vendor, '1000.00');
    const credit = await postCredit(vendor, '980.00');
    const bankBefore = await balanceOf(c.bank);
    const r = await pay({
      bills: [{ billId: bill.id, amount: '980.00', discountAmount: '20.00' }],
      credits: [{ creditId: credit.id, billId: bill.id, amount: '980.00' }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const payment = r.json.payments[0] as { id: string; total: string; netPayment: string; discountTotal: string; printStatus: string | null };
    // A vendor paid only by credits and a discount still gets a payment (total 0).
    expect([payment.total, payment.netPayment, payment.discountTotal]).toEqual(['0.0000', '0.0000', '20.0000']);
    expect(await balanceOf(c.bank)).toBe(bankBefore);
    expect((await row(bill.id)).billStatus).toBe('paid');
    const [app] = await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, payment.id));
    expect([app!.amount, app!.discountAmount]).toEqual(['0.0000', '20.0000']);
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, payment.id));
    expect(lines.some((l) => l.accountId === c.bank)).toBe(false);
    expect(lines.filter((l) => l.accountId === c.discount).map((l) => l.credit)).toEqual(['20.0000']);

    const v = await request('POST', `/api/v1/bill-payments/${payment.id}/void`, c.token, { reason: 'test' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    const reopened = await row(bill.id);
    expect([reopened.balanceDue, reopened.billStatus]).toEqual(['1000.0000', 'unpaid']);
    expect((await row(credit.id)).balanceDue).toBe('980.0000');
    expect(await balanceOf(c.discount)).toBe('0.00');
    const reversals = await db.select().from(journalLines)
      .where(and(eq(journalLines.transactionId, payment.id), eq(journalLines.isVoidReversal, true), eq(journalLines.accountId, c.discount)));
    expect(reversals.map((l) => [l.debit, l.credit])).toEqual([['20.0000', '0.0000']]);
  });

  it('void of a cash + discount payment restores the bill, the bank and the discount account', async () => {
    await setDiscountAccount(c.discount);
    const bill = await postBill(c.vendors[2]!, '218.44', discountTerms);
    const bankBefore = await balanceOf(c.bank);
    const r = await pay({ bills: [{ billId: bill.id, amount: '214.07', discountAmount: '4.37' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.payments[0].id as string;
    expect((await request('POST', `/api/v1/bill-payments/${id}/void`, c.token, { reason: 'wrong bank' })).status).toBe(200);
    expect([(await row(bill.id)).balanceDue, (await row(bill.id)).billStatus]).toEqual(['218.4400', 'unpaid']);
    expect(await balanceOf(c.bank)).toBe(bankBefore);
    expect(await balanceOf(c.discount)).toBe('0.00');
    expect(await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, id))).toEqual([]);
  });

  it('a bill settled only by a credit reopens on void (its bill is recomputed from the credit applications)', async () => {
    const vendor = c.vendors[3]!;
    const bill = await postBill(vendor, '200.00');
    const credit = await postCredit(vendor, '200.00');
    const r = await pay({
      bills: [{ billId: bill.id, amount: '200.00' }],
      credits: [{ creditId: credit.id, billId: bill.id, amount: '200.00' }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((await row(bill.id)).billStatus).toBe('paid');
    expect((await request('POST', `/api/v1/bill-payments/${r.json.payments[0].id}/void`, c.token, { reason: 'x' })).status).toBe(200);
    expect([(await row(bill.id)).balanceDue, (await row(bill.id)).billStatus]).toEqual(['200.0000', 'unpaid']);
  });
});

describe('Idempotency-Key on POST /bill-payments (U-102)', () => {
  it('a retry with the key replays the same payments and posts nothing more; the reader rebuilds them', async () => {
    const b1 = await postBill(c.vendors[0]!, '100.00');
    const b2 = await postBill(c.vendors[1]!, '250.00');
    const body = { bills: [{ billId: b1.id, amount: '100.00' }, { billId: b2.id, amount: '250.00' }] };
    const key = 'paybills-' + suffix().replace(/[^A-Za-z0-9_-]/g, '');
    const first = await pay(body, { 'Idempotency-Key': key });
    expect(first.status, JSON.stringify(first.json)).toBe(201);
    const again = await pay(body, { 'Idempotency-Key': key });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(first.json);
    const count = await db.select({ id: transactions.id }).from(transactions)
      .where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnType, 'bill_payment')));
    expect(count).toHaveLength(2);
    // Another body with the key is refused.
    const other = await pay({ bills: [{ billId: b1.id, amount: '1.00' }] }, { 'Idempotency-Key': key });
    expect([other.status, other.json.error.code]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);

    // A replay without a stored body reads the request's payments back.
    const firstId = first.json.payments[0].id as string;
    const rebuilt = await billPaymentService.paymentsPostedWith(c.tenantId, firstId, c.companyId);
    expect(rebuilt.map((p) => p.id).sort()).toEqual((first.json.payments as Array<{ id: string }>).map((p) => p.id).sort());
    expect(rebuilt.map((p) => p.netPayment).sort()).toEqual(['100.0000', '250.0000']);
  });
});

describe('check numbers (U-103, bill-payment-check-number-v1)', () => {
  it('numbers each vendor payment that pays cash; a credits-only payment takes none; CHECK_NUMBER_IN_USE; only for printLater false', async () => {
    const [v1, v2, , v4] = c.vendors as [string, string, string, string];
    const b1 = await postBill(v1, '10.00');
    const b4 = await postBill(v4, '40.00');
    const cm = await postCredit(v4, '40.00');
    const b2 = await postBill(v2, '20.00');
    const r = await pay({
      printLater: false, checkNumber: '7001',
      bills: [{ billId: b1.id, amount: '10.00' }, { billId: b4.id, amount: '40.00' }, { billId: b2.id, amount: '20.00' }],
      credits: [{ creditId: cm.id, billId: b4.id, amount: '40.00' }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((r.json.payments as Array<{ contactId: string; checkNumber: number | null }>).map((p) => [p.contactId, p.checkNumber]))
      .toEqual([[v1, 7001], [v4, null], [v2, 7002]]);

    const b5 = await postBill(v1, '5.00');
    const dup = await pay({ printLater: false, checkNumber: '7002', bills: [{ billId: b5.id, amount: '5.00' }] });
    expect([dup.status, dup.json.error.code, dup.json.error.details?.checkNumber]).toEqual([409, 'CHECK_NUMBER_IN_USE', '7002']);
    expect((await row(b5.id)).balanceDue).toBe('5.0000');

    const queued = await pay({ printLater: true, checkNumber: '8001', bills: [{ billId: b5.id, amount: '5.00' }] });
    expect([queued.status, queued.json.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    const ach = await pay({ method: 'ach', printLater: false, checkNumber: '8001', bills: [{ billId: b5.id, amount: '5.00' }] });
    expect(ach.status).toBe(400);

    // Without checkNumber and printLater false: today's behavior (no number).
    const plain = await pay({ printLater: false, bills: [{ billId: b5.id, amount: '5.00' }] });
    expect(plain.status, JSON.stringify(plain.json)).toBe(201);
    expect(plain.json.payments[0].checkNumber).toBeNull();
  });
});

describe('company scope (U-104)', () => {
  it('/bills/payable, GET /bill-payments and GET /bill-payments/:id read only the active company', async () => {
    const vendor = c.vendors[0]!;
    const billA = await postBill(vendor, '100.00');
    const moved = await postBill(vendor, '300.00');
    const credit = await postCredit(vendor, '50.00');
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    const asOther = { 'X-Company-Id': other!.id };
    // One bill belongs to the second company.
    await db.update(transactions).set({ companyId: other!.id }).where(eq(transactions.id, moved.id));

    const mine = await request('GET', '/api/v1/bills/payable', c.token);
    expect((mine.json.bills as Array<{ id: string }>).map((b) => b.id)).toEqual([billA.id]);
    expect((mine.json.credits as Array<{ id: string }>).map((x) => x.id)).toEqual([credit.id]);
    const theirs = await request('GET', '/api/v1/bills/payable', c.token, undefined, asOther);
    expect((theirs.json.bills as Array<{ id: string }>).map((b) => b.id)).toEqual([moved.id]);
    expect(theirs.json.credits).toEqual([]);

    const r = await pay({ bills: [{ billId: billA.id, amount: '100.00' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.payments[0].id as string;
    expect((await request('GET', `/api/v1/bill-payments/${id}`, c.token)).status).toBe(200);
    expect((await request('GET', `/api/v1/bill-payments/${id}`, c.token, undefined, asOther)).status).toBe(404);
    const listMine = await request('GET', '/api/v1/bill-payments', c.token);
    expect((listMine.json.data as Array<{ id: string }>).map((p) => p.id)).toEqual([id]);
    const listTheirs = await request('GET', '/api/v1/bill-payments', c.token, undefined, asOther);
    expect(listTheirs.json.data).toEqual([]);
    // The reader refuses another company's payment.
    await expect(billPaymentService.paymentsPostedWith(c.tenantId, id, other!.id)).rejects.toThrow('not found');
    // A row without a company is visible from both (legacy single-company data).
    await db.update(transactions).set({ companyId: null }).where(eq(transactions.id, id));
    expect((await request('GET', `/api/v1/bill-payments/${id}`, c.token, undefined, asOther)).status).toBe(200);
  });
});
