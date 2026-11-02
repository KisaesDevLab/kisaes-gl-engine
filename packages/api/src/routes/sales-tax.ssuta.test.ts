// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-153 / U-154 (sales-tax-ssuta-v1, bad-debt-recovery-v1,
// idempotency-recovery-v1): golden cases 12-14 with SSUTA on through the
// routes (packages/shared/fixtures/sales-tax-golden.json), payment edits and
// voids, the recovery rules (replay, 409s, closing date, scope, void), open
// items = GL after a recovery, the written-off invoices list, and the Pay
// Sales Tax preview's expectedOwed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts, companies, contacts, items, journalLines, transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems,
  salesTaxCodes, salesTaxAgencies, salesTaxPayments, writeOffRecoveries, permissionTemplates, transactions as transactionsT,
} from '../db/schema/index.js';
import { salesTaxRouter, salesTaxReportsRouter } from './sales-tax.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { paymentsRouter } from './payments.routes.js';
import { reportsRouter } from './reports.routes.js';
import { Harness, type Co, key, m2, contactAR } from './receivables.test-support.js';
import { cashBasisLinesWith, buildBalanceSheet } from '../services/report.service.js';
import { arOpenItemsAsOf } from '../services/ar-open-items.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

type Body = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/sales-tax-golden.json'), 'utf8')) as Body;
const monett = golden['seeds'].monett as Body;
const steps = (id: number) => (golden['cases'] as Body[]).find((c) => c['id'] === id)!['steps'] as Body[];

async function clean(tid: string) {
  for (const t of [writeOffRecoveries, salesTaxPayments, transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes,
    salesTaxAgencies, permissionTemplates]) {
    await db.delete(t).where(eq(t.tenantId, tid));
  }
}

const h = new Harness();
let c: Co;
const ids = {
  taxes: new Map<string, string>(), items: new Map<string, string>(), clients: new Map<string, string>(), agencies: new Map<string, string>(),
  docs: new Map<string, string>(), accts: new Map<string, string>(),
};

beforeEach(async () => {
  h.extraCleanup = [clean];
  await h.start([['/api/v1/sales-tax', salesTaxRouter], ['/api/v1/reports', salesTaxReportsRouter], ['/api/v1/reports', reportsRouter],
    ['/api/v1/invoices', invoicesRouter], ['/api/v1/transactions', transactionsRouter], ['/api/v1/payments', paymentsRouter]]);
  c = await h.company();
  for (const m of Object.values(ids)) m.clear();
});
afterEach(async () => { await h.stop(); });

const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.request(method, p, c.token, body, method === 'GET' ? headers : { 'Idempotency-Key': key(), ...headers });
const ok = (r: { status: number; json: Body }, status = 201) => { expect(r.status, JSON.stringify(r.json)).toBe(status); return r.json; };

/** The ssuta seed (the monett setup, no documents): SSUTA as asked. */
async function seed(ssuta = true) {
  for (const a of monett['agencies'] as Body[]) {
    const [v] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: a['name'] }).returning();
    ids.agencies.set(a['name'], ok(await req('POST', '/api/v1/sales-tax/agencies', { vendorId: v!.id }))['id']);
  }
  for (const t of monett['salesTaxes'] as Body[]) {
    const body = t['kind'] === 'group'
      ? { kind: 'group', name: t['name'], memberIds: (t['members'] as string[]).map((m) => ids.taxes.get(m)) }
      : { name: t['name'], rate: t['rate'], agencyId: ids.agencies.get(t['agency']) };
    ids.taxes.set(t['name'], ok(await req('POST', '/api/v1/sales-tax/items', body))['id']);
  }
  const [plants] = await db.insert(items).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Plants', incomeAccountId: c.roles['income']!, isTaxable: true }).returning();
  ids.items.set('Plants', plants!.id);
  for (const cl of monett['clients'] as Body[]) {
    const [row] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: cl['name'],
      defaultSalesTaxId: cl['salesTax'] ? ids.taxes.get(cl['salesTax']) : null }).returning();
    ids.clients.set(cl['name'], row!.id);
  }
  ids.accts.set('operating_checking', c.roles['checking']!);
  ids.accts.set('income', c.roles['income']!);
  ids.accts.set('accounts_receivable', c.roles['accounts_receivable']!);
  ids.accts.set('sales_tax_payable', c.roles['sales_tax_payable']!);
  for (const [role, a] of Object.entries(monett['accounts'] as Record<string, Body>)) {
    if (role === 'operating_checking' || role === 'income') continue;
    const [row] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, name: a['name'], accountType: a['type'],
      detailType: a['type'] === 'expense' ? 'office_expenses' : a['type'] === 'revenue' ? 'service' : 'other_income',
    }).returning();
    ids.accts.set(role, row!.id);
  }
  await db.update(companies).set({
    defaultSalesTaxId: ids.taxes.get(monett['companyDefault']), salesTaxSsuta: ssuta,
  }).where(eq(companies.id, c.companyId));
}

async function invoice(r: Body) {
  const j = ok(await req('POST', '/api/v1/invoices', {
    contactId: ids.clients.get(r['client']), txnDate: r['date'],
    lines: (r['lines'] as Body[]).map((l) => ({ itemId: ids.items.get(l['item']), quantity: l['quantity'], unitPrice: l['unitPrice'] })),
  }));
  const id = j['invoice']?.['id'] ?? j['id'];
  ids.docs.set(r['name'], id);
  return id as string;
}

const paymentBody = (r: Body) => ({
  customerId: ids.clients.get(r['client']), date: r['date'], amount: r['amount'], depositTo: ids.accts.get(r['depositTo']),
  discountAccountId: ids.accts.get('sales_discounts'), writeOffAccountId: ids.accts.get('bad_debts'),
  applications: (r['applications'] as Body[]).map((a) => ({
    invoiceId: ids.docs.get(a['invoice']), amount: a['amount'],
    ...(a['discount'] ? { discountAmount: a['discount'] } : {}), ...(a['writeOff'] ? { writeOffAmount: a['writeOff'] } : {}),
  })),
});

async function receive(r: Body) {
  const j = ok(await req('POST', '/api/v1/payments/receive', paymentBody(r)));
  ids.docs.set(r['name'], j['payment']['id']);
  return j['payment'] as Body;
}

async function preview(r: Body, editingPaymentId?: string) {
  return ok(await req('POST', '/api/v1/payments/preview', { ...paymentBody(r), ...(editingPaymentId ? { editingPaymentId } : {}) }), 200);
}

/** A transaction's lines as role:side:amount (golden role names), sorted. */
async function lines(txnId: string) {
  const rows = await db.select().from(journalLines).where(and(eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)));
  const roleOf = (id: string) => [...ids.accts.entries()].find(([, v]) => v === id)?.[0] ?? id;
  return rows.map((l) => (Number(l.debit) > 0 ? `${roleOf(l.accountId)}:debit:${m2(l.debit)}` : `${roleOf(l.accountId)}:credit:${m2(l.credit)}`)).sort();
}
const want = (ls: Body[]) => ls.map((l) => (l['debit'] !== undefined ? `${l['account']}:debit:${l['debit']}` : `${l['account']}:credit:${l['credit']}`)).sort();

async function liability(r: Body) {
  return ok(await req('GET', `/api/v1/reports/sales-tax-liability?start_date=${r['startDate']}&end_date=${r['endDate']}&basis=${r['basis']}`), 200);
}
function expectLiability(got: Body, w: Body) {
  const all: Body[] = (got['agencies'] as Body[]).flatMap((a) => a['items'] as Body[]);
  for (const x of w['items'] as Body[]) {
    const g = all.find((i) => i['name'] === x['item']);
    expect(g, `item ${x['item']}`).toBeTruthy();
    for (const [k, v] of Object.entries(x)) if (k !== 'item') expect(g![k], `${x['item']}.${k} (${got['basis']})`).toBe(v);
  }
}
/** The report ties to the GL on both bases (no other entries). */
async function expectTies(startDate: string, endDate: string) {
  for (const basis of ['accrual', 'cash']) {
    const r = await liability({ startDate, endDate, basis });
    expect([basis, r['otherEntries'], r['balanceCheck']['otherEntriesCumulative']]).toEqual([basis, '0.00', '0.00']);
  }
}

async function cashLedger(start: string, end: string) {
  const res = await db.execute(sql`
    WITH ${cashBasisLinesWith(c.tenantId, start, end, c.companyId)}
    SELECT cb.account_id, COALESCE(SUM(cb.debit - cb.credit), 0)::text AS dr FROM cb_lines cb GROUP BY cb.account_id`);
  const out: Record<string, string> = {};
  for (const r of res.rows as Body[]) {
    const role = [...ids.accts.entries()].find(([, v]) => v === r['account_id'])?.[0];
    if (role) out[role] = m2(r['dr']);
  }
  return out;
}

const recover = (body: Body, headers: Record<string, string> = {}) => req('POST', '/api/v1/payments/write-off-recoveries', body, headers);
const recoveryBody = (r: Body) => ({ invoiceId: ids.docs.get(r['invoice']), date: r['date'], amount: r['amount'] });

describe('golden 12 (SSUTA on): an early-payment discount lowers the tax owed', () => {
  it('previews and posts the 0.71 share, reports it on both bases, and rewrites it on edit', async () => {
    await seed();
    const s = steps(12);
    const invId = await invoice(s[0]!['request']);
    expect(m2((await db.select().from(transactionsT).where(eq(transactionsT.id, invId)))[0]!.total)).toBe(s[0]!['expect']['total']);
    const pv = await preview(s[1]!['request']);
    expect(pv['salesTaxSsuta']).toBe(true);
    const row = (pv['invoices'] as Body[]).find((i) => i['invoiceId'] === ids.docs.get('INV-H'))!;
    expect(row['discountTax']).toBe(s[1]!['expect']['discountTax']['INV-H']);
    expect([pv['totals']['discountTax'], pv['totals']['writeOffTax']]).toEqual(['0.71', '0.00']);
    const p = await receive(s[1]!['request']);
    expect(await lines(p['id'])).toEqual(want(s[1]!['expect']['journal']));
    expectLiability(await liability(s[2]!['request']), s[2]!['expect']);
    expectLiability(await liability(s[3]!['request']), s[3]!['expect']);
    await expectTies('2026-11-01', '2026-11-30');
    // The edit preview gives the same share back (balance with its own share added back).
    const again = await preview(s[1]!['request'], p['id']);
    expect((again['invoices'] as Body[]).find((i) => i['invoiceId'] === ids.docs.get('INV-H'))!['discountTax']).toBe('0.71');

    // PUT without the discount: the rows go, the invoice keeps 8.71 open, owed back to 35.50.
    const put = ok(await req('PUT', `/api/v1/payments/${p['id']}`, {
      ...paymentBody(s[1]!['request']), applications: [{ invoiceId: ids.docs.get('INV-H'), amount: '426.79' }],
    }), 200);
    expect(put['payment']['applications'].filter((a: Body) => !a['voided']).map((a: Body) => a['discount'])).toEqual(['0.00']);
    expect(await lines(p['id'])).toEqual(['accounts_receivable:credit:426.79', 'operating_checking:debit:426.79']);
    expectLiability(await liability(s[2]!['request']), { items: [{ item: 'Springfield', discounts: '0.00', owedAtEnd: '35.50' }] });
    // PUT with a smaller discount after a partial: the running total from the restored balance.
    ok(await req('PUT', `/api/v1/payments/${p['id']}`, {
      ...paymentBody(s[1]!['request']),
      applications: [{ invoiceId: ids.docs.get('INV-H'), amount: '426.79', discountAmount: '4.00' }],
    }), 200);
    // share of 430.79 of 435.50 = round2(35.50 x 430.79 / 435.50) = 35.12; D part 35.12 x 4 / 430.79 = 0.33.
    expect(await lines(p['id'])).toEqual(['accounts_receivable:credit:430.79', 'operating_checking:debit:426.79',
      'sales_discounts:debit:3.67', 'sales_tax_payable:debit:0.33']);
    await expectTies('2026-11-01', '2026-11-30');
    // A void drops the rows.
    ok(await req('POST', `/api/v1/payments/${p['id']}/void`, { reason: 'test' }), 200);
    expect((await db.select().from(transactionTaxLines).where(eq(transactionTaxLines.transactionId, p['id']))).length).toBe(0);
    expectLiability(await liability(s[2]!['request']), { items: [{ item: 'Springfield', collected: '35.50', discounts: '0.00', owedAtEnd: '35.50' }] });
  });

  it('SSUTA off posts as before (no tax share, preview 0.00)', async () => {
    await seed(false);
    const v = ((golden['cases'] as Body[]).find((x) => x['id'] === 12)!['variants'] as Body[])[0]!['steps'] as Body[];
    await invoice(v[0]!['request']);
    const pv = await preview(v[1]!['request']);
    expect([pv['salesTaxSsuta'], (pv['invoices'] as Body[])[0]!['discountTax']]).toEqual([false, '0.00']);
    const p = await receive(v[1]!['request']);
    expect(await lines(p['id'])).toEqual(want(v[1]!['expect']['journal']));
    expectLiability(await liability(v[2]!['request']), v[2]!['expect']);
  });
});

describe('golden 13 (SSUTA on): a bad debt, its recovery and the payment after it', () => {
  it('runs the case through the routes', async () => {
    await seed();
    const s = steps(13);
    await invoice(s[0]!['request']);
    const pv = await preview(s[1]!['request']);
    expect((pv['invoices'] as Body[])[0]!['writeOffTax']).toBe('9.60');
    const p = await receive(s[1]!['request']);
    expect(await lines(p['id'])).toEqual(want(s[1]!['expect']['journal']));
    expectLiability(await liability(s[2]!['request']), s[2]!['expect']);
    expectLiability(await liability(s[3]!['request']), s[3]!['expect']);
    const led = await cashLedger(s[4]!['request']['startDate'], s[4]!['request']['endDate']);
    expect([m2(-Number(led['income'] ?? 0)), led['bad_debts'] ?? '0.00']).toEqual([s[4]!['expect']['income'], s[4]!['expect']['bad_debts']]);
    await expectTies('2026-11-01', '2026-11-30');

    // The written-off invoices of the client.
    const wo = ok(await req('GET', `/api/v1/payments/write-offs?customerId=${ids.clients.get('Ozark Outfitters')}`), 200);
    expect(wo['data']).toEqual([expect.objectContaining({
      invoiceId: ids.docs.get('INV-J'), invoiceDate: '2026-11-04', writeOffDate: '2026-11-20', writtenOff: '117.75', writeOffTax: '9.60',
      recovered: '0.00', recoveredTax: '0.00', recoverable: '117.75', balanceDue: '0.00',
    })]);

    // Recovery 12/15, replayed with its key.
    const k = key();
    const rec = ok(await recover(recoveryBody(s[5]!['request']), { 'Idempotency-Key': k }));
    expect([rec['recoveredTax'], rec['invoiceBalanceDue'], rec['amount'], rec['txnType']]).toEqual([s[5]!['expect']['recoveredTax'], s[5]!['expect']['invoiceBalanceDue'], '50.00', 'bad_debt_recovery']);
    expect(await lines(rec['id'])).toEqual(want(s[5]!['expect']['journal']));
    const replay = ok(await recover(recoveryBody(s[5]!['request']), { 'Idempotency-Key': k }));
    expect(replay['id']).toBe(rec['id']);
    expect(ok(await req('GET', `/api/v1/payments/write-off-recoveries/${rec['id']}`), 200)['recoveredTax']).toBe('4.08');
    expectLiability(await liability(s[6]!['request']), s[6]!['expect']);
    // Open items = GL after the recovery: the invoice is open 50.00.
    const oz = ids.clients.get('Ozark Outfitters')!;
    const open = await arOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf: '2026-12-31', contactIds: [oz] });
    expect(open.map((o) => [o.txnId, o.open])).toEqual([[ids.docs.get('INV-J'), '50.00']]);
    expect(await contactAR(c, oz)).toBe('50.00');
    // More than is left: 409 with what is available.
    const over = await recover({ ...recoveryBody(s[5]!['request']), amount: '67.76' });
    expect([over.status, over.json['error']?.['code'], over.json['error']?.['details']?.['available']]).toEqual([409, 'RECOVERY_EXCEEDS_WRITE_OFF', '67.75']);

    // The client pays the reopened 50.00 normally.
    await receive(s[7]!['request']);
    expectLiability(await liability(s[8]!['request']), s[8]!['expect']);
    await expectTies('2026-12-01', '2026-12-31');
    // The payment that wrote it off can't be bounced, voided or edited.
    const b = await req('POST', `/api/v1/payments/${p['id']}/bounce`, { date: s[9]!['request']['date'] });
    expect([b.status, b.json['error']?.['code']]).toEqual([s[9]!['expect']['error']['status'], s[9]!['expect']['error']['code']]);
    const v = await req('POST', `/api/v1/payments/${p['id']}/void`, { reason: 'x' });
    expect([v.status, v.json['error']?.['code']]).toEqual([409, 'WRITE_OFF_RECOVERED']);
    const e = await req('PUT', `/api/v1/payments/${p['id']}`, { ...paymentBody(s[1]!['request']), memo: 'changed', amount: '99.00',
      applications: [{ invoiceId: ids.docs.get('INV-J'), amount: '99.00', writeOffAmount: '118.75' }] });
    expect([e.status, e.json['error']?.['code']]).toEqual([409, 'WRITE_OFF_RECOVERED']);
    // The reopened balance was paid: the recovery can't be voided.
    const rv = await req('POST', `/api/v1/transactions/${rec['id']}/void`, { reason: 'x' });
    expect([rv.status, rv.json['error']?.['code']]).toEqual([409, 'RECOVERY_IN_USE']);
    const bs = await buildBalanceSheet(c.tenantId, '2026-12-31', 'cash', c.companyId);
    expect(m2(bs.totalAssets)).toBe(m2(bs.totalLiabilities + bs.totalEquity));
  });

  it('a void of the recovery gives the write-off back; the payment can be voided again after it', async () => {
    await seed();
    const s = steps(13);
    await invoice(s[0]!['request']);
    const p = await receive(s[1]!['request']);
    const rec = ok(await recover(recoveryBody(s[5]!['request'])));
    expect((await db.select().from(transactionTaxLines).where(eq(transactionTaxLines.transactionId, rec['id']))).map((r) => [r.kind, m2(r.tax)]))
      .toEqual([['recovery', '4.08']]);
    ok(await req('POST', `/api/v1/transactions/${rec['id']}/void`, { reason: 'entered twice' }), 200);
    expect((await db.select().from(transactionTaxLines).where(eq(transactionTaxLines.transactionId, rec['id']))).length).toBe(0);
    expect(m2((await db.select().from(transactionsT).where(eq(transactionsT.id, ids.docs.get('INV-J')!)))[0]!.balanceDue)).toBe('0.00');
    expectLiability(await liability({ basis: 'accrual', startDate: '2026-11-01', endDate: '2026-12-31' }),
      { items: [{ item: 'Springfield', recoveries: '0.00', owedAtEnd: '8.15' }] });
    // Two recoveries add up by running total: 50.00 then 67.75 bring back all 9.60.
    const r1 = ok(await recover(recoveryBody(s[5]!['request'])));
    const r2 = ok(await recover({ ...recoveryBody(s[5]!['request']), amount: '67.75', date: '2026-12-16' }));
    expect([r1['recoveredTax'], r2['recoveredTax'], r2['invoiceBalanceDue']]).toEqual(['4.08', '5.52', '117.75']);
    const none = ok(await req('GET', `/api/v1/payments/write-offs?customerId=${ids.clients.get('Ozark Outfitters')}`), 200);
    expect(none['data']).toEqual([]);
    const all = ok(await req('GET', `/api/v1/payments/write-offs?invoiceId=${ids.docs.get('INV-J')}&includeRecovered=true`), 200);
    expect(all['data'][0]).toMatchObject({ recovered: '117.75', recoveredTax: '9.60', recoverable: '0.00' });
    await expectTies('2026-11-01', '2026-12-31');
    ok(await req('POST', `/api/v1/transactions/${r2['id']}/void`, { reason: 'x' }), 200);
    ok(await req('POST', `/api/v1/transactions/${r1['id']}/void`, { reason: 'x' }), 200);
    ok(await req('POST', `/api/v1/payments/${p['id']}/void`, { reason: 'x' }), 200);
    // Rows stay (three recoveries, all void now) and count for nothing.
    expect((await db.select().from(writeOffRecoveries).where(eq(writeOffRecoveries.tenantId, c.tenantId))).length).toBe(3);
  });

  it('recovery rules: dates, scope, closing date, a write-off posted with SSUTA off, edits refused', async () => {
    await seed(false);
    const s = steps(13);
    await invoice(s[0]!['request']);
    await receive(s[1]!['request']);
    // Before the write-off: 400.
    const early = await recover({ ...recoveryBody(s[5]!['request']), date: '2026-11-19' });
    expect([early.status, early.json['error']?.['code']]).toEqual([400, 'RECOVERY_DATE_INVALID']);
    // Another company: 404 for the invoice and the list.
    const other = await h.secondCompany(c);
    expect((await recover(recoveryBody(s[5]!['request']), other)).status).toBe(404);
    expect((await req('GET', `/api/v1/payments/write-offs?customerId=${ids.clients.get('Ozark Outfitters')}`, undefined, other)).status).toBe(404);
    // Closed period: needs the closing password.
    await db.update(companies).set({ lockDate: '2026-12-31' }).where(eq(companies.id, c.companyId));
    const closed = await recover(recoveryBody(s[5]!['request']));
    expect(closed.status).toBeGreaterThanOrEqual(400);
    expect(closed.status).toBeLessThan(500);
    expect(await db.select().from(writeOffRecoveries).where(eq(writeOffRecoveries.tenantId, c.tenantId))).toEqual([]);
    await db.update(companies).set({ lockDate: null }).where(eq(companies.id, c.companyId));
    // Written off with SSUTA off: no bad-debt tax, so the whole amount goes back to the write-off account.
    const rec = ok(await recover(recoveryBody(s[5]!['request'])));
    expect(rec['recoveredTax']).toBe('0.00');
    expect(await lines(rec['id'])).toEqual(['accounts_receivable:debit:50.00', 'bad_debts:credit:50.00']);
    // No edit through /transactions.
    const put = await req('PUT', `/api/v1/transactions/${rec['id']}`, { txnType: 'bad_debt_recovery', txnDate: '2026-12-15', lines: [] });
    expect(put.status).toBeGreaterThanOrEqual(400);
    expect(put.status).toBeLessThan(500);
    // Cash basis ignores the recovery.
    const led = await cashLedger('2026-12-01', '2026-12-31');
    expect([led['accounts_receivable'] ?? '0.00', led['bad_debts'] ?? '0.00']).toEqual(['0.00', '0.00']);
  });
});

describe('golden 14 (SSUTA on): a bounce gives the discount tax back', () => {
  it('posts the bounce with the stored share and reports owed 35.50 accrual, 0.00 cash; its void restores the share', async () => {
    await seed();
    const s = steps(14);
    await invoice(s[0]!['request']);
    const p = await receive(s[1]!['request']);
    const b = ok(await req('POST', `/api/v1/payments/${p['id']}/bounce`, { date: s[2]!['request']['date'] }));
    expect(await lines(b['returnId'])).toEqual(want(s[2]!['expect']['journal']));
    expectLiability(await liability(s[3]!['request']), s[3]!['expect']);
    expectLiability(await liability(s[4]!['request']), s[4]!['expect']);
    await expectTies('2026-11-01', '2026-11-30');
    const bs = await buildBalanceSheet(c.tenantId, '2026-11-30', 'cash', c.companyId);
    expect(m2(bs.totalAssets)).toBe(m2(bs.totalLiabilities + bs.totalEquity));
    // A later switch-off does not change what the bounce gives back (Q-P23w); its void restores the discount row.
    ok(await req('POST', `/api/v1/transactions/${b['returnId']}/void`, { reason: 'bank error' }), 200);
    expectLiability(await liability(s[3]!['request']), { items: [{ item: 'Springfield', discounts: '-0.71', owedAtEnd: '34.79' }] });
    await db.update(companies).set({ salesTaxSsuta: false }).where(eq(companies.id, c.companyId));
    const b2 = ok(await req('POST', `/api/v1/payments/${p['id']}/bounce`, { date: '2026-11-26' }));
    expect(await lines(b2['returnId'])).toEqual(want(s[2]!['expect']['journal']));
    await expectTies('2026-11-01', '2026-11-30');
  });
});

describe('the cash Balance Sheet with SSUTA on (missing test 1)', () => {
  it('discounts, write-offs, a bounce and a recovery keep the cash Balance Sheet balanced with no A/R or bad debts', async () => {
    await seed();
    const oz = ids.clients.get('Ozark Outfitters')!;
    const chk = c.roles['checking']!;
    const inv = (n: string, date: string, price: string) => invoice({ name: n, client: 'Ozark Outfitters', date, lines: [{ item: 'Plants', quantity: '1', unitPrice: price }] });
    const pay = async (date: string, amount: string, apps: Body[]) => ok(await req('POST', '/api/v1/payments/receive', {
      customerId: oz, date, amount, depositTo: chk, applications: apps,
      discountAccountId: ids.accts.get('sales_discounts'), writeOffAccountId: ids.accts.get('bad_debts'),
    }))['payment'] as Body;
    const i1 = await inv('S-1', '2026-01-10', '1000.00');
    const i2 = await inv('S-2', '2026-02-10', '300.00');
    const p1 = await pay('2026-02-01', '500.00', [{ invoiceId: i1, amount: '500.00' }]);
    await pay('2026-03-05', '560.00', [{ invoiceId: i1, amount: '560.00', discountAmount: '10.00', writeOffAmount: '18.75' }]);
    const p3 = await pay('2026-03-06', '300.00', [{ invoiceId: i2, amount: '290.00', discountAmount: '6.63', writeOffAmount: '30.00' }]);
    ok(await req('POST', `/api/v1/payments/${p3['id']}/bounce`, { date: '2026-04-02' }));
    ok(await recover({ invoiceId: i1, date: '2026-05-01', amount: '10.00' }));
    await pay('2026-05-20', '10.00', [{ invoiceId: i1, amount: '10.00' }]);
    expect(p1['id']).toBeTruthy();
    for (const asOf of ['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']) {
      const bs = await buildBalanceSheet(c.tenantId, asOf, 'cash', c.companyId);
      expect(m2(bs.totalAssets), asOf).toBe(m2(bs.totalLiabilities + bs.totalEquity));
      const led = await cashLedger('2026-01-01', asOf);
      expect([asOf, led['accounts_receivable'] ?? '0.00', led['bad_debts'] ?? '0.00']).toEqual([asOf, '0.00', '0.00']);
    }
    await expectTies('2026-01-01', '2026-06-30');
    const open = await arOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf: '2026-06-30', contactIds: [oz] });
    expect(m2(open.reduce((s2, o) => s2 + Number(o.open), 0))).toBe(await contactAR(c, oz));
  });
});

describe('Pay Sales Tax preview and capabilities', () => {
  it('the preview returns the expectedOwed the post takes', async () => {
    await seed();
    await invoice({ name: 'X-1', client: 'Ozark Outfitters', date: '2026-11-03', lines: [{ item: 'Plants', quantity: '1', unitPrice: '400.00' }] });
    const pv = ok(await req('POST', '/api/v1/sales-tax/payments/preview', {
      agencyId: ids.agencies.get('Sample State Revenue Dept.'), throughDate: '2026-11-30', date: '2026-12-10',
      bankAccountId: ids.accts.get('operating_checking'), method: 'electronic',
    }), 200);
    expect([pv['owed'], pv['expectedOwed'], pv['total']]).toEqual(['35.50', '35.50', '35.50']);
    const paid = ok(await req('POST', '/api/v1/sales-tax/payments', {
      agencyId: ids.agencies.get('Sample State Revenue Dept.'), throughDate: '2026-11-30', date: '2026-12-10',
      bankAccountId: ids.accts.get('operating_checking'), method: 'electronic', expectedOwed: pv['expectedOwed'],
    }));
    expect(paid['id']).toBeTruthy();
  });

  it('advertises sales-tax-ssuta-v1, bad-debt-recovery-v1 and idempotency-recovery-v1', () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(['sales-tax-ssuta-v1', 'bad-debt-recovery-v1', 'idempotency-recovery-v1']));
  });
});
