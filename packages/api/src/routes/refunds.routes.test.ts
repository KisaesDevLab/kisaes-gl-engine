// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-139 (refund-credit-memo-v1, refund-checks-v1): refunds of credit-memo
// credit and refunds by check; golden cases 3 and 4, races, rule 3b.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// First: it wraps only the route layers created after it loads.
import 'express-async-errors';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contacts } from '../db/schema/index.js';
import { paymentsRouter } from './payments.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { customerRefundsRouter } from './customer-refunds.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { checksRouter } from './checks.routes.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { buildProfitAndLoss } from '../services/report.service.js';
import { Harness, type Co, golden, key, txn, contactAR, lineSet, expectedLines, accountBalance, m2 } from './receivables.test-support.js';

const h = new Harness();
let c: Co;
type Step = Record<string, any>;
const caseSteps = (id: number) => (golden['cases'] as Array<{ id: number; steps: Step[] }>).find((x) => x.id === id)!.steps;

beforeEach(async () => {
  await h.start([
    ['/api/v1/payments', paymentsRouter], ['/api/v1/credit-memos', creditMemosRouter],
    ['/api/v1/customer-refunds', customerRefundsRouter], ['/api/v1/transactions', transactionsRouter],
    ['/api/v1/checks', checksRouter],
  ]);
  c = await h.company();
  await db.update(contacts).set({ billingLine1: '400 Bluestem Rd', billingCity: 'Neosho', billingState: 'MO', billingZip: '64850' })
    .where(eq(contacts.id, c.customer));
  await h.seed(c);
});
afterEach(async () => { await h.stop(); });

const remaining = async (memo: string) => (await h.request('GET', `/api/v1/credit-memos/${memo}`, c.token)).json['creditMemo']?.remaining
  ?? (await h.request('GET', `/api/v1/payments/credits?customerId=${c.customer}`, c.token)).json['data']
    .find((x: Step) => x['sourceId'] === memo)?.remaining ?? '0.00';

async function refund(memo: string, req: Step, headers: Record<string, string> = {}) {
  return h.request('POST', '/api/v1/customer-refunds', c.token, {
    sourceId: memo, txnDate: req['date'], contactId: c.customer, amount: req['amount'], paymentMethod: req['method'] ?? req['paymentMethod'],
    ...(req['printLater'] !== undefined ? { printLater: req['printLater'] } : {}), refundFromAccountId: c.roles[req['from']],
  }, headers);
}
const inQueue = async (id: string) => {
  const q = await h.request('GET', '/api/v1/checks/print-queue', c.token);
  const row = q.json['data'] as Step[];
  return row.find((x) => x['id'] === id);
};

describe('refund-credit-memo-v1 / refund-checks-v1 (U-139)', () => {
  it('advertises the capabilities', () => {
    expect(DESKTOP_CAPABILITIES).toContain('refund-credit-memo-v1');
    expect(DESKTOP_CAPABILITIES).toContain('refund-checks-v1');
  });

  it('golden 3: keep as credit, refund by check (print queue with the address), void gives it back', async () => {
    const steps = caseSteps(3);
    const bank0 = await accountBalance(c, c.roles['checking']!);
    const memo = await h.legacyMemo(c, '2026-11-02', '399.75');
    expect(await contactAR(c)).toBe(steps[0]!['expect'].contactBalance);
    const r = await refund(memo, steps[1]!['request'], { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json['transaction'].id;
    const e = steps[1]!['expect'];
    expect(await lineSet(c, id)).toEqual(expectedLines(e.lines));
    expect(await remaining(memo)).toBe(e.remaining);
    expect(await contactAR(c)).toBe(e.contactBalance);
    expect(m2(Number(await accountBalance(c, c.roles['checking']!)) - Number(bank0))).toBe(m2(-Number(steps[1]!['request'].amount)));
    const q = await inQueue(id);
    expect(!!q).toBe(!!e.printQueue && e.printQueue !== 'empty');
    expect(q?.['contactName'] ?? q?.['payeeNameOnCheck']).toBe(e.printQueue.payee);
    expect(q?.['payeeAddress']).toEqual(['400 Bluestem Rd', 'Neosho, MO 64850']);
    const rec = await h.request('GET', `/api/v1/customer-refunds/${id}`, c.token);
    expect(rec.json['refund']).toMatchObject({ amount: '399.75', printStatus: 'queue', source: { id: memo, kind: 'credit_memo' } });
    const list = await h.request('GET', '/api/v1/checks', c.token);
    expect((list.json['data'] as Step[]).some((x) => x['id'] === id)).toBe(true);
    // A memo with a live refund can't be voided.
    const vm = await h.request('POST', `/api/v1/transactions/${memo}/void`, c.token, { reason: 't' });
    expect([vm.status, vm.json['error'].code]).toEqual([409, 'CREDIT_REFUNDED']);
    const v = await h.request('POST', `/api/v1/transactions/${id}/void`, c.token, { reason: 't' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    const ev = steps[2]!['expect'];
    expect(await remaining(memo)).toBe(ev.remaining);
    expect(await contactAR(c)).toBe(ev.contactBalance);
    expect(!!(await inQueue(id))).toBe(ev.printQueue !== 'empty');
  });

  it('golden 4: partial refund, apply the rest, over-refund, void order', async () => {
    const steps = caseSteps(4);
    const memo = await h.legacyMemo(c, '2026-11-02', '399.75');
    const r1 = await refund(memo, steps[1]!['request']);
    expect(r1.status, JSON.stringify(r1.json)).toBe(201);
    expect(await remaining(memo)).toBe(steps[1]!['expect'].remaining);
    const a = await h.request('POST', `/api/v1/credit-memos/${memo}/apply`, c.token,
      { date: steps[2]!['request'].date, applications: [{ invoiceId: c.invoices.get('B') }] });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    expect(a.json['remaining']).toBe(steps[2]!['expect'].remaining);
    expect(m2((await txn(c.invoices.get('B')!)).balanceDue)).toBe(steps[2]!['expect'].invoices.B.balanceDue);
    const over = await refund(memo, steps[3]!['request']);
    expect([over.status, over.json['error'].code, over.json['error'].details.remaining]).toEqual([409, 'CREDIT_NOT_AVAILABLE', '0.00']);
    let vm = await h.request('POST', `/api/v1/transactions/${memo}/void`, c.token, { reason: 't' });
    expect([vm.status, vm.json['error'].code]).toEqual([409, 'CREDIT_REFUNDED']);
    const vr = await h.request('POST', `/api/v1/transactions/${r1.json['transaction'].id}/void`, c.token, { reason: 't' });
    expect(vr.status).toBe(200);
    expect(await remaining(memo)).toBe(steps[5]!['expect'].remaining);
    vm = await h.request('POST', `/api/v1/transactions/${memo}/void`, c.token, { reason: 't' });
    expect(vm.status, JSON.stringify(vm.json)).toBe(200);
    expect([m2((await txn(c.invoices.get('A')!)).balanceDue), m2((await txn(c.invoices.get('B')!)).balanceDue), await contactAR(c)])
      .toEqual(['250.00', '500.00', '750.00']);
  });

  it('two concurrent refunds of one memo: one wins, the other is CREDIT_NOT_AVAILABLE; a replay posts once', async () => {
    const memo = await h.legacyMemo(c, '2026-11-02', '100.00');
    const req = { date: '2026-11-05', amount: '80.00', paymentMethod: 'check', from: 'operating' };
    const res = await Promise.all([refund(memo, req), refund(memo, req)]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
    const k = key();
    const a = await refund(memo, { ...req, amount: '20.00' }, { 'Idempotency-Key': k });
    const b = await refund(memo, { ...req, amount: '20.00' }, { 'Idempotency-Key': k });
    expect([a.status, b.status, b.json['transaction']?.id]).toEqual([201, 201, a.json['transaction'].id]);
    expect(await remaining(memo)).toBe('0.00');
  });

  it('date before the source is 400; the account must be a bank account; a typed check number is checked', async () => {
    const memo = await h.legacyMemo(c, '2026-11-02', '100.00');
    let r = await refund(memo, { date: '2026-11-01', amount: '10.00', paymentMethod: 'check', from: 'operating' });
    expect([r.status, r.json['error'].code]).toEqual([400, 'REFUND_DATE_BEFORE_SOURCE']);
    r = await refund(memo, { date: '2026-11-03', amount: '10.00', paymentMethod: 'cash', from: 'payments_clearing' });
    expect([r.status, r.json['error'].code]).toEqual([400, 'REFUND_ACCOUNT_INVALID']);
    r = await h.request('POST', '/api/v1/customer-refunds', c.token, { sourceId: memo, txnDate: '2026-11-03', contactId: c.customer,
      amount: '10.00', paymentMethod: 'check', checkNumber: 5001, refundFromAccountId: c.roles['operating'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json['transaction'].checkNumber).toBe(5001);
    r = await h.request('POST', '/api/v1/customer-refunds', c.token, { sourceId: memo, txnDate: '2026-11-03', contactId: c.customer,
      amount: '10.00', paymentMethod: 'check', checkNumber: 5001, refundFromAccountId: c.roles['operating'] });
    expect([r.status, r.json['error'].code]).toEqual([409, 'CHECK_NUMBER_IN_USE']);
  });

  it('a held deposit refund by check also queues', async () => {
    const d = await h.receive(c, { date: '2026-11-01', amount: '50.00', depositTo: c.roles['operating'], holdAsDeposit: true });
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    const r = await h.request('POST', '/api/v1/customer-refunds', c.token, { sourceId: d.json['payment'].id, txnDate: '2026-11-03',
      contactId: c.customer, amount: '50.00', paymentMethod: 'check', refundFromAccountId: c.roles['operating'] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(!!(await inQueue(r.json['transaction'].id))).toBe(true);
  });

  it('cash basis rule 3b: income + tax = net cash (received - refunded)', async () => {
    const memo = await h.legacyMemo(c, '2026-11-02', '100.00');
    await h.receive(c, { date: '2026-11-03', amount: '250.00', depositTo: c.roles['operating'], applications: [{ invoiceId: c.invoices.get('A'), amount: '250.00' }] });
    const r = await refund(memo, { date: '2026-11-05', amount: '40.00', paymentMethod: 'check', from: 'operating' });
    expect(r.status).toBe(201);
    const pl = await buildProfitAndLoss(c.tenantId, '2026-01-01', '2026-12-31', 'cash', c.companyId) as { netIncome: number };
    expect(m2(pl.netIncome)).toBe('210.00');
  });
});
