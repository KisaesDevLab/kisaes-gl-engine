// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-150 (sales-tax-pay-v1, idempotency-sales-tax-pay-v1): golden case 9
// (Pay Sales Tax with an adjustment, replay, S1 re-preview, stale 409, an
// electronic payment, a linked outside check, void), the check queue, link
// and unlink rules, mark paid through, no edit, the closing date.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  companies, contacts, items, accounts, transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes,
  salesTaxAgencies, salesTaxPayments, salesTaxMarkPaidRuns, auditLog,
} from '../db/schema/index.js';
import { salesTaxRouter, salesTaxReportsRouter } from './sales-tax.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { Harness, type Co, key, m2, lineSet, expectedLines } from './receivables.test-support.js';
import * as checks from '../services/check.service.js';
import * as ledger from '../services/ledger.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

type Body = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/sales-tax-golden.json'), 'utf8')) as Body;
const monett = golden['seeds'].monett as Body;
const g9 = (golden['cases'] as Body[]).find((c) => c['id'] === 9)!['steps'] as Body[];

async function clean(tid: string) {
  for (const t of [salesTaxMarkPaidRuns, salesTaxPayments, transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes, salesTaxAgencies]) {
    await db.delete(t).where(eq(t.tenantId, tid));
  }
}

const h = new Harness();
let c: Co;
const ids = { taxes: new Map<string, string>(), agencies: new Map<string, string>(), clients: new Map<string, string>(), accts: new Map<string, string>(), docs: new Map<string, string>() };
let plants = '';

beforeEach(async () => {
  h.extraCleanup = [clean];
  await h.start([['/api/v1/sales-tax', salesTaxRouter], ['/api/v1/reports', salesTaxReportsRouter], ['/api/v1/invoices', invoicesRouter],
    ['/api/v1/transactions', transactionsRouter]]);
  c = await h.company();
  for (const m of Object.values(ids)) m.clear();
  await seed();
});
afterEach(async () => { await h.stop(); });

const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.request(method, p, c.token, body, method === 'GET' ? headers : { 'Idempotency-Key': key(), ...headers });
const ok = (r: { status: number; json: Body }, status = 201) => { expect(r.status, JSON.stringify(r.json)).toBe(status); return r.json; };

async function seed() {
  for (const a of monett['agencies'] as Body[]) {
    const [v] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: a['name'],
      billingLine1: '1 Capitol Ave', billingCity: 'Jefferson City', billingState: 'MO', billingZip: '65101' }).returning();
    ids.agencies.set(a['name'], ok(await req('POST', '/api/v1/sales-tax/agencies', { vendorId: v!.id }))['id']);
  }
  for (const t of monett['salesTaxes'] as Body[]) {
    const body = t['kind'] === 'group'
      ? { kind: 'group', name: t['name'], memberIds: (t['members'] as string[]).map((m) => ids.taxes.get(m)) }
      : { name: t['name'], rate: t['rate'], agencyId: ids.agencies.get(t['agency']) };
    ids.taxes.set(t['name'], ok(await req('POST', '/api/v1/sales-tax/items', body))['id']);
  }
  const [it] = await db.insert(items).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Plants', incomeAccountId: c.roles['income']!, isTaxable: true }).returning();
  plants = it!.id;
  for (const cl of [{ name: 'Hollister Family' }, { name: 'Ozark Outfitters', salesTax: 'Springfield' }]) {
    const [row] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: cl.name,
      defaultSalesTaxId: cl.salesTax ? ids.taxes.get(cl.salesTax) : null }).returning();
    ids.clients.set(cl.name, row!.id);
  }
  const [disc] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Sales tax discounts', accountType: 'other_revenue', detailType: 'other_income' }).returning();
  ids.accts.set('sales_tax_discounts', disc!.id);
  ids.accts.set('operating_checking', c.roles['checking']!);
  c.roles['sales_tax_discounts'] = disc!.id;
  c.roles['operating_checking'] = c.roles['checking']!;
  await db.update(companies).set({ defaultSalesTaxId: ids.taxes.get('Monett') }).where(eq(companies.id, c.companyId));
  // November: State 80.70 and City 74.02 (Monett 1,910.15); Springfield 88.75 + 16.30 + 26.63 = 131.68 (golden 6's figures).
  const inv = async (client: string, date: string, price: string) => ok(await req('POST', '/api/v1/invoices', {
    contactId: ids.clients.get(client), txnDate: date, lines: [{ itemId: plants, quantity: '1', unitPrice: price }],
  }));
  await inv('Hollister Family', '2026-11-04', '1910.15');
  await inv('Ozark Outfitters', '2026-11-02', '1000.00');
  await inv('Ozark Outfitters', '2026-11-18', '183.70');
  await inv('Ozark Outfitters', '2026-11-20', '300.00');
}

/** A golden pay/payPreview request as the API body. */
function body(r: Body) {
  return {
    agencyId: ids.agencies.get(r['agency']), throughDate: r['throughDate'], date: r['date'], bankAccountId: ids.accts.get(r['bankAccount']),
    method: r['method'],
    ...(r['lines'] ? { lines: (r['lines'] as Body[]).map((l) => ({ taxItemId: ids.taxes.get(l['item']), amount: l['amount'] })) } : {}),
    ...(r['adjustments'] ? { adjustments: (r['adjustments'] as Body[]).map((a) => ({
      taxItemId: ids.taxes.get(a['item']), accountId: ids.accts.get(a['account']), amount: a['amount'], reason: a['reason'] })) } : {}),
    ...(r['printLater'] !== undefined ? { printLater: r['printLater'] } : {}),
    ...(r['expectedOwed'] ? { expectedOwed: r['expectedOwed'] } : {}),
  };
}

const owed = async (asOf: string, agency: string) => ok(await req('GET', `/api/v1/sales-tax/owed?asOf=${asOf}&agencyId=${ids.agencies.get(agency)}`), 200);

describe('golden 9: Pay Sales Tax', () => {
  it('pays with an adjustment, replays, re-previews to 0.00, refuses a stale owed, links an outside check, voids', async () => {
    // Preview.
    const pv = ok(await req('POST', '/api/v1/sales-tax/payments/preview', body(g9[0]!['request'])), 200);
    expect(pv['lines'].map((l: Body) => [l['name'], l['owed'], l['adjustment'], l['amount']]))
      .toEqual(g9[0]!['expect']['lines'].map((l: Body) => [l['item'], l['owed'], l['adjustment'], l['amount']]));
    expect([pv['total'], pv['problems']]).toEqual([g9[0]!['expect']['total'], []]);
    // Pay by check, printed later; the journal.
    const k = key();
    const p1 = await req('POST', '/api/v1/sales-tax/payments', body(g9[1]!['request']), { 'Idempotency-Key': k });
    const pay1 = ok(p1);
    expect([pay1['total'], pay1['printStatus']]).toEqual(['210.42', 'queue']);
    expect(await lineSet(c, pay1['id'])).toEqual(expectedLines((g9[1]!['expect']['journal'] as Body[]).map((l) => ({ ...l, account: l['account'] === 'operating_checking' ? 'checking' : l['account'] })) as never));
    // Replay: the same payment.
    const again = ok(await req('POST', '/api/v1/sales-tax/payments', body(g9[1]!['request']), { 'Idempotency-Key': k }));
    expect(again['id']).toBe(pay1['id']);
    // Owed 0.00; a re-preview through 11/30 dated later is 0.00 too (S1).
    expect((await owed('2026-11-30', 'Sample State Revenue Dept.'))['total']).toBe('0.00');
    expect(ok(await req('POST', '/api/v1/sales-tax/payments/preview', body(g9[4]!['request'])), 200)['total']).toBe('0.00');
    // Stale expectedOwed: 409.
    const stale = await req('POST', '/api/v1/sales-tax/payments', body(g9[5]!['request']));
    expect([stale.status, stale.json['error']?.code]).toEqual([409, 'SALES_TAX_OWED_CHANGED']);
    expect(stale.json['error']['details']['owed']).toBe('74.02');
    // Electronic 50.00 to the City; 24.02 left.
    const pay2 = ok(await req('POST', '/api/v1/sales-tax/payments', body(g9[6]!['request'])));
    expect(pay2['printStatus']).toBeNull();
    expect((await owed('2026-11-30', 'Sample City Revenue Office'))['agencies'][0]['items'].map((i: Body) => [i['name'], i['owed']])).toEqual([['City', '24.02']]);
    // A check written outside Pay Sales Tax, then linked.
    const chk = await checks.createCheck(c.tenantId, {
      bankAccountId: c.roles['checking']!, txnDate: '2026-12-12', amount: '24.02', printLater: true,
      lines: [{ accountId: c.roles['sales_tax_payable']!, amount: '24.02' }],
    } as never, c.userId, c.companyId);
    const cityItem = ids.taxes.get('City')!;
    const city = ids.agencies.get('Sample City Revenue Office')!;
    const bad = await req('POST', '/api/v1/sales-tax/payments/link', { transactionId: chk.id, agencyId: city, lines: [{ taxItemId: cityItem, amount: '20.00' }] });
    expect([bad.status, bad.json['error']?.code]).toEqual([400, 'LINK_TOTAL_MISMATCH']);
    const wrongItem = await req('POST', '/api/v1/sales-tax/payments/link', { transactionId: chk.id, agencyId: city, lines: [{ taxItemId: ids.taxes.get('State'), amount: '24.02' }] });
    expect([wrongItem.status, wrongItem.json['error']?.code]).toEqual([400, 'TAX_ITEM_NOT_FOR_AGENCY']);
    ok(await req('POST', '/api/v1/sales-tax/payments/link', { transactionId: chk.id, agencyId: city, lines: [{ taxItemId: cityItem, amount: '24.02' }] }));
    const twice = await req('POST', '/api/v1/sales-tax/payments/link', { transactionId: chk.id, agencyId: city, lines: [{ taxItemId: cityItem, amount: '24.02' }] });
    expect([twice.status, twice.json['error']?.code]).toEqual([409, 'ALREADY_LINKED']);
    expect((await owed('2026-11-30', 'Sample City Revenue Office'))['total']).toBe('0.00');
    const dec = ok(await req('GET', '/api/v1/reports/sales-tax-liability?start_date=2026-12-01&end_date=2026-12-31&basis=accrual'), 200);
    expect(dec['otherEntries']).toBe('0.00');
    const linked = ok(await req('GET', `/api/v1/sales-tax/payments/${chk.id}`), 200);
    expect([linked['linked'], linked['stubLines']]).toEqual([true, [{ label: 'City', amount: '24.02' }]]);
    const list = ok(await req('GET', '/api/v1/sales-tax/payments?start_date=2026-12-01&end_date=2026-12-31'), 200);
    expect(list['data'].map((d: Body) => `${d['total']}:${d['linked']}`).sort()).toEqual(['210.42:false', '24.02:true', '50.00:false']);
    // The record and its stub.
    const rec = ok(await req('GET', `/api/v1/sales-tax/payments/${pay1['id']}`), 200);
    expect(rec['stubLines']).toEqual([{ label: 'State', amount: '80.70' }, { label: 'Springfield', amount: '129.72' }, { label: 'Timely filing discount', amount: '-1.96' }]);
    // In the check queue until voided; void gives the owed back.
    expect((await checks.getPrintQueue(c.tenantId, undefined, c.companyId)).map((q) => q.id)).toContain(pay1['id']);
    ok(await req('POST', `/api/v1/transactions/${pay1['id']}/void`, { reason: 'wrong date' }), 200);
    const back = await owed('2026-11-30', 'Sample State Revenue Dept.');
    expect([back['agencies'][0]['items'].map((i: Body) => [i['name'], i['owed']]), back['total']])
      .toEqual([[['State', '80.70'], ['Springfield', '131.68']], '212.38']);
    expect((await checks.getPrintQueue(c.tenantId, undefined, c.companyId)).map((q) => q.id)).not.toContain(pay1['id']);
    // Unlink brings the City's 24.02 back.
    ok(await req('POST', `/api/v1/sales-tax/payments/${chk.id}/unlink`, {}), 200);
    expect((await owed('2026-11-30', 'Sample City Revenue Office'))['total']).toBe('24.02');
  });
});

describe('Pay Sales Tax rules', () => {
  const state = () => ids.agencies.get('Sample State Revenue Dept.')!;
  const base = () => ({ agencyId: state(), throughDate: '2026-11-30', date: '2026-12-10', bankAccountId: c.roles['checking']!, method: 'electronic' });

  it('validation: expectedOwed required, total above 0.00, a check needs a number or print later, adjustment accounts', async () => {
    const r1 = await req('POST', '/api/v1/sales-tax/payments', base());
    expect([r1.status, r1.json['error']?.code]).toEqual([400, 'VALIDATION_ERROR']);
    const zero = await req('POST', '/api/v1/sales-tax/payments', { ...base(), lines: [{ taxItemId: ids.taxes.get('State'), amount: '0.00' }], expectedOwed: '80.70' });
    expect([zero.status, zero.json['error']?.code]).toEqual([400, 'PAYMENT_TOTAL_NOT_POSITIVE']);
    const chk = await req('POST', '/api/v1/sales-tax/payments', { ...base(), method: 'check', printLater: true, checkNumber: 77, expectedOwed: '212.38' });
    expect([chk.status, chk.json['error']?.code]).toEqual([400, 'CHECK_NO_OR_PRINT_LATER']);
    const adj = await req('POST', '/api/v1/sales-tax/payments/preview', { ...base(), adjustments: [{ taxItemId: ids.taxes.get('State'), accountId: c.roles['checking'], amount: '-1.00', reason: 'x' }] });
    expect([adj.status, adj.json['error']?.code]).toEqual([400, 'ADJUSTMENT_ACCOUNT_INVALID']);
    const more = ok(await req('POST', '/api/v1/sales-tax/payments/preview', { ...base(), lines: [{ taxItemId: ids.taxes.get('State'), amount: '90.00' }] }), 200);
    expect(more['problems'].map((p: Body) => p['code'])).toEqual(['AMOUNT_MORE_THAN_OWED']);
    // A numbered check: hand written, the number taken; reusing it is 409.
    const n1 = ok(await req('POST', '/api/v1/sales-tax/payments', { ...base(), method: 'check', checkNumber: 5001, lines: [{ taxItemId: ids.taxes.get('State'), amount: '10.00' }], expectedOwed: '80.70' }));
    expect([n1['checkNumber'], n1['printStatus']]).toEqual([5001, 'hand_written']);
    const n2 = await req('POST', '/api/v1/sales-tax/payments', { ...base(), method: 'check', checkNumber: 5001, lines: [{ taxItemId: ids.taxes.get('State'), amount: '10.00' }], expectedOwed: '70.70' });
    expect([n2.status, n2.json['error']?.code]).toEqual([409, 'CHECK_NUMBER_IN_USE']);
    // No edit.
    const put = await req('PUT', `/api/v1/transactions/${n1['id']}`, { txnType: 'sales_tax_payment', txnDate: '2026-12-10', lines: [] });
    expect(put.status).toBeGreaterThanOrEqual(400);
  });

  it('concurrent payments to one agency: one wins, the other is 409 SALES_TAX_OWED_CHANGED', async () => {
    const b = { ...base(), expectedOwed: '212.38' };
    const [a, z] = await Promise.all([req('POST', '/api/v1/sales-tax/payments', b), req('POST', '/api/v1/sales-tax/payments', b)]);
    expect([a.status, z.status].sort()).toEqual([201, 409]);
    expect((await owed('2026-11-30', 'Sample State Revenue Dept.'))['total']).toBe('0.00');
  });

  it('the closing date needs the closing password', async () => {
    await db.update(companies).set({ lockDate: '2026-12-31' }).where(eq(companies.id, c.companyId));
    const r = await req('POST', '/api/v1/sales-tax/payments', { ...base(), expectedOwed: '212.38' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    expect(await db.select().from(salesTaxPayments).where(eq(salesTaxPayments.tenantId, c.tenantId))).toEqual([]);
  });

  it('mark paid through: opening lines, no GL, owed 0.00; another company\'s agency is 404', async () => {
    const m = ok(await req('POST', '/api/v1/sales-tax/payments/mark-paid-through', { agencyId: state(), throughDate: '2026-11-30' }));
    expect(m['total']).toBe('212.38');
    expect((await owed('2026-11-30', 'Sample State Revenue Dept.'))['total']).toBe('0.00');
    const lines = await db.select().from(salesTaxPaymentLines).where(and(eq(salesTaxPaymentLines.tenantId, c.tenantId), eq(salesTaxPaymentLines.kind, 'opening')));
    expect(lines.every((l) => l.transactionId === null)).toBe(true);
    const other = await h.secondCompany(c);
    const r = await h.request('POST', '/api/v1/sales-tax/payments/preview', c.token, base(), other);
    expect(r.status).toBe(404);
    expect(m2('0')).toBe('0.00');
  });

  it('advertises sales-tax-pay-v1 and idempotency-sales-tax-pay-v1', () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(['sales-tax-pay-v1', 'idempotency-sales-tax-pay-v1']));
  });
});

describe('review fixes (U-150)', () => {
  const state = () => ids.agencies.get('Sample State Revenue Dept.')!;
  const base = () => ({ agencyId: state(), throughDate: '2026-11-30', date: '2026-12-10', bankAccountId: c.roles['checking']!, method: 'electronic' });

  it('lines[].amount null = owed + adjustments, computed by the engine; preview and pay agree', async () => {
    const b = {
      ...base(),
      lines: [{ taxItemId: ids.taxes.get('State'), amount: null }, { taxItemId: ids.taxes.get('Springfield'), amount: '100.00' }],
      adjustments: [{ taxItemId: ids.taxes.get('State'), accountId: ids.accts.get('sales_tax_discounts'), amount: '-1.00', reason: 'Timely filing discount' }],
    };
    const pv = ok(await req('POST', '/api/v1/sales-tax/payments/preview', b), 200);
    expect(pv['lines'].map((l: Body) => [l['name'], l['owed'], l['adjustment'], l['amount']]))
      .toEqual([['State', '80.70', '-1.00', '79.70'], ['Springfield', '131.68', '0.00', '100.00']]);
    expect([pv['total'], pv['problems']]).toEqual(['179.70', []]);
    // Absent is the same as null.
    const pv2 = ok(await req('POST', '/api/v1/sales-tax/payments/preview', { ...b, lines: [{ taxItemId: ids.taxes.get('State') }, b.lines[1]] }), 200);
    expect(pv2['total']).toBe('179.70');
    const paid = ok(await req('POST', '/api/v1/sales-tax/payments', { ...b, expectedOwed: pv['owed'] }));
    expect(paid['total']).toBe(pv['total']);
    const after = await owed('2026-11-30', 'Sample State Revenue Dept.');
    expect(after['agencies'][0]['items'].map((i: Body) => [i['name'], i['owed']])).toEqual([['State', '0.00'], ['Springfield', '31.68']]);
  });

  it('owed is read on the pay transaction\'s connection: more concurrent pays than pool connections all finish; one wins', async () => {
    const b = { ...base(), expectedOwed: '212.38' };
    const results = await Promise.all(Array.from({ length: 25 }, () => req('POST', '/api/v1/sales-tax/payments', b)));
    const codes = results.map((r) => (r.status === 201 ? 201 : `${r.status}:${r.json['error']?.code}`));
    expect(codes.filter((x) => x === 201).length).toBe(1);
    expect(codes.filter((x) => x !== 201).every((x) => x === '409:SALES_TAX_OWED_CHANGED' || x === '409:RETRY')).toBe(true);
    expect((await owed('2026-11-30', 'Sample State Revenue Dept.'))['total']).toBe('0.00');
  }, 60_000);

  it('mark paid through: the 201 shape on replay, closing date, list, undo (owed comes back, audited), ALREADY_UNDONE, scope', async () => {
    const k = key();
    const m = ok(await req('POST', '/api/v1/sales-tax/payments/mark-paid-through', { agencyId: state(), throughDate: '2026-11-30' }, { 'Idempotency-Key': k }));
    expect(m).toMatchObject({ agencyId: state(), throughDate: '2026-11-30', total: '212.38', undoneAt: null });
    expect(m['lines'].map((l: Body) => [l['name'], l['amount']])).toEqual([['State', '80.70'], ['Springfield', '131.68']]);
    const replay = ok(await req('POST', '/api/v1/sales-tax/payments/mark-paid-through', { agencyId: state(), throughDate: '2026-11-30' }, { 'Idempotency-Key': k }));
    expect(replay).toEqual(m);
    expect(ok(await req('GET', '/api/v1/sales-tax/payments/mark-paid-through'), 200)['data'].map((r: Body) => r['runId'])).toEqual([m['runId']]);
    // Another company's run is 404.
    const other = await h.secondCompany(c);
    const foreign = await h.request('POST', `/api/v1/sales-tax/payments/mark-paid-through/${m['runId']}/undo`, c.token, {}, { 'Idempotency-Key': key(), ...other });
    expect(foreign.status).toBe(404);
    // A closed period: undo and a new run need the closing password.
    await db.update(companies).set({ lockDate: '2026-12-31' }).where(eq(companies.id, c.companyId));
    const lockedUndo = await req('POST', `/api/v1/sales-tax/payments/mark-paid-through/${m['runId']}/undo`, {});
    expect(lockedUndo.status).toBeGreaterThanOrEqual(400);
    expect(lockedUndo.status).toBeLessThan(500);
    const lockedRun = await req('POST', '/api/v1/sales-tax/payments/mark-paid-through', { agencyId: ids.agencies.get('Sample City Revenue Office'), throughDate: '2026-11-30' });
    expect(lockedRun.status).toBeGreaterThanOrEqual(400);
    expect(lockedRun.status).toBeLessThan(500);
    expect((await db.select().from(salesTaxMarkPaidRuns).where(eq(salesTaxMarkPaidRuns.tenantId, c.tenantId))).length).toBe(1);
    await db.update(companies).set({ lockDate: null }).where(eq(companies.id, c.companyId));
    // Undo: owed comes back; replay returns the same body; a second undo is 409.
    const uk = key();
    const u = ok(await req('POST', `/api/v1/sales-tax/payments/mark-paid-through/${m['runId']}/undo`, {}, { 'Idempotency-Key': uk }), 200);
    expect([u['runId'], u['total'], typeof u['undoneAt']]).toEqual([m['runId'], '212.38', 'string']);
    expect((await owed('2026-11-30', 'Sample State Revenue Dept.'))['total']).toBe('212.38');
    expect(ok(await req('POST', `/api/v1/sales-tax/payments/mark-paid-through/${m['runId']}/undo`, {}, { 'Idempotency-Key': uk }), 200)).toEqual(u);
    const again = await req('POST', `/api/v1/sales-tax/payments/mark-paid-through/${m['runId']}/undo`, {});
    expect([again.status, again.json['error']?.code]).toEqual([409, 'ALREADY_UNDONE']);
    expect(ok(await req('GET', '/api/v1/sales-tax/payments/mark-paid-through'), 200)['data']).toEqual([]);
    expect(ok(await req('GET', '/api/v1/sales-tax/payments/mark-paid-through?include_undone=true'), 200)['data'].length).toBe(1);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'sales_tax_mark_paid')));
    expect(audit.map((a) => a.action).sort()).toEqual(['create', 'delete']);
  });

  it('an over-paid item keeps its credit: mark paid writes lines only for items with tax owed', async () => {
    const spr = ids.taxes.get('Springfield')!;
    await db.insert(salesTaxPaymentLines).values({ tenantId: c.tenantId, companyId: c.companyId, transactionId: null, taxItemId: spr, agencyId: state(),
      kind: 'opening', lineDate: '2026-11-01', amount: '140.0000' });
    const m = ok(await req('POST', '/api/v1/sales-tax/payments/mark-paid-through', { agencyId: state(), throughDate: '2026-11-30' }));
    expect(m['lines'].map((l: Body) => [l['name'], l['amount']])).toEqual([['State', '80.70']]);
    expect((await owed('2026-11-30', 'Sample State Revenue Dept.'))['agencies'][0]['items'].map((i: Body) => [i['name'], i['owed']]))
      .toEqual([['State', '0.00'], ['Springfield', '-8.32']]);
  });

  it('a linked check: an edit of its amount or date is 409 SALES_TAX_LINKED; a memo edit goes through; after unlink it edits', async () => {
    const chk = await checks.createCheck(c.tenantId, {
      bankAccountId: c.roles['checking']!, txnDate: '2026-12-12', amount: '24.02', printLater: true,
      lines: [{ accountId: c.roles['sales_tax_payable']!, amount: '24.02' }],
    } as never, c.userId, c.companyId);
    const city = ids.agencies.get('Sample City Revenue Office')!;
    ok(await req('POST', '/api/v1/sales-tax/payments/link', { transactionId: chk.id, agencyId: city, lines: [{ taxItemId: ids.taxes.get('City'), amount: '24.02' }] }));
    const edit = (over: Body) => checks.updateCheck(c.tenantId, chk.id, {
      bankAccountId: c.roles['checking']!, txnDate: '2026-12-12', amount: '24.02', lines: [{ accountId: c.roles['sales_tax_payable']!, amount: '24.02' }], ...over,
    } as never, c.userId, c.companyId);
    await expect(edit({ amount: '20.00', lines: [{ accountId: c.roles['sales_tax_payable']!, amount: '20.00' }] })).rejects.toMatchObject({ code: 'SALES_TAX_LINKED', statusCode: 409 });
    await expect(edit({ txnDate: '2026-12-20' })).rejects.toMatchObject({ code: 'SALES_TAX_LINKED' });
    await edit({ memo: 'City sales tax, November' });
    // A linked journal entry, edited through the ledger (PUT /transactions/:id).
    const jeLines = (amt: string) => [{ accountId: c.roles['sales_tax_payable']!, debit: amt, credit: '0' }, { accountId: c.roles['checking']!, debit: '0', credit: amt }];
    const je = await ledger.postTransaction(c.tenantId, { txnType: 'journal_entry', txnDate: '2026-12-14', lines: jeLines('10.00') } as never, c.userId, c.companyId);
    ok(await req('POST', '/api/v1/sales-tax/payments/link', { transactionId: je.id, agencyId: state(), lines: [{ taxItemId: ids.taxes.get('State'), amount: '10.00' }] }));
    await expect(ledger.updateTransaction(c.tenantId, je.id, { txnType: 'journal_entry', txnDate: '2026-12-21', lines: jeLines('10.00') } as never, c.userId, c.companyId))
      .rejects.toMatchObject({ code: 'SALES_TAX_LINKED' });
    await expect(ledger.updateTransaction(c.tenantId, je.id, { txnType: 'journal_entry', txnDate: '2026-12-14', lines: jeLines('12.00') } as never, c.userId, c.companyId))
      .rejects.toMatchObject({ code: 'SALES_TAX_LINKED' });
    await ledger.updateTransaction(c.tenantId, je.id, { txnType: 'journal_entry', txnDate: '2026-12-14', memo: 'State', lines: jeLines('10.00') } as never, c.userId, c.companyId);
    expect((await owed('2026-11-30', 'Sample City Revenue Office'))['total']).toBe('50.00');
    ok(await req('POST', `/api/v1/sales-tax/payments/${chk.id}/unlink`, {}), 200);
    await edit({ amount: '20.00', lines: [{ accountId: c.roles['sales_tax_payable']!, amount: '20.00' }] });
  });

  it('a void keeps a payment\'s lines for GET; owed comes back', async () => {
    const p = ok(await req('POST', '/api/v1/sales-tax/payments', { ...base(), expectedOwed: '212.38' }));
    ok(await req('POST', `/api/v1/transactions/${p['id']}/void`, { reason: 'test' }), 200);
    const got = ok(await req('GET', `/api/v1/sales-tax/payments/${p['id']}`), 200);
    expect([got['status'], got['lines'].length]).toEqual(['void', 2]);
    expect((await owed('2026-11-30', 'Sample State Revenue Dept.'))['total']).toBe('212.38');
  });
});