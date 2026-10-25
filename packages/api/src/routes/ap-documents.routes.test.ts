// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// A/P documents (U-83 ap-closing-v1, U-84 ap-edit-v1, U-85 bill-lines-v1,
// U-86 bill-terms-v1, U-87 bill-received-v1) through the HTTP routes:
//   - closed periods on bills, vendor credits and bill payments: no, wrong
//     and right closing password; an override audit row;
//   - expectedUpdatedAt → 409 STALE on PUT, void and DELETE; PUT then PUT
//     with the returned updatedAt is not stale and shows the new ref;
//   - vendor credit edit (balance recomputed) and CREDIT_APPLIED once applied
//     or refunded; bill / credit delete while unapplied;
//   - register void of a paid bill (409) and of a bill payment (the bills
//     reopen); payBills refuses deleted bills and voided credits;
//   - item lines: quantity x cost exact, LINE_AMOUNT_MISMATCH,
//     LINE_QTY_RATE_INCOMPLETE, quantity + amount without cost, billable;
//   - terms: discount terms, custom terms, overrides, GET /bills/terms-dates,
//     GET /payment-terms, the DST due date under TZ=America/Chicago;
//   - vendor-summary counts posted documents only; bill received;
//   - exact paid status (0.01 left is never "paid");
//   - a bill edit racing Pay Bills keeps the bill and A/P in step;
//   - duplicate and generic edits refuse A/P documents; attach-draft and
//     link check their target; a bill capture blocks delete.

process.env['TZ'] = 'America/Chicago';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, depositLines, transactionTags, tags, vendorCreditApplications, billPaymentApplications, userPermissions,
  attachments, billCaptures, items,
} from '../db/schema/index.js';
import { transactionsRouter } from './transactions.routes.js';
import { billsRouter } from './bills.routes.js';
import { vendorCreditsRouter } from './vendor-credits.routes.js';
import { billPaymentsRouter } from './bill-payments.routes.js';
import { paymentTermsRouter } from './payment-terms.routes.js';
import { attachmentsRouter } from './attachments.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as billService from '../services/bill.service.js';
import * as billPaymentService from '../services/bill-payment.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const CLOSING_PHRASE = 'ap-closing-123'; // gitleaks:allow (test placeholder)

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

interface Res { status: number; json: any }

function request(method: string, pathname: string, token: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
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
  await db.delete(billCaptures).where(eq(billCaptures.tenantId, tid));
  await db.delete(attachments).where(eq(attachments.tenantId, tid));
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tid));
  await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(items).where(eq(items.tenantId, tid));
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
  tenantId: string; userId: string; token: string; companyId: string;
  bank: string; ap: string; expense: string; otherExpense: string; income: string;
  customer: string; vendor: string; otherVendor: string;
}

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `apdoc-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `AP Docs ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const expenses = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(2);
  const [income] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue'))).limit(1);
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Table Rock Marina' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Midwest Equipment Rental' }).returning();
  const [otherVendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Cosmos Granite' }).returning();
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: company!.id,
    bank: bank!.id, ap: await bySystemTag(tenantId, 'accounts_payable'),
    expense: expenses[0]!.id, otherExpense: expenses[1]!.id, income: income?.id ?? expenses[1]!.id,
    customer: customer!.id, vendor: vendor!.id, otherVendor: otherVendor!.id,
  };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/bills', billsRouter);
  app.use('/api/v1/vendor-credits', vendorCreditsRouter);
  app.use('/api/v1/bill-payments', billPaymentsRouter);
  app.use('/api/v1/payment-terms', paymentTermsRouter);
  app.use('/api/v1/attachments', attachmentsRouter);
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
const billBody = (extra: Record<string, unknown> = {}, lines?: unknown[]) => ({
  contactId: c.vendor, txnDate: '2026-11-03', vendorInvoiceNumber: 'INV-55871', paymentTerms: 'net_15',
  lines: lines ?? [
    { accountId: c.expense, amount: '1330.00', description: 'Excavator rental' },
    { accountId: c.otherExpense, amount: '150.00', description: 'Delivery' },
  ],
  ...extra,
});
const creditBody = (extra: Record<string, unknown> = {}) => ({
  contactId: c.vendor, txnDate: '2026-11-05', vendorInvoiceNumber: 'CM-12',
  lines: [{ accountId: c.expense, amount: '200.00' }],
  ...extra,
});
const postBill = async (extra: Record<string, unknown> = {}, lines?: unknown[]) => {
  const r = await request('POST', '/api/v1/bills', c.token, billBody(extra, lines));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.bill;
};
const postCredit = async (extra: Record<string, unknown> = {}) => {
  const r = await request('POST', '/api/v1/vendor-credits', c.token, creditBody(extra));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.credit;
};
const pay = (bills: Array<{ billId: string; amount: string }>, credits: unknown[] = [], extra: Record<string, unknown> = {}) =>
  request('POST', '/api/v1/bill-payments', c.token, {
    bankAccountId: c.bank, txnDate: '2026-11-20', method: 'check', printLater: true, bills, credits, ...extra,
  });
const summary = async (contactId = c.vendor) =>
  (await request('GET', `/api/v1/bills/vendor-summary?contactId=${contactId}`, c.token)).json.summary;
/** Net A/P (credit − debit) on the vendor's posted bills, credits and payments. */
const apNet = async (contactId = c.vendor) => {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS net
    FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
    WHERE t.tenant_id = ${c.tenantId} AND t.contact_id = ${contactId} AND jl.account_id = ${c.ap}
      AND t.status = 'posted' AND jl.is_void_reversal = false
  `);
  return Number((res.rows as Array<{ net: string }>)[0]!.net).toFixed(4);
};

it('advertises the A/P capabilities', () => {
  for (const cap of ['ap-closing-v1', 'ap-edit-v1', 'bill-lines-v1', 'bill-terms-v1', 'bill-received-v1']) {
    expect(DESKTOP_CAPABILITIES).toContain(cap);
  }
});

describe('closed periods (ap-closing-v1)', () => {
  const close = () => db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, c.companyId));
  const setPassword = async () => db.update(companies)
    .set({ closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) }).where(eq(companies.id, c.companyId));
  const overrides = () => db.select().from(auditLog).where(and(
    eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'closing_date_override'),
  ));

  it('bills: none 423, wrong 403, right 201 with an override row; edit and void too', async () => {
    await close();
    await setPassword();
    const closed = billBody({ txnDate: '2026-06-15' });
    let r = await request('POST', '/api/v1/bills', c.token, closed);
    expect(r.status).toBe(423);
    expect(r.json.error.code).toBe('TB_PERIOD_LOCKED');
    expect(r.json.error.details.closingPasswordRequired).toBe(true);
    r = await request('POST', '/api/v1/bills', c.token, { ...closed, closingPassword: 'wrong-guess' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect(await db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnType, 'bill')))).toHaveLength(0);
    r = await request('POST', '/api/v1/bills', c.token, { ...closed, closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(201);
    const bill = r.json.bill;
    const created = (await overrides()).find((o) => (o.afterData as any)?.transactionId === bill.id);
    expect(created).toBeTruthy();
    expect((created!.afterData as any).oldDate).toBeNull();
    expect(JSON.stringify(created)).not.toContain(CLOSING_PHRASE);

    // Moving it out of the closed period still needs the password (old date).
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ txnDate: '2026-07-15' }));
    expect(r.status).toBe(423);
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ txnDate: '2026-07-15', closingPassword: CLOSING_PHRASE }));
    expect(r.status).toBe(200);
    expect(r.json.bill.txnDate).toBe('2026-07-15');

    // Void of a closed-period bill.
    const old = await postBill({ txnDate: '2026-06-20', closingPassword: CLOSING_PHRASE });
    r = await request('POST', `/api/v1/bills/${old.id}/void`, c.token, { reason: 'dup' });
    expect(r.status).toBe(423);
    r = await request('POST', `/api/v1/bills/${old.id}/void`, c.token, { reason: 'dup', closingPassword: 'nope' });
    expect(r.status).toBe(403);
    r = await request('POST', `/api/v1/bills/${old.id}/void`, c.token, { reason: 'dup', closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(200);
    expect(r.json.bill.status).toBe('void');
  });

  it('vendor credits and bill payments honour the password', async () => {
    await close();
    await setPassword();
    let r = await request('POST', '/api/v1/vendor-credits', c.token, creditBody({ txnDate: '2026-06-10' }));
    expect(r.status).toBe(423);
    r = await request('POST', '/api/v1/vendor-credits', c.token, creditBody({ txnDate: '2026-06-10', closingPassword: 'x' }));
    expect(r.status).toBe(403);
    r = await request('POST', '/api/v1/vendor-credits', c.token, creditBody({ txnDate: '2026-06-10', closingPassword: CLOSING_PHRASE }));
    expect(r.status).toBe(201);
    const credit = r.json.credit;
    r = await request('PUT', `/api/v1/vendor-credits/${credit.id}`, c.token, creditBody({ txnDate: '2026-06-10', memo: 'edit' }));
    expect(r.status).toBe(423);
    r = await request('PUT', `/api/v1/vendor-credits/${credit.id}`, c.token, creditBody({ txnDate: '2026-06-10', memo: 'edit', closingPassword: CLOSING_PHRASE }));
    expect(r.status).toBe(200);
    r = await request('POST', `/api/v1/vendor-credits/${credit.id}/void`, c.token, { reason: 'x' });
    expect(r.status).toBe(423);
    r = await request('POST', `/api/v1/vendor-credits/${credit.id}/void`, c.token, { reason: 'x', closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(200);

    const bill = await postBill({ txnDate: '2026-06-01', closingPassword: CLOSING_PHRASE });
    const payBody = { bankAccountId: c.bank, txnDate: '2026-06-25', method: 'check', printLater: true, bills: [{ billId: bill.id, amount: '1480.00' }] };
    r = await request('POST', '/api/v1/bill-payments', c.token, payBody);
    expect(r.status).toBe(423);
    r = await request('POST', '/api/v1/bill-payments', c.token, { ...payBody, closingPassword: 'bad' });
    expect(r.status).toBe(403);
    r = await request('POST', '/api/v1/bill-payments', c.token, { ...payBody, closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(201);
    const paymentId = r.json.payments[0].id;
    r = await request('POST', `/api/v1/bill-payments/${paymentId}/void`, c.token, { reason: 'x' });
    expect(r.status).toBe(423);
    r = await request('POST', `/api/v1/bill-payments/${paymentId}/void`, c.token, { reason: 'x', closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(200);
    expect((await row(bill.id)).billStatus).toBe('unpaid');
  });
});

describe('stale tokens (ap-edit-v1)', () => {
  it('PUT then PUT with the returned updatedAt is not stale and shows the new ref; an old token is 409 STALE', async () => {
    const bill = await postBill();
    const first = bill.updatedAt as string;
    let r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ vendorInvoiceNumber: 'INV-55871-A', expectedUpdatedAt: first }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.bill.vendorInvoiceNumber).toBe('INV-55871-A');
    const second = r.json.bill.updatedAt as string;
    expect(new Date(second).getTime()).toBe((await row(bill.id)).updatedAt!.getTime());
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ vendorInvoiceNumber: 'INV-55871-B', expectedUpdatedAt: second }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.bill.vendorInvoiceNumber).toBe('INV-55871-B');

    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ vendorInvoiceNumber: 'LOST', expectedUpdatedAt: first }));
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('STALE');
    expect(r.json.error.details.updatedAt).toBe((await row(bill.id)).updatedAt!.toISOString());
    expect((await row(bill.id)).vendorInvoiceNumber).toBe('INV-55871-B');

    r = await request('POST', `/api/v1/bills/${bill.id}/void`, c.token, { reason: 'x', expectedUpdatedAt: first });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('STALE');
    r = await request('POST', `/api/v1/transactions/${bill.id}/void`, c.token, { reason: 'x', expectedUpdatedAt: first });
    expect(r.json.error.code).toBe('STALE');
    r = await request('DELETE', `/api/v1/transactions/${bill.id}`, c.token, { expectedUpdatedAt: first });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('STALE');
    expect((await row(bill.id)).status).toBe('posted');
    r = await request('DELETE', `/api/v1/transactions/${bill.id}`, c.token, { expectedUpdatedAt: (await request('GET', `/api/v1/bills/${bill.id}`, c.token)).json.bill.updatedAt });
    expect(r.status).toBe(200);
    expect(r.json.transaction.status).toBe('deleted');
  });

  it('a credit PUT with an old token is 409 STALE; a malformed token is 400', async () => {
    const credit = await postCredit();
    let r = await request('PUT', `/api/v1/vendor-credits/${credit.id}`, c.token, creditBody({ memo: 'one', expectedUpdatedAt: credit.updatedAt }));
    expect(r.status).toBe(200);
    r = await request('PUT', `/api/v1/vendor-credits/${credit.id}`, c.token, creditBody({ memo: 'two', expectedUpdatedAt: credit.updatedAt }));
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('STALE');
    r = await request('PUT', `/api/v1/vendor-credits/${credit.id}`, c.token, creditBody({ expectedUpdatedAt: 'yesterday' }));
    expect(r.status).toBe(400);
  });
});

describe('edit and delete (ap-edit-v1)', () => {
  it('a vendor credit edits while unapplied (balance recomputed) and is 409 CREDIT_APPLIED once applied', async () => {
    const credit = await postCredit();
    let r = await request('PUT', `/api/v1/vendor-credits/${credit.id}`, c.token, creditBody({
      lines: [{ accountId: c.expense, amount: '250.00', tagId: null }, { accountId: c.otherExpense, amount: '10.00' }],
    }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.credit.total).toBe('260.0000');
    expect(r.json.credit.balanceDue).toBe('260.0000');
    expect(r.json.credit.vendorInvoiceNumber).toBe('CM-12');

    const bill = await postBill();
    r = await pay([{ billId: bill.id, amount: '300.00' }], [{ creditId: credit.id, billId: bill.id, amount: '100.00' }]);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    r = await request('PUT', `/api/v1/vendor-credits/${credit.id}`, c.token, creditBody());
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('CREDIT_APPLIED');
    r = await request('DELETE', `/api/v1/transactions/${credit.id}`, c.token);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('CREDIT_APPLIED');
    r = await request('POST', `/api/v1/transactions/${credit.id}/void`, c.token, { reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('CREDIT_APPLIED');
    r = await request('DELETE', `/api/v1/transactions/${bill.id}`, c.token);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BILL_HAS_PAYMENTS');
  });

  it('a refunded credit is CREDIT_APPLIED on PUT and TXN_DELETE_LINKED on delete', async () => {
    const credit = await postCredit();
    const made = await request('POST', '/api/v1/transactions', c.token, {
      txnType: 'deposit', txnDate: '2026-11-10', depositToAccountId: c.bank,
      lines: [{ accountId: c.ap, amount: '80.00', sourceTransactionId: credit.id }],
    });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    let r = await request('PUT', `/api/v1/vendor-credits/${credit.id}`, c.token, creditBody());
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('CREDIT_APPLIED');
    expect(r.json.error.details.refundDepositIds).toEqual([made.json.transaction.id]);
    r = await request('DELETE', `/api/v1/transactions/${credit.id}`, c.token);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('TXN_DELETE_LINKED');
  });

  it('an unpaid bill and an unapplied credit delete; vendor-summary leaves them out', async () => {
    const bill = await postBill();
    const credit = await postCredit();
    let s = await summary();
    expect(Number(s.totalOwed)).toBe(1480);
    expect(s.availableCreditsCount).toBe(1);
    let r = await request('DELETE', `/api/v1/transactions/${bill.id}`, c.token, { reason: 'entered twice' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await request('DELETE', `/api/v1/transactions/${credit.id}`, c.token);
    expect(r.status).toBe(200);
    s = await summary();
    expect(Number(s.totalOwed)).toBe(0);
    expect(s.unpaidCount).toBe(0);
    expect(s.availableCreditsCount).toBe(0);
    expect(await apNet()).toBe('0.0000');
    // A deleted bill can't be paid (review B2).
    r = await pay([{ billId: bill.id, amount: '1480.00' }]);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('BILL_NOT_PAYABLE');
  });

  it('vendor-summary leaves out a voided bill and a voided credit (U-84d)', async () => {
    const keep = await postBill({ vendorInvoiceNumber: 'KEEP' });
    const gone = await postBill({ vendorInvoiceNumber: 'GONE' });
    const credit = await postCredit();
    await postCredit({ vendorInvoiceNumber: 'CM-13' });
    expect((await request('POST', `/api/v1/bills/${gone.id}/void`, c.token, { reason: 'x' })).status).toBe(200);
    expect((await request('POST', `/api/v1/vendor-credits/${credit.id}/void`, c.token, { reason: 'x' })).status).toBe(200);
    const s = await summary();
    expect(Number(s.totalOwed)).toBe(1480);
    expect(s.unpaidCount).toBe(1);
    expect(s.availableCreditsCount).toBe(1);
    expect(Number(s.totalAvailableCredits)).toBe(200);
    expect(keep.id).toBeTruthy();
  });

  it('payBills refuses a voided credit (review B2)', async () => {
    const bill = await postBill();
    const credit = await postCredit();
    expect((await request('POST', `/api/v1/vendor-credits/${credit.id}/void`, c.token, { reason: 'x' })).status).toBe(200);
    const r = await pay([{ billId: bill.id, amount: '500.00' }], [{ creditId: credit.id, billId: bill.id, amount: '100.00' }]);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('CREDIT_NOT_AVAILABLE');
  });

  it('register void: a paid bill is 409; a bill payment voids with its applications and the bill reopens (review B1)', async () => {
    const bill = await postBill();
    const credit = await postCredit();
    let r = await pay([{ billId: bill.id, amount: '1480.00' }], [{ creditId: credit.id, billId: bill.id, amount: '200.00' }]);
    expect(r.status).toBe(201);
    const paymentId = r.json.payments[0].id;
    expect((await row(bill.id)).billStatus).toBe('paid');
    expect((await row(credit.id)).balanceDue).toBe('0.0000');

    r = await request('POST', `/api/v1/transactions/${bill.id}/void`, c.token, { reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BILL_HAS_PAYMENTS');

    r = await request('POST', `/api/v1/transactions/${paymentId}/void`, c.token, { reason: 'wrong account' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.transaction.status).toBe('void');
    const b = await row(bill.id);
    expect(b.billStatus).toBe('unpaid');
    expect(b.balanceDue).toBe('1480.0000');
    expect((await row(credit.id)).balanceDue).toBe('200.0000');
    expect(await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.paymentId, paymentId))).toHaveLength(0);
    expect(await db.select().from(vendorCreditApplications).where(eq(vendorCreditApplications.paymentId, paymentId))).toHaveLength(0);
    expect(await apNet()).toBe('1280.0000');
    // And now the bill voids from the register.
    r = await request('POST', `/api/v1/transactions/${bill.id}/void`, c.token, { reason: 'x' });
    expect(r.status).toBe(200);
  });

  it('a paid bill keeps vendor, date and total; the received flag can\'t go false', async () => {
    const bill = await postBill();
    expect((await pay([{ billId: bill.id, amount: '480.00' }])).status).toBe(201);
    let r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({}, [
      { accountId: c.expense, amount: '1430.00' }, { accountId: c.otherExpense, amount: '150.00' },
    ]));
    expect(r.status).toBe(400);
    // 0.0001 off is a different total (exact, review S1).
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({}, [
      { accountId: c.expense, amount: '1330.0001' }, { accountId: c.otherExpense, amount: '150.00' },
    ]));
    expect(r.status).toBe(400);
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({}, [
      { accountId: c.expense, amount: '1000.00' }, { accountId: c.otherExpense, amount: '480.00' },
    ]));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.bill.billStatus).toBe('partial');
    expect(r.json.bill.balanceDue).toBe('1000.0000');
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ billReceived: false }));
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BILL_HAS_PAYMENTS');
  });

  it('a generic PUT /transactions edit of a bill is refused; duplicate refuses A/P documents', async () => {
    const bill = await postBill();
    let r = await request('PUT', `/api/v1/transactions/${bill.id}`, c.token, {
      txnType: 'expense', txnDate: '2026-11-03', payFromAccountId: c.bank, contactId: c.vendor,
      lines: [{ expenseAccountId: c.expense, amount: '1.00' }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(400);
    expect(r.json.error.code).toBe('TXN_EDIT_UNSUPPORTED');
    expect((await row(bill.id)).balanceDue).toBe('1480.0000');
    r = await request('POST', `/api/v1/transactions/${bill.id}/duplicate`, c.token, {});
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('TXN_DUPLICATE_UNSUPPORTED');
  });

  it('a bill entered from a bill capture can\'t be deleted', async () => {
    const bill = await postBill();
    const [att] = await db.insert(attachments).values({
      tenantId: c.tenantId, companyId: c.companyId, fileName: 'inv.pdf', filePath: 'x/inv.pdf',
      attachableType: 'bill', attachableId: bill.id,
    }).returning();
    await db.insert(billCaptures).values({
      tenantId: c.tenantId, companyId: c.companyId, attachmentId: att!.id, source: 'staff', uploadedByUserId: c.userId, status: 'entered',
      billId: bill.id, contentSha256: 'a'.repeat(64), fileName: 'inv.pdf',
    } as any);
    const r = await request('DELETE', `/api/v1/transactions/${bill.id}`, c.token);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('TXN_DELETE_LINKED');
    expect(r.json.error.details.links).toContain('bill_capture');
  });
});

describe('a bill edit racing Pay Bills (review B1, missing test 1)', () => {
  it('the bill balance and A/P stay in step whichever wins', async () => {
    for (let i = 0; i < 4; i++) {
      const bill = await billService.createBill(c.tenantId, billBody({ vendorInvoiceNumber: `RACE-${i}` }) as any, c.userId, c.companyId);
      const results = await Promise.allSettled([
        billService.updateBill(c.tenantId, bill.id, billBody({ vendorInvoiceNumber: `RACE-${i}` }, [
          { accountId: c.expense, amount: '1430.00' }, { accountId: c.otherExpense, amount: '150.00' },
        ]) as any, c.userId, c.companyId),
        billPaymentService.payBills(c.tenantId, {
          bankAccountId: c.bank, txnDate: '2026-11-20', method: 'check', printLater: true,
          bills: [{ billId: bill.id, amount: '1480.00' }],
        } as any, c.userId, c.companyId),
      ]);
      expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
      const b = await row(bill.id);
      const paid = await db.execute(sql`SELECT COALESCE(SUM(amount), 0)::text AS s FROM bill_payment_applications WHERE bill_id = ${bill.id}`);
      const paidSum = Number((paid.rows as Array<{ s: string }>)[0]!.s);
      // balance due = total − applications, exactly.
      expect(Number(b.balanceDue)).toBeCloseTo(Number(b.total) - paidSum, 6);
      expect(['1480.0000', '1580.0000']).toContain(b.total);
      if (results[0].status === 'fulfilled' && results[1].status === 'fulfilled') {
        // Edit first (1580), then the 1480 payment: 100 left.
        expect(b.total).toBe('1580.0000');
        expect(b.balanceDue).toBe('100.0000');
        expect(b.billStatus).toBe('partial');
      }
    }
    // A/P on the books equals the open balances the bills show.
    const open = await db.execute(sql`
      SELECT COALESCE(SUM(balance_due), 0)::text AS s FROM transactions
      WHERE tenant_id = ${c.tenantId} AND txn_type = 'bill' AND status = 'posted'`);
    expect(await apNet()).toBe(Number((open.rows as Array<{ s: string }>)[0]!.s).toFixed(4));
  });
});

describe('exact paid status (review S1, missing test 8)', () => {
  it('0.01 left on a bill or credit is never "paid"', async () => {
    const bill = await postBill();
    let r = await pay([{ billId: bill.id, amount: '1479.99' }]);
    expect(r.status).toBe(201);
    const b = await row(bill.id);
    expect(b.billStatus).toBe('partial');
    expect(b.balanceDue).toBe('0.0100');
    expect(Number((await summary()).totalOwed)).toBeCloseTo(0.01, 6);
    const payable = (await request('GET', `/api/v1/bills/payable?contactId=${c.vendor}`, c.token)).json.bills;
    expect(payable.map((p: any) => p.id)).toContain(bill.id);
    // Overpaying by 0.0001 is refused (no tolerance).
    r = await pay([{ billId: bill.id, amount: '0.0101' }]);
    expect(r.status).toBe(400);

    const credit = await postCredit();
    const bill2 = await postBill({ vendorInvoiceNumber: 'INV-2' });
    r = await pay([{ billId: bill2.id, amount: '199.99' }], [{ creditId: credit.id, billId: bill2.id, amount: '199.99' }]);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const cr = await row(credit.id);
    expect(cr.balanceDue).toBe('0.0100');
    expect(cr.billStatus).toBe('unpaid');
  });
});

describe('item lines (bill-lines-v1)', () => {
  it('quantity x cost is exact and stored with item, customer and billable; mismatch and incomplete are 400', async () => {
    const [item] = await db.insert(items).values({ tenantId: c.tenantId, name: 'Boat lift', incomeAccountId: c.income } as any).returning();
    const bill = await postBill({}, [
      { accountId: c.expense, itemId: item!.id, quantity: '4', unitPrice: '218.44', amount: '873.76', contactId: c.customer, isBillable: true },
      { accountId: c.otherExpense, quantity: '2.5', amount: '606.24', description: 'Hours, no rate' },
    ]);
    expect(bill.total).toBe('1480.0000');
    const lines = bill.lines.filter((l: any) => Number(l.debit) > 0);
    expect(lines[0]).toMatchObject({ itemId: item!.id, quantity: '4.0000', unitPrice: '218.4400', contactId: c.customer, isBillable: true, billedStatus: 'unbilled' });
    expect(lines[1]).toMatchObject({ quantity: '2.5000', unitPrice: null });

    let r = await request('POST', '/api/v1/bills', c.token, billBody({}, [
      { accountId: c.expense, quantity: '3', unitPrice: '49.995', amount: '149.98' },
    ]));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('LINE_AMOUNT_MISMATCH');
    expect(r.json.error.details).toEqual({ lineIndex: 0, expected: '149.99' });
    r = await request('POST', '/api/v1/bills', c.token, billBody({}, [
      { accountId: c.expense, amount: '10.00' }, { accountId: c.expense, unitPrice: '5', amount: '10.00' },
    ]));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('LINE_QTY_RATE_INCOMPLETE');
    expect(r.json.error.details.lineIndex).toBe(1);
    r = await request('POST', '/api/v1/bills', c.token, billBody({}, [{ accountId: c.expense, amount: '10.00', isBillable: true }]));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VALIDATION_ERROR');
    r = await request('POST', '/api/v1/bills', c.token, billBody({}, [{ accountId: c.expense, amount: '10.00', quantity: '0' }]));
    expect(r.status).toBe(400);
    r = await request('POST', '/api/v1/bills', c.token, billBody({}, [{ accountId: c.expense, amount: 10 }]));
    expect(r.status).toBe(400);
    r = await request('POST', '/api/v1/bills', c.token, billBody({}, [{ accountId: c.expense, amount: '1e3' }]));
    expect(r.status).toBe(400);
    r = await request('POST', '/api/v1/bills', c.token, billBody({}, [{ accountId: c.expense, amount: '10.00', itemId: crypto.randomUUID() }]));
    expect(r.status).toBe(400);
  });

  it('credit lines take items and tags but are never billable', async () => {
    const [tag] = await db.insert(tags).values({ tenantId: c.tenantId, name: 'Install' }).returning();
    let r = await request('POST', '/api/v1/vendor-credits', c.token, creditBody({
      lines: [{ accountId: c.expense, quantity: '2', unitPrice: '100', amount: '200.00', tagId: tag!.id, contactId: c.customer }],
    }));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const line = r.json.credit.lines.find((l: any) => Number(l.credit) > 0);
    expect(line).toMatchObject({ quantity: '2.0000', unitPrice: '100.0000', tagId: tag!.id, contactId: c.customer, isBillable: false });
    r = await request('POST', '/api/v1/vendor-credits', c.token, creditBody({
      lines: [{ accountId: c.expense, amount: '200.00', contactId: c.customer, isBillable: true }],
    }));
    expect(r.status).toBe(400);
  });

  it('draftAttachmentId relinks the draft in the same transaction, with an audit row; attach-draft and link check the target', async () => {
    const draftId = crypto.randomUUID();
    const [att] = await db.insert(attachments).values({
      tenantId: c.tenantId, companyId: c.companyId, fileName: 'midwest.pdf', filePath: 'x/midwest.pdf',
      attachableType: 'draft', attachableId: draftId,
    }).returning();
    // A failing bill leaves the draft alone.
    let r = await request('POST', '/api/v1/bills', c.token, billBody({ draftAttachmentId: draftId }, [{ accountId: c.expense, amount: 'bad' }]));
    expect(r.status).toBe(400);
    expect((await db.select().from(attachments).where(eq(attachments.id, att!.id)))[0]!.attachableType).toBe('draft');
    const bill = await postBill({ draftAttachmentId: draftId });
    const moved = (await db.select().from(attachments).where(eq(attachments.id, att!.id)))[0]!;
    expect(moved).toMatchObject({ attachableType: 'bill', attachableId: bill.id });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'attachment')));
    expect(audits.some((a) => a.entityId === att!.id)).toBe(true);

    r = await request('POST', `/api/v1/bills/${crypto.randomUUID()}/attach-draft`, c.token, { draftId });
    expect(r.status).toBe(404);
    r = await request('POST', `/api/v1/attachments/${att!.id}/link`, c.token, { attachableType: 'bill', attachableId: crypto.randomUUID() });
    expect(r.status).toBe(404);
    r = await request('POST', `/api/v1/attachments/${att!.id}/link`, c.token, { attachableType: 'vendor_credit', attachableId: bill.id });
    expect(r.status).toBe(404);
    r = await request('POST', `/api/v1/attachments/${att!.id}/link`, c.token, { attachableType: 'bill', attachableId: bill.id });
    expect(r.status).toBe(200);
  });
});

describe('terms (bill-terms-v1)', () => {
  it('due and discount dates, overrides, the DST window, terms-dates and payment-terms', async () => {
    let bill = await postBill({ txnDate: '2026-03-01', paymentTerms: 'net_15' });
    expect(bill.dueDate).toBe('2026-03-16');
    expect(bill.dueDateOverridden).toBe(false);
    bill = await postBill({ txnDate: '2026-03-01', paymentTerms: '2_10_net_30' });
    expect(bill).toMatchObject({ dueDate: '2026-03-31', discountDate: '2026-03-11', discountPercent: '2.0000', discountDays: 10, termsDays: 30 });
    bill = await postBill({ txnDate: '2026-03-01', paymentTerms: 'custom', termsDays: 20, discountPercent: '1.5', discountDays: 5, dueDate: '2026-04-01' });
    expect(bill).toMatchObject({ dueDate: '2026-04-01', dueDateOverridden: true, discountDate: '2026-03-06', discountPercent: '1.5000' });
    // Editing without a dueDate recomputes it and clears the override.
    let r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ txnDate: '2026-03-01', paymentTerms: 'custom', termsDays: 20 }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.bill).toMatchObject({ dueDate: '2026-03-21', dueDateOverridden: false, discountPercent: null, discountDate: null });

    r = await request('POST', '/api/v1/bills', c.token, billBody({ paymentTerms: 'net_30', discountPercent: '2', discountDays: 10 }));
    expect(r.status).toBe(400);
    r = await request('POST', '/api/v1/bills', c.token, billBody({ paymentTerms: 'net_31' }));
    expect(r.status).toBe(400);
    r = await request('POST', '/api/v1/bills', c.token, billBody({ txnDate: '2026-02-30' }));
    expect(r.status).toBe(400);
    r = await request('POST', '/api/v1/bills', c.token, billBody({ paymentTerms: 'custom', termsDays: 10, discountPercent: '2', discountDays: 10 }));
    expect(r.status).toBe(400);

    r = await request('GET', '/api/v1/bills/terms-dates?txnDate=2026-03-01&paymentTerms=net_15', c.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ dueDate: '2026-03-16', discountDate: null, paymentTerms: 'net_15', termsDays: 15, discountPercent: null, discountDays: null, source: 'input' });
    await db.update(contacts).set({ defaultPaymentTerms: 'custom', defaultTermsDays: 25, defaultDiscountPercent: '1', defaultDiscountDays: 7 })
      .where(eq(contacts.id, c.vendor));
    r = await request('GET', `/api/v1/bills/terms-dates?txnDate=2026-03-01&contactId=${c.vendor}`, c.token);
    expect(r.json).toEqual({ dueDate: '2026-03-26', discountDate: '2026-03-08', paymentTerms: 'custom', termsDays: 25, discountPercent: '1.0000', discountDays: 7, source: 'vendor' });
    bill = await postBill({ txnDate: '2026-03-01', paymentTerms: undefined });
    expect(bill).toMatchObject({ paymentTerms: 'custom', dueDate: '2026-03-26', discountDate: '2026-03-08' });
    r = await request('GET', '/api/v1/bills/terms-dates?txnDate=2026-13-01', c.token);
    expect(r.status).toBe(400);

    r = await request('GET', '/api/v1/payment-terms', c.token);
    expect(r.status).toBe(200);
    const codes = r.json.terms.map((t: any) => t.code);
    expect(codes).toEqual(['due_on_receipt', 'net_10', 'net_15', 'net_30', 'net_45', 'net_60', 'net_90', '1_10_net_30', '2_10_net_30', 'custom']);
    expect(r.json.terms.find((t: any) => t.code === '2_10_net_30')).toEqual({ code: '2_10_net_30', label: '2% 10 Net 30', netDays: 30, discountPercent: '2.0000', discountDays: 10 });
  });
});

describe('bill received (bill-received-v1)', () => {
  it('not received: in A/P and vendor-summary, out of payable, refused by Pay Bills until ticked', async () => {
    const bill = await postBill({ billReceived: false });
    expect(bill.billReceived).toBe(false);
    expect(Number((await summary()).totalOwed)).toBe(1480);
    expect(await apNet()).toBe('1480.0000');
    let payable = (await request('GET', '/api/v1/bills/payable', c.token)).json.bills;
    expect(payable.map((p: any) => p.id)).not.toContain(bill.id);
    let r = await pay([{ billId: bill.id, amount: '1480.00' }]);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BILL_NOT_RECEIVED');
    // Omitted on edit keeps it; true is an ordinary edit.
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ memo: 'still waiting' }));
    expect(r.json.bill.billReceived).toBe(false);
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ billReceived: true }));
    expect(r.json.bill.billReceived).toBe(true);
    payable = (await request('GET', '/api/v1/bills/payable', c.token)).json.bills;
    expect(payable.map((p: any) => p.id)).toContain(bill.id);
    const list = (await request('GET', `/api/v1/bills?contactId=${c.vendor}`, c.token)).json.data;
    expect(list[0]).toMatchObject({ billReceived: true });
    expect((await postBill()).billReceived).toBe(true);
  });
});

describe('vendor credit list (review S6)', () => {
  it('rows carry vendorInvoiceNumber and search matches it', async () => {
    await postCredit({ vendorInvoiceNumber: 'CM-7781' });
    await postCredit({ vendorInvoiceNumber: 'CM-0001' });
    const r = await request('GET', `/api/v1/vendor-credits?contactId=${c.vendor}&search=7781`, c.token);
    expect(r.status).toBe(200);
    expect(r.json.data).toHaveLength(1);
    expect(r.json.data[0].vendorInvoiceNumber).toBe('CM-7781');
  });
});
