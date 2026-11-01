// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-138 (credit-memo-edit-v1) and U-143 (sales-receipt-lines-v1): credit
// memos and sales receipts on the invoice line model; golden cases 1, 2, 7.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// First: it wraps only the route layers created after it loads.
import 'express-async-errors';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { paymentApplications, companies, transactions } from '../db/schema/index.js';
import { paymentsRouter } from './payments.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { salesReceiptsRouter } from './sales-receipts.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { buildSalesTaxLiability } from '../services/report.service.js';
import { getOrCreateSystemAccount } from '../services/system-accounts.service.js';
import { Harness, type Co, golden, key, txn, contactAR, lineSet, expectedLines, accountBalance, m2 } from './receivables.test-support.js';

const h = new Harness();
let c: Co;
type Step = Record<string, any>;
const caseSteps = (id: number) => (golden['cases'] as Array<{ id: number; steps: Step[] }>).find((x) => x.id === id)!.steps;

beforeEach(async () => {
  await h.start([
    ['/api/v1/payments', paymentsRouter], ['/api/v1/credit-memos', creditMemosRouter],
    ['/api/v1/sales-receipts', salesReceiptsRouter], ['/api/v1/transactions', transactionsRouter],
  ]);
  c = await h.company(golden['seed'].company.defaultSalesTaxRate);
  c.roles['sales_tax_payable'] = await getOrCreateSystemAccount(c.tenantId, 'sales_tax_payable', c.companyId);
  await h.seed(c);
});
afterEach(async () => { await h.stop(); });

const lines = (spec: unknown) => ((spec === 'memoLines' ? golden['memoLines'] : spec) as Step[])
  .map(({ account, ...rest }) => ({ accountId: c.roles[account], ...rest }));
const apps = (xs: Step[] | undefined) => xs?.map((a) => ({ invoiceId: c.invoices.get(a['invoice'])!, amount: a['amount'] }));
const bal = async (k: string) => m2((await txn(c.invoices.get(k)!)).balanceDue);

async function createMemo(req: Step, headers: Record<string, string> = {}) {
  return h.request('POST', '/api/v1/credit-memos', c.token, {
    txnDate: req['date'], contactId: c.customer, lines: lines(req['lines']), applications: apps(req['applications']),
  }, headers);
}

describe('credit-memo-edit-v1 (U-138)', () => {
  it('advertises the capabilities', () => {
    expect(DESKTOP_CAPABILITIES).toContain('credit-memo-edit-v1');
    expect(DESKTOP_CAPABILITIES).toContain('sales-receipt-lines-v1');
  });

  it('golden 1: items and tax preview = post; tax liability report = GL', async () => {
    const [pv, post] = caseSteps(1);
    const p = await h.request('POST', '/api/v1/credit-memos/preview', c.token, {
      txnDate: pv!['request'].date, contactId: c.customer, lines: lines(pv!['request'].lines),
    });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const e = pv!['expect'];
    expect([p.json['subtotal'], p.json['taxableBase'], p.json['taxTotal'], p.json['total'], p.json['remainingCredit']])
      .toEqual([e.subtotal, e.taxableBase, e.taxTotal, e.total, e.remainingCredit]);
    expect(p.json['suggestedApplications']).toEqual(apps(e.suggestedApplications));
    expect(p.json['problems']).toEqual([]);
    const r = await createMemo(post!['request'], { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const memo = r.json['creditMemo'];
    expect(memo.totals).toEqual({ subtotal: e.subtotal, taxTotal: e.taxTotal, total: e.total });
    expect(memo.remaining).toBe(post!['expect'].remaining);
    expect(await lineSet(c, memo.id)).toEqual(expectedLines(post!['expect'].lines));
    expect(await contactAR(c)).toBe(post!['expect'].contactBalance);
    const rep = await buildSalesTaxLiability(c.tenantId, '2026-11-01', '2026-11-30', c.companyId);
    expect([m2(rep.totalSales), m2(rep.totalTax)]).toEqual([
      post!['expect'].engineOnly.salesTaxLiability.totalSales, post!['expect'].engineOnly.salesTaxLiability.totalTax,
    ]);
    expect(m2(rep.totalTax)).toBe(m2(-Number(await accountBalance(c, c.roles['sales_tax_payable']!, '2026-11-30'))));
    const g = await h.request('GET', `/api/v1/credit-memos/${memo.id}`, c.token);
    expect(g.json['creditMemo'].lines.map((l: Step) => [l['amount'], l['taxAmount']])).toEqual([['300.00', '24.75'], ['75.00', '0.00']]);
  });

  it('golden 2: apply at save oldest first; rows dated with the memo; an injected failure rolls everything back', async () => {
    const [step] = caseSteps(2);
    const before = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM transactions WHERE tenant_id = ${c.tenantId}`)).rows[0] as { n: number };
    // A wrong expectedBalanceDue on the second invoice: 409 and nothing posts.
    const bad = await h.request('POST', '/api/v1/credit-memos', c.token, {
      txnDate: step!['request'].date, contactId: c.customer, lines: lines(step!['request'].lines),
      applications: [{ invoiceId: c.invoices.get('A'), amount: '250.00' }, { invoiceId: c.invoices.get('B'), amount: '149.75', expectedBalanceDue: '1.0000' }],
    });
    expect([bad.status, bad.json['error'].code]).toEqual([409, 'INVOICE_BALANCE_CHANGED']);
    const after = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM transactions WHERE tenant_id = ${c.tenantId}`)).rows[0] as { n: number };
    expect(after.n).toBe(before.n);
    expect(await bal('A')).toBe('250.00');
    const r = await createMemo(step!['request']);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const e = step!['expect'];
    expect(r.json['creditMemo'].remaining).toBe(e.remaining);
    expect([await bal('A'), await bal('B')]).toEqual([e.invoices.A, e.invoices.B]);
    expect([(await txn(c.invoices.get('A')!)).invoiceStatus, (await txn(c.invoices.get('B')!)).invoiceStatus]).toEqual([e.invoiceStatus.A, e.invoiceStatus.B]);
    expect(await contactAR(c)).toBe(e.contactBalance);
    const rows = await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, r.json['creditMemo'].id));
    expect(rows.every((x) => x.appliedDate === null)).toBe(true);
  });

  it('total 0.00 or less is 400; 3-place amounts are 400; billable fields are 400', async () => {
    let r = await h.request('POST', '/api/v1/credit-memos', c.token, { txnDate: '2026-11-02', contactId: c.customer,
      lines: [{ accountId: c.roles['sales'], quantity: '1', unitPrice: '-5.00' }] });
    expect([r.status, r.json['error'].code]).toEqual([400, 'CREDIT_MEMO_TOTAL_NOT_POSITIVE']);
    r = await h.request('POST', '/api/v1/credit-memos', c.token, { txnDate: '2026-11-02', contactId: c.customer,
      lines: [{ accountId: c.roles['sales'], quantity: '1', unitPrice: '5.00' }], applications: [{ invoiceId: c.invoices.get('A'), amount: '1.001' }] });
    expect(r.status).toBe(400);
    r = await h.request('POST', '/api/v1/credit-memos', c.token, { txnDate: '2026-11-02', contactId: c.customer,
      lines: [{ accountId: c.roles['sales'], quantity: '1', unitPrice: '5.00', markupPercent: '10' }] });
    expect([r.status, r.json['error'].code]).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('PUT: STALE, CREDIT_IN_USE (total and client), SOURCE_DATE_AFTER_USE, closing date', async () => {
    const r = await createMemo({ date: '2026-11-02', lines: [{ account: 'sales', quantity: '1', unitPrice: '100.00', isTaxable: false }] });
    const id = r.json['creditMemo'].id;
    const a = await h.request('POST', `/api/v1/credit-memos/${id}/apply`, c.token, { date: '2026-11-05', applications: [{ invoiceId: c.invoices.get('A'), amount: '60.00' }] });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    const rec = (await h.request('GET', `/api/v1/credit-memos/${id}`, c.token)).json['creditMemo'];
    const body = (over: Step) => ({ txnDate: '2026-11-02', contactId: c.customer, expectedUpdatedAt: rec.updatedAt,
      lines: [{ accountId: c.roles['sales'], quantity: '1', unitPrice: '100.00', isTaxable: false }], ...over });
    let p = await h.request('PUT', `/api/v1/credit-memos/${id}`, c.token, body({ lines: [{ accountId: c.roles['sales'], quantity: '1', unitPrice: '59.99', isTaxable: false }] }));
    expect([p.status, p.json['error'].code, p.json['error'].details]).toEqual([409, 'CREDIT_IN_USE', { inUse: '60.00' }]);
    p = await h.request('PUT', `/api/v1/credit-memos/${id}`, c.token, body({ contactId: c.other }));
    expect([p.status, p.json['error'].code]).toEqual([409, 'CREDIT_IN_USE']);
    p = await h.request('PUT', `/api/v1/credit-memos/${id}`, c.token, body({ txnDate: '2026-11-06' }));
    expect([p.status, p.json['error'].code]).toEqual([400, 'SOURCE_DATE_AFTER_USE']);
    p = await h.request('PUT', `/api/v1/credit-memos/${id}`, c.token, body({ expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }));
    expect([p.status, p.json['error'].code]).toEqual([409, 'STALE']);
    p = await h.request('PUT', `/api/v1/credit-memos/${id}`, c.token, body({ lines: [{ accountId: c.roles['sales'], quantity: '1', unitPrice: '80.00', isTaxable: false }] }));
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect([p.json['creditMemo'].totals.total, p.json['creditMemo'].remaining]).toEqual(['80.00', '20.00']);
    await db.update(companies).set({ lockDate: '2026-11-03' }).where(eq(companies.id, c.companyId));
    p = await h.request('PUT', `/api/v1/credit-memos/${id}`, c.token, body({ expectedUpdatedAt: p.json['creditMemo'].updatedAt }));
    expect(p.status).toBeGreaterThanOrEqual(400);
  });
});

describe('sales-receipt-lines-v1 (U-143)', () => {
  it('golden 7: an item with tax; preview = post; a negative receipt to Payments Clearing is refused', async () => {
    const [ok, neg] = caseSteps(7);
    const body = (s: Step) => ({ txnDate: s['request'].date, contactId: c.customer, depositToAccountId: c.roles[s['request'].depositTo], lines: lines(s['request'].lines) });
    const pv = await h.request('POST', '/api/v1/sales-receipts/preview', c.token, body(ok!));
    expect([pv.json['subtotal'], pv.json['taxTotal'], pv.json['total']]).toEqual([ok!['expect'].subtotal, ok!['expect'].taxTotal, ok!['expect'].total]);
    const r = await h.request('POST', '/api/v1/sales-receipts', c.token, body(ok!), { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json['salesReceipt'].totals.total).toBe(ok!['expect'].total);
    expect(await lineSet(c, r.json['salesReceipt'].id)).toEqual(expectedLines(ok!['expect'].lines));
    const np = await h.request('POST', '/api/v1/sales-receipts/preview', c.token, body(neg!));
    expect(np.json['problems']).toEqual([{ code: neg!['expect'].error }]);
    const n = await h.request('POST', '/api/v1/sales-receipts', c.token, body(neg!));
    expect([n.status, n.json['error'].code]).toEqual([neg!['expect'].status, neg!['expect'].error]);
    const toBank = await h.request('POST', '/api/v1/sales-receipts', c.token, { ...body(neg!), depositToAccountId: c.roles['operating'] });
    expect(toBank.status, JSON.stringify(toBank.json)).toBe(201);
    const id = r.json['salesReceipt'].id;
    const put = await h.request('PUT', `/api/v1/sales-receipts/${id}`, c.token, { ...body(ok!), memo: 'edited',
      expectedUpdatedAt: r.json['salesReceipt'].updatedAt });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json['salesReceipt'].memo).toBe('edited');
    expect((await txn(id)).txnType).toBe('cash_sale');
    const old = await h.request('POST', '/api/v1/transactions', c.token, { txnType: 'cash_sale', txnDate: '2026-11-04',
      depositToAccountId: c.roles['payments_clearing'], lines: [{ accountId: c.roles['sales'], quantity: '1', unitPrice: '10.00' }] });
    expect(old.status).toBe(201);
    expect(m2((await db.select().from(transactions).where(eq(transactions.id, old.json['transaction'].id)))[0]!.total)).toBe('10.00');
  });
});
