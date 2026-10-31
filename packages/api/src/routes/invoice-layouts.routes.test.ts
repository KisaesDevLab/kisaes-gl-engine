// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Invoice print layouts (U-130, invoice-layouts-v1) through the HTTP routes:
//   - a company's first layout "Standard" (a copy of the template it printed
//     with) is its default; GET/PUT /company/invoice-template use it;
//   - create / update (columns merge, expectedUpdatedAt) / set default /
//     delete (default refused, in use refused or reassigned);
//   - names unique per company; company scope; audit rows; one default under
//     concurrent writes;
//   - invoices: layoutId on POST / PUT / preview / GET and copies; the
//     engine PDF prints the layout's columns.

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
  contacts, transactionTags, userPermissions, idempotencyKeys, invoiceTemplates, items,
} from '../db/schema/index.js';
import { invoicesRouter } from './invoices.routes.js';
import { companyRouter } from './company.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as pdfService from '../services/pdf.service.js';
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

interface Co { tenantId: string; token: string; companyId: string; revenue: string; customer: string }

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `layouts-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `Layouts ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [revenue] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue'))).limit(1);
  const [cust] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  return { tenantId, token: reg.tokens.accessToken, companyId: company!.id, revenue: revenue!.id, customer: cust!.id };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/invoices', invoicesRouter);
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

const L = '/api/v1/company/invoice-layouts';
const body = (extra: Record<string, unknown> = {}) => ({
  txnDate: '2026-11-04', contactId: c.customer,
  lines: [{ accountId: c.revenue, description: 'Install', quantity: '2', unitPrice: '50.00', serviceDate: '2026-10-28' }],
  ...extra,
});
const invoice = (extra: Record<string, unknown> = {}) => request('POST', '/api/v1/invoices', c.token, body(extra));
const list = async (headers: Record<string, string> = {}) => (await request('GET', L, c.token, undefined, headers)).json.data as any[];
const create = (b: Record<string, unknown>, headers: Record<string, string> = {}) => request('POST', L, c.token, b, headers);

describe('invoice layouts (U-130)', () => {
  it('advertises the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('invoice-layouts-v1');
  });

  it('the first layout is Standard, a copy of the template; /invoice-template is the default layout', async () => {
    const put = await request('PUT', '/api/v1/company/invoice-template', c.token, { footerText: 'Ozark footer', showPoNumber: true });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    const layouts = await list();
    expect(layouts).toHaveLength(1);
    expect(layouts[0]).toMatchObject({
      id: put.json.template.id, name: 'Standard', isDefault: true, footerText: 'Ozark footer', showPoNumber: true, invoiceCount: 0,
      columns: { item: false, description: true, serviceDate: false, quantity: true, rate: true },
    });
    expect(layouts[0].resolvedFooters.invoice).toBe('Ozark footer');
    // Reading again creates nothing.
    expect(await list()).toHaveLength(1);
  });

  it('a company that never wrote a template gets one Standard default on first read', async () => {
    const [a, b] = await Promise.all([list(), list()]);
    expect(a.map((l) => l.id)).toEqual(b.map((l) => l.id));
    const rows = await db.select().from(invoiceTemplates)
      .where(and(eq(invoiceTemplates.tenantId, c.tenantId), eq(invoiceTemplates.companyId, c.companyId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Standard', isDefault: true });
  });

  it('create, edit, name conflicts, stale edits, set default and audit rows', async () => {
    const [standard] = await list();
    const svc = await create({ name: 'Service with dates', columns: { serviceDate: true, item: true }, footerText: 'Service footer' });
    expect(svc.status, JSON.stringify(svc.json)).toBe(201);
    expect(svc.json.layout).toMatchObject({
      name: 'Service with dates', isDefault: false, footerText: 'Service footer',
      columns: { item: true, description: true, serviceDate: true, quantity: true, rate: true },
    });
    const dup = await create({ name: ' service WITH dates ' });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('INVOICE_LAYOUT_NAME_IN_USE');
    expect((await create({ name: '' })).status).toBe(400);
    expect((await create({ name: 'X', columns: { amount: false } })).status).toBe(400);

    const id = svc.json.layout.id;
    const upd = await request('PUT', `${L}/${id}`, c.token, { columns: { rate: false }, expectedUpdatedAt: svc.json.layout.updatedAt });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    expect(upd.json.layout.columns).toEqual({ item: true, description: true, serviceDate: true, quantity: true, rate: false });
    const stale = await request('PUT', `${L}/${id}`, c.token, { name: 'Late', expectedUpdatedAt: svc.json.layout.updatedAt });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE');
    expect((await request('PUT', `${L}/${id}`, c.token, { name: 'standard' })).json.error.code).toBe('INVOICE_LAYOUT_NAME_IN_USE');
    expect((await request('PUT', `${L}/${id}`, c.token, { name: 'Service' })).json.layout.name).toBe('Service');

    const def = await request('POST', `${L}/${id}/default`, c.token);
    expect(def.status, JSON.stringify(def.json)).toBe(200);
    expect(def.json.layout.isDefault).toBe(true);
    const after = await list();
    expect(after.map((l) => [l.name, l.isDefault])).toEqual([['Service', true], ['Standard', false]]);
    const tpl = await request('GET', '/api/v1/company/invoice-template', c.token);
    expect(tpl.json.template.id).toBe(id);
    expect(tpl.json.resolvedFooters.invoice).toBe('Service footer');

    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'invoice_template')));
    expect(audits.filter((a) => a.entityId === id).map((a) => a.action).sort()).toEqual(['create', 'update', 'update', 'update']);
    expect(audits.some((a) => a.entityId === standard.id && a.action === 'create')).toBe(true);
  });

  it('concurrent set-default calls leave exactly one default', async () => {
    await list();
    const ids = [];
    for (const name of ['A', 'B', 'C']) ids.push((await create({ name })).json.layout.id);
    const results = await Promise.all(ids.map((id) => request('POST', `${L}/${id}/default`, c.token)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await list()).filter((l) => l.isDefault)).toHaveLength(1);
  });

  it('delete refuses the default and layouts in use unless reassigned to the default', async () => {
    const [standard] = await list();
    const prod = (await create({ name: 'Product' })).json.layout;
    expect((await request('DELETE', `${L}/${standard.id}`, c.token)).json.error.code).toBe('INVOICE_LAYOUT_IS_DEFAULT');

    const inv = await invoice({ layoutId: prod.id });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    const refused = await request('DELETE', `${L}/${prod.id}`, c.token);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatchObject({ code: 'INVOICE_LAYOUT_IN_USE', details: { invoiceCount: 1 } });
    expect((await list()).find((l) => l.id === prod.id)!.invoiceCount).toBe(1);

    const before = (await request('GET', `/api/v1/invoices/${inv.json.invoice.id}`, c.token)).json.invoice;
    const del = await request('DELETE', `${L}/${prod.id}?reassignToDefault=true`, c.token);
    expect(del.status, JSON.stringify(del.json)).toBe(200);
    expect(del.json).toEqual({ reassignedCount: 1 });
    const got = (await request('GET', `/api/v1/invoices/${inv.json.invoice.id}`, c.token)).json.invoice;
    expect(got.layoutId).toBeNull();
    expect(got.updatedAt).toBe(before.updatedAt);
    expect((await request('GET', `${L}/${prod.id}`, c.token)).json.error.code).toBe('INVOICE_LAYOUT_NOT_FOUND');
    expect((await request('DELETE', `${L}/not-a-uuid`, c.token)).status).toBe(404);

    const unused = (await create({ name: 'Unused' })).json.layout;
    expect((await request('DELETE', `${L}/${unused.id}`, c.token)).json).toEqual({ reassignedCount: 0 });
  });

  it('layouts are company scoped', async () => {
    const mine = (await create({ name: 'Mine' })).json.layout;
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    const asOther = { 'X-Company-Id': other!.id };
    const theirs = await list(asOther);
    expect(theirs.map((l) => l.name)).toEqual(['Standard']);
    expect((await list()).map((l) => l.name)).toEqual(['Standard', 'Mine']);
    for (const [m, p] of [['GET', ''], ['PUT', ''], ['DELETE', ''], ['POST', '/default']] as const) {
      const r = await request(m, `${L}/${mine.id}${p}`, c.token, m === 'PUT' ? { name: 'Stolen' } : undefined, asOther);
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    // Their own name space: "Mine" is free there.
    expect((await create({ name: 'Mine' }, asOther)).status).toBe(201);
    // One company's default change leaves the other's alone.
    await request('POST', `${L}/${mine.id}/default`, c.token);
    expect((await list(asOther)).find((l) => l.name === 'Standard')!.isDefault).toBe(true);
  });

  it('invoices carry layoutId on create, edit, preview, get and copies', async () => {
    await list();
    const svc = (await create({ name: 'Service' })).json.layout;
    expect((await invoice()).json.invoice.layoutId).toBeNull();

    const inv = await invoice({ layoutId: svc.id });
    expect(inv.json.invoice.layoutId).toBe(svc.id);
    const id = inv.json.invoice.id;
    const kept = await request('PUT', `/api/v1/invoices/${id}`, c.token, body({ memo: 'edit' }));
    expect(kept.status, JSON.stringify(kept.json)).toBe(200);
    expect(kept.json.invoice.layoutId).toBe(svc.id);
    const cleared = await request('PUT', `/api/v1/invoices/${id}`, c.token, body({ layoutId: null }));
    expect(cleared.json.invoice.layoutId).toBeNull();
    await request('PUT', `/api/v1/invoices/${id}`, c.token, body({ layoutId: svc.id }));

    const pv = await request('POST', '/api/v1/invoices/preview', c.token, body({ invoiceId: id }));
    expect(pv.status, JSON.stringify(pv.json)).toBe(200);
    expect(pv.json.layoutId).toBe(svc.id);
    expect((await request('POST', '/api/v1/invoices/preview', c.token, body({ layoutId: null }))).json.layoutId).toBeNull();

    const copy = await request('POST', `/api/v1/invoices/${id}/duplicate`, c.token);
    expect(copy.status, JSON.stringify(copy.json)).toBeLessThan(300);
    const copyId = copy.json.invoice?.id ?? copy.json.id;
    expect((await request('GET', `/api/v1/invoices/${copyId}`, c.token)).json.invoice.layoutId).toBe(svc.id);

    // Not a layout of this company: refused everywhere, nothing written.
    const [other] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Co' }).returning();
    const foreign = (await create({ name: 'Foreign' }, { 'X-Company-Id': other!.id })).json.layout;
    for (const bad of [foreign.id, '00000000-0000-4000-8000-000000000999']) {
      const r = await invoice({ layoutId: bad });
      expect(r.status).toBe(400);
      expect(r.json.error.code).toBe('INVOICE_LAYOUT_NOT_FOUND');
      expect((await request('PUT', `/api/v1/invoices/${id}`, c.token, body({ layoutId: bad }))).json.error.code).toBe('INVOICE_LAYOUT_NOT_FOUND');
      expect((await request('POST', '/api/v1/invoices/preview', c.token, body({ layoutId: bad }))).json.error.code).toBe('INVOICE_LAYOUT_NOT_FOUND');
    }
    expect((await invoice({ layoutId: 'nope' })).status).toBe(400);
    expect((await request('GET', `/api/v1/invoices/${id}`, c.token)).json.invoice.layoutId).toBe(svc.id);
  });

  it('the engine PDF prints the invoice layout columns', async () => {
    await list();
    const [item] = await db.insert(items).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Deck stain', incomeAccountId: c.revenue }).returning();
    const lines = [{ accountId: c.revenue, itemId: item!.id, description: 'Two coats', quantity: '2', unitPrice: '50.00', serviceDate: '2026-10-28' }];
    const plain = await invoice({ lines });
    expect(plain.status, JSON.stringify(plain.json)).toBe(201);
    const std = await pdfService.getInvoiceHtml(c.tenantId, plain.json.invoice.id);
    expect(std).toContain('<th>Description</th>');
    expect(std).toContain('>Qty</th>');
    expect(std).toContain('>Rate</th>');
    expect(std).not.toContain('Service Date');
    expect(std).not.toContain('Deck stain');

    const svc = (await create({ name: 'Service', columns: { serviceDate: true, item: true, rate: false }, footerText: 'Service footer' })).json.layout;
    const dated = await invoice({ lines, layoutId: svc.id });
    const html = await pdfService.getInvoiceHtml(c.tenantId, dated.json.invoice.id);
    expect(html).toContain('>Service Date</th>');
    expect(html).toContain('<th>Item</th>');
    expect(html).toContain('2026-10-28');
    expect(html).toContain('Deck stain');
    expect(html).toContain('Two coats');
    expect(html).not.toContain('>Rate</th>');
    expect(html).toContain('Service footer');

    // An invoice whose layout was deleted prints with the default.
    await request('DELETE', `${L}/${svc.id}?reassignToDefault=true`, c.token);
    expect(await pdfService.getInvoiceHtml(c.tenantId, dated.json.invoice.id)).not.toContain('Service Date');
  });
});
