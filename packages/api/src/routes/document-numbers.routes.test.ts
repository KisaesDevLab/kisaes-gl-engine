// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Document numbering (U-111, document-numbers-v1) and the forms print queue
// (U-113, forms-print-queue-v1) through the HTTP routes:
//   - per-type prefix / next number per company, peek, claim, PUT;
//   - invoices, cash sales and credit memos numbered from their counter;
//     the invoice counter moves only the request's company;
//   - duplicates 409 DOCUMENT_NUMBER_IN_USE, or warnings with warnOnly;
//   - company-scoped invoice template with footerOverrides / resolvedFooters;
//   - printLater, GET /forms/print-queue, POST /forms/mark-printed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as documentNumbers from '../services/document-number.service.js';
import * as formsPrint from '../services/forms-print.service.js';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, transactionTags, tags, userPermissions, idempotencyKeys, invoiceTemplates,
} from '../db/schema/index.js';
import { invoicesRouter } from './invoices.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { documentNumbersRouter } from './document-numbers.routes.js';
import { formsRouter } from './forms.routes.js';
import { companyRouter } from './company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

interface Res { status: number; json: any }

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
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(invoiceTemplates).where(eq(invoiceTemplates.tenantId, tid));
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

interface Co { tenantId: string; token: string; companyId: string; userId: string; bank: string; revenue: string; customer: string }

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `docnum-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `Doc Numbers ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const [revenue] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue'))).limit(1);
  const [cust] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  return {
    tenantId, token: reg.tokens.accessToken, companyId: company!.id, userId: reg.user.id,
    bank: bank!.id, revenue: revenue!.id, customer: cust!.id,
  };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/invoices', invoicesRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/document-numbers', documentNumbersRouter);
  app.use('/api/v1/forms', formsRouter);
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

const lines = (amount = '100.00') => [{ accountId: c.revenue, description: 'Install', quantity: '1', unitPrice: amount }];
const invoice = (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  request('POST', '/api/v1/invoices', c.token, { txnDate: '2026-11-04', contactId: c.customer, lines: lines(), ...extra }, headers);
const cashSale = (extra: Record<string, unknown> = {}) =>
  request('POST', '/api/v1/transactions', c.token, {
    txnType: 'cash_sale', txnDate: '2026-11-04', contactId: c.customer, depositToAccountId: c.bank, lines: lines('40.00'), ...extra,
  });
const creditMemo = (extra: Record<string, unknown> = {}) =>
  request('POST', '/api/v1/transactions', c.token, {
    txnType: 'credit_memo', txnDate: '2026-11-04', contactId: c.customer, lines: lines('15.00'), ...extra,
  });

describe('document numbering (U-111)', () => {
  it('advertises the capabilities', () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(['document-numbers-v1', 'forms-print-queue-v1']));
  });

  it('lists, peeks, sets and claims numbers per type; creates take the next number', async () => {
    const listed = await request('GET', '/api/v1/document-numbers', c.token);
    expect(listed.status).toBe(200);
    expect(listed.json.numbers).toEqual([
      { type: 'invoice', prefix: 'INV-', nextNumber: 1001, next: 'INV-1001' },
      { type: 'cash_sale', prefix: '', nextNumber: 1001, next: '1001' },
      { type: 'credit_memo', prefix: '', nextNumber: 1001, next: '1001' },
      { type: 'statement', prefix: '', nextNumber: 1001, next: '1001' },
    ]);

    const put = await request('PUT', '/api/v1/document-numbers/cash_sale', c.token, { prefix: 'SR-', nextNumber: 500 });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json).toEqual({ type: 'cash_sale', prefix: 'SR-', nextNumber: 500, next: 'SR-500' });
    expect((await request('PUT', '/api/v1/document-numbers/credit_memo', c.token, { prefix: 'CM-' })).json.next).toBe('CM-1001');
    expect((await request('PUT', '/api/v1/document-numbers/invoice', c.token, { nextNumber: 2001 })).json.next).toBe('INV-2001');

    // Peek takes nothing.
    expect((await request('GET', '/api/v1/document-numbers/next?type=cash_sale', c.token)).json.next).toBe('SR-500');
    expect((await request('GET', '/api/v1/document-numbers/next?type=cash_sale', c.token)).json.next).toBe('SR-500');
    expect((await request('GET', '/api/v1/document-numbers/next?type=estimate', c.token)).status).toBe(400);

    const inv = await invoice();
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    expect(inv.json.invoice.txnNumber).toBe('INV-2001');
    expect(inv.json.warnings).toEqual([]);
    const sale = await cashSale();
    expect(sale.status, JSON.stringify(sale.json)).toBe(201);
    expect(sale.json.transaction.txnNumber).toBe('SR-500');
    const memo = await creditMemo();
    expect(memo.status, JSON.stringify(memo.json)).toBe(201);
    expect(memo.json.transaction.txnNumber).toBe('CM-1001');
    expect((await request('GET', '/api/v1/document-numbers/next?type=cash_sale', c.token)).json.next).toBe('SR-501');

    // Statements have no create route: claim.
    const st1 = await request('POST', '/api/v1/document-numbers/claim', c.token, { type: 'statement' });
    expect(st1.status).toBe(201);
    expect(st1.json).toEqual({ type: 'statement', number: 1001, txnNumber: '1001' });
    expect((await request('POST', '/api/v1/document-numbers/claim', c.token, { type: 'statement' })).json.number).toBe(1002);

    // A typed number leaves the counter alone.
    expect((await cashSale({ txnNumber: 'MANUAL-1' })).json.transaction.txnNumber).toBe('MANUAL-1');
    expect((await request('GET', '/api/v1/document-numbers/next?type=cash_sale', c.token)).json.next).toBe('SR-501');

    expect((await request('PUT', '/api/v1/document-numbers/cash_sale', c.token, {})).status).toBe(400);
    expect((await request('PUT', '/api/v1/document-numbers/cash_sale', c.token, { nextNumber: 0 })).status).toBe(400);
  });

  it('the invoice counter moves only the request\'s company', async () => {
    const [other] = await db.insert(companies).values({
      tenantId: c.tenantId, businessName: 'Second Co', invoicePrefix: 'B-', invoiceNextNumber: 7,
    }).returning();
    const inv = await invoice();
    expect(inv.json.invoice.txnNumber).toBe('INV-1001');
    const [theirs] = await db.select().from(companies).where(eq(companies.id, other!.id));
    expect(theirs!.invoiceNextNumber).toBe(7);
    const asOther = { 'X-Company-Id': other!.id };
    expect((await request('GET', '/api/v1/document-numbers/next?type=invoice', c.token, undefined, asOther)).json.next).toBe('B-7');
    const theirInv = await invoice({}, asOther);
    expect(theirInv.status, JSON.stringify(theirInv.json)).toBe(201);
    expect(theirInv.json.invoice.txnNumber).toBe('B-7');
    expect((await request('GET', '/api/v1/document-numbers/next?type=invoice', c.token)).json.next).toBe('INV-1002');
  });

  it('a duplicate typed number is 409 DOCUMENT_NUMBER_IN_USE, or posts with a warning when warnOnly', async () => {
    const first = await invoice({ txnNumber: 'R-77' });
    expect(first.status).toBe(201);
    const dup = await invoice({ txnNumber: 'R-77' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('DOCUMENT_NUMBER_IN_USE');
    expect(dup.json.error.details).toEqual({ txnNumber: 'R-77', transactionId: first.json.invoice.id });

    const warned = await invoice({ txnNumber: 'R-77', warnOnly: true });
    expect(warned.status, JSON.stringify(warned.json)).toBe(201);
    expect(warned.json.invoice.txnNumber).toBe('R-77');
    expect(warned.json.warnings).toEqual([expect.objectContaining({
      code: 'DOCUMENT_NUMBER_IN_USE', txnNumber: 'R-77', transactionId: first.json.invoice.id,
    })]);

    // Per type: the same number on a cash sale is fine; a second cash sale is not.
    expect((await cashSale({ txnNumber: 'R-77' })).status).toBe(201);
    const dupSale = await cashSale({ txnNumber: 'R-77' });
    expect(dupSale.status).toBe(409);
    expect(dupSale.json.error.code).toBe('DOCUMENT_NUMBER_IN_USE');
    const warnedSale = await cashSale({ txnNumber: 'R-77', warnOnly: true });
    expect(warnedSale.status).toBe(201);
    expect(warnedSale.json.warnings).toHaveLength(1);

    // Edit to a taken number: 409, or a warning.
    const second = await invoice();
    const body = { txnDate: '2026-11-04', contactId: c.customer, lines: lines(), txnNumber: 'R-77' };
    expect((await request('PUT', `/api/v1/invoices/${second.json.invoice.id}`, c.token, body)).status).toBe(409);
    const editWarned = await request('PUT', `/api/v1/invoices/${second.json.invoice.id}`, c.token, { ...body, warnOnly: true });
    expect(editWarned.status, JSON.stringify(editWarned.json)).toBe(200);
    expect(editWarned.json.warnings).toHaveLength(1);

    // Another company's invoices don't clash.
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    expect((await invoice({ txnNumber: 'R-77' }, { 'X-Company-Id': other!.id })).status).toBe(201);
  });
});

describe('auto numbers vs typed numbers, failed posts and concurrent PUT (review S2, S3)', () => {
  const next = async (type: string) => (await request('GET', `/api/v1/document-numbers/next?type=${type}`, c.token)).json.next;

  it('an auto number skips numbers typed by hand, also after PUT moves the counter back', async () => {
    expect((await invoice({ txnNumber: 'INV-1001' })).status).toBe(201);
    expect((await invoice({ txnNumber: 'INV-1002' })).status).toBe(201);
    expect((await invoice({ txnNumber: 'INV-1005' })).status).toBe(201);
    const auto = await invoice();
    expect(auto.status, JSON.stringify(auto.json)).toBe(201);
    expect(auto.json.invoice.txnNumber).toBe('INV-1003');
    expect(await next('invoice')).toBe('INV-1004');
    expect((await invoice()).json.invoice.txnNumber).toBe('INV-1004');
    expect((await invoice()).json.invoice.txnNumber).toBe('INV-1006');

    // PUT moves the counter back below numbers already used: skipped again.
    expect((await request('PUT', '/api/v1/document-numbers/invoice', c.token, { nextNumber: 1001 })).status).toBe(200);
    expect((await invoice()).json.invoice.txnNumber).toBe('INV-1007');

    // Same for the jsonb counters (cash sales, prefix '').
    expect((await cashSale({ txnNumber: '1001' })).status).toBe(201);
    const sale = await cashSale();
    expect(sale.status, JSON.stringify(sale.json)).toBe(201);
    expect(sale.json.transaction.txnNumber).toBe('1002');
    // A deleted document's number is free again.
    const typedMemo = await creditMemo({ txnNumber: '1001' });
    await db.update(transactions).set({ status: 'deleted' }).where(eq(transactions.id, typedMemo.json.transaction.id));
    expect((await creditMemo()).json.transaction.txnNumber).toBe('1001');
    // POST /claim skips too.
    const claimed = await request('POST', '/api/v1/document-numbers/claim', c.token, { type: 'cash_sale' });
    expect(claimed.json).toEqual({ type: 'cash_sale', number: 1003, txnNumber: '1003' });
  });

  it('a refused post takes no number (claimed in the posting transaction)', async () => {
    await db.update(companies).set({ lockDate: '2026-12-31' }).where(eq(companies.id, c.companyId));
    for (const [create, type] of [[invoice, 'invoice'], [cashSale, 'cash_sale'], [creditMemo, 'credit_memo']] as const) {
      const before = await next(type);
      const r = await create();
      expect(r.status, JSON.stringify(r.json)).toBe(423);
      expect(await next(type)).toBe(before);
    }
    await db.update(companies).set({ lockDate: null }).where(eq(companies.id, c.companyId));
    expect((await invoice()).json.invoice.txnNumber).toBe('INV-1001');
  });

  it('concurrent creates get distinct numbers', async () => {
    const made = await Promise.all([invoice(), invoice(), invoice(), invoice(), invoice()]);
    for (const r of made) expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(made.map((r) => r.json.invoice.txnNumber).sort()).toEqual(['INV-1001', 'INV-1002', 'INV-1003', 'INV-1004', 'INV-1005']);
  });

  it('a PUT racing a claim never rolls the next number back', async () => {
    let put!: Promise<Res>;
    await db.transaction(async (holder) => {
      await holder.execute(sql`SELECT 1 FROM companies WHERE id = ${c.companyId} FOR UPDATE`);
      // PUT of the prefix only, while the claim below holds the company row.
      put = request('PUT', '/api/v1/document-numbers/cash_sale', c.token, { prefix: 'SR-' });
      for (let i = 0; i < 250; i++) {
        const waiting = await holder.execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
        `);
        if ((waiting.rows[0] as { n: number }).n >= 1) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const got = await documentNumbers.claim(c.tenantId, 'cash_sale', c.companyId, holder);
      expect(got.number).toBe(1001);
    });
    const r = await put;
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ type: 'cash_sale', prefix: 'SR-', nextNumber: 1002, next: 'SR-1002' });
    expect(await next('cash_sale')).toBe('SR-1002');
  });
});

describe('company-scoped footers (U-111)', () => {
  it('footerText per company with per-type overrides; resolvedFooters falls back on blank', async () => {
    const got = await request('GET', '/api/v1/company/invoice-template', c.token);
    expect(got.status).toBe(200);
    expect(got.json.resolvedFooters).toEqual({
      invoice: 'Thank you for your business!', cash_sale: 'Thank you for your business!',
      credit_memo: 'Thank you for your business!', statement: 'Thank you for your business!',
    });

    const put = await request('PUT', '/api/v1/company/invoice-template', c.token, {
      footerText: 'Ozark Remodeling, 417-555-0100',
      footerOverrides: { cash_sale: 'Thanks for shopping', statement: '   ', credit_memo: null },
    });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json.resolvedFooters).toEqual({
      invoice: 'Ozark Remodeling, 417-555-0100', cash_sale: 'Thanks for shopping',
      credit_memo: 'Ozark Remodeling, 417-555-0100', statement: 'Ozark Remodeling, 417-555-0100',
    });
    expect(put.json.template.companyId).toBe(c.companyId);

    // A second company keeps the tenant default until it writes its own.
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    const asOther = { 'X-Company-Id': other!.id };
    const theirs = await request('GET', '/api/v1/company/invoice-template', c.token, undefined, asOther);
    expect(theirs.json.resolvedFooters.invoice).toBe('Thank you for your business!');
    const theirPut = await request('PUT', '/api/v1/company/invoice-template', c.token, { footerText: 'Second Co footer' }, asOther);
    expect(theirPut.json.resolvedFooters.cash_sale).toBe('Second Co footer');
    expect((await request('GET', '/api/v1/company/invoice-template', c.token)).json.resolvedFooters.cash_sale).toBe('Thanks for shopping');

    expect((await request('PUT', '/api/v1/company/invoice-template', c.token, { footerOverrides: { estimate: 'x' } })).status).toBe(400);
  });
});

describe('forms print queue (U-113)', () => {
  it('printLater forms are listed by type and company; mark-printed clears them with an audit row', async () => {
    const inv = await invoice({ printLater: true });
    const plain = await invoice();
    const sale = await cashSale({ printLater: true });
    const memo = await creditMemo({ printLater: true });
    for (const r of [inv, plain, sale, memo]) expect(r.status, JSON.stringify(r.json)).toBe(201);

    const all = await request('GET', '/api/v1/forms/print-queue', c.token);
    expect(all.status).toBe(200);
    expect((all.json.data as any[]).map((r) => r.id).sort()).toEqual(
      [inv.json.invoice.id, sale.json.transaction.id, memo.json.transaction.id].sort(),
    );
    const invoices = await request('GET', '/api/v1/forms/print-queue?type=invoice', c.token);
    expect(invoices.json.data).toEqual([{
      id: inv.json.invoice.id, type: 'invoice', txnNumber: inv.json.invoice.txnNumber, txnDate: '2026-11-04',
      contactName: 'Rivera Remodel', total: '100.0000',
    }]);
    expect((await request('GET', '/api/v1/forms/print-queue?type=bill', c.token)).status).toBe(400);

    // Another company sees none of them.
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    const asOther = { 'X-Company-Id': other!.id };
    expect((await request('GET', '/api/v1/forms/print-queue', c.token, undefined, asOther)).json.data).toEqual([]);
    expect((await request('POST', '/api/v1/forms/mark-printed', c.token, { ids: [inv.json.invoice.id] }, asOther)).status).toBe(404);

    // A non-form id refuses the whole request.
    const bad = await request('POST', '/api/v1/forms/mark-printed', c.token, { ids: [inv.json.invoice.id, c.bank] });
    expect(bad.status).toBe(404);

    const marked = await request('POST', '/api/v1/forms/mark-printed', c.token, { ids: [inv.json.invoice.id, sale.json.transaction.id, plain.json.invoice.id] });
    expect(marked.status, JSON.stringify(marked.json)).toBe(200);
    expect(marked.json).toEqual({ marked: 2, alreadyPrinted: 1 });
    expect((await request('GET', '/api/v1/forms/print-queue', c.token)).json.data.map((r: any) => r.id)).toEqual([memo.json.transaction.id]);
    const audit = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'form_print')));
    expect(audit.map((a) => a.entityId).sort()).toEqual([inv.json.invoice.id, sale.json.transaction.id].sort());

    // An edit can put a form back in the queue; void leaves the queue.
    const body = { txnDate: '2026-11-04', contactId: c.customer, lines: lines(), printLater: true };
    expect((await request('PUT', `/api/v1/invoices/${plain.json.invoice.id}`, c.token, body)).status).toBe(200);
    expect((await request('GET', '/api/v1/forms/print-queue?type=invoice', c.token)).json.data.map((r: any) => r.id)).toEqual([plain.json.invoice.id]);
    await db.update(transactions).set({ status: 'void' }).where(eq(transactions.id, plain.json.invoice.id));
    expect((await request('GET', '/api/v1/forms/print-queue?type=invoice', c.token)).json.data).toEqual([]);
  });

  it('printLater on an edit is company-scoped and commits with the edit (review S6)', async () => {
    const inv = await invoice();
    const sale = await cashSale();
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    const asOther = { 'X-Company-Id': other!.id };
    const printLater = async (id: string) => (await db.select().from(transactions).where(eq(transactions.id, id)))[0]!.printLater;

    // Through the routes, from another company: refused, the mark unchanged.
    const invBody = { txnDate: '2026-11-04', contactId: c.customer, lines: lines(), printLater: true };
    expect((await request('PUT', `/api/v1/invoices/${inv.json.invoice.id}`, c.token, invBody, asOther)).status).toBe(404);
    const saleBody = {
      txnType: 'cash_sale', txnDate: '2026-11-04', contactId: c.customer, depositToAccountId: c.bank, lines: lines('40.00'), printLater: true,
    };
    expect((await request('PUT', `/api/v1/transactions/${sale.json.transaction.id}`, c.token, saleBody, asOther)).status).toBe(404);
    expect(await printLater(inv.json.invoice.id)).toBe(false);
    expect(await printLater(sale.json.transaction.id)).toBe(false);

    // The service itself refuses another company's form and a non-form.
    await expect(formsPrint.setPrintLater(db, c.tenantId, inv.json.invoice.id, true, other!.id))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(formsPrint.setPrintLater(db, c.tenantId, c.bank, true, c.companyId))
      .rejects.toMatchObject({ statusCode: 404 });
    expect(await printLater(inv.json.invoice.id)).toBe(false);

    // A refused edit (closed period) leaves the mark as it was.
    await db.update(companies).set({ lockDate: '2026-12-31' }).where(eq(companies.id, c.companyId));
    expect((await request('PUT', `/api/v1/invoices/${inv.json.invoice.id}`, c.token, invBody)).status).toBe(423);
    expect(await printLater(inv.json.invoice.id)).toBe(false);
    await db.update(companies).set({ lockDate: null }).where(eq(companies.id, c.companyId));
    expect((await request('PUT', `/api/v1/invoices/${inv.json.invoice.id}`, c.token, invBody)).status).toBe(200);
    expect(await printLater(inv.json.invoice.id)).toBe(true);
  });
});
