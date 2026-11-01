// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The Receive Payment golden scenarios (ClientLedger P21, U-132 to U-135),
// canonical in packages/shared/fixtures/payment-golden.json; the ClientLedger
// client keeps a byte-identical copy (fixtures/payments/golden.json) and runs
// every case through its --demo engine. Each case starts from an empty
// company with one client and the invoices listed; steps run in order
// through the HTTP routes. Invoices are keyed by number, accounts by role.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, items, tags, transactionTags, userPermissions, idempotencyKeys, paymentApplications, depositLines,
} from '../db/schema/index.js';
import { paymentsRouter } from './payments.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as invoiceService from '../services/invoice.service.js';

const Decimal = DecimalLib.default || DecimalLib;
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/payment-golden.json'), 'utf8')) as {
  cases: Array<{
    id: number; name: string; company: { writeOffThreshold?: string };
    invoices: GoldenInvoice[]; otherPending?: string; steps: any[];
  }>;
};
interface GoldenInvoice { number: string; date: string; dueDate: string; total: string; discountPercent?: string; discountDays?: number }

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

function request(method: string, pathname: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(data ? { 'Content-Length': String(data.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json });
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
  await db.delete(paymentApplications).where(eq(paymentApplications.tenantId, tid));
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

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const m2 = (x: string | number | null | undefined) => new Decimal(String(x ?? '0')).toFixed(2);

/** One case's company: roles -> account ids, the client, the invoices by number. */
async function makeCase(c: (typeof golden.cases)[number]) {
  const reg = await authService.register({
    email: `rpg-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Neosho Supply',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const token = reg.tokens.accessToken;
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const tag = async (t: string) => (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, t)) }))!.id;
  const bank = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  const revenue = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) }))!.id;
  const mk = async (name: string, accountType: string, accountNumber: string) =>
    (await db.insert(accounts).values({ tenantId, companyId: company!.id, name, accountType, accountNumber }).returning())[0]!.id;
  const roles: Record<string, string> = {
    undeposited_funds: await tag('payments_clearing'),
    accounts_receivable: await tag('accounts_receivable'),
    operating: bank,
    write_off: await mk('Bad Debts (golden)', 'expense', '69001'),
    sales_discount: await mk('Sales Discounts (golden)', 'revenue', '49001'),
    bank_fee: await mk('Bank Fees (golden)', 'expense', '69002'),
  };
  await db.update(companies).set({
    defaultSalesTaxRate: '0', writeOffThreshold: c.company.writeOffThreshold ?? null,
    writeOffAccountId: roles['write_off'], salesDiscountAccountId: roles['sales_discount'], nsfBankFeeAccountId: roles['bank_fee'],
  }).where(eq(companies.id, company!.id));
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Neosho Dental Group' }).returning();
  const ctx = { tenantId, token, companyId: company!.id, roles, revenue, customer: customer!.id, invoices: new Map<string, string>(),
    payment: '', other: '', bankStart: '0', userId: reg.user.id };
  for (const inv of c.invoices) await addInvoice(ctx, inv);
  if (c.otherPending) {
    const [other] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Joplin Vet' }).returning();
    const oi = await invoiceService.createInvoice(tenantId, {
      contactId: other!.id, txnDate: '2026-10-01', lines: [{ accountId: revenue, description: 'Other', quantity: '1', unitPrice: c.otherPending, isTaxable: false }],
    } as never, reg.user.id, company!.id);
    const r = await request('POST', '/api/v1/payments/receive', token, {
      customerId: other!.id, date: '2026-11-01', depositTo: roles['undeposited_funds'], amount: c.otherPending,
      applications: [{ invoiceId: oi.id, amount: c.otherPending }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    ctx.other = r.json.payment.id;
  }
  ctx.bankStart = await accountBalance(ctx, roles['operating']!);
  return ctx;
}
type Ctx = Awaited<ReturnType<typeof makeCase>>;

async function addInvoice(ctx: Pick<Ctx, 'tenantId' | 'customer' | 'revenue' | 'userId' | 'companyId' | 'invoices'>, inv: GoldenInvoice) {
  const created = await invoiceService.createInvoice(ctx.tenantId, {
    contactId: ctx.customer, txnDate: inv.date, dueDate: inv.dueDate, txnNumber: inv.number,
    lines: [{ accountId: ctx.revenue, description: 'Work', quantity: '1', unitPrice: inv.total, isTaxable: false }],
  } as never, ctx.userId, ctx.companyId);
  const discountDate = inv.discountDays !== undefined
    ? new Date(Date.parse(inv.date + 'T00:00:00Z') + inv.discountDays * 86400000).toISOString().slice(0, 10) : null;
  await db.update(transactions).set({
    invoiceStatus: 'sent', sentAt: new Date(),
    ...(inv.discountPercent ? { discountPercent: inv.discountPercent, discountDays: inv.discountDays ?? null, discountDate } : {}),
  }).where(eq(transactions.id, created.id));
  ctx.invoices.set(inv.number, created.id);
}

/** Balance of an account from posted lines, debit positive (liabilities credit positive when asked). */
async function accountBalance(ctx: Pick<Ctx, 'tenantId'>, accountId: string, creditPositive = false) {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS b FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id WHERE jl.tenant_id = ${ctx.tenantId} AND jl.account_id = ${accountId} AND t.status = 'posted'`);
  const b = new Decimal((res.rows as Array<{ b: string }>)[0]!.b);
  return (creditPositive ? b.negated() : b).toFixed(2);
}

async function contactBalance(ctx: Ctx) {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS b FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id WHERE jl.tenant_id = ${ctx.tenantId} AND t.status = 'posted'
      AND jl.account_id = ${ctx.roles['accounts_receivable']} AND COALESCE(jl.contact_id, t.contact_id) = ${ctx.customer}`);
  return m2((res.rows as Array<{ b: string }>)[0]!.b);
}

const roleOf = (ctx: Ctx, accountId: string) =>
  Object.entries(ctx.roles).find(([, id]) => id === accountId)?.[0] ?? accountId;

async function lineSet(ctx: Ctx, txnId: string) {
  const rows = await db.select().from(journalLines).where(and(eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)));
  // Customer Deposits is created on first use (lazy role).
  const cd = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.systemTag, 'customer_deposits')) });
  if (cd) ctx.roles['customer_deposits'] = cd.id;
  return rows.map((l) => new Decimal(l.debit ?? '0').greaterThan(0)
    ? `${roleOf(ctx, l.accountId)}:debit:${m2(l.debit)}` : `${roleOf(ctx, l.accountId)}:credit:${m2(l.credit)}`).sort();
}
const expectedLines = (lines: Array<{ account: string; debit?: string; credit?: string }>) =>
  lines.map((l) => (l.debit !== undefined ? `${l.account}:debit:${l.debit}` : `${l.account}:credit:${l.credit}`)).sort();

const byNumber = (ctx: Ctx, rows: Array<{ invoiceId: string }>, field: string) => {
  const numberOf = new Map([...ctx.invoices].map(([n, id]) => [id, n]));
  return Object.fromEntries(rows.map((r: any) => [numberOf.get(r.invoiceId) ?? r.invoiceId, r[field]]));
};

async function checkCommon(ctx: Ctx, e: any) {
  if (e.invoices) {
    for (const [num, want] of Object.entries(e.invoices as Record<string, { balanceDue: string; status: string }>)) {
      const [row] = await db.select().from(transactions).where(eq(transactions.id, ctx.invoices.get(num)!));
      expect([num, m2(row!.balanceDue), row!.invoiceStatus]).toEqual([num, want.balanceDue, want.status]);
    }
  }
  if (e.contactBalance !== undefined) expect(await contactBalance(ctx)).toBe(e.contactBalance);
  if (e.customerDeposits !== undefined) {
    const cd = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, ctx.tenantId), eq(accounts.systemTag, 'customer_deposits')) });
    expect(cd ? await accountBalance(ctx, cd.id, true) : '0.00').toBe(e.customerDeposits);
  }
  if (e.unappliedRemaining !== undefined || e.depositRemaining !== undefined) {
    const rec = (await request('GET', `/api/v1/payments/${ctx.payment}`, ctx.token)).json.payment;
    if (e.unappliedRemaining !== undefined) expect(rec.unappliedRemaining).toBe(e.unappliedRemaining);
    if (e.depositRemaining !== undefined) expect(rec.depositRemaining).toBe(e.depositRemaining);
  }
}

const mapApps = (ctx: Ctx, apps: any[] | undefined) => apps?.map(({ invoice, ...rest }) => ({ invoiceId: ctx.invoices.get(invoice)!, ...rest }));

async function runStep(ctx: Ctx, c: (typeof golden.cases)[number], step: any) {
  const e = step.expect ?? {};
  switch (step.op) {
    case 'invoice':
      await addInvoice(ctx, step.invoice);
      return;
    case 'preview': {
      const { applications, ...rest } = step.request;
      const r = await request('POST', '/api/v1/payments/preview', ctx.token, {
        customerId: ctx.customer, depositTo: ctx.roles['undeposited_funds'], ...rest,
        ...(applications ? { applications: mapApps(ctx, applications) } : {}),
      });
      if (e.error) { expect(r.json?.error?.code ?? r.json?.problems?.[0]?.code).toBe(e.error); return; }
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const p = r.json;
      for (const k of ['amount', 'amountSource', 'contactBalanceBefore', 'contactBalanceAfter', 'overpayment', 'holdAsDepositOffered']) {
        if (e[k] !== undefined) expect([k, p[k]]).toEqual([k, e[k]]);
      }
      if (e.payments) expect(byNumber(ctx, p.invoices, 'payment')).toEqual(e.payments);
      if (e.remaining) expect(byNumber(ctx, p.invoices, 'remaining')).toEqual(e.remaining);
      if (e.discountAvailable) expect(byNumber(ctx, p.invoices, 'discountAvailable')).toEqual(e.discountAvailable);
      if (e.suggestDiscount) expect(byNumber(ctx, p.invoices, 'suggestDiscount')).toEqual(e.suggestDiscount);
      if (e.totals) expect(p.totals).toMatchObject(e.totals);
      if (e.shortfalls) {
        const numberOf = new Map([...ctx.invoices].map(([n, id]) => [id, n]));
        expect(p.shortfalls.map((s: any) => ({ invoice: numberOf.get(s.invoiceId), amount: s.amount, withinWriteOffLimit: s.withinWriteOffLimit })))
          .toEqual(e.shortfalls);
      }
      if (e.engineOnly?.pendingDeposits) expect(p.pendingDeposits).toEqual(e.engineOnly.pendingDeposits);
      return;
    }
    case 'receive': {
      const { applications, depositTo, ...rest } = step.request;
      const r = await request('POST', '/api/v1/payments/receive', ctx.token, {
        customerId: ctx.customer, depositTo: ctx.roles[depositTo], applications: mapApps(ctx, applications) ?? [], ...rest,
      });
      if (e.error) { expect([r.status >= 400, r.json?.error?.code]).toEqual([true, e.error]); return; }
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      ctx.payment = r.json.payment.id;
      if (e.lines) expect(await lineSet(ctx, ctx.payment)).toEqual(expectedLines(e.lines));
      await checkCommon(ctx, e);
      return;
    }
    case 'void': {
      const r = await request('POST', `/api/v1/payments/${ctx.payment}/void`, ctx.token, {});
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      await checkCommon(ctx, e);
      return;
    }
    case 'apply': {
      const glBefore = (await db.select().from(journalLines).where(eq(journalLines.tenantId, ctx.tenantId))).length;
      const r = await request('POST', `/api/v1/payments/${ctx.payment}/apply`, ctx.token, {
        date: step.request.date, applications: mapApps(ctx, step.request.applications),
      });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      if (e.applied) expect(byNumber(ctx, r.json.applied, 'amount')).toEqual(e.applied);
      if (e.remaining !== undefined) expect(r.json.remaining).toBe(e.remaining);
      if (e.lines) {
        if (e.lines.length === 0) {
          expect((await db.select().from(journalLines).where(eq(journalLines.tenantId, ctx.tenantId))).length).toBe(glBefore);
        } else {
          expect(await lineSet(ctx, r.json.drawId)).toEqual(expectedLines(e.lines));
        }
      }
      await checkCommon(ctx, e);
      return;
    }
    case 'deposit': {
      const ids = (step.payments as string[]).map((p) => (p === 'this' ? ctx.payment : ctx.other));
      const amounts = await Promise.all(ids.map(async (id) => m2((await db.select().from(transactions).where(eq(transactions.id, id)))[0]!.total)));
      const r = await request('POST', '/api/v1/transactions', ctx.token, {
        txnType: 'deposit', txnDate: step.date, depositToAccountId: ctx.roles[step.account],
        lines: ids.map((id, i) => ({ accountId: ctx.roles['undeposited_funds'], amount: amounts[i], sourceTransactionId: id })),
      });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      (ctx as any).depositId = r.json.transaction.id;
      if (e.total) expect(m2(r.json.transaction.total)).toBe(e.total);
      return;
    }
    case 'bounce':
    case 'bounceAgain': {
      const r = await request('POST', `/api/v1/payments/${ctx.payment}/bounce`, ctx.token, step.request);
      if (e.error) { expect([r.status, r.json.error.code]).toEqual([409, e.error]); return; }
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      if (e.heldIn) expect(roleOf(ctx, r.json.heldIn.accountId)).toBe(e.heldIn);
      if (e.lines) expect(await lineSet(ctx, r.json.returnId)).toEqual(expectedLines(e.lines));
      if (e.feeLines) expect(await lineSet(ctx, r.json.feeId)).toEqual(expectedLines(e.feeLines));
      if (e.operatingChange !== undefined) {
        expect(new Decimal(await accountBalance(ctx, ctx.roles['operating']!)).minus(ctx.bankStart).toFixed(2)).toBe(e.operatingChange);
      }
      if (e.otherStillDeposited) {
        const links = await db.select().from(depositLines).where(eq(depositLines.sourceTransactionId, ctx.other));
        expect(links.length).toBe(1);
      }
      if (e.credits !== undefined) {
        const p = await request('POST', '/api/v1/payments/preview', ctx.token, { customerId: ctx.customer, date: step.request.date });
        expect(p.json.credits.length).toBe(e.credits);
      }
      if (e.pendingIncludesPayment !== undefined) {
        const pend = await request('GET', '/api/v1/payments/pending-deposits?exact=1', ctx.token);
        expect(pend.json.items.some((i: any) => i.transactionId === ctx.payment)).toBe(e.pendingIncludesPayment);
      }
      await checkCommon(ctx, e);
      return;
    }
    case 'voidDeposit': {
      const r = await request('POST', `/api/v1/transactions/${(ctx as any).depositId}/void`, ctx.token, { reason: 'golden' });
      expect([r.status, r.json.error.code]).toEqual([409, e.error]);
      return;
    }
    default:
      throw new Error(`unknown golden op ${step.op} in case ${c.id}`);
  }
}

describe('payment-golden.json scenarios', () => {
  for (const c of golden.cases) {
    it(`case ${c.id}: ${c.name}`, async () => {
      const ctx = await makeCase(c);
      for (const [i, step] of c.steps.entries()) {
        try { await runStep(ctx, c, step); } catch (err) {
          (err as Error).message = `step ${i + 1} (${step.op}): ${(err as Error).message}`;
          throw err;
        }
      }
    });
  }
});
