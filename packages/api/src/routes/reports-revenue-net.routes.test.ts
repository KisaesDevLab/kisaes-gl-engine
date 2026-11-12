// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-216 (reports-revenue-net-v1, ClientLedger A08 Q-A08h): Revenue by
// Category totals each income account at its natural net (credits − debits),
// so a credit memo's or refund's debit to an income account reduces it and the
// report equals the P&L's income and other income, account by account, on
// both bases. Before, the summary summed credits only.
//
// Books (all through the engine's document services): invoices A (Sep 15,
// 250.00) and B (Oct 20, 500.00); a payment of A in full (Oct 5); credit memo
// CM1 (Nov 2, 150.00) applied to B; credit memo CM2 (Nov 3, 100.00) refunded
// 40.00 by check (Nov 6); a payment of B's rest, 350.00 (Nov 10); a journal
// entry to other income (Nov 12, 75.00) and one debiting it back (Nov 13,
// 20.00); a journal entry to a second income account that a later one
// reverses in full (a zero-net account, left out like the P&L does).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import { accounts } from '../db/schema/index.js';
import { db } from '../db/index.js';
import * as ledger from '../services/ledger.service.js';
import { buildAccountDetailReport, buildProfitAndLoss } from '../services/report.service.js';
import { ReportDecimal as Decimal } from '../services/report-exact.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { paymentsRouter } from './payments.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { customerRefundsRouter } from './customer-refunds.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { reportsRouter } from './reports.routes.js';
import { Harness, type Co } from './receivables.test-support.js';

const h = new Harness();
let c: Co;
let otherIncome = '';
let washIncome = '';

const D = (x: string | number | null | undefined) => new Decimal(String(x ?? 0)).toFixed(2);
const RANGES: Array<[string, string]> = [
  ['2026-01-01', '2026-12-31'],
  ['2026-11-01', '2026-11-30'],
  ['2026-10-01', '2026-10-31'],
];

async function ok(r: Promise<{ status: number; json: Record<string, any> }>, want = 201) {
  const x = await r;
  expect(x.status, JSON.stringify(x.json)).toBe(want);
  return x.json;
}

async function plIncome(from: string, to: string, basis: 'accrual' | 'cash') {
  const pl = await buildProfitAndLoss(c.tenantId, from, to, basis, null, null, null, { exactAmounts: true }) as unknown as
    { revenue: Array<{ accountId: string; amountExact: string }>; otherRevenue: Array<{ accountId: string; amountExact: string }> };
  const m: Record<string, string> = {};
  for (const e of [...pl.revenue, ...pl.otherRevenue]) {
    if (!new Decimal(e.amountExact).isZero()) m[e.accountId] = D(e.amountExact);
  }
  return m;
}

async function revenueByCategory(from: string, to: string, basis: 'accrual' | 'cash', exact: boolean) {
  const q = `start_date=${from}&end_date=${to}&basis=${basis}${exact ? '&exact=1' : ''}`;
  const r = await h.request('GET', `/api/v1/reports/revenue-by-category?${q}`, c.token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const rows = r.json['data'] as Array<{ account_id: string; total: string; totalExact?: string }>;
  return Object.fromEntries(rows.map((x) => [x.account_id, D(exact ? x.totalExact : x.total)]));
}

beforeAll(async () => {
  await h.start([
    ['/api/v1/payments', paymentsRouter], ['/api/v1/credit-memos', creditMemosRouter],
    ['/api/v1/customer-refunds', customerRefundsRouter], ['/api/v1/transactions', transactionsRouter],
    ['/api/v1/reports', reportsRouter],
  ]);
  c = await h.company();
  await h.seed(c);
  const [oi] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Interest Income U216', accountNumber: '4916', accountType: 'other_revenue' }).returning();
  otherIncome = oi!.id;
  const [wi] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Wash Income U216', accountNumber: '4917', accountType: 'revenue' }).returning();
  washIncome = wi!.id;

  const A = c.invoices.get('A')!;
  const B = c.invoices.get('B')!;
  await ok(h.receive(c, { date: '2026-10-05', amount: '250.00', depositTo: c.roles['operating'], applications: [{ invoiceId: A, amount: '250.00' }] }));
  const cm1 = await h.legacyMemo(c, '2026-11-02', '150.00');
  await ok(h.request('POST', `/api/v1/credit-memos/${cm1}/apply`, c.token, { date: '2026-11-02', applications: [{ invoiceId: B }] }), 200);
  const cm2 = await h.legacyMemo(c, '2026-11-03', '100.00');
  await ok(h.request('POST', '/api/v1/customer-refunds', c.token, {
    sourceId: cm2, txnDate: '2026-11-06', contactId: c.customer, amount: '40.00', paymentMethod: 'check', refundFromAccountId: c.roles['operating'],
  }));
  await ok(h.receive(c, { date: '2026-11-10', amount: '350.00', depositTo: c.roles['operating'], applications: [{ invoiceId: B, amount: '350.00' }] }));

  const je = (date: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
    ledger.postTransaction(c.tenantId, { txnType: 'journal_entry', txnDate: date, lines } as never, c.userId, c.companyId);
  const bank = c.roles['operating']!;
  await je('2026-11-12', [{ accountId: bank, debit: '75.00', credit: '0' }, { accountId: otherIncome, debit: '0', credit: '75.00' }]);
  await je('2026-11-13', [{ accountId: otherIncome, debit: '20.00', credit: '0' }, { accountId: bank, debit: '0', credit: '20.00' }]);
  await je('2026-11-14', [{ accountId: bank, debit: '30.00', credit: '0' }, { accountId: washIncome, debit: '0', credit: '30.00' }]);
  await je('2026-11-15', [{ accountId: washIncome, debit: '30.00', credit: '0' }, { accountId: bank, debit: '0', credit: '30.00' }]);
}, 120_000);

afterAll(async () => { await h.stop(); });

describe('Revenue by Category nets debits (reports-revenue-net-v1, U-216)', () => {
  it('advertises the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('reports-revenue-net-v1');
  });

  for (const basis of ['accrual', 'cash'] as const) {
    for (const [from, to] of RANGES) {
      it(`equals the P&L income per account (${basis}, ${from}..${to}; legacy and exact=1)`, async () => {
        const want = await plIncome(from, to, basis);
        expect(Object.keys(want).length).toBeGreaterThan(0);
        expect(await revenueByCategory(from, to, basis, false)).toEqual(want);
        expect(await revenueByCategory(from, to, basis, true)).toEqual(want);
      });
    }
  }

  it('the credit memos and the refund reduce income; a zero-net account is left out', async () => {
    const sales = c.roles['sales']!;
    // Accrual November: CM1 and CM2 debit Sales 250.00, nothing credits it.
    const accNov = await revenueByCategory('2026-11-01', '2026-11-30', 'accrual', true);
    expect(accNov[sales]).toBe('-250.00');
    expect(accNov[otherIncome]).toBe('55.00');
    expect(accNov[washIncome]).toBeUndefined();
    // Accrual year: invoices 750.00 − memos 250.00.
    expect((await revenueByCategory('2026-01-01', '2026-12-31', 'accrual', true))[sales]).toBe('500.00');
    // Cash year: received 600.00 − refunded 40.00 = net cash 560.00 (rule 3b).
    expect((await revenueByCategory('2026-01-01', '2026-12-31', 'cash', true))[sales]).toBe('560.00');
  });

  it("the summary total equals the detail subtotal; 'gross' keeps the normal-side sum", async () => {
    const opts = { title: 't', accountTypes: ['revenue', 'other_revenue'], normalSide: 'credit' as const, companyId: c.companyId };
    const net = await buildAccountDetailReport(c.tenantId, '2026-11-01', '2026-11-30', opts);
    const det = await buildAccountDetailReport(c.tenantId, '2026-11-01', '2026-11-30', { ...opts, detail: true, exactAmounts: true });
    if (!('groups' in det)) throw new Error('detail');
    const sub = Object.fromEntries(det.groups.filter((g) => !new Decimal(g.subtotalExact!).isZero()).map((g) => [g.accountId, D(g.subtotalExact)]));
    expect(Object.fromEntries((net.data as Array<{ account_id: string; total: string }>).map((r) => [r.account_id, D(r.total)]))).toEqual(sub);
    const gross = await buildAccountDetailReport(c.tenantId, '2026-11-01', '2026-11-30', { ...opts, summaryTotal: 'gross' });
    const g = Object.fromEntries((gross.data as Array<{ account_id: string; total: string }>).map((r) => [r.account_id, D(r.total)]));
    // Credits only: Sales has none in November; the wash account's 30.00 credit counts.
    expect(g).toEqual({ [otherIncome]: '75.00', [washIncome]: '30.00' });
  });
});
