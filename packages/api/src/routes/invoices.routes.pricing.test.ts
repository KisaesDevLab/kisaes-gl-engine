// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Item kinds and invoice pricing (ClientLedger P20 E2), through the HTTP
// routes:
//   - U-39a item-kinds-sales-v1: discount and subtotal items, kind rules;
//   - U-40 price-levels-v1: CRUD, fixed prices rounded to the cent, names,
//     in-use and inactive levels, a client's level;
//   - U-129 invoice-pricing-v1: POST /invoices/preview equals what POST
//     /invoices posts for every golden pricing case, writes nothing, and
//     PUT with the lines as read back keeps the figures.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray, count } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, items, transactionTags, userPermissions, idempotencyKeys, documentSendEvents, priceLevels, priceLevelItems,
} from '../db/schema/index.js';
import { invoicesRouter } from './invoices.routes.js';
import { itemsRouter } from './items.routes.js';
import { priceLevelsRouter } from './price-levels.routes.js';
import { contactsRouter } from './contacts.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { getInvoiceHtml } from '../services/pdf.service.js';

const Decimal = DecimalLib.default || DecimalLib;
const here = path.dirname(fileURLToPath(import.meta.url));

interface GoldenItem { id: string; type: string; unitPrice: string | null; discountPercent: string | null }
interface GoldenLine { item?: GoldenItem; quantity?: string; unitPrice?: string; discountPercent?: string; isTaxable: boolean; taxRate?: string }
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/invoice-golden.json'), 'utf8')) as {
  pricingCases: Array<{
    name: string; defaultTaxRate: string; priceLevel?: { percent: string; itemPrices: Record<string, string> };
    lines: GoldenLine[];
    expect: { lines: Array<Record<string, string | null>>; subtotal: string; taxableBase: string; taxTotal: string; total: string };
  }>;
};

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
  await db.delete(documentSendEvents).where(eq(documentSendEvents.tenantId, tid));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(priceLevelItems).where(eq(priceLevelItems.tenantId, tid));
  await db.delete(priceLevels).where(eq(priceLevels.tenantId, tid));
  await db.delete(items).where(eq(items.tenantId, tid));
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

interface Co { tenantId: string; token: string; companyId: string; revenue: string; ar: string; tax: string; customer: string }

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  return a!.id;
}

async function makeCompany(): Promise<Co> {
  const reg = await authService.register({
    email: `inv-pricing-${suffix()}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: 'Monett Landscapes',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  await db.update(companies).set({ defaultSalesTaxRate: '0.0810', defaultPaymentTerms: 'net_30' }).where(eq(companies.id, company!.id));
  const revenue = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Hartley Residence' }).returning();
  return {
    tenantId, token: reg.tokens.accessToken, companyId: company!.id, revenue: revenue!.id,
    ar: await bySystemTag(tenantId, 'accounts_receivable'), tax: await bySystemTag(tenantId, 'sales_tax_payable'), customer: customer!.id,
  };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/invoices', invoicesRouter);
  app.use('/api/v1/items', itemsRouter);
  app.use('/api/v1/price-levels', priceLevelsRouter);
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

async function makeItem(body: Record<string, unknown>) {
  const r = await request('POST', '/api/v1/items', c.token, { incomeAccountId: c.revenue, ...body, name: `${body['name'] ?? 'item'}-${suffix()}` });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.item;
}

const revenueLines = (inv: any) => (inv.lines as any[]).filter((l) => l.accountId !== c.ar && l.accountId !== c.tax);

it('advertises the item pricing capabilities', () => {
  for (const cap of ['item-kinds-sales-v1', 'price-levels-v1', 'invoice-pricing-v1']) expect(DESKTOP_CAPABILITIES).toContain(cap);
});

describe('item-kinds-sales-v1 (U-39a)', () => {
  it('existing-style items are service; discount and subtotal items follow the kind rules; list filters by kind', async () => {
    const plain = await makeItem({ name: 'labor', unitPrice: '65.00' });
    expect(plain.itemType).toBe('service');
    const pct = await makeItem({ name: 'pct', itemType: 'discount', discountPercent: '10' });
    expect([pct.itemType, pct.discountPercent, pct.isTaxable]).toEqual(['discount', '10.0000', true]);
    const amt = await makeItem({ name: 'amt', itemType: 'discount', unitPrice: '15.00', isTaxable: false });
    expect([amt.unitPrice, amt.isTaxable]).toEqual(['15.0000', false]);
    await makeItem({ name: 'sub', itemType: 'subtotal' });

    const bad = async (body: Record<string, unknown>) => {
      const r = await request('POST', '/api/v1/items', c.token, { incomeAccountId: c.revenue, name: `bad-${suffix()}`, ...body });
      expect(r.status, JSON.stringify(r.json)).toBe(400);
    };
    await bad({ itemType: 'discount', discountPercent: '10', unitPrice: '5.00' });
    await bad({ itemType: 'discount', unitPrice: '-5.00' });
    await bad({ itemType: 'discount', discountPercent: '0' });
    await bad({ itemType: 'discount', discountPercent: '100.01' });
    await bad({ itemType: 'subtotal', unitPrice: '1.00' });
    await bad({ itemType: 'service', discountPercent: '5' });
    await bad({ itemType: 'inventory' });

    // An edit is checked against the merged item.
    const r = await request('PUT', `/api/v1/items/${pct.id}`, c.token, { unitPrice: '3.00' });
    expect(r.status).toBe(400);
    const ok = await request('PUT', `/api/v1/items/${pct.id}`, c.token, { unitPrice: '3.00', discountPercent: null });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect([ok.json.item.unitPrice, ok.json.item.discountPercent]).toEqual(['3.0000', null]);

    const list = await request('GET', '/api/v1/items?itemType=discount', c.token);
    expect((list.json.data as any[]).map((i) => i.itemType)).toEqual(['discount', 'discount']);
  });
});

describe('price-levels-v1 (U-40)', () => {
  it('creates, reads, edits and deletes levels; prices round to the cent; names, items and in-use are checked', async () => {
    const shrubs = await makeItem({ name: 'shrubs', unitPrice: '32.50' });
    const disc = await makeItem({ name: 'disc', itemType: 'discount', discountPercent: '10' });
    const created = await request('POST', '/api/v1/price-levels', c.token, {
      name: 'Contractor', percent: '-7.5', itemPrices: [{ itemId: shrubs.id, unitPrice: '29.995' }],
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const lvl = created.json.priceLevel;
    expect([lvl.name, lvl.percent, lvl.isActive, lvl.companyId]).toEqual(['Contractor', '-7.5000', true, c.companyId]);
    expect(lvl.itemPrices).toEqual([{ itemId: shrubs.id, unitPrice: '30.0000' }]);

    expect((await request('POST', '/api/v1/price-levels', c.token, { name: 'contractor' })).json.error.code).toBe('PRICE_LEVEL_NAME_IN_USE');
    expect((await request('POST', '/api/v1/price-levels', c.token, { name: 'X', itemPrices: [{ itemId: disc.id, unitPrice: '1' }] })).status).toBe(400);
    expect((await request('POST', '/api/v1/price-levels', c.token, { name: 'X', percent: '-100.5' })).status).toBe(400);
    expect((await request('POST', '/api/v1/price-levels', c.token, { name: 'X', itemPrices: [{ itemId: shrubs.id, unitPrice: '1' }, { itemId: shrubs.id, unitPrice: '2' }] })).status).toBe(400);

    const edited = await request('PUT', `/api/v1/price-levels/${lvl.id}`, c.token, { percent: '5', itemPrices: [] });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect([edited.json.priceLevel.percent, edited.json.priceLevel.itemPrices]).toEqual(['5.0000', []]);
    const list = await request('GET', '/api/v1/price-levels', c.token);
    expect(list.json.data.map((l: any) => [l.name, l.itemPriceCount])).toEqual([['Contractor', 0]]);

    // A client with the level: delete is refused; the client's level shows on the contact.
    const set = await request('PUT', `/api/v1/contacts/${c.customer}`, c.token, { priceLevelId: lvl.id });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.contact.priceLevelId).toBe(lvl.id);
    const del = await request('DELETE', `/api/v1/price-levels/${lvl.id}`, c.token);
    expect([del.status, del.json.error.code]).toEqual([409, 'PRICE_LEVEL_IN_USE']);
    await request('PUT', `/api/v1/contacts/${c.customer}`, c.token, { priceLevelId: null });
    expect((await request('DELETE', `/api/v1/price-levels/${lvl.id}`, c.token)).status).toBe(200);
    expect((await request('GET', `/api/v1/price-levels/${lvl.id}`, c.token)).status).toBe(404);
    const audits = await db.select({ n: count() }).from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'price_level')));
    expect(audits[0]!.n).toBe(3);
  });

  it('an inactive level prices nothing and can\'t be given to a client; a level of another company is 404', async () => {
    const shrubs = await makeItem({ name: 'shrubs', unitPrice: '32.50' });
    const lvl = (await request('POST', '/api/v1/price-levels', c.token, { name: 'Down', percent: '-7.5' })).json.priceLevel;
    await request('PUT', `/api/v1/contacts/${c.customer}`, c.token, { priceLevelId: lvl.id });
    const body = { contactId: c.customer, txnDate: '2026-11-03', lines: [{ itemId: shrubs.id, quantity: '24', isTaxable: false }] };
    expect((await request('POST', '/api/v1/invoices/preview', c.token, body)).json.lines[0].unitPrice).toBe('30.06');
    await request('PUT', `/api/v1/price-levels/${lvl.id}`, c.token, { isActive: false });
    const p = (await request('POST', '/api/v1/invoices/preview', c.token, body)).json;
    expect([p.lines[0].unitPrice, p.lines[0].unitPriceSource, p.priceLevel]).toEqual(['32.5000', 'item', null]);
    const [other] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'customer', displayName: 'Other' }).returning();
    expect((await request('PUT', `/api/v1/contacts/${other!.id}`, c.token, { priceLevelId: lvl.id })).status).toBe(400);

    const [co2] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    await db.update(priceLevels).set({ companyId: co2!.id }).where(eq(priceLevels.id, lvl.id));
    expect((await request('GET', `/api/v1/price-levels/${lvl.id}`, c.token)).status).toBe(404);
  });
});

describe('invoice-pricing-v1 (U-129)', () => {
  // Each golden pricing case through the routes: preview, then post, then GET.
  it.each(golden.pricingCases)('preview == post: $name', async (gc) => {
    await db.update(companies).set({ defaultSalesTaxRate: gc.defaultTaxRate }).where(eq(companies.id, c.companyId));
    const made = new Map<string, any>();
    for (const l of gc.lines) {
      if (!l.item || made.has(l.item.id)) continue;
      made.set(l.item.id, await makeItem({
        name: l.item.id, itemType: l.item.type, unitPrice: l.item.unitPrice, discountPercent: l.item.discountPercent,
      }));
    }
    if (gc.priceLevel) {
      const lvl = await request('POST', '/api/v1/price-levels', c.token, {
        name: `L-${suffix()}`, percent: gc.priceLevel.percent,
        itemPrices: Object.entries(gc.priceLevel.itemPrices).map(([id, unitPrice]) => ({ itemId: made.get(id).id, unitPrice })),
      });
      expect(lvl.status, JSON.stringify(lvl.json)).toBe(201);
      await request('PUT', `/api/v1/contacts/${c.customer}`, c.token, { priceLevelId: lvl.json.priceLevel.id });
    }
    const lines = gc.lines.map((l) => ({
      ...(l.item ? { itemId: made.get(l.item.id).id } : { accountId: c.revenue }),
      ...(l.quantity !== undefined ? { quantity: l.quantity } : {}),
      ...(l.unitPrice !== undefined ? { unitPrice: l.unitPrice } : {}),
      ...(l.discountPercent !== undefined ? { discountPercent: l.discountPercent } : {}),
      ...(l.taxRate !== undefined ? { taxRate: l.taxRate } : {}),
      isTaxable: l.isTaxable,
    }));
    const body = { contactId: c.customer, txnDate: '2026-11-03', lines };

    const txnsBefore = await db.select({ n: count() }).from(transactions).where(eq(transactions.tenantId, c.tenantId));
    const auditsBefore = await db.select({ n: count() }).from(auditLog).where(eq(auditLog.tenantId, c.tenantId));
    const pv = await request('POST', '/api/v1/invoices/preview', c.token, body);
    expect(pv.status, JSON.stringify(pv.json)).toBe(200);
    const p = pv.json;
    // Nothing written.
    expect((await db.select({ n: count() }).from(transactions).where(eq(transactions.tenantId, c.tenantId)))[0]!.n).toBe(txnsBefore[0]!.n);
    expect((await db.select({ n: count() }).from(auditLog).where(eq(auditLog.tenantId, c.tenantId)))[0]!.n).toBe(auditsBefore[0]!.n);

    // The golden figures (an item price reads back at 4 places).
    gc.expect.lines.forEach((e, i) => {
      const l = p.lines[i];
      expect({ ...l, unitPrice: null, itemId: undefined, isTaxable: undefined }).toEqual({ ...e, unitPrice: null, itemId: undefined, isTaxable: undefined });
      if (e['unitPrice'] === null) expect(l.unitPrice).toBeNull();
      else expect(new Decimal(l.unitPrice).equals(e['unitPrice']!)).toBe(true);
    });
    expect([p.subtotal, p.taxableBase, p.taxTotal, p.total]).toEqual([gc.expect.subtotal, gc.expect.taxableBase, gc.expect.taxTotal, gc.expect.total]);
    expect(p.contactBalanceAfter).toBe(gc.expect.total);
    expect(p.dueDate).toBe('2026-12-03');

    // Posting the same body gives the same figures.
    const posted = await request('POST', '/api/v1/invoices', c.token, body);
    expect(posted.status, JSON.stringify(posted.json)).toBe(201);
    const got = (await request('GET', `/api/v1/invoices/${posted.json.invoice.id}`, c.token)).json.invoice;
    expect([got.subtotal, got.taxAmount, got.total]).toEqual([p.subtotal, p.taxTotal, p.total].map((v: string) => new Decimal(v).toFixed(4)));
    const rev = revenueLines(got);
    expect(rev).toHaveLength(p.lines.length);
    rev.forEach((l: any, i: number) => {
      const pl = p.lines[i];
      const signed = new Decimal(l.credit).minus(l.debit);
      expect(signed.toFixed(2)).toBe(pl.itemType === 'subtotal' ? '0.00' : pl.amount);
      expect(new Decimal(l.taxAmount).toFixed(2)).toBe(pl.taxAmount);
      expect(l.unitPriceSource).toBe(pl.unitPriceSource);
      expect(l.discountPercent).toBe(pl.discountPercent);
      expect(l.unitPrice === null ? null : new Decimal(l.unitPrice).toFixed(2)).toBe(pl.unitPrice === null ? null : new Decimal(pl.unitPrice).toFixed(2));
    });
    const debit = (got.lines as any[]).reduce((s, l) => s.plus(l.debit), new Decimal(0));
    const credit = (got.lines as any[]).reduce((s, l) => s.plus(l.credit), new Decimal(0));
    expect(debit.equals(credit)).toBe(true);

    // An edit preview takes the invoice's own total out of the balance first.
    const edit = await request('POST', '/api/v1/invoices/preview', c.token, { ...body, invoiceId: got.id });
    expect([edit.json.contactBalanceBefore, edit.json.contactBalanceAfter]).toEqual(['0.00', gc.expect.total]);

    // PUT with the lines as read back keeps every figure.
    const resend = rev.map((l: any) => ({
      ...(l.itemId ? { itemId: l.itemId } : { accountId: l.accountId }),
      ...(l.quantity !== null ? { quantity: l.quantity } : {}),
      ...(l.unitPrice !== null ? { unitPrice: l.unitPrice } : {}),
      ...(l.discountPercent !== null ? { discountPercent: l.discountPercent } : {}),
      isTaxable: l.isTaxable,
    }));
    const put = await request('PUT', `/api/v1/invoices/${got.id}`, c.token, { ...body, lines: resend, expectedUpdatedAt: got.updatedAt });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect([put.json.invoice.subtotal, put.json.invoice.taxAmount, put.json.invoice.total]).toEqual([got.subtotal, got.taxAmount, got.total]);
  });

  it('refuses an item with no price, a discount with both a percent and an amount, and another company\'s invoiceId', async () => {
    const noPrice = await makeItem({ name: 'np' });
    const r1 = await request('POST', '/api/v1/invoices/preview', c.token, { contactId: c.customer, txnDate: '2026-11-03', lines: [{ itemId: noPrice.id, quantity: '1' }] });
    expect([r1.status, r1.json.error.code]).toEqual([400, 'VALIDATION_ERROR']);
    const disc = await makeItem({ name: 'd', itemType: 'discount', discountPercent: '10' });
    const both = { contactId: c.customer, txnDate: '2026-11-03', lines: [{ accountId: c.revenue, quantity: '1', unitPrice: '10' }, { itemId: disc.id, discountPercent: '5', unitPrice: '1' }] };
    expect((await request('POST', '/api/v1/invoices/preview', c.token, both)).status).toBe(400);
    expect((await request('POST', '/api/v1/invoices', c.token, both)).status).toBe(400);
    const missing = await request('POST', '/api/v1/invoices/preview', c.token, {
      contactId: c.customer, txnDate: '2026-11-03', invoiceId: '00000000-0000-4000-8000-000000000000', lines: [{ accountId: c.revenue, quantity: '1', unitPrice: '1' }],
    });
    expect(missing.status).toBe(404);
  });

  it('the printed invoice shows the subtotal amount and the discount percent', async () => {
    const shrubs = await makeItem({ name: 'shrubs', unitPrice: '32.50' });
    const sub = await makeItem({ name: 'sub', itemType: 'subtotal' });
    const disc = await makeItem({ name: 'disc', itemType: 'discount', discountPercent: '10' });
    const r = await request('POST', '/api/v1/invoices', c.token, {
      contactId: c.customer, txnDate: '2026-11-03', hideZeroLines: true,
      lines: [{ itemId: shrubs.id, quantity: '24', isTaxable: false, description: 'Shrubs' }, { itemId: sub.id, description: 'Plants subtotal' },
        { itemId: disc.id, isTaxable: false, description: 'Spring discount' }],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.invoice.total).toBe('702.0000');
    const html = await getInvoiceHtml(c.tenantId, r.json.invoice.id);
    const row = (label: string) => html.slice(html.indexOf(label), html.indexOf('</tr>', html.indexOf(label)));
    expect(row('Plants subtotal')).toContain('$780.00');
    expect(row('Spring discount')).toContain('10%');
    expect(row('Spring discount')).toContain('$-78.00');
  });

  it('the client balance after counts the open invoices already posted', async () => {
    const first = await request('POST', '/api/v1/invoices', c.token, { contactId: c.customer, txnDate: '2026-11-01', lines: [{ accountId: c.revenue, quantity: '1', unitPrice: '100.00', isTaxable: false }] });
    expect(first.status).toBe(201);
    const p = (await request('POST', '/api/v1/invoices/preview', c.token, { contactId: c.customer, txnDate: '2026-11-03', lines: [{ accountId: c.revenue, quantity: '2', unitPrice: '10.00', isTaxable: true }] })).json;
    expect([p.total, p.contactBalanceBefore, p.contactBalanceAfter, p.taxRate]).toEqual(['21.62', '100.00', '121.62', '0.0810']);
  });
});
