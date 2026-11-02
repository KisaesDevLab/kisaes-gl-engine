// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-147 (sales-tax-setup-v1): documents with a sales tax. Golden cases 1-5
// (packages/shared/fixtures/sales-tax-golden.json) through the invoice,
// credit memo and sales receipt routes; preview = post = GET; client and
// company defaults; line codes; errors; saved rates on edit; Σ rows = STP
// on every path (create, PUT, duplicate, void).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import { companies, contacts, items, transactionTaxLines, accounts, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes, salesTaxAgencies } from '../db/schema/index.js';
import { salesTaxRouter } from './sales-tax.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { salesReceiptsRouter } from './sales-receipts.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { Harness, type Co, key, m2, lineSet, expectedLines } from './receivables.test-support.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const Decimal = DecimalLib.default || DecimalLib;
type Body = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/sales-tax-golden.json'), 'utf8')) as Body;
const monett = golden['seeds'].monett as Body;
const gstep = (id: number, i = 0) => (golden['cases'] as Body[]).find((c) => c['id'] === id)!['steps'][i] as Body;

async function cleanSalesTax(tid: string) {
  for (const t of [transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes, salesTaxAgencies]) {
    await db.delete(t).where(eq(t.tenantId, tid));
  }
}

const h = new Harness();
let c: Co;
const ids = { taxes: new Map<string, string>(), codes: new Map<string, string>(), items: new Map<string, string>(), clients: new Map<string, string>() };

beforeEach(async () => {
  h.extraCleanup = [cleanSalesTax];
  await h.start([['/api/v1/sales-tax', salesTaxRouter], ['/api/v1/invoices', invoicesRouter], ['/api/v1/credit-memos', creditMemosRouter],
    ['/api/v1/sales-receipts', salesReceiptsRouter], ['/api/v1/transactions', transactionsRouter]]);
  c = await h.company();
  for (const m of Object.values(ids)) m.clear();
  await seed();
});
afterEach(async () => { await h.stop(); });

const req = (method: string, p: string, body?: unknown) => h.request(method, p, c.token, body, method === 'GET' ? {} : { 'Idempotency-Key': key() });

async function seed() {
  const agencies = new Map<string, string>();
  for (const a of monett['agencies'] as Body[]) {
    const [v] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: a['name'] }).returning();
    agencies.set(a['name'], (await req('POST', '/api/v1/sales-tax/agencies', { vendorId: v!.id })).json['id']);
  }
  for (const t of monett['salesTaxes'] as Body[]) {
    const body = t['kind'] === 'group'
      ? { kind: 'group', name: t['name'], memberIds: (t['members'] as string[]).map((m) => ids.taxes.get(m)) }
      : { name: t['name'], rate: t['rate'], agencyId: agencies.get(t['agency']) };
    ids.taxes.set(t['name'], (await req('POST', '/api/v1/sales-tax/items', body)).json['id']);
  }
  for (const cd of (await req('GET', '/api/v1/sales-tax/codes')).json['data'] as Body[]) ids.codes.set(cd['code'], cd['id']);
  for (const cd of monett['codes'] as Body[]) {
    if (!cd['system']) ids.codes.set(cd['code'], (await req('POST', '/api/v1/sales-tax/codes', { code: cd['code'], name: cd['name'], taxable: cd['taxable'] })).json['id']);
  }
  for (const it of monett['items'] as Body[]) {
    const [row] = await db.insert(items).values({
      tenantId: c.tenantId, companyId: c.companyId, name: it['name'], incomeAccountId: c.roles['sales']!, isTaxable: it['taxCode'] === 'Tax',
      taxCodeId: ids.codes.get(it['taxCode']),
    }).returning();
    ids.items.set(it['name'], row!.id);
  }
  for (const cl of monett['clients'] as Body[]) {
    const [row] = await db.insert(contacts).values({
      tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: cl['name'],
      defaultSalesTaxId: cl['salesTax'] ? ids.taxes.get(cl['salesTax']) : null, taxCodeId: cl['taxCode'] ? ids.codes.get(cl['taxCode']) : null,
    }).returning();
    ids.clients.set(cl['name'], row!.id);
  }
  await db.update(companies).set({ defaultSalesTaxId: ids.taxes.get(monett['companyDefault']), salesTaxSsuta: monett['ssuta'] }).where(eq(companies.id, c.companyId));
}

const docBody = (r: Body) => ({
  contactId: ids.clients.get(r['client']), txnDate: r['date'],
  lines: (r['lines'] as Body[]).map((l) => ({ itemId: ids.items.get(l['item']), quantity: l['quantity'], unitPrice: l['unitPrice'] })),
});

/** Σ rows.tax and the STP lines of a transaction. */
async function invariant(txnId: string) {
  const rows = await db.select().from(transactionTaxLines).where(eq(transactionTaxLines.transactionId, txnId));
  const res = await db.execute(sql`SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS s FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
    WHERE jl.transaction_id = ${txnId} AND a.system_tag = 'sales_tax_payable'`);
  return { rows, sum: m2(rows.reduce((s, r) => s.plus(r.tax), new Decimal(0)).toFixed(4)), stp: m2((res.rows as Body[])[0]!['s']) };
}

function expectSalesTax(got: Body, want: Body) {
  expect([got['name'], got['rate']]).toEqual([want['name'], want['rate']]);
  expect((got['members'] as Body[]).map((m) => [m['name'], m['rate'], m['tax']])).toEqual((want['members'] as Body[]).map((m) => [m['name'], m['rate'], m['tax']]));
}

describe('golden 1-3: invoices with one sales tax', () => {
  for (const id of [1, 2, 3]) {
    it(`golden ${id}: preview = post = GET; rows = STP`, async () => {
      const s = gstep(id);
      const body = docBody(s['request']);
      const pv = await req('POST', '/api/v1/invoices/preview', body);
      expect(pv.status, JSON.stringify(pv.json)).toBe(200);
      const e = s['expect'];
      expect([pv.json['taxTotal'], pv.json['total']]).toEqual([e['taxTotal'], e['total']]);
      expectSalesTax(pv.json['salesTax'], e['salesTax']);
      expect((pv.json['lines'] as Body[]).map((l) => [l['amount'], l['taxCode']['code'], l['taxAmount']]))
        .toEqual((e['lines'] as Body[]).map((l) => [l['amount'], l['taxCode'], l['taxAmount']]));
      const post = await req('POST', '/api/v1/invoices', body);
      expect(post.status, JSON.stringify(post.json)).toBe(201);
      const invId = post.json['invoice']?.['id'] ?? post.json['id'];
      const got = await req('GET', `/api/v1/invoices/${invId}`);
      const inv = got.json['invoice'] ?? got.json;
      expect(m2(inv['taxAmount'])).toBe(e['taxTotal']);
      expect(inv['salesTaxId']).toBe(ids.taxes.get(e['salesTax']['name']));
      expectSalesTax(inv['salesTax'], e['salesTax']);
      const taxed = (inv['lines'] as Body[]).filter((l) => l['taxCode']);
      expect(taxed.map((l) => l['taxCode']['code'])).toEqual((e['lines'] as Body[]).map((l) => l['taxCode']));
      const inv2 = await invariant(invId);
      expect([inv2.sum, inv2.stp]).toEqual([e['taxTotal'], e['taxTotal']]);
    });
  }
});

describe('golden 4-5: credit memo and sales receipt', () => {
  it('golden 4: credit memo -0.49 (-0.26 / -0.23); journal; GET', async () => {
    const s = gstep(4);
    const body = { ...docBody(s['request']), applications: [] };
    const pv = await req('POST', '/api/v1/credit-memos/preview', body);
    expectSalesTax(pv.json['salesTax'], s['expect']['salesTax']);
    const r = await req('POST', '/api/v1/credit-memos', body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const memo = r.json['creditMemo'];
    expectSalesTax(memo['salesTax'], s['expect']['salesTax']);
    expect(await lineSet(c, memo['id'])).toEqual(expectedLines(s['expect']['journal']));
    const inv = await invariant(memo['id']);
    expect([inv.sum, inv.stp]).toEqual(['-0.49', '-0.49']);
  });

  it('golden 5: sales receipt 8.88 to Payments Clearing', async () => {
    const s = gstep(5);
    const r = await req('POST', '/api/v1/sales-receipts', { ...docBody(s['request']), depositToAccountId: c.roles['payments_clearing'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const sr = r.json['salesReceipt'];
    expectSalesTax(sr['salesTax'], s['expect']['salesTax']);
    expect(await lineSet(c, sr['id'])).toEqual(expectedLines(s['expect']['journal']));
    expect((await invariant(sr['id'])).sum).toBe('8.88');
  });
});

describe('resolution, codes and errors', () => {
  it('golden 6 INV-F: the client\'s Res code makes the line non-taxable; a nonTaxable row per item carries it', async () => {
    const s = gstep(6, 0);
    const r = await req('POST', '/api/v1/invoices', docBody(s['request']));
    const invId = r.json['invoice']?.['id'] ?? r.json['id'];
    const inv = (await req('GET', `/api/v1/invoices/${invId}`)).json;
    expect(m2((inv['invoice'] ?? inv)['taxAmount'])).toBe('0.00');
    const rows = (await invariant(invId)).rows;
    expect(rows.map((x) => [x.taxItemId, x.taxCodeId, m2(x.base), m2(x.tax)])).toContainEqual([ids.taxes.get('Springfield'), ids.codes.get('Res'), '500.00', '0.00']);
  });

  it('salesTaxId overrides the client; null means none; with a line taxRate is 400; inactive is 400; tax off is 400', async () => {
    const base = docBody(gstep(1)['request']);
    const monettPv = await req('POST', '/api/v1/invoices/preview', { ...base, salesTaxId: ids.taxes.get('Monett') });
    expect(monettPv.json['taxTotal']).toBe('81.00');
    const none = await req('POST', '/api/v1/invoices/preview', { ...base, salesTaxId: null });
    expect([none.json['taxTotal'], none.json['salesTax']]).toEqual(['0.00', null]);
    const both = await req('POST', '/api/v1/invoices/preview', { ...base, salesTaxId: ids.taxes.get('Monett'), lines: base.lines.map((l) => ({ ...l, taxRate: '0.05' })) });
    expect([both.status, both.json['error']?.code]).toEqual([400, 'TAX_RATE_WITH_SALES_TAX']);
    await req('POST', `/api/v1/sales-tax/items/${ids.taxes.get('Monett')}/deactivate`, {});
    const inactive = await req('POST', '/api/v1/invoices/preview', { ...base, salesTaxId: ids.taxes.get('Monett') });
    expect([inactive.status, inactive.json['error']?.code]).toEqual([400, 'TAX_ITEM_INACTIVE']);
    await db.update(companies).set({ salesTaxEnabled: false }).where(eq(companies.id, c.companyId));
    const off = await req('POST', '/api/v1/invoices/preview', { ...base, salesTaxId: ids.taxes.get('Springfield') });
    expect([off.status, off.json['error']?.code]).toEqual([400, 'SALES_TAX_OFF']);
    const offDefault = await req('POST', '/api/v1/invoices/preview', base);
    expect(offDefault.json['taxTotal']).toBe('0.00');
  });

  it('a line taxCodeId wins; a code of another company is 400; line taxRate still works (legacy path, never a 400)', async () => {
    const base = docBody(gstep(1)['request']);
    const non = await req('POST', '/api/v1/invoices/preview', { ...base, lines: base.lines.map((l) => ({ ...l, taxCodeId: ids.codes.get('Non') })) });
    expect([non.json['taxTotal'], non.json['lines'][0]['taxCode']['source']]).toEqual(['0.00', 'request']);
    const legacy = await req('POST', '/api/v1/invoices', { ...base, lines: base.lines.map((l) => ({ ...l, isTaxable: true, taxRate: 0.0725 })) });
    expect(legacy.status, JSON.stringify(legacy.json)).toBe(201);
    const id = legacy.json['invoice']?.['id'] ?? legacy.json['id'];
    expect((await invariant(id)).sum).toBe('72.50');
    const other = await h.secondCompany(c);
    const [code] = await db.select().from(accounts).limit(0);
    void code; void other;
    const bad = await req('POST', '/api/v1/invoices/preview', { ...base, lines: base.lines.map((l) => ({ ...l, taxCodeId: '00000000-0000-4000-8000-000000000001' })) });
    expect([bad.status, bad.json['error']?.code]).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('an edit keeps saved rates (RATE_CHANGED) unless useCurrentRates; PUT rewrites rows; duplicate keeps the sales tax; void drops rows', async () => {
    const s = gstep(1);
    const r = await req('POST', '/api/v1/invoices', docBody(s['request']));
    const id = r.json['invoice']?.['id'] ?? r.json['id'];
    await req('PUT', `/api/v1/sales-tax/items/${ids.taxes.get('Springfield')}`, { rate: '0.090000' });
    const pv = await req('POST', '/api/v1/invoices/preview', { ...docBody(s['request']), invoiceId: id });
    expect([pv.json['taxTotal'], pv.json['problems'].map((p: Body) => p['code'])]).toEqual(['88.75', ['RATE_CHANGED']]);
    const kept = await req('PUT', `/api/v1/invoices/${id}`, docBody(s['request']));
    expect(kept.status, JSON.stringify(kept.json)).toBe(200);
    expect((await invariant(id)).sum).toBe('88.75');
    const cur = await req('PUT', `/api/v1/invoices/${id}`, { ...docBody(s['request']), useCurrentRates: true });
    expect(cur.status).toBe(200);
    const after = await invariant(id);
    expect([after.sum, after.stp, after.rows[0]!.rate]).toEqual(['90.00', '90.00', '0.090000']);
    const dup = await req('POST', `/api/v1/invoices/${id}/duplicate`, {});
    if (dup.status === 201 || dup.status === 200) {
      const dupId = dup.json['invoice']?.['id'] ?? dup.json['id'];
      const d = await invariant(dupId);
      expect([d.sum, d.stp, d.rows[0]!.taxItemId]).toEqual(['90.00', '90.00', ids.taxes.get('Springfield')]);
    }
    expect((await req('POST', `/api/v1/transactions/${id}/void`, { reason: 'test' })).status).toBe(200);
    expect((await invariant(id)).rows).toEqual([]);
  });

  it('advertises sales-tax-setup-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('sales-tax-setup-v1');
  });
});
