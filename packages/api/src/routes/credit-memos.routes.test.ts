// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-137 (credit-memo-apply-v1, idempotency-credit-memo-v1) and U-142 / U-121
// A/R half (ar-open-items-asof-v1, ar-aging-exact-v1): credit memos as A/R
// credit sources, the P21 unapply fix, the date rules, the legacy pointer
// readers, the memo void branch, A/R open items and the exact aging.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// First: it wraps only the route layers created after it loads.
import 'express-async-errors';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, paymentApplications, transactions, auditLog, companies } from '../db/schema/index.js';
import { paymentsRouter } from './payments.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { arOpenItemsAsOf, ageOpenItems } from '../services/ar-open-items.js';
import { buildARAgingSummary, buildProfitAndLoss } from '../services/report.service.js';
import { getBalances } from '../services/contacts.service.js';
import * as ledger from '../services/ledger.service.js';
import { Harness, type Co, golden, key, txn, contactAR, accountBalance, m2 } from './receivables.test-support.js';

const h = new Harness();
let c: Co;

beforeEach(async () => {
  await h.start([
    ['/api/v1/payments', paymentsRouter], ['/api/v1/credit-memos', creditMemosRouter],
    ['/api/v1/transactions', transactionsRouter], ['/api/v1/invoices', invoicesRouter],
  ]);
  c = await h.company();
  await h.seed(c);
});
afterEach(async () => { await h.stop(); });

const A = () => c.invoices.get('A')!;
const B = () => c.invoices.get('B')!;
const bal = async (id: string) => m2((await txn(id)).balanceDue);

describe('credit-memo-apply-v1 (U-137)', () => {
  it('advertises the capabilities', () => {
    for (const cap of ['credit-memo-apply-v1', 'idempotency-credit-memo-v1', 'ar-open-items-asof-v1', 'ar-aging-exact-v1']) {
      expect(DESKTOP_CAPABILITIES).toContain(cap);
    }
  });

  it('a memo is an open credit; /apply fills oldest first with no GL lines; /unapply gives it back', async () => {
    const memo = await h.legacyMemo(c, '2026-11-02', '399.75');
    expect(await contactAR(c)).toBe('350.25');
    let cr = await h.request('GET', `/api/v1/payments/credits?customerId=${c.customer}`, c.token);
    expect(cr.status).toBe(200);
    expect(cr.json['data']).toEqual([{
      sourceId: memo, kind: 'credit_memo', date: '2026-11-02', number: (await txn(memo)).txnNumber, total: '399.75', remaining: '399.75',
    }]);
    const gl = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM journal_lines WHERE tenant_id = ${c.tenantId}`)).rows[0] as { n: number };
    const k = key();
    const body = { date: '2026-11-03', applications: [
      { invoiceId: A(), expectedBalanceDue: (await txn(A())).balanceDue }, { invoiceId: B(), expectedBalanceDue: (await txn(B())).balanceDue },
    ] };
    const r = await h.request('POST', `/api/v1/credit-memos/${memo}/apply`, c.token, body, { 'Idempotency-Key': k });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toEqual({ applied: [{ invoiceId: A(), amount: '250.00' }, { invoiceId: B(), amount: '149.75' }], remaining: '0.00' });
    // Replay: same key, nothing applied twice.
    const again = await h.request('POST', `/api/v1/credit-memos/${memo}/apply`, c.token, body, { 'Idempotency-Key': k });
    expect(again.status).toBe(200);
    expect([await bal(A()), await bal(B()), (await txn(A())).invoiceStatus]).toEqual(['0.00', '350.25', 'paid']);
    const gl2 = (await db.execute(sql`SELECT COUNT(*)::int AS n FROM journal_lines WHERE tenant_id = ${c.tenantId}`)).rows[0] as { n: number };
    expect(gl2.n).toBe(gl.n);
    expect(await contactAR(c)).toBe('350.25');
    cr = await h.request('GET', `/api/v1/payments/credits?customerId=${c.customer}`, c.token);
    expect(cr.json['data']).toEqual([]);

    const memoRow = await txn(memo);
    const u = await h.request('POST', `/api/v1/credit-memos/${memo}/unapply`, c.token,
      { invoiceId: B(), expectedUpdatedAt: memoRow.updatedAt!.toISOString() }, { 'Idempotency-Key': key() });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    expect(u.json).toEqual({ remaining: '149.75' });
    expect(await bal(B())).toBe('500.00');
    const stale = await h.request('POST', `/api/v1/credit-memos/${memo}/unapply`, c.token,
      { invoiceId: A(), expectedUpdatedAt: memoRow.updatedAt!.toISOString() });
    expect([stale.status, stale.json['error'].code]).toEqual([409, 'STALE']);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityId, memo)));
    expect(audits.length).toBeGreaterThanOrEqual(2);
  });

  it('over the remaining credit is 409 CREDIT_NOT_AVAILABLE; before the memo date 400 APPLY_DATE_BEFORE_SOURCE; another company 404', async () => {
    const memo = await h.legacyMemo(c, '2026-11-02', '100.00');
    let r = await h.request('POST', `/api/v1/credit-memos/${memo}/apply`, c.token,
      { date: '2026-11-03', applications: [{ invoiceId: A(), amount: '100.01' }] });
    expect([r.status, r.json['error'].code, r.json['error'].details?.remaining]).toEqual([409, 'CREDIT_NOT_AVAILABLE', '100.00']);
    r = await h.request('POST', `/api/v1/credit-memos/${memo}/apply`, c.token,
      { date: '2026-11-01', applications: [{ invoiceId: A(), amount: '10.00' }] });
    expect([r.status, r.json['error'].code]).toEqual([400, 'APPLY_DATE_BEFORE_SOURCE']);
    r = await h.request('POST', `/api/v1/credit-memos/${memo}/apply`, c.token,
      { date: '2026-11-03', applications: [{ invoiceId: A(), amount: '10.001' }] });
    expect(r.status).toBe(400);
    const other = await h.company();
    r = await h.request('POST', `/api/v1/credit-memos/${memo}/apply`, other.token,
      { date: '2026-11-03', applications: [{ invoiceId: A(), amount: '10.00' }] });
    expect(r.status).toBe(404);
    r = await h.request('GET', `/api/v1/payments/credits?customerId=${c.customer}`, other.token);
    expect(r.status).toBe(404);
  });

  it('a memo applied inside a receive (sourceId alias); a receive dated before the memo is refused', async () => {
    const memo = await h.legacyMemo(c, '2026-11-02', '100.00');
    let r = await h.receive(c, { date: '2026-11-01', amount: '50.00', applications: [{ invoiceId: A(), amount: '50.00' }],
      creditApplications: [{ sourceId: memo, invoiceId: A(), amount: '100.00' }] });
    expect([r.status, r.json['error']?.code]).toEqual([400, 'APPLY_DATE_BEFORE_SOURCE']);
    const pv = await h.request('POST', '/api/v1/payments/preview', c.token, { customerId: c.customer, date: '2026-11-05' });
    expect(pv.json['credits']).toEqual([expect.objectContaining({ sourcePaymentId: memo, kind: 'credit_memo', remaining: '100.00' })]);
    r = await h.receive(c, { date: '2026-11-05', amount: '50.00', applications: [{ invoiceId: A(), amount: '50.00' }],
      creditApplications: [{ sourceId: memo, invoiceId: A(), amount: '100.00' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(await bal(A())).toBe('100.00');
    const rows = await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, memo));
    expect(rows.map((x) => [x.appliedDate, x.appliedInTxnId])).toEqual([['2026-11-05', r.json['payment'].id]]);
    // Voiding the memo reopens what it settled; the receipt's own row stays.
    const v = await h.request('POST', `/api/v1/transactions/${memo}/void`, c.token, { reason: 'test' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(await bal(A())).toBe('200.00');
    expect(await contactAR(c)).toBe('700.00');
  });

  it('a memo void and a receipt void that used it run together without a deadlock (S1)', async () => {
    for (const order of [0, 1]) {
      const memo = await h.legacyMemo(c, '2026-11-02', '10.00');
      const r = await h.receive(c, { date: '2026-11-05', amount: '5.00', applications: [{ invoiceId: B(), amount: '5.00' }],
        creditApplications: [{ sourcePaymentId: memo, invoiceId: B(), amount: '10.00' }] });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      const before = await bal(B());
      const ids = order === 0 ? [memo, r.json['payment'].id] : [r.json['payment'].id, memo];
      const res = await Promise.all(ids.map((id) => h.request('POST', `/api/v1/transactions/${id}/void`, c.token, { reason: 'race' })));
      for (const x of res) expect([200, 409]).toContain(x.status);
      expect(res.some((x) => x.status === 200)).toBe(true);
      if (res.every((x) => x.status === 200)) expect(await bal(B())).toBe(m2(Number(before) + 15));
    }
  });

  it('memo void needs the closing password for an applied date in a closed period', async () => {
    const memo = await h.legacyMemo(c, '2026-11-02', '10.00');
    const r = await h.request('POST', `/api/v1/credit-memos/${memo}/apply`, c.token,
      { date: '2026-11-03', applications: [{ invoiceId: A() }] });
    expect(r.status).toBe(200);
    await db.update(companies).set({ lockDate: '2026-11-03' }).where(eq(companies.id, c.companyId));
    const v = await h.request('POST', `/api/v1/transactions/${memo}/void`, c.token, { reason: 'test' });
    expect(v.status).toBeGreaterThanOrEqual(400);
    expect(await bal(A())).toBe('240.00');
  });
});

describe('P21 unapply hole (B1a) and the date rules (B1b)', () => {
  it('unapply of a row with a write-off is 409 APPLICATION_HAS_ADJUSTMENTS; without one it works', async () => {
    const [wo] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Bad debts', accountType: 'expense', accountNumber: '69901' }).returning();
    const r = await h.receive(c, { date: '2026-11-03', amount: '249.00', writeOffAccountId: wo!.id,
      applications: [{ invoiceId: A(), amount: '249.00', writeOffAmount: '1.00' }, ] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const u = await h.request('POST', '/api/v1/payments/unapply', c.token, { paymentId: r.json['payment'].id, invoiceId: A() });
    expect([u.status, u.json['error'].code, u.json['error'].details]).toEqual([409, 'APPLICATION_HAS_ADJUSTMENTS', { invoiceId: A() }]);
    expect(await bal(A())).toBe('0.00');
    const r2 = await h.receive(c, { date: '2026-11-03', amount: '100.00', applications: [{ invoiceId: B(), amount: '100.00' }] });
    const u2 = await h.request('POST', '/api/v1/payments/unapply', c.token, { paymentId: r2.json['payment'].id, invoiceId: B() });
    expect(u2.status).toBe(200);
  });

  it('a payment PUT may not move its date after its credit was used: 400 SOURCE_DATE_AFTER_USE', async () => {
    const p = await h.receive(c, { date: '2026-11-03', amount: '300.00', applications: [] });
    const pid = p.json['payment'].id;
    const a = await h.request('POST', `/api/v1/payments/${pid}/apply`, c.token, { date: '2026-11-05', applications: [{ invoiceId: A() }] });
    expect(a.status, JSON.stringify(a.json)).toBe(200);
    let r = await h.request('PUT', `/api/v1/payments/${pid}`, c.token, {
      customerId: c.customer, date: '2026-11-06', depositTo: c.roles['payments_clearing'], amount: '300.00', applications: [],
    });
    expect([r.status, r.json['error'].code]).toEqual([400, 'SOURCE_DATE_AFTER_USE']);
    r = await h.request('PUT', `/api/v1/payments/${pid}`, c.token, {
      customerId: c.customer, date: '2026-11-04', depositTo: c.roles['payments_clearing'], amount: '300.00', applications: [],
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    r = await h.request('POST', `/api/v1/payments/${pid}/apply`, c.token, { date: '2026-11-01', applications: [{ invoiceId: B(), amount: '1.00' }] });
    expect([r.status, r.json['error'].code]).toEqual([400, 'APPLY_DATE_BEFORE_SOURCE']);
  });
});

describe('legacy credit memo pointers (Q-P22f)', () => {
  async function legacyPointer(total: string) {
    const memo = await h.legacyMemo(c, '2026-11-02', total);
    await db.update(transactions).set({ appliedToInvoiceId: A() }).where(eq(transactions.id, memo));
    return memo;
  }

  it('is an open credit with intendedInvoiceId while the invoice is open; the invoice can still be voided', async () => {
    const memo = await legacyPointer('40.00');
    const cr = await h.request('GET', `/api/v1/payments/credits?customerId=${c.customer}`, c.token);
    expect(cr.json['data'][0]).toMatchObject({ sourceId: memo, remaining: '40.00', intendedInvoiceId: A() });
    const rel = await h.request('GET', `/api/v1/transactions/${A()}/related`, c.token);
    if (rel.status === 200) expect((rel.json['related'] as Array<{ id: string }>).some((x) => x.id === memo)).toBe(false);
    const v = await h.request('POST', `/api/v1/transactions/${A()}/void`, c.token, { reason: 'test' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    const cr2 = await h.request('GET', `/api/v1/payments/credits?customerId=${c.customer}`, c.token);
    expect(cr2.json['data'][0].intendedInvoiceId).toBeUndefined();
  });

  it('POST /transactions credit_memo with appliedToInvoiceId writes a real application and stamps nothing', async () => {
    const memo = await h.legacyMemo(c, '2026-11-02', '300.00', { appliedToInvoiceId: A() });
    expect((await txn(memo)).appliedToInvoiceId).toBeNull();
    expect(await bal(A())).toBe('0.00');
    const rows = await db.select().from(paymentApplications).where(eq(paymentApplications.paymentId, memo));
    expect(rows.map((x) => [x.invoiceId, m2(x.amount), x.appliedDate])).toEqual([[A(), '250.00', null]]);
    const cr = await h.request('GET', `/api/v1/payments/credits?customerId=${c.customer}`, c.token);
    expect(cr.json['data'][0]).toMatchObject({ sourceId: memo, remaining: '50.00' });
    // An invoice with a live memo application can't be voided (U-124).
    const v = await h.request('POST', `/api/v1/transactions/${A()}/void`, c.token, { reason: 'test' });
    expect([v.status, v.json['error'].code]).toEqual([409, 'INVOICE_HAS_PAYMENTS']);
  });
});

describe('A/R open items and the exact aging (U-142)', () => {
  it('golden 5: statement aging = A/R aging = GL, and a later payment does not change it', async () => {
    const step = (golden['cases'] as Array<{ id: number; steps: Array<Record<string, any>> }>).find((x) => x.id === 5)!.steps;
    const want = step[2]!['expect'];
    await h.legacyMemo(c, '2026-11-02', '399.75');
    await h.receive(c, { date: '2026-11-30', amount: '50.00' });
    const check = async () => {
      const items = await arOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf: '2026-11-30', contactIds: [c.customer] });
      const aging = ageOpenItems(items, '2026-11-30');
      expect(aging.items.map((i) => [i.date, i.open, i.days, i.bucket])).toEqual(
        (want.openItems as Array<Record<string, unknown>>).map((i) => [i['date'], i['open'], i['days'], i['bucket']]));
      expect({ ...aging.buckets, total: aging.total }).toEqual(want.aging);
      expect(aging.difference).toBe('0.00');
      const summary = await buildARAgingSummary(c.tenantId, '2026-11-30', c.companyId);
      const row = summary.customers.find((x) => x.contactId === c.customer)!;
      expect(row.total).toBe(want.agingSummaryRow);
      expect({ ...row.buckets, total: row.total }).toEqual(want.aging);
      expect(await contactAR(c, c.customer, '2026-11-30')).toBe(want.contactBalance);
      expect(summary.totalExact).toBe(await accountBalance(c, c.roles['accounts_receivable']!, '2026-11-30'));
      expect(summary.total).toBe(Number(summary.totalExact));
    };
    await check();
    await h.receive(c, { date: '2026-12-03', amount: '100.00', applications: [{ invoiceId: A(), amount: '100.00' }] });
    await check();
  });

  it('GL property: Σ items = getBalances per client and Σ rows incl. "(no client)" = the A/R account, at every date', async () => {
    const [wo] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Bad debts', accountType: 'expense', accountNumber: '69902' }).returning();
    // An invoice dated after its payment (a prepayment applied later).
    const pre = await h.receive(c, { date: '2026-10-01', amount: '80.00' });
    const late = await h.invoice(c, { date: '2026-11-15', dueDate: '2026-12-15', total: '120.00' });
    expect((await h.request('POST', `/api/v1/payments/${pre.json['payment'].id}/apply`, c.token,
      { date: '2026-10-05', applications: [{ invoiceId: late }] })).status).toBe(200);
    // A discount/write-off row, then a pre-E1 unapply of it seeded by SQL (the GL keeps the write-off).
    const p = await h.receive(c, { date: '2026-10-25', amount: '240.00', writeOffAccountId: wo!.id,
      applications: [{ invoiceId: A(), amount: '240.00', writeOffAmount: '10.00' }] });
    expect(p.status, JSON.stringify(p.json)).toBe(201);
    await db.execute(sql`UPDATE payment_applications SET voided_at = now() WHERE payment_id = ${p.json['payment'].id}`);
    await db.execute(sql`UPDATE transactions SET amount_paid = 0, balance_due = total, invoice_status = 'sent' WHERE id = ${A()}`);
    // A memo applied inside a receive, a bounce, a JE to A/R with no client.
    const memo = await h.legacyMemo(c, '2026-11-02', '60.00');
    const r = await h.receive(c, { date: '2026-11-04', amount: '40.00', applications: [{ invoiceId: B(), amount: '40.00' }],
      creditApplications: [{ sourcePaymentId: memo, invoiceId: B(), amount: '60.00' }] });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const bounced = await h.receive(c, { date: '2026-11-06', amount: '25.00', depositTo: c.roles['operating'], applications: [{ invoiceId: B(), amount: '25.00' }] });
    const bnc = await h.request('POST', `/api/v1/payments/${bounced.json['payment'].id}/bounce`, c.token, { date: '2026-11-20' });
    expect(bnc.status, JSON.stringify(bnc.json)).toBe(201);
    await ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2026-11-10', lines: [
        { accountId: c.roles['accounts_receivable']!, debit: '7.00', credit: '0' },
        { accountId: c.roles['sales']!, debit: '0', credit: '7.00' },
      ],
    } as never, c.userId, c.companyId);

    for (const asOf of ['2026-09-30', '2026-10-03', '2026-10-31', '2026-11-05', '2026-11-10', '2026-11-19', '2026-11-20', '2026-12-31']) {
      const items = await arOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf });
      const sumFor = (id: string | null) => items.filter((i) => i.contactId === id).reduce((s, i) => s + Number(i.openExact), 0);
      expect(m2(sumFor(c.customer)), asOf).toBe(await contactAR(c, c.customer, asOf));
      const all = items.reduce((s, i) => s + Number(i.openExact), 0);
      expect(m2(all), asOf).toBe(await accountBalance(c, c.roles['accounts_receivable']!, asOf));
      const summary = await buildARAgingSummary(c.tenantId, asOf, c.companyId);
      expect(summary.totalExact, asOf).toBe(await accountBalance(c, c.roles['accounts_receivable']!, asOf));
      if (asOf >= '2026-11-10') expect(summary.customers.some((x) => x.contactId === null && x.name === '(no client)')).toBe(true);
    }
    // Subledger property, today: each invoice's item = its cent balance, except the pre-E1 unapplied write-off (A).
    const today = await arOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf: '2099-12-31', contactIds: [c.customer] });
    for (const id of [B(), late]) {
      const it = today.find((i) => i.txnId === id);
      expect(it?.open ?? '0.00').toBe(m2((await txn(id)).balanceDue));
    }
    const balances = await getBalances(c.tenantId, [c.customer], c.companyId);
    expect(m2(balances.get(c.customer)!.openBalance)).toBe(await contactAR(c));
  });

  it('cash basis: a credit memo applied at save is not cash; the invoice paid by money is', async () => {
    const memo = await h.legacyMemo(c, '2026-11-02', '100.00', { appliedToInvoiceId: A() });
    expect(memo).toBeTruthy();
    const pl = async () => (await buildProfitAndLoss(c.tenantId, '2026-01-01', '2026-12-31', 'cash', c.companyId) as { netIncome: number }).netIncome;
    expect(await pl()).toBe(0);
    await h.receive(c, { date: '2026-11-05', amount: '150.00', applications: [{ invoiceId: A(), amount: '150.00' }] });
    expect(await pl()).toBe(150);
  });
});
