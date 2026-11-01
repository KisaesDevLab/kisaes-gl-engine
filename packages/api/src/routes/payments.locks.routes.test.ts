// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Receive Payment under concurrency (U-132 review E-B1): every write on a
// payment takes its locks in one order (the deposit holding it, the payment
// rows, the invoices) and reads its links again under the locks. Each test
// holds the first writer's locks in an open database transaction, starts the
// second writer over HTTP, waits until Postgres shows it waiting for a lock,
// then commits the first and checks the second's answer and the books.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, items, tags, transactionTags, userPermissions, idempotencyKeys, paymentApplications, documentSendEvents,
  depositLines,
} from '../db/schema/index.js';
import { paymentsRouter } from './payments.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as invoiceService from '../services/invoice.service.js';
import * as depositService from '../services/deposit.service.js';

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
        'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
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
  await db.delete(documentSendEvents).where(eq(documentSendEvents.tenantId, tid));
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

interface Co {
  tenantId: string; token: string; companyId: string; userId: string;
  bank: string; revenue: string; ar: string; clearing: string; customer: string;
}

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/payments', paymentsRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  const reg = await authService.register({
    email: `rpl-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Neosho Supply',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  await db.update(companies).set({ defaultSalesTaxRate: '0', defaultPaymentTerms: 'net_30' }).where(eq(companies.id, company!.id));
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const revenue = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Neosho Dental Group' }).returning();
  c = {
    tenantId, token: reg.tokens.accessToken, companyId: company!.id, userId: reg.user.id,
    bank: bank!.id, revenue: revenue!.id, ar: await bySystemTag(tenantId, 'accounts_receivable'),
    clearing: await bySystemTag(tenantId, 'payments_clearing'), customer: customer!.id,
  };
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

async function invoice(total: string, date: string) {
  const inv = await invoiceService.createInvoice(c.tenantId, {
    contactId: c.customer, txnDate: date,
    lines: [{ accountId: c.revenue, description: 'Work', quantity: '1', unitPrice: total, isTaxable: false }],
  } as never, c.userId, c.companyId);
  return inv.id;
}

async function row(id: string) {
  return (await db.select().from(transactions).where(eq(transactions.id, id)))[0]!;
}

async function balance(accountId: string) {
  return (await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) }))!.balance;
}

async function bounces() {
  return db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnType, 'returned_payment')));
}

async function receive(invoiceId: string, amount: string, depositTo = c.clearing) {
  const r = await request('POST', '/api/v1/payments/receive', c.token, {
    customerId: c.customer, date: '2026-11-03', depositTo, amount, applications: [{ invoiceId, amount }],
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.payment as { id: string; updatedAt: string };
}

function depositInput(paymentId: string, amount: string) {
  return {
    txnType: 'deposit', txnDate: '2026-11-05', depositToAccountId: c.bank,
    lines: [{ accountId: c.clearing, amount, sourceTransactionId: paymentId }],
  } as never;
}

/** Resolves once another session waits for a row lock (the tests run one at a time). */
async function lockWaiter() {
  for (let i = 0; i < 200; i++) {
    const res = await db.execute(sql`SELECT COUNT(*)::int AS n FROM pg_locks WHERE NOT granted`);
    if ((res.rows as Array<{ n: number }>)[0]!.n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the second writer never waited for a lock');
}

/**
 * `first` runs in a database transaction that stays open; `second` starts,
 * blocks on one of first's locks, then first commits. Returns second's answer.
 */
async function interleave(first: (tx: Tx) => Promise<unknown>, second: () => Promise<Res>): Promise<Res> {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const started = new Promise<void>((r) => { ready = r; });
  const outer = db.transaction(async (tx) => { await first(tx); ready(); await gate; });
  await Promise.race([started, outer]);
  const pending = second();
  await lockWaiter();
  release();
  await outer;
  return pending;
}

describe('lock order and re-read under lock (U-132, E-B1)', () => {
  it('bounce versus a deposit created meanwhile: 409 STALE, the deposit stands and nothing is taken back twice', async () => {
    const i1 = await invoice('4385.00', '2026-09-15');
    const p = await receive(i1, '4000.00');
    const bankBefore = await balance(c.bank);
    const r = await interleave(
      (tx) => depositService.createDepositWithWarnings(c.tenantId, depositInput(p.id, '4000.00'), c.userId, c.companyId, tx),
      () => request('POST', `/api/v1/payments/${p.id}/bounce`, c.token, { date: '2026-11-12' }),
    );
    expect([r.status, r.json.error?.code]).toEqual([409, 'STALE']);
    expect(await bounces()).toEqual([]);
    expect(await balance(c.clearing)).toBe('0.0000');
    expect(Number(await balance(c.bank)) - Number(bankBefore)).toBe(4000);
    expect((await row(i1)).balanceDue).toBe('385.0000');
    // Retried, the bounce now takes the money back out of the bank.
    const again = await request('POST', `/api/v1/payments/${p.id}/bounce`, c.token, { date: '2026-11-12' });
    expect(again.status, JSON.stringify(again.json)).toBe(201);
    expect(again.json.heldIn).toEqual({ accountId: c.bank, kind: 'bank' });
    expect(await balance(c.bank)).toBe(bankBefore);
    expect(await balance(c.clearing)).toBe('0.0000');
  });

  it('bounce versus a deposit void meanwhile: the bounce takes the money out of Payments Clearing, not the bank', async () => {
    const i1 = await invoice('4385.00', '2026-09-15');
    const p = await receive(i1, '4000.00');
    const bankBefore = await balance(c.bank);
    const d = await depositService.createDeposit(c.tenantId, depositInput(p.id, '4000.00'), c.userId, c.companyId);
    const r = await interleave(
      (tx) => ledger.voidTransactionInTx(tx, c.tenantId, d.id, 'wrong bank', c.userId),
      () => request('POST', `/api/v1/payments/${p.id}/bounce`, c.token, { date: '2026-11-12' }),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.heldIn).toEqual({ accountId: c.clearing, kind: 'payments_clearing' });
    expect((await row(d.id)).status).toBe('void');
    expect(await balance(c.bank)).toBe(bankBefore);
    expect(await balance(c.clearing)).toBe('0.0000');
    expect((await row(i1)).balanceDue).toBe('4385.0000');
    const pending = await request('GET', '/api/v1/payments/pending-deposits?exact=1', c.token);
    expect(pending.json.items).toEqual([]);
  });

  it('void versus bounce of the same payment: the invoice is restored once', async () => {
    const i1 = await invoice('500.00', '2026-09-15');
    const p = await receive(i1, '500.00', c.bank);
    const r = await interleave(
      (tx) => ledger.voidTransactionInTx(tx, c.tenantId, p.id, 'entered twice', c.userId),
      () => request('POST', `/api/v1/payments/${p.id}/bounce`, c.token, { date: '2026-11-12' }),
    );
    expect(r.status).toBe(400);
    expect(await bounces()).toEqual([]);
    const x = await row(i1);
    expect([x.balanceDue, x.amountPaid]).toEqual(['500.0000', '0.0000']);
  });

  /** P pays 4,385.00 with 4,440.00 (55.00 credit); X pays 250.00 of a 300.00 invoice and uses 30.00 of P's credit. */
  async function creditUsedInside() {
    const i1 = await invoice('4385.00', '2026-09-15');
    const p = await request('POST', '/api/v1/payments/receive', c.token, {
      customerId: c.customer, date: '2026-11-03', depositTo: c.bank, amount: '4440.00',
      applications: [{ invoiceId: i1, amount: '4385.00' }],
    });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    const n1 = await invoice('300.00', '2026-11-10');
    const x = await request('POST', '/api/v1/payments/receive', c.token, {
      customerId: c.customer, date: '2026-11-12', depositTo: c.bank, amount: '250.00',
      applications: [{ invoiceId: n1, amount: '250.00' }], creditApplications: [{ sourcePaymentId: p.json.payment.id, invoiceId: n1, amount: '30.00' }],
    });
    expect(x.status, JSON.stringify(x.json)).toBe(201);
    expect((await row(n1)).balanceDue).toBe('20.0000');
    return { i1, n1, p: p.json.payment.id as string, x: x.json.payment.id as string };
  }

  it('source bounce versus a void of the payment its credit was applied inside: n1 is restored once', async () => {
    const s = await creditUsedInside();
    const { bouncePaymentInTx } = await import('../services/payment.service.js');
    const r = await interleave(
      (tx) => bouncePaymentInTx(tx, c.tenantId, s.p, { date: '2026-11-15' } as never, c.userId, c.companyId),
      () => request('POST', `/api/v1/payments/${s.x}/void`, c.token, {}),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const n1 = await row(s.n1);
    expect([n1.balanceDue, n1.amountPaid]).toEqual(['300.0000', '0.0000']);
    expect((await row(s.i1)).balanceDue).toBe('4385.0000');
  });

  it('void of the applying payment versus the source bounce: n1 is restored once', async () => {
    const s = await creditUsedInside();
    const r = await interleave(
      (tx) => ledger.voidTransactionInTx(tx, c.tenantId, s.x, 'wrong client', c.userId),
      () => request('POST', `/api/v1/payments/${s.p}/bounce`, c.token, { date: '2026-11-15' }),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const n1 = await row(s.n1);
    expect([n1.balanceDue, n1.amountPaid]).toEqual(['300.0000', '0.0000']);
    expect((await row(s.i1)).balanceDue).toBe('4385.0000');
  });

  /** A 500.00 deposit held in the bank, 300.00 of it drawn to a 1,200.00 invoice (U-135). */
  async function heldAndDrawn() {
    const h = await request('POST', '/api/v1/payments/receive', c.token, {
      customerId: c.customer, date: '2026-11-01', depositTo: c.bank, amount: '500.00', applications: [], holdAsDeposit: true,
    });
    expect(h.status, JSON.stringify(h.json)).toBe(201);
    const inv1 = await invoice('1200.00', '2026-11-05');
    const a = await request('POST', `/api/v1/payments/${h.json.payment.id}/apply`, c.token, { date: '2026-11-06', applications: [{ invoiceId: inv1, amount: '300.00' }] });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    return { hold: h.json.payment.id as string, draw: a.json.drawId as string, inv1, cd: await bySystemTag(c.tenantId, 'customer_deposits') };
  }

  it('bounce of a held deposit versus a void of its draw: the draw goes first, the bounce takes back the whole 500.00 from Customer Deposits', async () => {
    const bankBefore = await balance(c.bank);
    const s = await heldAndDrawn();
    const r = await interleave(
      (tx) => ledger.voidTransactionInTx(tx, c.tenantId, s.draw, 'applied to the wrong invoice', c.userId),
      () => request('POST', `/api/v1/payments/${s.hold}/bounce`, c.token, { date: '2026-11-10' }),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.transactionId, r.json.returnId), eq(journalLines.isVoidReversal, false))).orderBy(journalLines.lineOrder);
    expect(lines.map((l) => [l.accountId, l.debit, l.credit])).toEqual([[s.cd, '500.0000', '0.0000'], [c.bank, '0.0000', '500.0000']]);
    const inv1 = await row(s.inv1);
    expect([inv1.balanceDue, inv1.amountPaid]).toEqual(['1200.0000', '0.0000']);
    expect(await balance(s.cd)).toBe('0.0000');
    expect(await balance(c.bank)).toBe(bankBefore);
  });

  it('a draw void waiting on the bounce of its held deposit is refused with 409 PAYMENT_BOUNCED', async () => {
    const s = await heldAndDrawn();
    const { bouncePaymentInTx } = await import('../services/payment.service.js');
    const r = await interleave(
      (tx) => bouncePaymentInTx(tx, c.tenantId, s.hold, { date: '2026-11-10' } as never, c.userId, c.companyId),
      () => request('POST', `/api/v1/payments/${s.draw}/void`, c.token, {}),
    );
    expect([r.status, r.json.error?.code]).toEqual([409, 'PAYMENT_BOUNCED']);
    expect((await row(s.draw)).status).toBe('posted');
    const inv1 = await row(s.inv1);
    expect([inv1.balanceDue, inv1.amountPaid]).toEqual(['1200.0000', '0.0000']);
    expect(await balance(s.cd)).toBe('0.0000');
  });

  it('two unapplies of the same row: the invoice moves once', async () => {
    const i1 = await invoice('500.00', '2026-09-15');
    const p = await receive(i1, '200.00', c.bank);
    const r = await interleave(
      async (tx) => {
        // An unapply inside the open transaction, as the route does it.
        await tx.execute(sql`SELECT id FROM transactions WHERE id = ${p.id} FOR UPDATE`);
        const [app] = await tx.select().from(paymentApplications).where(eq(paymentApplications.paymentId, p.id));
        await tx.update(paymentApplications).set({ voidedAt: new Date() }).where(eq(paymentApplications.id, app!.id));
        await tx.update(transactions).set({ amountPaid: '0.0000', balanceDue: '500.0000', invoiceStatus: 'draft' }).where(eq(transactions.id, i1));
      },
      () => request('POST', '/api/v1/payments/unapply', c.token, { paymentId: p.id, invoiceId: i1 }),
    );
    expect([r.status, r.json.error?.code]).toEqual([404, 'NOT_FOUND']);
    const x = await row(i1);
    expect([x.balanceDue, x.amountPaid]).toEqual(['500.0000', '0.0000']);
  });
});
