// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-147 / U-148 / U-25 (sales-tax-rate6-v1, company-sales-tax-flags-v1,
// idempotency-sales-tax-v1): setup CRUD for agencies, items, groups and codes
// with the golden seed (packages/shared/fixtures/sales-tax-golden.json), the
// company flags, 6-place rates, golden cases 1-3 (compute) and 11 (backfill
// and legacy rates), the Σ rows = STP invariant and scope.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import {
  companies, contacts, items, journalLines, transactions, salesTaxAgencies, salesTaxCodes, salesTaxGroupMembers, salesTaxItems,
  transactionTaxLines, salesTaxPaymentLines, accounts,
} from '../db/schema/index.js';
import { salesTaxRouter } from './sales-tax.routes.js';
import { companyRouter } from './company.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import * as ledger from '../services/ledger.service.js';
import { Harness, type Co, key, m2 } from './receivables.test-support.js';
import { computeSalesTotals, allocateCents, parseSalesTaxRate } from '../utils/sales-compute.js';
import * as invoiceService from '../services/invoice.service.js';
import * as salesTax from '../services/sales-tax.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { DESKTOP_KEPT } from '../desktop/features.js';

const Decimal = DecimalLib.default || DecimalLib;
type Body = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/sales-tax-golden.json'), 'utf8')) as Body;
const monett = golden['seeds'].monett as Body;
const gcase = (id: number) => (golden['cases'] as Body[]).find((c) => c['id'] === id)!;

const h = new Harness();
let c: Co;

export async function cleanSalesTax(tid: string) {
  for (const t of [transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes, salesTaxAgencies]) {
    await db.delete(t).where(eq(t.tenantId, tid));
  }
}

beforeEach(async () => {
  h.extraCleanup = [cleanSalesTax];
  await h.start([['/api/v1/sales-tax', salesTaxRouter], ['/api/v1/company', companyRouter], ['/api/v1/transactions', transactionsRouter],
    ['/api/v1/invoices', invoicesRouter], ['/api/v1/credit-memos', creditMemosRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const post = (p: string, body: unknown, extra: Record<string, string> = {}) => h.request('POST', `/api/v1/sales-tax${p}`, c.token, body, { 'Idempotency-Key': key(), ...extra });
const put = (p: string, body: unknown) => h.request('PUT', `/api/v1/sales-tax${p}`, c.token, body, { 'Idempotency-Key': key() });
const get = (p: string, headers: Record<string, string> = {}) => h.request('GET', `/api/v1/sales-tax${p}`, c.token, undefined, headers);

async function vendor(name: string) {
  const [v] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: name }).returning();
  return v!.id;
}

/** The golden monett setup through the routes: agencies, items, the group, the Res code. */
async function seedSetup() {
  const agencies = new Map<string, string>();
  for (const a of monett['agencies'] as Body[]) {
    const r = await post('/agencies', { vendorId: await vendor(a['name']) });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    agencies.set(a['name'], r.json['id']);
  }
  const taxes = new Map<string, Body>();
  for (const t of monett['salesTaxes'] as Body[]) {
    const body = t['kind'] === 'group'
      ? { kind: 'group', name: t['name'], memberIds: (t['members'] as string[]).map((m) => taxes.get(m)!['id']) }
      : { kind: 'item', name: t['name'], rate: t['rate'], agencyId: agencies.get(t['agency']) };
    const r = await post('/items', body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    taxes.set(t['name'], r.json);
  }
  const codes = new Map<string, string>();
  for (const cd of monett['codes'] as Body[]) {
    if (cd['system']) continue;
    const r = await post('/codes', { code: cd['code'], name: cd['name'], taxable: cd['taxable'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    codes.set(cd['code'], r.json['id']);
  }
  return { agencies, taxes, codes };
}

describe('U-147 sales tax setup', () => {
  it('builds the golden setup: items, the Monett group (rate = sum of members), codes with Tax/Non system codes', async () => {
    const { taxes } = await seedSetup();
    expect(taxes.get('Springfield')!['rate']).toBe('0.088750');
    const g = taxes.get('Monett')!;
    expect([g['kind'], g['rate'], g['agencyId']]).toEqual(['group', '0.081000', null]);
    expect((g['members'] as Body[]).map((m) => [m['name'], m['rate']])).toEqual([['State', '0.042250'], ['City', '0.038750']]);
    const list = await get('/items');
    expect((list.json['data'] as Body[]).map((i) => i['name'])).toEqual(['City', 'Springfield', 'State', 'Monett']);
    expect((list.json['data'] as Body[]).find((i) => i['name'] === 'State')!['inUse']).toBe(true);
    expect((list.json['data'] as Body[]).find((i) => i['name'] === 'Springfield')!['agencyName']).toBe('Sample State Revenue Dept.');
    const codes = await get('/codes');
    expect((codes.json['data'] as Body[]).map((x) => [x['code'], x['taxable'], x['isSystem']]))
      .toEqual([['Non', false, true], ['Tax', true, true], ['Res', false, false]]);
  });

  it('refuses bad setup: AGENCY_EXISTS, AGENCY_REQUIRED, NAME_IN_USE (any case), GROUP_SIZE, GROUP_MEMBER_NOT_ITEM, non-vendor agencies', async () => {
    const { agencies, taxes } = await seedSetup();
    const vendorId = (await get(`/agencies/${agencies.get('Sample City Revenue Office')}`)).json['vendorId'];
    const err = (r: { status: number; json: Body }) => [r.status, r.json['error']?.code];
    expect(err(await post('/agencies', { vendorId }))).toEqual([409, 'AGENCY_EXISTS']);
    expect(err(await post('/agencies', { vendorId: c.customer }))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', { name: 'County', rate: '0.010000' }))).toEqual([400, 'AGENCY_REQUIRED']);
    expect(err(await post('/items', { name: 'state', rate: '0.010000', agencyId: agencies.get('Sample City Revenue Office') }))).toEqual([409, 'NAME_IN_USE']);
    expect(err(await post('/items', { kind: 'group', name: 'Empty', memberIds: [] }))).toEqual([400, 'GROUP_SIZE']);
    expect(err(await post('/items', { kind: 'group', name: 'Nested', memberIds: [taxes.get('Monett')!['id']] }))).toEqual([400, 'GROUP_MEMBER_NOT_ITEM']);
    const eleven = Array.from({ length: 11 }, () => taxes.get('State')!['id']);
    expect(err(await post('/items', { kind: 'group', name: 'Big', memberIds: eleven }))).toEqual([400, 'GROUP_SIZE']);
  });

  it('setup rates are strict 6-place strings, 0 <= r < 1 (U-148)', async () => {
    const { agencies } = await seedSetup();
    const agencyId = agencies.get('Sample City Revenue Office');
    for (const rate of [0.05, '0.0500001', '1', '1.000000', '-0.01', '5%']) {
      const r = await post('/items', { name: `R${String(rate)}`, rate, agencyId });
      expect([String(rate), r.status, r.json['error']?.code]).toEqual([String(rate), 400, 'VALIDATION_ERROR']);
    }
    const ok = await post('/items', { name: 'Tiny', rate: '0.000001', agencyId });
    expect([ok.status, ok.json['rate']]).toEqual([201, '0.000001']);
  });

  it('deactivate rules: ITEM_IN_GROUP, AGENCY_IN_USE, SYSTEM_CODE; reactivate; STALE on an old expectedUpdatedAt', async () => {
    const { agencies, taxes, codes } = await seedSetup();
    const state = taxes.get('State')!;
    const r1 = await post(`/items/${state['id']}/deactivate`, {});
    expect([r1.status, r1.json['error']?.code, r1.json['error']?.details?.groups]).toEqual([409, 'ITEM_IN_GROUP', ['Monett']]);
    expect((await post(`/items/${taxes.get('Monett')!['id']}/deactivate`, {})).status).toBe(200);
    expect((await post(`/items/${state['id']}/deactivate`, {})).json['isActive']).toBe(false);
    const g = await post(`/items/${taxes.get('Monett')!['id']}/reactivate`, {});
    expect([g.status, g.json['error']?.code]).toEqual([400, 'GROUP_MEMBER_NOT_ITEM']);
    const a = await post(`/agencies/${agencies.get('Sample State Revenue Dept.')}/deactivate`, {});
    expect([a.status, a.json['error']?.code]).toEqual([409, 'AGENCY_IN_USE']);
    const sys = (await get('/codes')).json['data'].find((x: Body) => x['code'] === 'Tax');
    const s = await post(`/codes/${sys['id']}/deactivate`, {});
    expect([s.status, s.json['error']?.code]).toEqual([409, 'SYSTEM_CODE']);
    const s2 = await put(`/codes/${sys['id']}`, { taxable: false });
    expect([s2.status, s2.json['error']?.code]).toEqual([409, 'SYSTEM_CODE']);
    expect((await put(`/codes/${sys['id']}`, { name: 'Taxable sale' })).json['name']).toBe('Taxable sale');
    const dup = await post('/codes', { code: 'res', name: 'Again', taxable: false });
    expect([dup.status, dup.json['error']?.code]).toEqual([409, 'CODE_IN_USE']);
    const res = (await get(`/codes/${codes.get('Res')}`)).json;
    expect((await put(`/codes/${res['id']}`, { name: 'Resale cert', expectedUpdatedAt: res['updatedAt'] })).status).toBe(200);
    const st = await put(`/codes/${res['id']}`, { name: 'Again', expectedUpdatedAt: res['updatedAt'] });
    expect([st.status, st.json['error']?.code]).toEqual([409, 'STALE']);
  });

  it('an agency change keeps the item; a legacy item can get an agency but its rate never changes', async () => {
    const { agencies } = await seedSetup();
    const legacy = await salesTax.legacyItemFor(db, c.tenantId, c.companyId, '0.0825');
    expect([legacy.name, legacy.legacyRate]).toEqual(['Sales tax 8.25%', '0.082500']);
    const r = await put(`/items/${legacy.id}`, { agencyId: agencies.get('Sample State Revenue Dept.') });
    expect([r.status, r.json['agencyName'], r.json['legacyRate']]).toEqual([200, 'Sample State Revenue Dept.', '0.082500']);
    const bad = await put(`/items/${legacy.id}`, { rate: '0.090000' });
    expect([bad.status, bad.json['error']?.code]).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('Idempotency-Key replays the same record; another company\'s id is 404; a role without sales_tax is 403', async () => {
    const { taxes } = await seedSetup();
    const k = key();
    const agencyId = (await get('/agencies')).json['data'][0]['id'];
    const a = await post('/items', { name: 'County', rate: '0.005000', agencyId }, { 'Idempotency-Key': k });
    const b = await post('/items', { name: 'County', rate: '0.005000', agencyId }, { 'Idempotency-Key': k });
    expect([a.status, b.status, b.json['id']]).toEqual([201, 201, a.json['id']]);
    const other = await h.secondCompany(c);
    expect((await get(`/items/${taxes.get('State')!['id']}`, other)).status).toBe(404);
    expect((await get('/items', other)).json['data']).toEqual([]);
    const token = await h.staffToken(c, { invoices: 'full' });
    expect((await h.request('GET', '/api/v1/sales-tax/items', token)).status).toBe(403);
    const viewer = await h.staffToken(c, { sales_tax: 'view' });
    expect((await h.request('GET', '/api/v1/sales-tax/items', viewer)).status).toBe(200);
    expect((await h.request('POST', '/api/v1/sales-tax/codes', viewer, { code: 'X', name: 'X', taxable: false })).status).toBe(403);
  });

  it('is in the desktop profile and advertises its capabilities', () => {
    expect(DESKTOP_KEPT).toContain('/api/v1/sales-tax');
    for (const cap of ['sales-tax-rate6-v1', 'company-sales-tax-flags-v1', 'idempotency-sales-tax-v1']) expect(DESKTOP_CAPABILITIES).toContain(cap);
  });
});

describe('U-25 company sales tax flags', () => {
  it('defaults: tax on, accrual, no default, SSUTA off (Q-SPF6); PUT sets them; defaultSalesTaxId sets the combined rate', async () => {
    const { taxes } = await seedSetup();
    const g = await h.request('GET', '/api/v1/company/settings', c.token);
    expect(g.json['settings']).toMatchObject({ salesTaxEnabled: true, salesTaxBasis: 'accrual', defaultSalesTaxId: null, salesTaxSsuta: false, defaultSalesTaxRate: '0.000000' });
    const p = await h.request('PUT', '/api/v1/company/settings', c.token, {
      salesTaxEnabled: true, salesTaxBasis: 'cash', defaultSalesTaxId: taxes.get('Monett')!['id'], salesTaxSsuta: true,
    });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json['settings']).toMatchObject({ salesTaxBasis: 'cash', defaultSalesTaxId: taxes.get('Monett')!['id'], salesTaxSsuta: true, defaultSalesTaxRate: '0.081000' });
    const bad = await h.request('PUT', '/api/v1/company/settings', c.token, { salesTaxBasis: 'modified' });
    expect(bad.status).toBe(400);
    await post(`/items/${taxes.get('Monett')!['id']}/deactivate`, {});
    const inactive = await h.request('PUT', '/api/v1/company/settings', c.token, { defaultSalesTaxId: taxes.get('Monett')!['id'] });
    expect([inactive.status, inactive.json['error']?.code]).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('a MyBooks Online rate PUT moves the default to the legacy item for it (S5); 0 clears it; long decimals round to 6 places', async () => {
    const p = await h.request('PUT', '/api/v1/company/settings', c.token, { defaultSalesTaxRate: '0.0725' });
    expect(p.json['settings']['defaultSalesTaxRate']).toBe('0.072500');
    const item = await salesTax.legacyItemFor(db, c.tenantId, c.companyId, '0.0725');
    expect([p.json['settings']['defaultSalesTaxId'], item.name]).toEqual([item.id, 'Sales tax 7.25%']);
    const q = await h.request('PUT', '/api/v1/company/settings', c.token, { defaultSalesTaxRate: '0.011000000000000001' });
    expect(q.json['settings']['defaultSalesTaxRate']).toBe('0.011000');
    const z = await h.request('PUT', '/api/v1/company/settings', c.token, { defaultSalesTaxRate: '0' });
    expect(z.json['settings']['defaultSalesTaxId']).toBeNull();
  });
});

describe('golden cases 1-3: document compute with one sales tax (Q-P23d)', () => {
  const unit = (name: string) => {
    const t = (monett['salesTaxes'] as Body[]).find((x) => x['name'] === name)!;
    const members = t['kind'] === 'group'
      ? (t['members'] as string[]).map((m) => (monett['salesTaxes'] as Body[]).find((x) => x['name'] === m)!)
      : [t];
    return { id: name, members: members.map((m) => ({ itemId: m['name'], rate: m['rate'] })) };
  };
  const itemTaxable = (item: string) => (monett['items'] as Body[]).find((i) => i['name'] === item)!['taxCode'] === 'Tax';

  for (const id of [1, 2, 3]) {
    it(`golden ${id}: ${gcase(id)['name']}`, () => {
      const step = gcase(id)['steps'][0] as Body;
      const client = (monett['clients'] as Body[]).find((x) => x['name'] === step['request']['client'])!;
      const tax = unit(client['salesTax'] ?? monett['companyDefault']);
      const lines = (step['request']['lines'] as Body[]).map((l) => ({
        amount: new Decimal(l['quantity']).times(l['unitPrice']).toFixed(2), isTaxable: itemTaxable(l['item']),
      }));
      const r = computeSalesTotals(lines, '0', tax);
      const e = step['expect'];
      expect(r.taxTotal).toBe(e['taxTotal']);
      expect(r.total).toBe(e['total']);
      expect(r.taxableBase).toBe(e['taxableBase']);
      expect(r.lines.map((l) => l.taxAmount)).toEqual((e['lines'] as Body[]).map((l) => l['taxAmount']));
      expect(r.salesTaxMembers!.map((m) => [m.itemId, m.rate, m.tax])).toEqual((e['salesTax']['members'] as Body[]).map((m) => [m['name'], m['rate'], m['tax']]));
      expect(r.lines.find((l) => l.isTaxable)!.taxRate).toBe(e['salesTax']['rate']);
    });
  }

  it('a floored negative base taxes 0.00 on every member without allocating (S3); a return reverses tax', () => {
    const tax = unit('Monett');
    const floored = computeSalesTotals([{ amount: '10.00', isTaxable: false }, { amount: '-5.00', isTaxable: true }], '0', tax);
    expect([floored.taxTotal, floored.salesTaxMembers!.map((m) => m.tax)]).toEqual(['0.00', ['0.00', '0.00']]);
    const ret = computeSalesTotals([{ amount: '-6.00', isTaxable: true }], '0', tax);
    expect([ret.taxTotal, ret.salesTaxMembers!.map((m) => m.tax)]).toEqual(['-0.49', ['-0.26', '-0.23']]);
  });

  it('allocation property: members and lines always sum to the document tax', () => {
    const tax = unit('Monett');
    for (let n = 1; n <= 200; n++) {
      const a = new Decimal(n).times('7.13').toFixed(2);
      const b = new Decimal(n).times('0.37').toFixed(2);
      const r = computeSalesTotals([{ amount: a, isTaxable: true }, { amount: b, isTaxable: true }, { amount: '1.00', isTaxable: false }], '0', tax);
      const sum = (xs: string[]) => xs.reduce((s, x) => s.plus(x), new Decimal(0)).toFixed(2);
      expect(sum(r.lines.map((l) => l.taxAmount))).toBe(r.taxTotal);
      expect(sum(r.salesTaxMembers!.map((m) => m.tax))).toBe(r.taxTotal);
    }
    expect(allocateCents([new Decimal('0.2535'), new Decimal('0.2325')], new Decimal('0.49')).map((x) => x.toFixed(2))).toEqual(['0.26', '0.23']);
  });
});

/** Σ rows.tax and the transaction's STP lines (credit - debit), as 2-place strings. */
async function rowsAndStp(txnId: string) {
  const rows = await db.select().from(transactionTaxLines).where(eq(transactionTaxLines.transactionId, txnId));
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(jl.credit - jl.debit), 0)::text AS s FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
    WHERE jl.transaction_id = ${txnId} AND a.system_tag = 'sales_tax_payable'`);
  return { rows, sum: m2(rows.reduce((s, r) => s.plus(r.tax), new Decimal(0)).toFixed(4)), stp: m2((res.rows as Body[])[0]!['s']) };
}

async function legacyInvoice(lines: Array<{ amount: string; taxRate: unknown }>, date: string) {
  const inv = await invoiceService.createInvoice(c.tenantId, {
    contactId: c.customer, txnDate: date,
    lines: lines.map((l) => ({ accountId: c.roles['sales'], description: 'Work', quantity: '1', unitPrice: l.amount, isTaxable: true, taxRate: l.taxRate })),
  } as never, c.userId, c.companyId);
  return inv.id;
}

describe('golden 11: backfill and legacy rates (engineOnly)', () => {
  const g = gcase(11);
  const stepOf = (op: string) => (g['steps'] as Body[]).find((s) => s['op'] === op)!;

  it('legacy line-rate documents write rows on a legacy item per rate; Σ rows = STP lines', async () => {
    const l1 = stepOf('legacyInvoice');
    const id = await legacyInvoice(l1['request']['lines'], l1['request']['date']);
    const { rows, sum, stp } = await rowsAndStp(id);
    expect([sum, stp]).toEqual([l1['expect']['taxTotal'], l1['expect']['taxTotal']]);
    const item = await salesTax.legacyItemFor(db, c.tenantId, c.companyId, '0.0825');
    expect(rows.map((r) => [r.taxItemId, r.kind, m2(r.base), m2(r.tax), r.rate])).toEqual([[item.id, 'sale', '300.00', '24.75', '0.082500']]);
  });

  it('B3: a JSON number rate 0.011000000000000001 is 0.011000, tax 1.10 on "Sales tax 1.1%"; never a 400', async () => {
    const l2 = (g['steps'] as Body[]).filter((s) => s['op'] === 'legacyInvoice')[1]!;
    const r = await h.request('POST', '/api/v1/invoices', c.token, {
      contactId: c.customer, txnDate: l2['request']['date'],
      lines: [{ accountId: c.roles['sales'], description: 'Work', quantity: '1', unitPrice: '100.00', isTaxable: true, taxRate: 0.011000000000000001 }],
    }, { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const invId = r.json['invoice']?.['id'] ?? r.json['id'];
    const [line] = await db.select().from(journalLines).where(and(eq(journalLines.transactionId, invId), eq(journalLines.isTaxable, true)));
    expect(new Decimal(line!.taxRate!).toFixed(6)).toBe(l2['expect']['lineTaxRate']);
    const { rows, sum } = await rowsAndStp(invId);
    expect(sum).toBe(l2['expect']['taxTotal']);
    const [item] = await db.select().from(salesTaxItems).where(eq(salesTaxItems.id, rows[0]!.taxItemId!));
    expect(item!.name).toBe(l2['expect']['item']);
    expect(parseSalesTaxRate(0.011000000000000001, 'x').toFixed(6)).toBe('0.011000');
  });

  it('concurrent posts at a new rate make one legacy item (ON CONFLICT)', async () => {
    const step = stepOf('concurrentLegacy');
    await Promise.all(Array.from({ length: step['request']['count'] }, () => legacyInvoice([{ amount: '10.00', taxRate: step['request']['rate'] }], '2026-11-06')));
    const found = await db.select().from(salesTaxItems).where(and(eq(salesTaxItems.companyId, c.companyId), eq(salesTaxItems.legacyRate, '0.072500')));
    expect(found.length).toBe(step['expect']['items']);
  });

  it('the 0252 backfill: legacy items, rows, opening paid = rows - STP balance (B2), the company default, an audit row', async () => {
    await db.update(companies).set({ defaultSalesTaxRate: golden['seeds'].legacy['defaultSalesTaxRate'] }).where(eq(companies.id, c.companyId));
    const l1 = stepOf('legacyInvoice');
    const inv = await legacyInvoice(l1['request']['lines'], l1['request']['date']);
    const stp = c.roles['sales_tax_payable']!;
    await ledger.postTransaction(c.tenantId, {
      txnType: 'expense', txnDate: stepOf('legacyCheck')['request']['date'],
      lines: [{ accountId: stp, debit: '24.75', credit: '0' }, { accountId: c.roles['checking'], debit: '0', credit: '24.75' }],
    } as never, c.userId, c.companyId);
    // As it was before 0252: no rows, no legacy items, no default.
    await cleanSalesTax(c.tenantId);
    await db.update(companies).set({ defaultSalesTaxId: null, salesTaxEnabled: null }).where(eq(companies.id, c.companyId));
    const r = await salesTax.backfillCompany(db, c.tenantId, c.companyId);
    const want = stepOf('backfill')['expect'];
    expect(r['openingPaid']).toBe(want['openingPaid']);
    const legacy = await db.select().from(salesTaxItems).where(eq(salesTaxItems.companyId, c.companyId));
    expect(legacy.map((i) => [i.name, i.legacyRate])).toEqual((want['legacyItems'] as Body[]).map((i) => [i['name'], i['rate']]));
    const { rows } = await rowsAndStp(inv);
    expect(rows.map((x) => [m2(x.base), m2(x.tax), x.taxItemId])).toEqual([['300.00', '24.75', legacy[0]!.id]]);
    const opening = await db.select().from(salesTaxPaymentLines).where(eq(salesTaxPaymentLines.companyId, c.companyId));
    expect(opening.map((o) => [o.kind, m2(o.amount), o.taxItemId, o.transactionId])).toEqual([['opening', '24.75', legacy[0]!.id, null]]);
    const [co] = await db.select().from(companies).where(eq(companies.id, c.companyId));
    expect([co!.defaultSalesTaxId, co!.salesTaxEnabled]).toEqual([legacy[0]!.id, want['salesTaxEnabled']]);
    // Owed = rows - opening = 0.00.
    const owed = rows.reduce((s, x) => s.plus(x.tax), new Decimal(0)).minus(opening.reduce((s, o) => s.plus(o.amount), new Decimal(0)));
    expect(owed.toFixed(2)).toBe(want['owed']);
    // Running it again changes nothing.
    expect((await salesTax.backfillCompany(db, c.tenantId, c.companyId))['skipped']).toBe(true);
  });

  it('an edit keeps the document\'s saved rate whatever the company default says now (S5)', async () => {
    const id = await legacyInvoice([{ amount: '300.00', taxRate: '0.0825' }], '2026-09-10');
    await h.request('PUT', '/api/v1/company/settings', c.token, { defaultSalesTaxRate: '0.0900' });
    const inv = await invoiceService.getInvoice(c.tenantId, id, c.companyId) as Body;
    await invoiceService.updateInvoice(c.tenantId, id, {
      contactId: c.customer, txnDate: '2026-09-10',
      lines: (inv['lines'] as Body[]).filter((l) => l['isTaxable']).map((l) => ({
        accountId: l['accountId'], description: l['description'], quantity: '1', unitPrice: '300.00', isTaxable: true, taxRate: l['taxRate'],
      })),
    } as never, c.userId, c.companyId);
    expect((await rowsAndStp(id)).sum).toBe('24.75');
  });
});

describe('the rows invariant (S3, missing test 5)', () => {
  it('invoice, credit memo and void: Σ rows = STP lines; a void drops the rows; a hand STP line is an unassigned row', async () => {
    const inv = await legacyInvoice([{ amount: '100.00', taxRate: '0.0825' }, { amount: '50.00', taxRate: '0.06' }], '2026-11-02');
    const a = await rowsAndStp(inv);
    expect([a.sum, a.stp, a.rows.length]).toEqual(['11.25', '11.25', 2]);
    const cm = await h.request('POST', '/api/v1/credit-memos', c.token, {
      txnDate: '2026-11-03', contactId: c.customer, applications: [],
      lines: [{ accountId: c.roles['sales'], description: 'Back', quantity: '1', unitPrice: '10.00', isTaxable: true, taxRate: '0.0825' }],
    }, { 'Idempotency-Key': key() });
    expect(cm.status, JSON.stringify(cm.json)).toBe(201);
    const memo = String(cm.json['creditMemo']?.['id'] ?? cm.json['id'] ?? cm.json['transaction']?.['id']);
    const m = await rowsAndStp(memo);
    expect([m.sum, m.stp]).toEqual(['-0.83', '-0.83']);
    expect((await h.request('POST', `/api/v1/transactions/${inv}/void`, c.token, { reason: 'test' })).status).toBe(200);
    expect((await rowsAndStp(inv)).rows).toEqual([]);
    const stpId = c.roles['sales_tax_payable']!;
    const [ar] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'accounts_receivable')));
    const odd = await h.request('POST', '/api/v1/transactions', c.token, {
      txnType: 'invoice', txnDate: '2026-11-04', contactId: c.customer,
      lines: [{ accountId: ar!.id, debit: '5.00', credit: '0' }, { accountId: stpId, debit: '0', credit: '5.00' }],
    });
    if (odd.status === 201) {
      const o = await rowsAndStp(odd.json['transaction']?.['id'] ?? odd.json['id']);
      expect([o.sum, o.rows[0]?.taxItemId ?? null]).toEqual(['5.00', null]);
    }
  });
});

describe('migration 0252', () => {
  it('rates are numeric with a scale <= 6 CHECK; a 7-place rate is refused by the database', async () => {
    const res = await db.execute(sql`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid = 'journal_lines'::regclass AND attname = 'tax_rate'`);
    expect((res.rows as Body[])[0]!['t']).toBe('numeric');
    await expect(db.execute(sql`UPDATE companies SET default_sales_tax_rate = 0.0000001 WHERE id = ${c.companyId}`)).rejects.toThrow();
  });

  it('the rollback drops what 0252 adds and restores numeric(5,4)', () => {
    const rb = readFileSync(path.resolve(here, '../db/migrations/0252_sales_tax_setup.rollback.sql'), 'utf8');
    for (const t of ['transaction_tax_lines', 'sales_tax_items', 'sales_tax_payment_lines', 'sales_tax_backfill_company']) expect(rb).toContain(t);
    expect(rb).toMatch(/tax_rate TYPE numeric\(5,4\)/);
  });

  it('items and contacts carry the new columns (tax code, default sales tax)', async () => {
    const [it0] = await db.select().from(items).limit(1);
    expect(it0 === undefined || 'taxCodeId' in it0).toBe(true);
    const [tx0] = await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId)).limit(1);
    expect(tx0 === undefined || 'salesTaxId' in tx0).toBe(true);
  });
});
