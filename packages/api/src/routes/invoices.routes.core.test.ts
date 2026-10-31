// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Invoice core (ClientLedger P20 E1), through the HTTP routes:
//   - U-122 sales-cents-v1: the mockup invoice totals 3,234.87, the golden
//     rounding traps, the company default rate, cash sales and credit memos;
//   - U-123 invoice-fields-v1: itemId, serviceDate, poNumber,
//     customerMessage, tagIds, hideZeroLines; company scope of references;
//   - U-124 invoice-edit-v1 / idempotency-invoice-v1: closed periods, 409
//     STALE, 409 INVOICE_HAS_PAYMENTS, keyed PUT / void / sent, company scope;
//   - U-125 invoice-terms-v1: invoice -> client -> company terms, discount
//     and custom terms, PUT recomputes the due date when the terms change;
//   - U-126 invoice-sent-history-v1: POST /:id/sent, mark-printed,
//     sendHistory kept across edits, ?sent=false, recipients never audited;
//   - U-38 contact-balance-v1: open balance and oldest open date.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import { and, eq, inArray } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, items, tags, transactionTags, userPermissions, idempotencyKeys, paymentApplications, documentSendEvents,
} from '../db/schema/index.js';
import { invoicesRouter } from './invoices.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { formsRouter } from './forms.routes.js';
import { contactsRouter } from './contacts.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as cashSaleService from '../services/cash-sale.service.js';
import * as creditMemoService from '../services/credit-memo.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const Decimal = DecimalLib.default || DecimalLib;
const CLOSING_PHRASE = 'closed-books-phrase';

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
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanTenant(tid: string) {
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
  bank: string; revenue: string; ar: string; tax: string; customer: string;
}

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  return a!.id;
}

async function makeCompany(): Promise<Co> {
  const reg = await authService.register({
    email: `inv-core-${suffix()}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: 'Monett Landscapes',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  await db.update(companies).set({ defaultSalesTaxRate: '0.0810', defaultPaymentTerms: 'net_30' }).where(eq(companies.id, company!.id));
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const revenue = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Hartley Residence' }).returning();
  return {
    tenantId, token: reg.tokens.accessToken, companyId: company!.id, userId: reg.user.id,
    bank: bank!.id, revenue: revenue!.id, ar: await bySystemTag(tenantId, 'accounts_receivable'),
    tax: await bySystemTag(tenantId, 'sales_tax_payable'), customer: customer!.id,
  };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/invoices', invoicesRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/forms', formsRouter);
  app.use('/api/v1/contacts', contactsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

const key = () => crypto.randomBytes(12).toString('hex');
const line = (quantity: string, unitPrice: string, isTaxable: boolean, extra: Record<string, unknown> = {}) =>
  ({ accountId: c.revenue, quantity, unitPrice, isTaxable, ...extra });
const mockupLines = () => [
  line('18', '65.00', false, { description: 'Install labor' }),
  line('24', '32.50', true, { description: 'Shrubs, 3 gal' }),
  line('6', '48.00', true, { description: 'Mulch, yard' }),
  line('1', '842.15', true, { description: 'Perennials' }),
];

async function postInvoice(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await request('POST', '/api/v1/invoices', c.token, { contactId: c.customer, txnDate: '2026-11-03', ...body }, headers);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.invoice;
}

const revenueLines = (inv: any) => (inv.lines as any[]).filter((l) => l.accountId !== c.ar && l.accountId !== c.tax);
const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0));

it('advertises the invoice core capabilities', () => {
  for (const cap of ['sales-cents-v1', 'invoice-edit-v1', 'idempotency-invoice-v1', 'invoice-terms-v1',
    'invoice-fields-v1', 'invoice-sent-history-v1', 'contact-balance-v1']) {
    expect(DESKTOP_CAPABILITIES).toContain(cap);
  }
});

describe('sales-cents-v1 (U-122)', () => {
  it('AC1: the mockup invoice is 3,080.15 + 154.72 = 3,234.87; line taxes sum to the tax; GET equals POST; it balances', async () => {
    const inv = await postInvoice({ lines: mockupLines() });
    expect(inv.subtotal).toBe('3080.1500');
    expect(inv.taxAmount).toBe('154.7200');
    expect(inv.total).toBe('3234.8700');
    expect(inv.balanceDue).toBe('3234.8700');
    const rev = revenueLines(inv);
    expect(rev.map((l) => l.credit)).toEqual(['1170.0000', '780.0000', '288.0000', '842.1500']);
    expect(rev.map((l) => l.taxAmount)).toEqual(['0.0000', '63.1800', '23.3300', '68.2100']);
    expect(sum(rev.map((l) => l.taxAmount)).toFixed(4)).toBe('154.7200');
    const got = (await request('GET', `/api/v1/invoices/${inv.id}`, c.token)).json.invoice;
    expect([got.subtotal, got.taxAmount, got.total]).toEqual([inv.subtotal, inv.taxAmount, inv.total]);
    const debit = sum((got.lines as any[]).map((l) => l.debit));
    const credit = sum((got.lines as any[]).map((l) => l.credit));
    expect(debit.equals(credit)).toBe(true);
    expect((got.lines as any[]).find((l) => l.accountId === c.tax).credit).toBe('154.7200');
  });

  it('rounding traps: three 1.05 lines at 8.1 % tax 0.26 (0.09 / 0.09 / 0.08); 10 % of 0.25 is 0.03', async () => {
    const three = await postInvoice({ lines: [line('1', '1.05', true), line('1', '1.05', true), line('1', '1.05', true)] });
    expect(three.taxAmount).toBe('0.2600');
    expect(revenueLines(three).map((l) => l.taxAmount)).toEqual(['0.0900', '0.0900', '0.0800']);
    expect(three.total).toBe('3.4100');
    const tenth = await postInvoice({ lines: [line('1', '0.25', true, { taxRate: '0.10' })] });
    expect(tenth.taxAmount).toBe('0.0300');
    expect(tenth.total).toBe('0.2800');
  });

  it('a taxable line without taxRate takes the REQUEST company default; a discount line reduces the base', async () => {
    const [b] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Branch B', setupComplete: true, defaultSalesTaxRate: '0.0500' }).returning();
    const [custB] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: b!.id, contactType: 'customer', displayName: 'B customer' }).returning();
    const r = await request('POST', '/api/v1/invoices', c.token, {
      contactId: custB!.id, txnDate: '2026-11-03', lines: [line('1', '100.00', true), line('1', '-15.00', true)],
    }, { 'X-Company-Id': b!.id });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // Base 85.00 x 5 % = 4.25 (not the first company's 8.1 %).
    expect(r.json.invoice.taxAmount).toBe('4.2500');
    expect(revenueLines(r.json.invoice).map((l: any) => [l.debit, l.credit, l.taxAmount])).toEqual([
      ['0.0000', '100.0000', '5.0000'], ['15.0000', '0.0000', '-0.7500'],
    ]);
  });

  it('cash sales are taxed once per document; credit memo lines round to the cent', async () => {
    const sale = await cashSaleService.createCashSale(c.tenantId, {
      txnDate: '2026-11-03', depositToAccountId: c.bank,
      lines: [1, 2, 3].map(() => ({ accountId: c.revenue, quantity: '1', unitPrice: '1.05', isTaxable: true })),
    }, c.userId, c.companyId);
    expect(sale.taxAmount).toBe('0.2600');
    expect(sale.total).toBe('3.4100');
    const memo = await creditMemoService.createCreditMemo(c.tenantId, {
      txnDate: '2026-11-03', contactId: c.customer, lines: [{ accountId: c.revenue, quantity: '3', unitPrice: '0.335' }],
    }, c.userId, c.companyId);
    expect(memo.total).toBe('1.0100');
  });

  it('a price with more than 4 places is 400 VALIDATION_ERROR and posts nothing', async () => {
    const r = await request('POST', '/api/v1/invoices', c.token, { contactId: c.customer, txnDate: '2026-11-03', lines: [line('1', '1.00001', false)] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('VALIDATION_ERROR');
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId))).toHaveLength(0);
  });
});

describe('invoice-fields-v1 (U-123)', () => {
  it('itemId supplies the account and taxable flag; the header fields round-trip; an edit that omits them keeps them', async () => {
    const [item] = await db.insert(items).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Mulch', incomeAccountId: c.revenue, isTaxable: true }).returning();
    const [tag] = await db.insert(tags).values({ tenantId: c.tenantId, name: 'Hartley job' }).returning();
    const inv = await postInvoice({
      poNumber: 'PO-7781', customerMessage: 'Thank you for your business.', memo: 'internal', hideZeroLines: true, tagIds: [tag!.id],
      lines: [
        { itemId: item!.id, quantity: '6', unitPrice: '48.00', serviceDate: '2026-10-31' },
        line('1', '0', false, { description: 'Free consult' }),
      ],
    });
    const rev = revenueLines(inv);
    expect(rev[0].accountId).toBe(c.revenue);
    expect(rev[0].itemId).toBe(item!.id);
    expect(rev[0].isTaxable).toBe(true);
    expect(rev[0].serviceDate).toBe('2026-10-31');
    expect(inv.taxAmount).toBe('23.3300');
    expect([inv.poNumber, inv.customerMessage, inv.memo, inv.hideZeroLines]).toEqual(['PO-7781', 'Thank you for your business.', 'internal', true]);
    expect(inv.tagIds).toEqual([tag!.id]);

    const r = await request('PUT', `/api/v1/invoices/${inv.id}`, c.token, {
      contactId: c.customer, txnDate: '2026-11-03', lines: [{ itemId: item!.id, quantity: '7', unitPrice: '48.00' }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const e = r.json.invoice;
    expect([e.poNumber, e.customerMessage, e.hideZeroLines]).toEqual(['PO-7781', 'Thank you for your business.', true]);
    expect(e.tagIds).toEqual([tag!.id]);
    expect(e.total).toBe('363.2200'); // 336.00 + 27.216 -> 27.22

    const cleared = await request('PUT', `/api/v1/invoices/${inv.id}`, c.token, {
      contactId: c.customer, txnDate: '2026-11-03', poNumber: '', tagIds: [], lines: [{ itemId: item!.id, quantity: '7', unitPrice: '48.00' }],
    });
    expect(cleared.json.invoice.poNumber).toBeNull();
    expect(cleared.json.invoice.tagIds).toEqual([]);
  });

  it('a customer, item or tag of another company is 400 VALIDATION_ERROR', async () => {
    const [b] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Branch B', setupComplete: true }).returning();
    const [itemB] = await db.insert(items).values({ tenantId: c.tenantId, companyId: b!.id, name: 'B item', incomeAccountId: c.revenue }).returning();
    const [tagB] = await db.insert(tags).values({ tenantId: c.tenantId, companyId: b!.id, name: 'B tag' }).returning();
    const [custB] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: b!.id, contactType: 'customer', displayName: 'B only' }).returning();
    for (const body of [
      { contactId: c.customer, lines: [{ itemId: itemB!.id, quantity: '1', unitPrice: '1.00' }] },
      { contactId: c.customer, tagIds: [tagB!.id], lines: [line('1', '1.00', false)] },
      { contactId: custB!.id, lines: [line('1', '1.00', false)] },
    ]) {
      const r = await request('POST', '/api/v1/invoices', c.token, { txnDate: '2026-11-03', ...body }, { 'X-Company-Id': c.companyId });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
      expect(r.json.error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('invoice-terms-v1 (U-125)', () => {
  it('invoice terms, else the client\'s, else the company\'s; discount and custom terms; PUT recomputes when the terms change', async () => {
    const a = await postInvoice({ lines: [line('1', '10.00', false)] });
    expect([a.paymentTerms, a.dueDate]).toEqual(['net_30', '2026-12-03']);

    await db.update(contacts).set({ defaultPaymentTerms: 'net_15' }).where(eq(contacts.id, c.customer));
    const b = await postInvoice({ lines: [line('1', '10.00', false)] });
    expect([b.paymentTerms, b.dueDate]).toEqual(['net_15', '2026-11-18']);

    const d = await postInvoice({ paymentTerms: '2_10_net_30', lines: [line('1', '10.00', false)] });
    expect([d.paymentTerms, d.dueDate, d.discountPercent, d.discountDate]).toEqual(['2_10_net_30', '2026-12-03', '2.0000', '2026-11-13']);

    const cu = await postInvoice({ paymentTerms: 'custom', termsDays: 20, lines: [line('1', '10.00', false)] });
    expect([cu.paymentTerms, cu.termsDays, cu.dueDate]).toEqual(['custom', 20, '2026-11-23']);

    const typed = await postInvoice({ paymentTerms: 'net_10', dueDate: '2026-11-30', lines: [line('1', '10.00', false)] });
    expect([typed.dueDate, typed.dueDateOverridden]).toEqual(['2026-11-30', true]);

    // An edit that sends no terms keeps them and the due date.
    let r = await request('PUT', `/api/v1/invoices/${typed.id}`, c.token, { contactId: c.customer, txnDate: '2026-11-03', lines: [line('1', '12.00', false)] });
    expect([r.json.invoice.paymentTerms, r.json.invoice.dueDate]).toEqual(['net_10', '2026-11-30']);
    // Changing the terms recomputes the due date.
    r = await request('PUT', `/api/v1/invoices/${typed.id}`, c.token, { contactId: c.customer, txnDate: '2026-11-03', paymentTerms: 'net_45', lines: [line('1', '12.00', false)] });
    expect([r.json.invoice.paymentTerms, r.json.invoice.dueDate, r.json.invoice.dueDateOverridden]).toEqual(['net_45', '2026-12-18', false]);
    // So does moving the date.
    r = await request('PUT', `/api/v1/invoices/${typed.id}`, c.token, { contactId: c.customer, txnDate: '2026-11-10', lines: [line('1', '12.00', false)] });
    expect(r.json.invoice.dueDate).toBe('2026-12-25');
  });
});

describe('invoice-edit-v1 / idempotency-invoice-v1 (U-124)', () => {
  const close = async () => {
    await db.update(companies).set({ lockDate: '2026-06-30', closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) }).where(eq(companies.id, c.companyId));
  };

  it('closed period: POST, PUT and void need the closing password; an override row is written', async () => {
    await close();
    const body = { contactId: c.customer, txnDate: '2026-06-15', lines: [line('1', '10.00', false)] };
    let r = await request('POST', '/api/v1/invoices', c.token, body);
    expect(r.status).toBe(423);
    expect(r.json.error.code).toBe('TB_PERIOD_LOCKED');
    r = await request('POST', '/api/v1/invoices', c.token, { ...body, closingPassword: 'wrong-guess' });
    expect(r.status).toBe(403);
    r = await request('POST', '/api/v1/invoices', c.token, { ...body, closingPassword: CLOSING_PHRASE });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.invoice.id;
    r = await request('PUT', `/api/v1/invoices/${id}`, c.token, { ...body, txnDate: '2026-07-15' });
    expect(r.status).toBe(423);
    r = await request('PUT', `/api/v1/invoices/${id}`, c.token, { ...body, txnDate: '2026-06-20', closingPassword: CLOSING_PHRASE });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await request('POST', `/api/v1/invoices/${id}/void`, c.token, { reason: 'dup' });
    expect(r.status).toBe(423);
    r = await request('POST', `/api/v1/invoices/${id}/void`, c.token, { reason: 'dup', closingPassword: CLOSING_PHRASE });
    expect(r.status).toBe(200);
    const overrides = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'closing_date_override')));
    expect(overrides.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(overrides)).not.toContain(CLOSING_PHRASE);
  });

  it('PUT and void: expectedUpdatedAt mismatch is 409 STALE and changes nothing', async () => {
    const inv = await postInvoice({ lines: [line('1', '10.00', false)] });
    const stale = new Date(Date.parse(inv.updatedAt) - 60_000).toISOString();
    let r = await request('PUT', `/api/v1/invoices/${inv.id}`, c.token, {
      contactId: c.customer, txnDate: '2026-11-03', lines: [line('1', '99.00', false)], expectedUpdatedAt: stale,
    });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('STALE');
    expect((await request('GET', `/api/v1/invoices/${inv.id}`, c.token)).json.invoice.total).toBe('10.0000');
    r = await request('PUT', `/api/v1/invoices/${inv.id}`, c.token, {
      contactId: c.customer, txnDate: '2026-11-03', lines: [line('1', '99.00', false)], expectedUpdatedAt: inv.updatedAt,
    });
    expect(r.status).toBe(200);
    r = await request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'x', expectedUpdatedAt: inv.updatedAt });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('STALE');
  });

  it('PUT, void and sent replay with the same Idempotency-Key', async () => {
    const inv = await postInvoice({ lines: [line('1', '10.00', false)] });
    const k = key();
    const body = { contactId: c.customer, txnDate: '2026-11-03', lines: [line('2', '10.00', false)] };
    const first = await request('PUT', `/api/v1/invoices/${inv.id}`, c.token, body, { 'Idempotency-Key': k });
    const again = await request('PUT', `/api/v1/invoices/${inv.id}`, c.token, body, { 'Idempotency-Key': k });
    expect(first.status).toBe(200);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.json.invoice.updatedAt).toBe(first.json.invoice.updatedAt);
    const other = await request('PUT', `/api/v1/invoices/${inv.id}`, c.token, { ...body, memo: 'changed' }, { 'Idempotency-Key': k });
    expect(other.status).toBe(422);

    const sk = key();
    const s1 = await request('POST', `/api/v1/invoices/${inv.id}/sent`, c.token, { method: 'printed' }, { 'Idempotency-Key': sk });
    const s2 = await request('POST', `/api/v1/invoices/${inv.id}/sent`, c.token, { method: 'printed' }, { 'Idempotency-Key': sk });
    expect([s1.status, s2.status]).toEqual([200, 200]);
    expect(await db.select().from(documentSendEvents).where(eq(documentSendEvents.transactionId, inv.id))).toHaveLength(1);

    const vk = key();
    const v1 = await request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'dup' }, { 'Idempotency-Key': vk });
    const v2 = await request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'dup' }, { 'Idempotency-Key': vk });
    expect([v1.status, v2.status]).toEqual([200, 200]);
    expect(v2.headers['idempotent-replayed']).toBe('true');
  });

  it('void with a payment applied is 409 INVOICE_HAS_PAYMENTS (also through /transactions); after the payment is voided it voids', async () => {
    const inv = await postInvoice({ lines: [line('1', '100.00', false)] });
    const pay = await request('POST', `/api/v1/invoices/${inv.id}/payment`, c.token, { amount: '40.00', txnDate: '2026-11-04', depositToAccountId: c.bank });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    let r = await request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('INVOICE_HAS_PAYMENTS');
    expect(r.json.error.details.payments).toBe(1);
    r = await request('POST', `/api/v1/transactions/${inv.id}/void`, c.token, { reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('INVOICE_HAS_PAYMENTS');
    r = await request('POST', `/api/v1/transactions/${pay.json.payment.id}/void`, c.token, { reason: 'bounced' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'x' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.invoice.status).toBe('void');
  });

  it('an invoice of another company is 404 on GET, PUT, void and sent; another transaction type is 400', async () => {
    const inv = await postInvoice({ lines: [line('1', '10.00', false)] });
    const [b] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Branch B', setupComplete: true }).returning();
    const asB = { 'X-Company-Id': b!.id };
    expect((await request('GET', `/api/v1/invoices/${inv.id}`, c.token, undefined, asB)).status).toBe(404);
    expect((await request('PUT', `/api/v1/invoices/${inv.id}`, c.token, { contactId: c.customer, txnDate: '2026-11-03', lines: [line('1', '1.00', false)] }, asB)).status).toBe(404);
    expect((await request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'x' }, asB)).status).toBe(404);
    expect((await request('POST', `/api/v1/invoices/${inv.id}/sent`, c.token, { method: 'pdf' }, asB)).status).toBe(404);
    const sale = await cashSaleService.createCashSale(c.tenantId, {
      txnDate: '2026-11-03', depositToAccountId: c.bank, lines: [{ accountId: c.revenue, quantity: '1', unitPrice: '5.00', isTaxable: false }],
    }, c.userId, c.companyId);
    expect((await request('GET', `/api/v1/invoices/${sale.id}`, c.token)).status).toBe(400);
  });
});

describe('invoice-sent-history-v1 (U-126)', () => {
  it('records sends, keeps them across edits, lists unsent invoices whatever their payment status, and never audits recipients', async () => {
    const sent = await postInvoice({ lines: [line('1', '100.00', false)] });
    const unsentPaid = await postInvoice({ lines: [line('1', '50.00', false)] });
    const queued = await postInvoice({ printLater: true, lines: [line('1', '20.00', false)] });

    let r = await request('POST', `/api/v1/invoices/${sent.id}/sent`, c.token, {
      method: 'email', recipients: ['ap@hartley.example', 'ap@hartley.example', 'owner@hartley.example'],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.invoice.invoiceStatus).toBe('sent');
    expect(r.json.invoice.sentAt).toBeTruthy();
    expect(r.json.invoice.sendHistory).toHaveLength(1);
    expect(r.json.invoice.sendHistory[0]).toMatchObject({ method: 'email', recipients: ['ap@hartley.example', 'owner@hartley.example'] });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityId, sent.id)));
    expect(JSON.stringify(audits)).not.toContain('hartley.example');

    // An edit keeps the history.
    r = await request('PUT', `/api/v1/invoices/${sent.id}`, c.token, { contactId: c.customer, txnDate: '2026-11-03', lines: [line('1', '110.00', false)] });
    expect(r.json.invoice.sendHistory).toHaveLength(1);

    // Partly paid, never sent: still unsent.
    await request('POST', `/api/v1/invoices/${unsentPaid.id}/payment`, c.token, { amount: '10.00', txnDate: '2026-11-04', depositToAccountId: c.bank });

    // Mark printed records a "printed" send.
    r = await request('POST', '/api/v1/forms/mark-printed', c.token, { ids: [queued.id] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const q = (await request('GET', `/api/v1/invoices/${queued.id}`, c.token)).json.invoice;
    expect(q.sendHistory.map((e: any) => e.method)).toEqual(['printed']);
    expect(q.invoiceStatus).toBe('sent');

    const unsent = (await request('GET', '/api/v1/invoices?sent=false', c.token)).json.data.map((t: any) => t.id);
    expect(unsent).toEqual([unsentPaid.id]);
    const sentIds = (await request('GET', '/api/v1/invoices?sent=true', c.token)).json.data.map((t: any) => t.id).sort();
    expect(sentIds).toEqual([sent.id, queued.id].sort());

    // A void invoice can't be recorded as sent.
    const v = await postInvoice({ lines: [line('1', '1.00', false)] });
    await request('POST', `/api/v1/invoices/${v.id}/void`, c.token, { reason: 'x' });
    r = await request('POST', `/api/v1/invoices/${v.id}/sent`, c.token, { method: 'pdf' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('INVOICE_VOID');
  });
});

describe('contact-balance-v1 (U-38)', () => {
  it('open balance is invoices less payments; the oldest open date is the oldest invoice with a balance', async () => {
    await postInvoice({ txnDate: '2026-10-01', lines: [line('1', '100.00', false)] });
    const second = await postInvoice({ txnDate: '2026-10-15', lines: [line('1', '50.00', false)] });
    const first = (await db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnDate, '2026-10-01'))))[0]!;
    await request('POST', `/api/v1/invoices/${first.id}/payment`, c.token, { amount: '100.00', txnDate: '2026-10-20', depositToAccountId: c.bank });
    const r = await request('GET', `/api/v1/contacts/${c.customer}`, c.token);
    expect(r.status).toBe(200);
    expect(r.json.contact).toMatchObject({ openBalance: '50.0000', oldestOpenDate: second.txnDate, payableBalance: '0.0000', oldestOpenBillDate: null });
    const list = (await request('GET', '/api/v1/contacts?contactType=customer', c.token)).json.data;
    expect(list.find((x: any) => x.id === c.customer).openBalance).toBe('50.0000');
  });
});
