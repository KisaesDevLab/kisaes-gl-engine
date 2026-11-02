// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-151 (tax-exemptions-v1): golden case 10 — certificates, preview
// warnings (EXEMPTION_MISSING / EXPIRED / EXPIRING) and the expiring report;
// attachment scope; another company's certificate is 404; no numbers in audit.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  companies, contacts, items, attachments, auditLog, transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes,
  salesTaxAgencies, contactTaxExemptions,
} from '../db/schema/index.js';
import { salesTaxRouter, salesTaxReportsRouter } from './sales-tax.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { salesReceiptsRouter } from './sales-receipts.routes.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

type Body = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/sales-tax-golden.json'), 'utf8')) as Body;
const monett = golden['seeds'].monett as Body;
const g10 = (golden['cases'] as Body[]).find((c) => c['id'] === 10)!['steps'] as Body[];

async function clean(tid: string) {
  await db.delete(attachments).where(eq(attachments.tenantId, tid));
  for (const t of [contactTaxExemptions, transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes, salesTaxAgencies]) {
    await db.delete(t).where(eq(t.tenantId, tid));
  }
}

const h = new Harness();
let c: Co;
const clients = new Map<string, string>();
const codes = new Map<string, string>();
let plants = '';

beforeEach(async () => {
  h.extraCleanup = [clean];
  await h.start([['/api/v1/sales-tax', salesTaxRouter], ['/api/v1/reports', salesTaxReportsRouter], ['/api/v1/invoices', invoicesRouter],
    ['/api/v1/sales-receipts', salesReceiptsRouter]]);
  c = await h.company();
  clients.clear(); codes.clear();
  await seed();
});
afterEach(async () => { await h.stop(); });

const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.request(method, p, c.token, body, method === 'GET' ? headers : { 'Idempotency-Key': key(), ...headers });
const ok = (r: { status: number; json: Body }, status = 201) => { expect(r.status, JSON.stringify(r.json)).toBe(status); return r.json; };

async function seed() {
  const [v] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Sample State Revenue Dept.' }).returning();
  const agency = ok(await req('POST', '/api/v1/sales-tax/agencies', { vendorId: v!.id }))['id'];
  const spr = ok(await req('POST', '/api/v1/sales-tax/items', { name: 'Springfield', rate: '0.088750', agencyId: agency }))['id'];
  for (const cd of ok(await req('GET', '/api/v1/sales-tax/codes'), 200)['data'] as Body[]) codes.set(cd['code'], cd['id']);
  codes.set('Res', ok(await req('POST', '/api/v1/sales-tax/codes', { code: 'Res', name: 'Resale', taxable: false }))['id']);
  const [it] = await db.insert(items).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Plants', incomeAccountId: c.roles['income']!, isTaxable: true }).returning();
  plants = it!.id;
  for (const cl of monett['clients'] as Body[]) {
    const [row] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: cl['name'],
      defaultSalesTaxId: cl['salesTax'] ? spr : null, taxCodeId: cl['taxCode'] ? codes.get(cl['taxCode']) : null }).returning();
    clients.set(cl['name'], row!.id);
  }
  await db.update(companies).set({ defaultSalesTaxId: spr }).where(eq(companies.id, c.companyId));
}

describe('golden 10: exemption certificates', () => {
  it('warns on previews and lists expiring certificates', async () => {
    for (const s of g10.filter((x) => x['op'] === 'exemption')) {
      const r = s['request'];
      ok(await req('POST', '/api/v1/sales-tax/exemptions', { contactId: clients.get(r['client']), number: r['number'], state: r['state'], expiresOn: r['expiresOn'] }));
    }
    for (const s of g10.filter((x) => x['op'] === 'invoicePreview')) {
      const r = s['request'];
      const pv = ok(await req('POST', '/api/v1/invoices/preview', {
        contactId: clients.get(r['client']), txnDate: r['date'], lines: (r['lines'] as Body[]).map((l) => ({ itemId: plants, quantity: l['quantity'], unitPrice: l['unitPrice'] })),
      }), 200);
      expect([r['client'], pv['warnings'].map((w: Body) => w['code'])]).toEqual([r['client'], s['expect']['warnings']]);
    }
    const sr = ok(await req('POST', '/api/v1/sales-receipts/preview', {
      contactId: clients.get('Briar Creek Co-op'), txnDate: '2026-11-20', depositToAccountId: c.roles['payments_clearing'], lines: [{ itemId: plants, quantity: '1', unitPrice: '10.00' }],
    }), 200);
    expect(sr['warnings'].map((w: Body) => w['code'])).toEqual(['EXEMPTION_MISSING']);
    const exp = g10.find((x) => x['op'] === 'exemptionsExpiring')!;
    const rep = ok(await req('GET', `/api/v1/reports/exemptions-expiring?asOf=${exp['request']['asOf']}&within=${exp['request']['within']}`), 200);
    expect(rep['data'].map((d: Body) => d['contactName']).sort()).toEqual([...exp['expect']['clients']].sort());
    expect(Object.fromEntries(rep['data'].map((d: Body) => [d['contactName'], d['status']]))).toEqual({ 'Cedar Hollow Supply': 'expired', 'Pine Bluff Nursery': 'expiring' });
    // No certificate numbers in the audit trail.
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'tax_exemption')));
    expect(audit.length).toBe(2);
    expect(JSON.stringify(audit)).not.toContain('RS-100');
  });
});

describe('exemption certificate rules', () => {
  it('validation, attachment scope, edit with STALE, deactivate, another company 404', async () => {
    const cedar = clients.get('Cedar Hollow Supply')!;
    const long = await req('POST', '/api/v1/sales-tax/exemptions', { contactId: cedar, number: 'x'.repeat(51) });
    expect(long.status).toBe(400);
    const [vendor] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'V' }).returning();
    expect((await req('POST', '/api/v1/sales-tax/exemptions', { contactId: vendor!.id, number: 'A1' })).status).toBe(400);
    const [onOther] = await db.insert(attachments).values({ tenantId: c.tenantId, companyId: c.companyId, fileName: 'c.pdf', filePath: 'x/c.pdf',
      attachableType: 'contact', attachableId: clients.get('Pine Bluff Nursery')! }).returning();
    const bad = await req('POST', '/api/v1/sales-tax/exemptions', { contactId: cedar, number: 'A1', attachmentId: onOther!.id });
    expect([bad.status, bad.json['error']?.code]).toEqual([400, 'VALIDATION_ERROR']);
    const [mine] = await db.insert(attachments).values({ tenantId: c.tenantId, companyId: c.companyId, fileName: 'c.pdf', filePath: 'x/d.pdf',
      attachableType: 'contact', attachableId: cedar }).returning();
    const e = ok(await req('POST', '/api/v1/sales-tax/exemptions', { contactId: cedar, number: 'A1', state: 'MO', expiresOn: '2027-06-30', attachmentId: mine!.id }));
    const stale = await req('PUT', `/api/v1/sales-tax/exemptions/${e['id']}`, { expiresOn: '2027-12-31', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect([stale.status, stale.json['error']?.code]).toEqual([409, 'STALE']);
    const upd = ok(await req('PUT', `/api/v1/sales-tax/exemptions/${e['id']}`, { expiresOn: '2027-12-31', expectedUpdatedAt: e['updatedAt'] }), 200);
    expect(upd['expiresOn']).toBe('2027-12-31');
    const off = ok(await req('POST', `/api/v1/sales-tax/exemptions/${e['id']}/deactivate`, {}), 200);
    expect(off['isActive']).toBe(false);
    expect(ok(await req('GET', `/api/v1/sales-tax/exemptions?contactId=${cedar}`), 200)['data']).toEqual([]);
    expect(ok(await req('GET', `/api/v1/sales-tax/exemptions?contactId=${cedar}&includeInactive=true`), 200)['data'].length).toBe(1);
    const other = await h.secondCompany(c);
    expect((await h.request('GET', `/api/v1/sales-tax/exemptions/${e['id']}`, c.token, undefined, other)).status).toBe(404);
  });

  it('advertises tax-exemptions-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('tax-exemptions-v1');
  });
});
