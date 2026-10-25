// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// A/P documents, security-review fix pass (PR #173):
//   H1  the generic void / delete / duplicate / edit routes (and v2 void)
//       need the A/P document's own permission (bills, vendor_credits,
//       pay_bills); duplicates merge refuses A/P documents
//   M2  POST /attachments/:id/link checks the attachment's and the target's
//       company (two companies in one tenant)
//   M3  an accountant excluded from a company can't void or pay its bills,
//       credits or payments; drafts of another company are not relinked
//   M4  Pay Bills and payment void in a closed period audit the payment id
//       and its dates
//   M5  bulk update skips A/P documents
//   L1  legacy free-text terms sent back unchanged; lines sent back
//       unchanged keep item, quantity, cost, customer and billable
//   L5  discount ranges are database constraints
//   idempotency-ap-v1: replay on every keyed A/P route; the A/P refusals
//       (STALE, BILL_HAS_PAYMENTS, CREDIT_APPLIED, TXN_DELETE_LINKED) are
//       never stored, on the new routes and on idempotency-v1's

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
  contacts, depositLines, transactionTags, vendorCreditApplications, billPaymentApplications, userPermissions,
  attachments, billCaptures, items, idempotencyKeys, accountantCompanyExclusions,
} from '../db/schema/index.js';
import { transactionsRouter } from './transactions.routes.js';
import { billsRouter } from './bills.routes.js';
import { vendorCreditsRouter } from './vendor-credits.routes.js';
import { billPaymentsRouter } from './bill-payments.routes.js';
import { attachmentsRouter } from './attachments.routes.js';
import { duplicatesRouter } from './duplicates.routes.js';
import { apiV2Router } from './api-v2.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const CLOSING_PHRASE = 'ap-guards-456'; // gitleaks:allow (test placeholder)

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
        let json: unknown = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
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
  await db.delete(billCaptures).where(eq(billCaptures.tenantId, tid));
  await db.delete(attachments).where(eq(attachments.tenantId, tid));
  await db.delete(billPaymentApplications).where(eq(billPaymentApplications.tenantId, tid));
  await db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(items).where(eq(items.tenantId, tid));
  await db.delete(contacts).where(eq(contacts.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) {
    await db.delete(accountantCompanyExclusions).where(inArray(accountantCompanyExclusions.userId, staff.map((u) => u.id)));
    await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  }
  await db.delete(companies).where(eq(companies.tenantId, tid));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

interface Co {
  tenantId: string; userId: string; token: string; companyId: string; companyB: string;
  bank: string; ap: string; expense: string; otherExpense: string; income: string;
  customer: string; vendor: string;
}

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `apguard-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `AP Guards ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [companyB] = await db.insert(companies).values({ tenantId, businessName: `AP Guards ${label} B`, setupComplete: true }).returning();
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const ap = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_payable')) });
  const expenses = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(2);
  const [income] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue'))).limit(1);
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Table Rock Marina' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Midwest Equipment Rental' }).returning();
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: company!.id, companyB: companyB!.id,
    bank: bank!.id, ap: ap!.id, expense: expenses[0]!.id, otherExpense: expenses[1]!.id, income: income?.id ?? expenses[1]!.id,
    customer: customer!.id, vendor: vendor!.id,
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
  app.use('/api/v1/attachments', attachmentsRouter);
  app.use('/api/v1/duplicates', duplicatesRouter);
  app.use('/api/v2', apiV2Router);
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
const payBody = (bills: Array<{ billId: string; amount: string }>, extra: Record<string, unknown> = {}) => ({
  bankAccountId: c.bank, txnDate: '2026-11-20', method: 'check', printLater: true, bills, ...extra,
});
const payBill = async (billId: string, amount = '1480.00') => {
  const r = await request('POST', '/api/v1/bill-payments', c.token, payBody([{ billId, amount }]));
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.payments[0].id as string;
};
/** Moves documents to company B (as if entered there). */
const moveToB = async (...ids: string[]) => {
  await db.update(transactions).set({ companyId: c.companyB }).where(inArray(transactions.id, ids));
  await db.update(journalLines).set({ companyId: c.companyB }).where(inArray(journalLines.transactionId, ids));
};

async function bookkeeper(overrides: Record<string, string>) {
  const [u] = await db.insert(users).values({
    tenantId: c.tenantId, email: `bk-${suffix()}@example.com`, passwordHash: 'x', displayName: 'Bookkeeper', role: 'bookkeeper',
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper' });
  await db.insert(userPermissions).values({ tenantId: c.tenantId, userId: u!.id, overrides: overrides as never });
  const token = (await authService.issueSession({ userId: u!.id, tenantId: c.tenantId, role: 'bookkeeper', email: u!.email } as never)).accessToken;
  return { id: u!.id, token };
}

const ALL_AP = { transactions: 'full', bills: 'full', vendor_credits: 'full', pay_bills: 'full', attachments: 'full' };

describe('H1: the generic routes need the A/P document\'s own permission', () => {
  it('transactions without bills / vendor_credits / pay_bills: 403 on void, delete, duplicate and edit; plain entries still work', async () => {
    const bill = await postBill();
    const bill2 = await postBill({ vendorInvoiceNumber: 'INV-2' });
    const credit = await postCredit();
    const paid = await postBill({ vendorInvoiceNumber: 'INV-3' });
    const paymentId = await payBill(paid.id);
    const bk = await bookkeeper({ transactions: 'full', bills: 'none', vendor_credits: 'none', pay_bills: 'none' });

    const denied = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await request(method, path, bk.token, body, headers);
      expect(r.status, `${method} ${path} ${JSON.stringify(r.json)}`).toBe(403);
      expect(r.json.error.code).toBe('PERMISSION_DENIED');
    };
    await denied('POST', `/api/v1/transactions/${bill.id}/void`, { reason: 'x' });
    await denied('DELETE', `/api/v1/transactions/${bill2.id}`);
    await denied('POST', `/api/v1/transactions/${bill.id}/duplicate`);
    await denied('PUT', `/api/v1/transactions/${bill.id}`, { txnType: 'expense', txnDate: '2026-11-03', lines: [] });
    await denied('POST', `/api/v1/transactions/${credit.id}/void`, { reason: 'x' });
    await denied('DELETE', `/api/v1/transactions/${credit.id}`);
    await denied('POST', `/api/v1/transactions/${paymentId}/void`, { reason: 'x' });
    // With an Idempotency-Key too (the guard runs ahead of idempotent()).
    await denied('POST', `/api/v1/transactions/${bill.id}/void`, { reason: 'x' }, { 'Idempotency-Key': crypto.randomUUID() });
    expect((await row(bill.id)).status).toBe('posted');
    expect((await row(bill2.id)).status).toBe('posted');
    expect((await row(credit.id)).status).toBe('posted');
    expect((await row(paymentId)).status).toBe('posted');

    // A plain expense is still the transactions permission's.
    const exp = await request('POST', '/api/v1/transactions', bk.token, {
      txnType: 'expense', txnDate: '2026-11-04', payFromAccountId: c.bank, contactId: c.vendor,
      lines: [{ expenseAccountId: c.expense, amount: '12.50', description: 'Fuel' }],
    });
    expect(exp.status, JSON.stringify(exp.json)).toBe(201);
    expect((await request('POST', `/api/v1/transactions/${exp.json.transaction.id}/void`, bk.token, { reason: 'x' })).status).toBe(200);

    // With the owning permission the same calls go through.
    const full = await bookkeeper({ transactions: 'full', bills: 'full', vendor_credits: 'full', pay_bills: 'full' });
    expect((await request('POST', `/api/v1/transactions/${paymentId}/void`, full.token, { reason: 'x' })).status).toBe(200);
    expect((await request('POST', `/api/v1/transactions/${bill.id}/void`, full.token, { reason: 'x' })).status).toBe(200);
    expect((await request('DELETE', `/api/v1/transactions/${credit.id}`, full.token)).status).toBe(200);
  });

  it('view-only on bills is not enough to void one', async () => {
    const bill = await postBill();
    const bk = await bookkeeper({ transactions: 'full', bills: 'view' });
    const r = await request('POST', `/api/v1/transactions/${bill.id}/void`, bk.token, { reason: 'x' });
    expect(r.status).toBe(403);
  });

  it('v2 POST /transactions/:id/void: transactions without pay_bills can\'t void a bill payment; scoped to the company', async () => {
    const bill = await postBill();
    const paymentId = await payBill(bill.id);
    const bk = await bookkeeper({ transactions: 'full', bills: 'full', vendor_credits: 'full', pay_bills: 'none' });
    let r = await request('POST', `/api/v2/transactions/${paymentId}/void`, bk.token, { reason: 'x' });
    expect(r.status, JSON.stringify(r.json)).toBe(403);
    expect(r.json.error.code).toBe('PERMISSION_DENIED');
    expect((await row(paymentId)).status).toBe('posted');
    expect((await row(bill.id)).billStatus).toBe('paid');

    // Another company's document is not found from company A.
    const billB = await postBill({ vendorInvoiceNumber: 'INV-B' });
    await moveToB(billB.id);
    r = await request('POST', `/api/v2/transactions/${billB.id}/void`, c.token, { reason: 'x' });
    expect(r.status).toBe(404);
    expect((await row(billB.id)).status).toBe('posted');

    // With pay_bills the v2 void goes through and frees the bill.
    const full = await bookkeeper(ALL_AP);
    r = await request('POST', `/api/v2/transactions/${paymentId}/void`, full.token, { reason: 'x' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await row(paymentId)).status).toBe('void');
    expect((await row(bill.id)).billStatus).toBe('unpaid');
  });

  it('POST /duplicates/merge refuses A/P documents (409 TXN_DUPLICATE_UNSUPPORTED) and is scoped to the company', async () => {
    const bill = await postBill();
    const bill2 = await postBill({ vendorInvoiceNumber: 'INV-2' });
    const credit = await postCredit();
    const paid = await postBill({ vendorInvoiceNumber: 'INV-3' });
    const paymentId = await payBill(paid.id);
    const expense = async (amount: string) => {
      const r = await request('POST', '/api/v1/transactions', c.token, {
        txnType: 'expense', txnDate: '2026-11-04', payFromAccountId: c.bank, contactId: c.vendor,
        lines: [{ expenseAccountId: c.expense, amount }],
      });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json.transaction.id as string;
    };
    const exp1 = await expense('1480.00');

    for (const [keepId, voidId] of [[bill.id, bill2.id], [exp1, bill2.id], [bill.id, exp1], [exp1, credit.id], [exp1, paymentId]]) {
      const r = await request('POST', '/api/v1/duplicates/merge', c.token, { keepId, voidId });
      expect(r.status, JSON.stringify(r.json)).toBe(409);
      expect(r.json.error.code).toBe('TXN_DUPLICATE_UNSUPPORTED');
    }
    for (const id of [bill.id, bill2.id, credit.id, paymentId, exp1]) expect((await row(id)).status).toBe('posted');
    expect((await row(paid.id)).billStatus).toBe('paid');

    // Another company's expense is not found from company A.
    const exp2 = await expense('1480.00');
    const expB = await expense('1480.00');
    await moveToB(expB);
    let r = await request('POST', '/api/v1/duplicates/merge', c.token, { keepId: exp1, voidId: expB });
    expect(r.status).toBe(404);
    expect((await row(expB)).status).toBe('posted');

    // Two plain expenses still merge.
    r = await request('POST', '/api/v1/duplicates/merge', c.token, { keepId: exp1, voidId: exp2 });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await row(exp2)).status).toBe('void');
  });
});

describe('M2: attachment links check both companies', () => {
  it('an attachment of company B can\'t be linked from A; A\'s attachment can\'t go to B\'s bill', async () => {
    const billA = await postBill();
    const billB = await postBill({ vendorInvoiceNumber: 'INV-B' });
    await moveToB(billB.id);
    const insertAtt = async (v: { companyId: string | null; attachableType: string; attachableId: string }) =>
      (await db.insert(attachments).values({ tenantId: c.tenantId, fileName: 'f.pdf', filePath: 'x/f.pdf', ...v }).returning())[0]!;

    // Stamped with company B.
    const stampedB = await insertAtt({ companyId: c.companyB, attachableType: 'draft', attachableId: crypto.randomUUID() });
    let r = await request('POST', `/api/v1/attachments/${stampedB.id}/link`, c.token, { attachableType: 'bill', attachableId: billA.id });
    expect(r.status).toBe(404);
    // Tenant-wide row attached to B's bill: its company is the bill's.
    const onBillB = await insertAtt({ companyId: null, attachableType: 'bill', attachableId: billB.id });
    r = await request('POST', `/api/v1/attachments/${onBillB.id}/link`, c.token, { attachableType: 'draft', attachableId: crypto.randomUUID() });
    expect(r.status).toBe(404);
    expect((await db.select().from(attachments).where(eq(attachments.id, onBillB.id)))[0]).toMatchObject({ attachableType: 'bill', attachableId: billB.id });
    // A tenant-wide draft to B's bill from A: the target is another company's.
    const draft = await insertAtt({ companyId: null, attachableType: 'draft', attachableId: crypto.randomUUID() });
    r = await request('POST', `/api/v1/attachments/${draft.id}/link`, c.token, { attachableType: 'bill', attachableId: billB.id });
    expect(r.status).toBe(404);
    // Same calls in company B's context work.
    r = await request('POST', `/api/v1/attachments/${draft.id}/link`, c.token, { attachableType: 'bill', attachableId: billB.id }, { 'X-Company-Id': c.companyB });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await request('POST', `/api/v1/attachments/${stampedB.id}/link`, c.token, { attachableType: 'bill', attachableId: billB.id }, { 'X-Company-Id': c.companyB });
    expect(r.status).toBe(200);
    // A's own draft to A's bill.
    const draftA = await insertAtt({ companyId: c.companyId, attachableType: 'draft', attachableId: crypto.randomUUID() });
    r = await request('POST', `/api/v1/attachments/${draftA.id}/link`, c.token, { attachableType: 'bill', attachableId: billA.id });
    expect(r.status).toBe(200);
    r = await request('POST', `/api/v1/attachments/${crypto.randomUUID()}/link`, c.token, { attachableType: 'bill', attachableId: billA.id });
    expect(r.status).toBe(404);
  });

  it('extract-from-attachment: another company\'s attachment is 404 before any OCR runs', async () => {
    const insertAtt = async (companyId: string | null) => (await db.insert(attachments).values({
      tenantId: c.tenantId, companyId, fileName: 'f.pdf', filePath: 'x/f.pdf', attachableType: 'draft', attachableId: crypto.randomUUID(),
    }).returning())[0]!;
    const attB = await insertAtt(c.companyB);
    let r = await request('POST', `/api/v1/bills/extract-from-attachment/${attB.id}`, c.token);
    expect(r.status, JSON.stringify(r.json)).toBe(404);
    // Its own company's, or a tenant-wide one, passes the check (and then
    // stops at the AI gates, not found-ness).
    for (const att of [await insertAtt(c.companyId), await insertAtt(null)]) {
      r = await request('POST', `/api/v1/bills/extract-from-attachment/${att.id}`, c.token);
      expect(r.status, JSON.stringify(r.json)).not.toBe(404);
    }
    r = await request('POST', `/api/v1/bills/extract-from-attachment/${attB.id}`, c.token, undefined, { 'X-Company-Id': c.companyB });
    expect(r.status).not.toBe(404);
  });

  it('attach-draft and draftAttachmentId leave another company\'s draft alone', async () => {
    const draftId = crypto.randomUUID();
    const [attB] = await db.insert(attachments).values({
      tenantId: c.tenantId, companyId: c.companyB, fileName: 'b.pdf', filePath: 'x/b.pdf', attachableType: 'draft', attachableId: draftId,
    }).returning();
    const [attShared] = await db.insert(attachments).values({
      tenantId: c.tenantId, companyId: null, fileName: 's.pdf', filePath: 'x/s.pdf', attachableType: 'draft', attachableId: draftId,
    }).returning();
    const bill = await postBill({ draftAttachmentId: draftId });
    const get = async (id: string) => (await db.select().from(attachments).where(eq(attachments.id, id)))[0]!;
    expect(await get(attB!.id)).toMatchObject({ attachableType: 'draft', attachableId: draftId });
    expect(await get(attShared!.id)).toMatchObject({ attachableType: 'bill', attachableId: bill.id });

    const bill2 = await postBill({ vendorInvoiceNumber: 'INV-2' });
    const r = await request('POST', `/api/v1/bills/${bill2.id}/attach-draft`, c.token, { draftId });
    expect(r.status).toBe(200);
    expect(r.json.reassigned).toBe(0);
    expect(await get(attB!.id)).toMatchObject({ attachableType: 'draft' });
  });
});

describe('M3: an accountant excluded from a company can\'t void or pay its documents', () => {
  it('void bill, credit and payment, generic void, delete and Pay Bills are 404 / refused; nothing changes', async () => {
    const billB = await postBill();
    const paidB = await postBill({ vendorInvoiceNumber: 'INV-P' });
    const paymentB = await payBill(paidB.id);
    const creditB = await postCredit();
    await moveToB(billB.id, paidB.id, paymentB, creditB.id);
    const acct = await bookkeeper(ALL_AP);
    await db.insert(accountantCompanyExclusions).values({ userId: acct.id, companyId: c.companyB } as never);

    // Naming company B is refused outright.
    let r = await request('POST', `/api/v1/bills/${billB.id}/void`, acct.token, { reason: 'x' }, { 'X-Company-Id': c.companyB });
    expect(r.status).toBe(403);
    // Without the header the accountant works in A: B's documents are not found.
    const notFound = async (method: string, path: string, body?: unknown) => {
      const res = await request(method, path, acct.token, body);
      expect(res.status, `${method} ${path} ${JSON.stringify(res.json)}`).toBe(404);
    };
    await notFound('POST', `/api/v1/bills/${billB.id}/void`, { reason: 'x' });
    await notFound('POST', `/api/v1/transactions/${billB.id}/void`, { reason: 'x' });
    await notFound('DELETE', `/api/v1/transactions/${billB.id}`);
    await notFound('POST', `/api/v1/vendor-credits/${creditB.id}/void`, { reason: 'x' });
    await notFound('POST', `/api/v1/transactions/${creditB.id}/void`, { reason: 'x' });
    await notFound('POST', `/api/v1/bill-payments/${paymentB}/void`, { reason: 'x' });
    await notFound('POST', `/api/v1/transactions/${paymentB}/void`, { reason: 'x' });
    r = await request('POST', '/api/v1/bill-payments', acct.token, payBody([{ billId: billB.id, amount: '10.00' }]));
    expect(r.status).toBe(400);
    expect(r.json.error.message).toMatch(/not found/i);
    r = await request('POST', '/api/v1/bill-payments', acct.token, payBody([{ billId: billB.id, amount: '10.00' }]));
    expect(r.status).toBe(400);

    for (const id of [billB.id, paidB.id, paymentB, creditB.id]) expect((await row(id)).status).toBe('posted');
    expect((await row(billB.id)).balanceDue).toBe('1480.0000');
    expect(await db.select().from(billPaymentApplications).where(eq(billPaymentApplications.billId, billB.id))).toHaveLength(0);

    // A credit of B can't be applied to an A bill either.
    const billA = await postBill({ vendorInvoiceNumber: 'INV-A' });
    r = await request('POST', '/api/v1/bill-payments', acct.token, {
      ...payBody([{ billId: billA.id, amount: '200.00' }]), credits: [{ creditId: creditB.id, billId: billA.id, amount: '200.00' }],
    });
    expect(r.status).toBe(400);
    expect((await row(creditB.id)).balanceDue).toBe('200.0000');

    // In its own company the owner still can.
    r = await request('POST', `/api/v1/bill-payments/${paymentB}/void`, c.token, { reason: 'x' }, { 'X-Company-Id': c.companyB });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  });
});

describe('M4: closed-period payments audit the payment and its dates', () => {
  it('Pay Bills writes one override row per payment with its id and date; void with the old date', async () => {
    const bill = await postBill({ txnDate: '2026-06-01' });
    await db.update(companies).set({ lockDate: '2026-06-30', closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) })
      .where(eq(companies.id, c.companyId));
    const overrides = () => db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'closing_date_override'),
    ));
    expect(await overrides()).toHaveLength(0);
    let r = await request('POST', '/api/v1/bill-payments', c.token, {
      ...payBody([{ billId: bill.id, amount: '1480.00' }], { txnDate: '2026-06-25' }), closingPassword: CLOSING_PHRASE,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const paymentId = r.json.payments[0].id;
    let rows = await overrides();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(paymentId);
    expect(rows[0]!.afterData).toMatchObject({ transactionId: paymentId, oldDate: null, newDate: '2026-06-25', method: 'password' });
    expect(JSON.stringify(rows[0])).not.toContain(CLOSING_PHRASE);

    r = await request('POST', `/api/v1/bill-payments/${paymentId}/void`, c.token, { reason: 'x', closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(200);
    rows = await overrides();
    expect(rows).toHaveLength(2);
    expect(rows.find((o) => (o.afterData as any)?.oldDate === '2026-06-25')!.afterData)
      .toMatchObject({ transactionId: paymentId, oldDate: '2026-06-25', newDate: null });
  });
});

describe('M5: bulk update skips A/P documents', () => {
  it('a bill, credit and payment are skipped with ap_document; an expense is updated', async () => {
    const bill = await postBill();
    const credit = await postCredit();
    const paid = await postBill({ vendorInvoiceNumber: 'INV-P' });
    const paymentId = await payBill(paid.id);
    const exp = await request('POST', '/api/v1/transactions', c.token, {
      txnType: 'expense', txnDate: '2026-11-04', payFromAccountId: c.bank, contactId: c.vendor,
      lines: [{ expenseAccountId: c.expense, amount: '12.50' }],
    });
    expect(exp.status).toBe(201);
    const [other] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'vendor', displayName: 'Cosmos Granite' }).returning();
    const r = await request('POST', '/api/v1/transactions/bulk-update', c.token, {
      txnIds: [bill.id, credit.id, paymentId, exp.json.transaction.id], setPayeeContactId: other!.id,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.updated).toBe(1);
    expect(r.json.skipped).toEqual(expect.arrayContaining([
      { id: bill.id, reason: 'ap_document' }, { id: credit.id, reason: 'ap_document' }, { id: paymentId, reason: 'ap_document' },
    ]));
    expect((await row(bill.id)).contactId).toBe(c.vendor);
    expect((await row(exp.json.transaction.id)).contactId).toBe(other!.id);
    const tagged = await request('POST', '/api/v1/transactions/bulk-update', c.token, { txnIds: [bill.id], setCategoryAccountId: c.otherExpense });
    expect(tagged.json.skipped).toEqual([{ id: bill.id, reason: 'ap_document' }]);
  });
});

describe('L1: an edit keeps what it sends back unchanged', () => {
  it('legacy free-text terms equal to the stored ones are kept with their due date; other unknown terms are 400', async () => {
    const bill = await postBill();
    await db.update(transactions).set({ paymentTerms: 'Net 30 EOM', dueDate: '2026-12-31', termsDays: null }).where(eq(transactions.id, bill.id));
    let r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ paymentTerms: 'Net 30 EOM', memo: 'kept terms' }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.bill).toMatchObject({ paymentTerms: 'Net 30 EOM', dueDate: '2026-12-31', memo: 'kept terms' });
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ paymentTerms: 'Net 45 EOM' }));
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VALIDATION_ERROR');
    // A new bill takes codes only.
    r = await request('POST', '/api/v1/bills', c.token, billBody({ paymentTerms: 'Net 30 EOM' }));
    expect(r.status).toBe(400);
    // Switching to a table code recomputes the due date.
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ paymentTerms: 'net_30' }));
    expect(r.status).toBe(200);
    expect(r.json.bill.dueDate).toBe('2026-12-03');
  });

  it('lines sent back without item fields keep item, quantity, cost, customer and billable; null clears them', async () => {
    const [item] = await db.insert(items).values({ tenantId: c.tenantId, name: 'Boat lift', incomeAccountId: c.income } as any).returning();
    const bill = await postBill({}, [
      { accountId: c.expense, itemId: item!.id, quantity: '4', unitPrice: '218.44', amount: '873.76', contactId: c.customer, isBillable: true, description: 'Lift' },
      { accountId: c.otherExpense, amount: '606.24', description: 'Delivery' },
    ]);
    const docLines = (b: any) => b.lines.filter((l: any) => Number(l.debit) > 0 && !l.isVoidReversal);
    // An older client: amounts and descriptions only.
    let r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({ memo: 'edited' }, [
      { accountId: c.expense, amount: '873.76', description: 'Lift' },
      { accountId: c.otherExpense, amount: '606.24', description: 'Delivery' },
    ]));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(docLines(r.json.bill)[0]).toMatchObject({
      itemId: item!.id, quantity: '4.0000', unitPrice: '218.4400', contactId: c.customer, isBillable: true, billedStatus: 'unbilled',
    });
    // A changed amount is a new line: nothing carried.
    r = await request('PUT', `/api/v1/bills/${bill.id}`, c.token, billBody({}, [
      { accountId: c.expense, amount: '873.75', description: 'Lift' },
      { accountId: c.otherExpense, amount: '606.24', description: 'Delivery' },
    ]));
    expect(r.status).toBe(200);
    expect(docLines(r.json.bill)[0]).toMatchObject({ itemId: null, quantity: null, unitPrice: null, contactId: null, isBillable: false });

    // Explicit nulls clear.
    const bill2 = await postBill({ vendorInvoiceNumber: 'INV-2' }, [
      { accountId: c.expense, itemId: item!.id, quantity: '2', unitPrice: '740', amount: '1480.00', contactId: c.customer, isBillable: true },
    ]);
    r = await request('PUT', `/api/v1/bills/${bill2.id}`, c.token, billBody({ vendorInvoiceNumber: 'INV-2' }, [
      { accountId: c.expense, amount: '1480.00', itemId: null, quantity: null, unitPrice: null, contactId: null, isBillable: false },
    ]));
    expect(r.status).toBe(200);
    expect(docLines(r.json.bill)[0]).toMatchObject({ itemId: null, quantity: null, contactId: null, isBillable: false });

    // Vendor credits too.
    const cr = await request('POST', '/api/v1/vendor-credits', c.token, creditBody({
      lines: [{ accountId: c.expense, itemId: item!.id, quantity: '2', unitPrice: '100', amount: '200.00', contactId: c.customer }],
    }));
    expect(cr.status).toBe(201);
    r = await request('PUT', `/api/v1/vendor-credits/${cr.json.credit.id}`, c.token, creditBody({ memo: 'edited' }));
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.credit.lines.find((l: any) => Number(l.credit) > 0)).toMatchObject({
      itemId: item!.id, quantity: '2.0000', unitPrice: '100.0000', contactId: c.customer,
    });
  });
});

describe('L5: discount ranges are database constraints', () => {
  it('refuses out-of-range discount days and percents written directly', async () => {
    const bill = await postBill();
    await expect(db.update(transactions).set({ discountDays: 400 }).where(eq(transactions.id, bill.id))).rejects.toThrow();
    await expect(db.update(transactions).set({ discountDays: -1 }).where(eq(transactions.id, bill.id))).rejects.toThrow();
    await expect(db.update(contacts).set({ defaultDiscountDays: 366 }).where(eq(contacts.id, c.vendor))).rejects.toThrow();
    await expect(db.update(contacts).set({ defaultDiscountPercent: '0' }).where(eq(contacts.id, c.vendor))).rejects.toThrow();
    await expect(db.update(contacts).set({ defaultDiscountPercent: '100' }).where(eq(contacts.id, c.vendor))).rejects.toThrow();
    await db.update(contacts).set({ defaultDiscountPercent: '2.5', defaultDiscountDays: 10 }).where(eq(contacts.id, c.vendor));
  });
});

describe('idempotency-ap-v1', () => {
  const key = () => crypto.randomUUID();
  const keyRows = (k: string) => db.select().from(idempotencyKeys).where(and(eq(idempotencyKeys.tenantId, c.tenantId), eq(idempotencyKeys.idempotencyKey, k)));
  const keyed = (method: string, path: string, body: unknown, k: string, headers: Record<string, string> = {}) =>
    request(method, path, c.token, body, { 'Idempotency-Key': k, ...headers });
  const count = async (type: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(transactions)
    .where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnType, type))))[0]!.n;
  const audits = async (entityId: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(auditLog)
    .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityId, entityId))))[0]!.n;

  it('is advertised', () => {
    expect(DESKTOP_CAPABILITIES).toContain('idempotency-ap-v1');
  });

  it('every keyed A/P route: first + replay -> one effect', async () => {
    // POST /vendor-credits.
    let k = key();
    const n0 = await count('vendor_credit');
    const first = await keyed('POST', '/api/v1/vendor-credits', creditBody(), k);
    expect(first.status).toBe(201);
    const again = await keyed('POST', '/api/v1/vendor-credits', creditBody(), k);
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json).toEqual(first.json);
    expect(await count('vendor_credit')).toBe(n0 + 1);
    const credit = first.json.credit;

    // PUT /vendor-credits/:id with the token: the replay is 200, not STALE.
    k = key();
    const putBody = creditBody({ memo: 'once', expectedUpdatedAt: credit.updatedAt });
    let a = await keyed('PUT', `/api/v1/vendor-credits/${credit.id}`, putBody, k);
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const auditsAfter = await audits(credit.id);
    let b = await keyed('PUT', `/api/v1/vendor-credits/${credit.id}`, putBody, k);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(await audits(credit.id)).toBe(auditsAfter);
    expect((await keyRows(k))[0]).toMatchObject({ route: 'PUT /vendor-credits/:id', entityId: credit.id, state: 'done' });

    // POST /vendor-credits/:id/void: the replay is 200, not "already void".
    k = key();
    a = await keyed('POST', `/api/v1/vendor-credits/${credit.id}/void`, { reason: 'dup' }, k);
    expect(a.status).toBe(200);
    b = await keyed('POST', `/api/v1/vendor-credits/${credit.id}/void`, { reason: 'dup' }, k);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json.credit.status).toBe('void');

    // PUT /bills/:id.
    const bill = await postBill();
    k = key();
    const billPut = billBody({ vendorInvoiceNumber: 'INV-ONCE', expectedUpdatedAt: bill.updatedAt });
    a = await keyed('PUT', `/api/v1/bills/${bill.id}`, billPut, k);
    expect(a.status).toBe(200);
    b = await keyed('PUT', `/api/v1/bills/${bill.id}`, billPut, k);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json).toEqual(a.json);

    // POST /bill-payments/:id/void.
    const paymentId = await payBill(bill.id);
    k = key();
    a = await keyed('POST', `/api/v1/bill-payments/${paymentId}/void`, { reason: 'x' }, k);
    expect(a.status).toBe(200);
    b = await keyed('POST', `/api/v1/bill-payments/${paymentId}/void`, { reason: 'x' }, k);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect((await row(bill.id)).billStatus).toBe('unpaid');

    // POST /bills/:id/void.
    k = key();
    a = await keyed('POST', `/api/v1/bills/${bill.id}/void`, { reason: 'x' }, k);
    expect(a.status).toBe(200);
    b = await keyed('POST', `/api/v1/bills/${bill.id}/void`, { reason: 'x' }, k);
    expect(b.status).toBe(200);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json.bill.status).toBe('void');
  });

  it('A/P refusals are never stored: the retry with the key runs again once the cause is gone', async () => {
    const bill = await postBill();
    const paymentId = await payBill(bill.id, '100.00');

    // 409 BILL_HAS_PAYMENTS on POST /bills/:id/void (idempotency-ap-v1) …
    const kVoid = key();
    let r = await keyed('POST', `/api/v1/bills/${bill.id}/void`, { reason: 'dup' }, kVoid);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BILL_HAS_PAYMENTS');
    expect(await keyRows(kVoid)).toHaveLength(0);
    // … and on DELETE /transactions/:id (idempotency-v1).
    const kDel = key();
    r = await keyed('DELETE', `/api/v1/transactions/${bill.id}`, undefined, kDel);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('BILL_HAS_PAYMENTS');
    expect(await keyRows(kDel)).toHaveLength(0);
    // … and on POST /transactions/:id/void (idempotency-v1).
    const kTv = key();
    r = await keyed('POST', `/api/v1/transactions/${bill.id}/void`, { reason: 'dup' }, kTv);
    expect(r.status).toBe(409);
    expect(await keyRows(kTv)).toHaveLength(0);

    // 409 STALE on PUT /bills/:id.
    const kStale = key();
    r = await keyed('PUT', `/api/v1/bills/${bill.id}`, billBody({ expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }), kStale);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('STALE');
    expect(await keyRows(kStale)).toHaveLength(0);

    // Once the payment is voided the same keyed void runs (not a stored 409).
    expect((await request('POST', `/api/v1/bill-payments/${paymentId}/void`, c.token, { reason: 'x' })).status).toBe(200);
    r = await keyed('POST', `/api/v1/bills/${bill.id}/void`, { reason: 'dup' }, kVoid);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.headers['idempotent-replayed']).toBeUndefined();
    expect(r.json.bill.status).toBe('void');

    // 409 CREDIT_APPLIED on PUT /vendor-credits/:id and void.
    const credit = await postCredit();
    const bill2 = await postBill({ vendorInvoiceNumber: 'INV-2' });
    r = await request('POST', '/api/v1/bill-payments', c.token, {
      ...payBody([{ billId: bill2.id, amount: '200.00' }]), credits: [{ creditId: credit.id, billId: bill2.id, amount: '200.00' }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const kCr = key();
    r = await keyed('PUT', `/api/v1/vendor-credits/${credit.id}`, creditBody({ memo: 'x' }), kCr);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('CREDIT_APPLIED');
    expect(await keyRows(kCr)).toHaveLength(0);
    const kCrVoid = key();
    r = await keyed('POST', `/api/v1/vendor-credits/${credit.id}/void`, { reason: 'x' }, kCrVoid);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('CREDIT_APPLIED');
    expect(await keyRows(kCrVoid)).toHaveLength(0);

    // 409 TXN_DELETE_LINKED on DELETE /transactions/:id (a captured bill).
    const captured = await postBill({ vendorInvoiceNumber: 'INV-CAP' });
    const [att] = await db.insert(attachments).values({
      tenantId: c.tenantId, companyId: c.companyId, fileName: 'inv.pdf', filePath: 'x/inv.pdf', attachableType: 'bill', attachableId: captured.id,
    }).returning();
    await db.insert(billCaptures).values({
      tenantId: c.tenantId, companyId: c.companyId, attachmentId: att!.id, source: 'staff', uploadedByUserId: c.userId, status: 'entered',
      billId: captured.id, contentSha256: 'b'.repeat(64), fileName: 'inv.pdf',
    } as any);
    const kLinked = key();
    r = await keyed('DELETE', `/api/v1/transactions/${captured.id}`, undefined, kLinked);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('TXN_DELETE_LINKED');
    expect(await keyRows(kLinked)).toHaveLength(0);
  });
});
