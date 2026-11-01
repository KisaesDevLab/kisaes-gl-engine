// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-146 (ClientLedger checkpoint PR-3 review): an invoice's client can't
// move while anything points at it (B1); cash basis after a bounced
// payment's invoice is voided (B2); lock order and deadlocks as 409 RETRY
// (S1); the bounce audit carries discounts and write-offs (S3); cash Sales
// by Customer / Item after a discounted payment bounces (S4); an edit down
// to the amount paid makes the invoice paid (N2).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// First: it wraps only the route layers created after it loads.
import 'express-async-errors';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog, financeChargeAssessments, financeChargeRuns, financeChargeSources } from '../db/schema/index.js';
import { paymentsRouter } from './payments.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { customerRefundsRouter } from './customer-refunds.routes.js';
import * as ledger from '../services/ledger.service.js';
import { arOpenItemsAsOf } from '../services/ar-open-items.js';
import { cashBasisLinesWith, buildSalesByCustomer, buildSalesByItem } from '../services/report.service.js';
import { deadlockAsRetry, isDeadlock } from '../utils/deadlock.js';
import { AppError } from '../utils/errors.js';
import { Harness, type Co, key, txn, contactAR, m2 } from './receivables.test-support.js';
import DecimalLib from 'decimal.js';

const Decimal = DecimalLib.default || DecimalLib;
const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [async (tid) => {
    await db.delete(financeChargeSources).where(eq(financeChargeSources.tenantId, tid));
    await db.delete(financeChargeAssessments).where(eq(financeChargeAssessments.tenantId, tid));
    await db.delete(financeChargeRuns).where(eq(financeChargeRuns.tenantId, tid));
  }];
  await h.start([
    ['/api/v1/payments', paymentsRouter], ['/api/v1/credit-memos', creditMemosRouter], ['/api/v1/transactions', transactionsRouter],
    ['/api/v1/invoices', invoicesRouter], ['/api/v1/customer-refunds', customerRefundsRouter],
  ]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const line = (amount: string, extra: Record<string, unknown> = {}) =>
  ({ accountId: c.roles['income'], description: 'Work', quantity: '1', unitPrice: amount, isTaxable: false, ...extra });

async function putInvoice(id: string, contactId: string, amount: string, extra: Record<string, unknown> = {}) {
  const inv = await txn(id);
  return h.request('PUT', `/api/v1/invoices/${id}`, c.token, {
    contactId, txnDate: inv.txnDate, expectedUpdatedAt: inv.updatedAt!.toISOString(), lines: [line(amount)], ...extra,
  }, { 'Idempotency-Key': key() });
}

/** Each client's open items (aging / statements) = its A/R from posted lines (Client Center). */
async function expectAgingEqualsLedger(asOf: string) {
  const items = await arOpenItemsAsOf(db, { tenantId: c.tenantId, companyId: c.companyId, asOf });
  for (const contactId of [c.customer, c.other]) {
    const open = items.filter((i) => i.contactId === contactId).reduce((s, i) => s.plus(i.openExact), new Decimal(0));
    expect(m2(open.toFixed(4)), contactId === c.customer ? 'customer' : 'other').toBe(await contactAR(c, contactId, asOf));
  }
}

/** Σ(debit - credit) of the cash-basis virtual ledger as of a date (0 = balanced) and its A/R. */
async function cashLedger(asOf: string) {
  const res = await db.execute(sql`
    WITH ${cashBasisLinesWith(c.tenantId, null, asOf, c.companyId)}
    SELECT COALESCE(SUM(cb.debit - cb.credit), 0)::text AS net,
      COALESCE(SUM(CASE WHEN cb.account_id = ${c.roles['accounts_receivable']} THEN cb.debit - cb.credit ELSE 0 END), 0)::text AS ar
    FROM cb_lines cb`);
  const r = (res.rows as Array<{ net: string; ar: string }>)[0]!;
  return { net: m2(r.net), ar: m2(r.ar) };
}

async function accrualAR(asOf: string) {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS b FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${c.tenantId} AND jl.account_id = ${c.roles['accounts_receivable']} AND t.status = 'posted' AND t.txn_date <= ${asOf}::date`);
  return m2((res.rows as Array<{ b: string }>)[0]!.b);
}

describe('B1: an invoice keeps its client while anything points at it', () => {
  it('a live payment or credit: 409 INVOICE_HAS_PAYMENTS on PUT /invoices and the ledger path; after unapply the move is allowed; aging = ledger throughout', async () => {
    const inv = await h.invoice(c, { date: '2026-10-01', total: '1000.00' });
    const pay = await h.receive(c, { date: '2026-10-05', amount: '400.00', applications: [{ invoiceId: inv, amount: '400.00' }] });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    await expectAgingEqualsLedger('2026-10-31');

    const moved = await putInvoice(inv, c.other, '1000.00');
    expect([moved.status, moved.json['error']?.code]).toEqual([409, 'INVOICE_HAS_PAYMENTS']);
    expect(moved.json['error'].details).toEqual({ payments: 1, credits: 0 });
    await expect(ledger.updateTransaction(c.tenantId, inv, {
      txnType: 'invoice', txnDate: '2026-10-01', contactId: c.other,
      lines: [{ accountId: c.roles['accounts_receivable']!, debit: '1000', credit: '0' }, { accountId: c.roles['income']!, debit: '0', credit: '1000' }],
    } as never, c.userId, c.companyId)).rejects.toMatchObject({ statusCode: 409, code: 'INVOICE_HAS_PAYMENTS' });
    expect((await txn(inv)).contactId).toBe(c.customer);
    await expectAgingEqualsLedger('2026-10-31');

    // Same client, other figures: allowed.
    const same = await putInvoice(inv, c.customer, '900.00');
    expect(same.status, JSON.stringify(same.json)).toBe(200);
    await expectAgingEqualsLedger('2026-10-31');

    // A credit memo applied: refused too.
    const u = await h.request('POST', '/api/v1/payments/unapply', c.token, { paymentId: pay.json['payment'].id, invoiceId: inv });
    expect(u.status, JSON.stringify(u.json)).toBe(200);
    const memo = await h.request('POST', '/api/v1/credit-memos', c.token, {
      txnDate: '2026-10-06', contactId: c.customer, lines: [line('50.00')], applications: [{ invoiceId: inv, amount: '50.00' }],
    });
    expect(memo.status, JSON.stringify(memo.json)).toBe(201);
    const byMemo = await putInvoice(inv, c.other, '900.00');
    expect([byMemo.status, byMemo.json['error']?.code, byMemo.json['error']?.details]).toEqual([409, 'INVOICE_HAS_PAYMENTS', { payments: 1, credits: 0 }]);

    // Nothing applied any more: the client may move, and both clients still tie.
    const um = await h.request('POST', `/api/v1/credit-memos/${memo.json['creditMemo'].id}/unapply`, c.token, {
      invoiceId: inv, expectedUpdatedAt: memo.json['creditMemo'].updatedAt,
    });
    expect(um.status, JSON.stringify(um.json)).toBe(200);
    const ok = await putInvoice(inv, c.other, '900.00');
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect((await txn(inv)).contactId).toBe(c.other);
    await expectAgingEqualsLedger('2026-10-31');
  });

  it('an invoice with nothing applied can change its client', async () => {
    const inv = await h.invoice(c, { date: '2026-10-01', total: '100.00' });
    const r = await putInvoice(inv, c.other, '100.00');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    await expectAgingEqualsLedger('2026-10-31');
  });
});

describe('B2: cash basis after a bounced payment\'s invoice is voided', () => {
  it('the cash ledger balances on every month end, and cash A/R = accrual A/R on the payment\'s month end', async () => {
    const inv = await h.invoice(c, { date: '2026-01-05', total: '100.00' });
    const pay = await h.receive(c, { date: '2026-01-10', amount: '100.00', depositTo: c.roles['checking'], applications: [{ invoiceId: inv, amount: '100.00' }] });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    const b = await h.request('POST', `/api/v1/payments/${pay.json['payment'].id}/bounce`, c.token, { date: '2026-03-05' });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    const v = await h.request('POST', `/api/v1/transactions/${inv}/void`, c.token, { reason: 'wrong client' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    for (const asOf of ['2026-01-31', '2026-02-28', '2026-03-31']) {
      expect((await cashLedger(asOf)).net, asOf).toBe('0.00');
    }
    const jan = await cashLedger('2026-01-31');
    expect(jan.ar).toBe(await accrualAR('2026-01-31'));
    expect(jan.ar).toBe('-100.00');
    expect((await cashLedger('2026-03-31')).ar).toBe(await accrualAR('2026-03-31'));
  });
});

/** The payment_applications audit row written with afterData.via = via. */
async function auditVia(via: string) {
  const rows = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityType, 'payment_applications')));
  const row = rows.find((r) => (r.afterData as { via?: string } | null)?.via === via);
  expect(row, via).toBeDefined();
  return row!;
}

describe('S3 / S4: a bounced payment with a discount and a write-off', () => {
  it('S4: cash Sales by Customer and by Item net to 0', async () => {
    const i1 = await h.invoice(c, { date: '2026-10-01', total: '100.00' });
    const pay = await h.receive(c, {
      date: '2026-10-05', amount: '98.00', discountAccountId: c.roles['income'], applications: [{ invoiceId: i1, amount: '98.00', discountAmount: '2.00' }],
    });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    const b = await h.request('POST', `/api/v1/payments/${pay.json['payment'].id}/bounce`, c.token, { date: '2026-10-20' });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    const sbc = await buildSalesByCustomer(c.tenantId, '2026-10-01', '2026-10-31', c.companyId, null, 'cash') as any;
    expect(m2((sbc.data as any[]).reduce((s: number, r: any) => s + Number(r.total ?? 0), 0))).toBe('0.00');
    const sbi = await buildSalesByItem(c.tenantId, '2026-10-01', '2026-10-31', c.companyId, null, 'cash') as any;
    expect(m2(((sbi.data ?? []) as any[]).reduce((s: number, r: any) => s + Number(r.total ?? r.amount ?? 0), 0))).toBe('0.00');
  });

  it('S3: the bounce audit carries what it took back; cash sales still net to 0', async () => {
    const inv = await h.invoice(c, { date: '2026-10-01', total: '100.00' });
    const inv2 = await h.invoice(c, { date: '2026-10-01', total: '50.00' });
    const pay = await h.receive(c, {
      date: '2026-10-05', amount: '147.50', discountAccountId: c.roles['income'], writeOffAccountId: c.roles['expense'],
      applications: [{ invoiceId: inv, amount: '98.00', discountAmount: '2.00' }, { invoiceId: inv2, amount: '49.50', writeOffAmount: '0.50' }],
    });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    const b = await h.request('POST', `/api/v1/payments/${pay.json['payment'].id}/bounce`, c.token, { date: '2026-10-20' });
    expect(b.status, JSON.stringify(b.json)).toBe(201);

    const bounceAudit = await auditVia('bounce');
    const before = (bounceAudit!.beforeData as { applications: Array<Record<string, unknown>> }).applications;
    const byInvoice = new Map(before.map((a) => [a['invoiceId'], a]));
    expect(byInvoice.get(inv)).toMatchObject({ amount: '98.0000', discount: '2.0000', discountAccountId: c.roles['income'], writeOff: '0.0000', appliedDate: null });
    expect(byInvoice.get(inv2)).toMatchObject({ amount: '49.5000', discount: '0.0000', writeOff: '0.5000', writeOffAccountId: c.roles['expense'] });

    const sbc = await buildSalesByCustomer(c.tenantId, '2026-10-01', '2026-10-31', c.companyId, null, 'cash') as any;
    const total = (sbc.data ?? sbc.rows ?? sbc.customers ?? []).reduce((s: number, r: any) => s + Number(r.total ?? 0), 0);
    expect(m2(total)).toBe('0.00');
    const sbi = await buildSalesByItem(c.tenantId, '2026-10-01', '2026-10-31', c.companyId, null, 'cash') as any;
    const itemTotal = (sbi.data ?? sbi.rows ?? sbi.items ?? []).reduce((s: number, r: any) => s + Number(r.total ?? r.amount ?? 0), 0);
    expect(m2(itemTotal)).toBe('0.00');

    // Voiding the bounce re-applies: its audit entry carries the same detail.
    const v = await h.request('POST', `/api/v1/transactions/${b.json['returnId']}/void`, c.token, { reason: 'bank error' });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    const voidAudit = await auditVia('void_bounce');
    const after = (voidAudit!.afterData as { applications: Array<Record<string, unknown>> }).applications;
    expect(after.find((a) => a['invoiceId'] === inv)).toMatchObject({ discount: '2.0000', discountAccountId: c.roles['income'] });
  });
});

describe('N2: an edit down to exactly the amount paid', () => {
  it('makes the invoice paid with 0.00 due, not partial', async () => {
    const inv = await h.invoice(c, { date: '2026-10-01', total: '100.00' });
    const pay = await h.receive(c, { date: '2026-10-05', amount: '60.00', applications: [{ invoiceId: inv, amount: '60.00' }] });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    expect((await txn(inv)).invoiceStatus).toBe('partial');
    const r = await putInvoice(inv, c.customer, '60.00');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const row = await txn(inv);
    expect([row.invoiceStatus, m2(row.balanceDue)]).toEqual(['paid', '0.00']);
    expect(row.paidAt).not.toBeNull();
  });
});

describe('S1: lock order and deadlocks', () => {
  it('a credit memo applied at save racing Receive Payment on the same invoice never fails with 500', async () => {
    for (let i = 0; i < 4; i++) {
      const inv = await h.invoice(c, { date: '2026-10-01', total: '100.00' });
      const [memo, pay] = await Promise.all([
        h.request('POST', '/api/v1/credit-memos', c.token, {
          txnDate: '2026-10-02', contactId: c.customer, lines: [line('100.00')], applications: [{ invoiceId: inv, amount: '100.00' }],
        }, { 'Idempotency-Key': key() }),
        h.receive(c, { date: '2026-10-02', amount: '100.00', depositTo: c.roles['checking'], applications: [{ invoiceId: inv, amount: '100.00' }] },
          { 'Idempotency-Key': key() }),
      ]);
      for (const r of [memo, pay]) expect([200, 201, 400, 409], JSON.stringify(r.json)).toContain(r.status);
      // Exactly one of them paid the invoice.
      expect([memo.status, pay.status].filter((s) => s === 201)).toHaveLength(1);
      expect(m2((await txn(inv)).balanceDue)).toBe('0.00');
    }
  });

  it('a refund and a payment to the same bank account at once never fail with 500', async () => {
    for (let i = 0; i < 4; i++) {
      const memo = await h.request('POST', '/api/v1/credit-memos', c.token, { txnDate: '2026-10-02', contactId: c.customer, lines: [line('30.00')] });
      expect(memo.status, JSON.stringify(memo.json)).toBe(201);
      const inv = await h.invoice(c, { date: '2026-10-01', total: '20.00' });
      const [refund, pay] = await Promise.all([
        h.request('POST', '/api/v1/customer-refunds', c.token, {
          txnDate: '2026-10-03', contactId: c.customer, refundFromAccountId: c.roles['checking'], amount: '30.00',
          sourceId: memo.json['creditMemo'].id, paymentMethod: 'cash',
        }, { 'Idempotency-Key': key() }),
        h.receive(c, { date: '2026-10-03', amount: '20.00', depositTo: c.roles['checking'], applications: [{ invoiceId: inv, amount: '20.00' }] },
          { 'Idempotency-Key': key() }),
      ]);
      expect(refund.status, JSON.stringify(refund.json)).toBe(201);
      expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    }
  });

  it('a deadlock is 409 RETRY; other errors pass through', () => {
    const seen: unknown[] = [];
    const next = (e?: unknown) => { seen.push(e); };
    const dl = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    deadlockAsRetry(dl, {} as never, {} as never, next);
    deadlockAsRetry({ cause: { code: '40P01' } }, {} as never, {} as never, next);
    const other = new Error('x');
    deadlockAsRetry(other, {} as never, {} as never, next);
    expect(seen[0]).toBeInstanceOf(AppError);
    expect(seen[0]).toMatchObject({ statusCode: 409, code: 'RETRY' });
    expect(seen[1]).toMatchObject({ statusCode: 409, code: 'RETRY' });
    expect(seen[2]).toBe(other);
    expect(isDeadlock({ code: '23505' })).toBe(false);
  });
});
