// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-149 / U-152 (sales-tax-liability-v2, cash-basis-spf-v1, daily-sales-tax-v1):
// golden cases 6, 7, 8 (and 8b), 15 and the cash parts of 12-14 with SSUTA
// off (packages/shared/fixtures/sales-tax-golden.json); the cash Balance
// Sheet at every month end with no A/R or Customer Deposits from payments;
// the report ties to the GL on both bases; owed (S1); the Q-P23z diagnostic;
// the 0253 permission grant; scope.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  companies, contacts, items, accounts, transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes,
  salesTaxAgencies, dailySalesTemplates, dailySalesTemplateLines, dailySalesEntries, dailySalesEntryValues, billPaymentApplications,
  vendorCreditApplications, permissionTemplates, userPermissions,
} from '../db/schema/index.js';
import { salesTaxRouter, salesTaxReportsRouter } from './sales-tax.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { salesReceiptsRouter } from './sales-receipts.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { paymentsRouter } from './payments.routes.js';
import { customerRefundsRouter } from './customer-refunds.routes.js';
import { reportsRouter } from './reports.routes.js';
import { Harness, type Co, key, m2 } from './receivables.test-support.js';
import { cashBasisLinesWith, buildBalanceSheet, buildSalesByCustomer, buildSalesByItem } from '../services/report.service.js';
import * as dailySales from '../services/daily-sales.service.js';
import * as billService from '../services/bill.service.js';
import * as billPayments from '../services/bill-payment.service.js';
import * as vendorCredits from '../services/vendor-credit.service.js';
import * as deposits from '../services/deposit.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { resolveEffectivePermissions } from '@kis-books/shared';

type Body = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/sales-tax-golden.json'), 'utf8')) as Body;
const monett = golden['seeds'].monett as Body;
const gcase = (id: number) => (golden['cases'] as Body[]).find((c) => c['id'] === id)!;
const gstep = (id: number, i: number) => gcase(id)['steps'][i] as Body;

async function cleanSalesTax(tid: string) {
  const entries = await db.select({ id: dailySalesEntries.id }).from(dailySalesEntries).where(eq(dailySalesEntries.tenantId, tid));
  for (const e of entries) await db.delete(dailySalesEntryValues).where(eq(dailySalesEntryValues.entryId, e.id));
  for (const t of [dailySalesEntries, dailySalesTemplateLines, dailySalesTemplates, billPaymentApplications, vendorCreditApplications,
    transactionTaxLines, salesTaxPaymentLines, salesTaxGroupMembers, salesTaxItems, salesTaxCodes, salesTaxAgencies, permissionTemplates]) {
    await db.delete(t).where(eq(t.tenantId, tid));
  }
}

const h = new Harness();
let c: Co;
const ids = {
  taxes: new Map<string, string>(), codes: new Map<string, string>(), items: new Map<string, string>(), clients: new Map<string, string>(),
  agencies: new Map<string, string>(), docs: new Map<string, string>(), accts: new Map<string, string>(),
};

beforeEach(async () => {
  h.extraCleanup = [cleanSalesTax];
  await h.start([['/api/v1/sales-tax', salesTaxRouter], ['/api/v1/reports', salesTaxReportsRouter], ['/api/v1/reports', reportsRouter],
    ['/api/v1/invoices', invoicesRouter], ['/api/v1/credit-memos', creditMemosRouter], ['/api/v1/sales-receipts', salesReceiptsRouter],
    ['/api/v1/transactions', transactionsRouter], ['/api/v1/payments', paymentsRouter], ['/api/v1/customer-refunds', customerRefundsRouter]]);
  c = await h.company();
  for (const m of Object.values(ids)) m.clear();
});
afterEach(async () => { await h.stop(); });

const req = (method: string, p: string, body?: unknown) => h.request(method, p, c.token, body, method === 'GET' ? {} : { 'Idempotency-Key': key() });
const ok = (r: { status: number; json: Body }, status = 201) => { expect(r.status, JSON.stringify(r.json)).toBe(status); return r.json; };

/** The monett seed: agencies, taxes, codes, items, clients, accounts; SSUTA as asked. */
async function seed(ssuta = !!monett['ssuta']) {
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
  for (const cd of ok(await req('GET', '/api/v1/sales-tax/codes'), 200)['data'] as Body[]) ids.codes.set(cd['code'], cd['id']);
  for (const cd of monett['codes'] as Body[]) {
    if (!cd['system']) ids.codes.set(cd['code'], ok(await req('POST', '/api/v1/sales-tax/codes', { code: cd['code'], name: cd['name'], taxable: cd['taxable'] }))['id']);
  }
  for (const it of monett['items'] as Body[]) {
    const [row] = await db.insert(items).values({
      tenantId: c.tenantId, companyId: c.companyId, name: it['name'], incomeAccountId: c.roles['income']!, isTaxable: it['taxCode'] === 'Tax',
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
  ids.accts.set('operating_checking', c.roles['checking']!);
  ids.accts.set('income', c.roles['income']!);
  for (const [role, a] of Object.entries(monett['accounts'] as Record<string, Body>)) {
    if (role === 'operating_checking' || role === 'income') continue;
    const [row] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, name: a['name'], accountType: a['type'],
      detailType: a['type'] === 'expense' ? 'office_expenses' : a['type'] === 'revenue' ? 'service' : 'other_income',
    }).returning();
    ids.accts.set(role, row!.id);
  }
  await db.update(companies).set({ defaultSalesTaxId: ids.taxes.get(monett['companyDefault']), salesTaxSsuta: ssuta }).where(eq(companies.id, c.companyId));
}

const docBody = (r: Body) => ({
  contactId: ids.clients.get(r['client']), txnDate: r['date'],
  lines: (r['lines'] as Body[]).map((l) => ({ itemId: ids.items.get(l['item']), quantity: l['quantity'], unitPrice: l['unitPrice'] })),
});

async function invoice(r: Body) {
  const j = ok(await req('POST', '/api/v1/invoices', docBody(r)));
  const id = j['invoice']?.['id'] ?? j['id'];
  ids.docs.set(r['name'], id);
  return id as string;
}

async function receive(r: Body) {
  const body: Body = {
    customerId: ids.clients.get(r['client']), date: r['date'], amount: r['amount'], depositTo: ids.accts.get(r['depositTo']),
    applications: (r['applications'] as Body[]).map((a) => ({
      invoiceId: ids.docs.get(a['invoice']), amount: a['amount'],
      ...(a['discount'] ? { discountAmount: a['discount'] } : {}), ...(a['writeOff'] ? { writeOffAmount: a['writeOff'] } : {}),
    })),
    discountAccountId: ids.accts.get('sales_discounts'), writeOffAccountId: ids.accts.get('bad_debts'),
  };
  const j = ok(await req('POST', '/api/v1/payments/receive', body));
  ids.docs.set(r['name'], j['payment']['id']);
  return j['payment'] as Body;
}

/** The golden 6 daily sale through a template: sales (Springfield-taxable), tax linked to a sales tax, cash. */
async function dailySale(r: Body, preview: boolean) {
  let tplId = ids.docs.get('DS-TEMPLATE');
  if (!tplId) {
    const tpl = await dailySales.createTemplate(c.tenantId, { name: 'Register' } as never, c.userId, c.companyId);
    await dailySales.replaceTemplateLines(c.tenantId, tpl.id, [
      { section: 'sales', label: 'Sales', accountId: ids.accts.get('income'), normalSide: 'credit' },
      { section: 'tax', label: 'Sales tax', accountId: null, normalSide: 'credit', salesTaxId: ids.taxes.get(r['salesTax']) },
      { section: 'payment', label: 'Cash', accountId: c.roles['payments_clearing'], normalSide: 'debit' },
    ] as never, c.userId, c.companyId);
    tplId = tpl.id;
    ids.docs.set('DS-TEMPLATE', tplId);
  }
  const t = await dailySales.getTemplate(c.tenantId, tplId, c.companyId);
  const line = (section: string) => t.lines.find((l) => l.section === section && l.isActive)!;
  expect(line('tax').accountId).toBe(c.roles['sales_tax_payable']);
  const total = (Number(r['sales']) * 100 + Number(r['tax']) * 100) / 100;
  const values = [
    { templateLineId: line('sales').id, amount: r['sales'] },
    { templateLineId: line('tax').id, amount: r['tax'] },
    { templateLineId: line('payment').id, amount: total.toFixed(2) },
  ];
  const pv = await dailySales.previewEntry(c.tenantId, { templateId: tplId, values } as never, c.companyId);
  if (preview) return pv;
  const draft = await dailySales.createDraft(c.tenantId, { templateId: tplId, businessDate: r['date'], values } as never, c.userId, c.companyId);
  const posted = await dailySales.postEntry(c.tenantId, draft.id, c.userId, c.companyId);
  ids.docs.set(r['name'], String(posted.transactionId));
  return pv;
}

async function liability(r: Body, extra = '') {
  return ok(await req('GET', `/api/v1/reports/sales-tax-liability?start_date=${r['startDate']}&end_date=${r['endDate']}&basis=${r['basis']}${extra}`), 200);
}

/** Golden liability expectations: items by name (and agency when given). */
function expectLiability(got: Body, want: Body) {
  const all: Body[] = (got['agencies'] as Body[]).flatMap((a) => (a['items'] as Body[]).map((i): Body => ({ ...i, agency: a['name'] })));
  for (const w of want['items'] as Body[]) {
    const g = all.find((i) => i['name'] === w['item'] && (!w['agency'] || i['agency'] === w['agency']));
    expect(g, `item ${w['item']}`).toBeTruthy();
    for (const [k, v] of Object.entries(w)) {
      if (k === 'item' || k === 'agency') continue;
      if (k === 'nonTaxable') {
        expect(Object.fromEntries((g!['nonTaxable'] as Body[]).map((n) => [n['code'], n['amount']])), `${w['item']}.nonTaxable`).toEqual(v);
      } else {
        expect(g![k], `${w['item']}.${k}`).toBe(v);
      }
    }
  }
  for (const k of ['total', 'glMovement', 'otherEntries', 'unassigned', 'roundingDifference']) {
    if (want[k] !== undefined) expect(got[k], k).toBe(want[k]);
  }
}

/** The cash virtual ledger over a range, by golden role, natural sign (expense and asset debit-positive). */
async function cashLedger(start: string | null, end: string) {
  const res = await db.execute(sql`
    WITH ${cashBasisLinesWith(c.tenantId, start, end, c.companyId)}
    SELECT a.id, a.system_tag, a.account_type, COALESCE(SUM(cb.debit - cb.credit), 0)::text AS dr
    FROM cb_lines cb JOIN accounts a ON a.id = cb.account_id GROUP BY a.id, a.system_tag, a.account_type`);
  const out: Record<string, string> = {};
  let net = 0;
  for (const r of res.rows as Body[]) {
    const debitNormal = r['account_type'] === 'asset' || r['account_type'] === 'expense' || r['account_type'] === 'cost_of_goods_sold' || r['account_type'] === 'other_expense';
    const v = debitNormal ? Number(r['dr']) : -Number(r['dr']);
    const role = r['system_tag'] === 'unapplied_receipts' ? 'unapplied_receipts_income'
      : [...ids.accts.entries()].find(([, id]) => id === r['id'])?.[0] ?? r['system_tag'] ?? r['id'];
    out[role] = m2((Number(out[role] ?? 0) + v).toFixed(4));
    if (!['asset', 'liability', 'equity'].includes(r['account_type'])) net -= Number(r['dr']);
  }
  out['net'] = m2(net.toFixed(4));
  return out;
}

function expectLedger(got: Record<string, string>, want: Body) {
  for (const [k, v] of Object.entries(want)) {
    if (k === 'note') continue;
    expect(got[k] ?? '0.00', k).toBe(v);
  }
}

/** The report ties to the GL: no other entries in the range or cumulatively. */
async function expectTies(startDate: string, endDate: string) {
  for (const basis of ['accrual', 'cash']) {
    const r = await liability({ startDate, endDate, basis });
    expect([basis, r['otherEntries']]).toEqual([basis, '0.00']);
    expect([basis, r['balanceCheck']['otherEntriesCumulative']]).toEqual([basis, '0.00']);
  }
}

describe('golden chain 1-6, 8, 7 (monett): liability on both bases and pure-cash receipts', () => {
  it('runs the chain', async () => {
    await seed();
    // 1-3 invoices, 4 credit memo, 5 sales receipt (E1 checks their figures).
    await invoice(gstep(1, 0)['request']);
    await invoice(gstep(2, 0)['request']);
    await invoice(gstep(3, 0)['request']);
    const cm = gstep(4, 0)['request'];
    ok(await req('POST', '/api/v1/credit-memos', { ...docBody(cm), applications: [] }));
    const sr = gstep(5, 0)['request'];
    ok(await req('POST', '/api/v1/sales-receipts', { ...docBody(sr), depositToAccountId: c.roles['payments_clearing'] }));

    // 6: INV-F (Res), daily sales (TAX_DIFFERS preview, then 17.75), INV-G; accrual November.
    await invoice(gstep(6, 0)['request']);
    const differs = await dailySale(gstep(6, 1)['request'], true);
    expect([differs.expectedTax, differs.problems]).toEqual([gstep(6, 1)['expect']['expectedTax'], gstep(6, 1)['expect']['problems']]);
    const ds = await dailySale(gstep(6, 2)['request'], false);
    expect([ds.expectedTax, ds.problems]).toEqual([gstep(6, 2)['expect']['expectedTax'], gstep(6, 2)['expect']['problems']]);
    const dsRows = await db.select().from(transactionTaxLines).where(eq(transactionTaxLines.transactionId, ids.docs.get('DS')!));
    expect(dsRows.map((r) => [r.taxItemId, m2(r.base), m2(r.tax)])).toEqual([[ids.taxes.get('Springfield'), '200.00', '17.75']]);
    await invoice(gstep(6, 3)['request']);
    expectLiability(await liability(gstep(6, 4)['request']), gstep(6, 4)['expect']);

    // 8: pure-cash receipts.
    const s8 = gcase(8)['steps'] as Body[];
    expect((await receive(s8[0]!['request']))['unappliedRemaining']).toBe(s8[0]!['expect']['unapplied']);
    const bs1027 = await cashLedger(null, s8[1]!['request']['asOf']);
    expectLedger(bs1027, s8[1]!['expect']);
    const a8 = s8[2]!['request'];
    ok(await req('POST', `/api/v1/payments/${ids.docs.get(a8['payment'])}/apply`, {
      date: a8['date'], applications: [{ invoiceId: ids.docs.get(a8['invoice']), amount: a8['amount'] }],
    }), 200);
    const dep = s8[3]!['request'];
    const depJ = ok(await req('POST', '/api/v1/payments/receive', {
      customerId: ids.clients.get(dep['client']), date: dep['date'], amount: dep['amount'], depositTo: ids.accts.get(dep['depositTo']),
      applications: [], holdAsDeposit: true,
    }));
    ids.docs.set(dep['name'], depJ['payment']['id']);
    await invoice(s8[4]!['request']);
    const draw = s8[5]!['request'];
    ok(await req('POST', `/api/v1/payments/${ids.docs.get(draw['deposit'])}/apply`, {
      date: draw['date'], applications: [{ invoiceId: ids.docs.get(draw['invoice']), amount: draw['amount'] }],
    }), 200);
    expectLiability(await liability(s8[6]!['request']), s8[6]!['expect']);
    expectLedger(await cashLedger(s8[7]!['request']['startDate'], s8[7]!['request']['endDate']), s8[7]!['expect']);
    const bs = await buildBalanceSheet(c.tenantId, s8[8]!['request']['asOf'], 'cash', c.companyId);
    expectLedger(await cashLedger(null, s8[8]!['request']['asOf']), { operating_checking: s8[8]!['expect']['operating_checking'],
      sales_tax_payable: s8[8]!['expect']['sales_tax_payable'], accounts_receivable: '0.00', customer_deposits: '0.00' });
    expect(m2(bs.totalEquity)).toBe(s8[8]!['expect']['equity']);
    expect(m2(bs.totalAssets)).toBe(m2(bs.totalLiabilities + bs.totalEquity));
    expectLedger(await cashLedger(s8[9]!['request']['startDate'], s8[9]!['request']['endDate']), s8[9]!['expect']);
    expect((await receive(s8[10]!['request']))['unappliedRemaining']).toBe(s8[10]!['expect']['unapplied']);
    const rf = s8[11]!['request'];
    ok(await req('POST', '/api/v1/customer-refunds', {
      txnDate: rf['date'], contactId: ids.clients.get(rf['client']), refundFromAccountId: ids.accts.get(rf['from']), amount: rf['amount'],
      sourceId: ids.docs.get(rf['source']),
    }));
    expectLedger(await cashLedger(s8[12]!['request']['startDate'], s8[12]!['request']['endDate']), s8[12]!['expect']);

    // 7: the running total.
    const s7 = gcase(7)['steps'] as Body[];
    for (const k of [0, 1, 2]) await receive(s7[k]!['request']);
    const nov = await liability(s7[3]!['request']);
    expectLiability(nov, s7[3]!['expect']);
    expectLiability(await liability(s7[4]!['request']), s7[4]!['expect']);

    // The report ties to the GL on both bases, every month and cumulatively.
    for (const [s, e] of [['2026-10-01', '2026-10-31'], ['2026-11-01', '2026-11-30'], ['2026-12-01', '2026-12-31']]) await expectTies(s!, e!);
    // The cash Balance Sheet balances at every month end and shows no A/R or Customer Deposits.
    for (const asOf of ['2026-09-30', '2026-10-31', '2026-11-30', '2026-12-31']) {
      const b = await buildBalanceSheet(c.tenantId, asOf, 'cash', c.companyId);
      expect(m2(b.totalAssets), asOf).toBe(m2(b.totalLiabilities + b.totalEquity));
      const led = await cashLedger(null, asOf);
      expect([asOf, led['accounts_receivable'] ?? '0.00', led['customer_deposits'] ?? '0.00']).toEqual([asOf, '0.00', '0.00']);
    }
    // Invoices settled by payments only: cash collected over all time = accrual collected (INV-E).
    const all = { startDate: '2026-01-01', endDate: '2026-12-31' };
    const pick = (r: Body) => (r['agencies'] as Body[]).flatMap((a) => a['items'] as Body[]).find((i) => i['name'] === 'Springfield')!;
    const cashAll = pick(await liability({ ...all, basis: 'cash' }));
    const accAll = pick(await liability({ ...all, basis: 'accrual' }));
    // Springfield accrual includes INV-F (Res, no tax) and nothing unpaid with tax: the totals agree.
    expect(cashAll['collected']).toBe(accAll['collected']);
    expect(cashAll['owedAtEnd']).toBe(accAll['owedAtEnd']);

    // GET /sales-tax/owed: the same figures as the report's owedAtEnd.
    const owed = ok(await req('GET', `/api/v1/sales-tax/owed?asOf=2026-11-30&basis=accrual&agencyId=${ids.agencies.get('Sample State Revenue Dept.')}`), 200);
    expect(owed['agencies'].map((a: Body) => a['items'].map((i: Body) => [i['name'], i['owed']]))).toEqual([[['State', '80.70'], ['Springfield', '131.68']]]);
    expect(owed['total']).toBe('212.38');
  });

  it('8b: a payment applied at save recognises income and tax on the payment date', async () => {
    await seed();
    const v = (gcase(8)['variants'] as Body[])[0]!;
    await invoice(v['steps'][0]['request']);
    expect((await receive(v['steps'][1]['request']))['unappliedRemaining']).toBe(v['steps'][1]['expect']['unapplied']);
    expectLiability(await liability(v['steps'][2]['request']), v['steps'][2]['expect']);
  });
});

describe('SSUTA off (the default for existing and MyBooks Online companies): discounts and write-offs', () => {
  it('golden 12 (SSUTA off): the discount carries no tax; owed 35.50 on accrual, collected 35.50 on cash', async () => {
    await seed(false);
    const v = (gcase(12)['variants'] as Body[])[0]!;
    await invoice(v['steps'][0]['request']);
    await receive(v['steps'][1]['request']);
    expectLiability(await liability(v['steps'][2]['request']), v['steps'][2]['expect']);
    expectLiability(await liability({ ...v['steps'][2]['request'], basis: 'cash' }), { items: [{ item: 'Springfield', collected: '35.50', discounts: '0.00', owedAtEnd: '35.50' }] });
    await expectTies('2026-11-01', '2026-11-30');
  });

  it('golden 13 (cash part): a write-off never shows on cash; collected 8.15 on 91.85', async () => {
    await seed(false);
    const s = gcase(13)['steps'] as Body[];
    await invoice(s[0]!['request']);
    await receive(s[1]!['request']);
    expectLiability(await liability(s[3]!['request']), s[3]!['expect']);
    expectLedger(await cashLedger(s[4]!['request']['startDate'], s[4]!['request']['endDate']), s[4]!['expect']);
    expectLiability(await liability(s[2]!['request']), { items: [{ item: 'Springfield', collected: '17.75', badDebts: '0.00', owedAtEnd: '17.75' }] });
    await expectTies('2026-11-01', '2026-11-30');
    // Cash Sales by Customer / P&L carry no bad-debt expense.
    const led = await cashLedger('2026-11-01', '2026-11-30');
    expect(led['bad_debts'] ?? '0.00').toBe('0.00');
  });

  it('golden 14 (SSUTA off): a bounce takes the cash collection back', async () => {
    await seed(false);
    const s = gcase(14)['steps'] as Body[];
    await invoice(s[0]!['request']);
    await receive(s[1]!['request']);
    ok(await req('POST', `/api/v1/payments/${ids.docs.get('PMT-H')}/bounce`, { date: s[2]!['request']['date'] }));
    expectLiability(await liability(s[3]!['request']), s[3]!['expect']);
    expectLiability(await liability(s[4]!['request']), s[4]!['expect']);
    await expectTies('2026-11-01', '2026-11-30');
    const b = await buildBalanceSheet(c.tenantId, '2026-11-30', 'cash', c.companyId);
    expect(m2(b.totalAssets)).toBe(m2(b.totalLiabilities + b.totalEquity));
  });
});

describe('golden 15: bill discounts and vendor refunds on cash (Q-SPF7)', () => {
  it('A/P clears, the expense nets to the cash paid, and a vendor refund leaves no A/P', async () => {
    await seed();
    const s = gcase(15)['steps'] as Body[];
    const [vendor] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Ozark Feed & Seed' }).returning();
    const bill = await billService.createBill(c.tenantId, {
      contactId: vendor!.id, txnDate: s[0]!['request']['date'],
      lines: [{ accountId: ids.accts.get('supplies'), amount: s[0]!['request']['lines'][0]['amount'] }],
    } as never, c.userId, c.companyId);
    const pb = s[1]!['request'];
    await billPayments.payBills(c.tenantId, {
      bankAccountId: ids.accts.get(pb['bankAccount']), txnDate: pb['date'], method: 'ach',
      bills: [{ billId: bill.id, amount: pb['amount'], discountAmount: pb['discount'] }], discountAccountId: ids.accts.get(pb['discountAccount']),
    } as never, c.userId, c.companyId);
    expectLedger(await cashLedger(s[2]!['request']['startDate'], s[2]!['request']['endDate']), s[2]!['expect']);
    const vc = await vendorCredits.createVendorCredit(c.tenantId, {
      contactId: vendor!.id, txnDate: s[3]!['request']['date'], lines: [{ accountId: ids.accts.get('supplies'), amount: s[3]!['request']['lines'][0]['amount'] }],
    } as never, c.userId, c.companyId);
    const rf = s[4]!['request'];
    await deposits.createDeposit(c.tenantId, {
      txnDate: rf['date'], depositToAccountId: ids.accts.get(rf['bankAccount']),
      lines: [{ accountId: (await apId()), amount: rf['amount'], contactId: vendor!.id, sourceTransactionId: vc.id }],
    } as never, c.userId, c.companyId);
    expectLedger(await cashLedger(s[5]!['request']['startDate'], s[5]!['request']['endDate']), s[5]!['expect']);
    const b = await buildBalanceSheet(c.tenantId, '2026-11-30', 'cash', c.companyId);
    expect(m2(b.totalAssets)).toBe(m2(b.totalLiabilities + b.totalEquity));
  });
});

describe('cash edge cases beyond rules 2, 2b and 3', () => {
  it('a bill paid in two months, the discount on the second payment: A/P 0.00 at each month end, the expense nets to the cash paid', async () => {
    await seed();
    const [vendor] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Split Vendor' }).returning();
    const bill = await billService.createBill(c.tenantId, {
      contactId: vendor!.id, txnDate: '2026-09-02', lines: [{ accountId: ids.accts.get('supplies'), amount: '200.00' }],
    } as never, c.userId, c.companyId);
    const payBill = (date: string, amount: string, discount?: string) => billPayments.payBills(c.tenantId, {
      bankAccountId: c.roles['checking'], txnDate: date, method: 'ach',
      bills: [{ billId: bill.id, amount, ...(discount ? { discountAmount: discount } : {}) }], ...(discount ? { discountAccountId: ids.accts.get('bill_discounts') } : {}),
    } as never, c.userId, c.companyId);
    await payBill('2026-09-20', '120.00');
    await payBill('2026-10-05', '76.00', '4.00');
    expectLedger(await cashLedger('2026-09-01', '2026-09-30'), { accounts_payable: '0.00', supplies: '120.00', bill_discounts: '0.00', net: '-120.00' });
    expectLedger(await cashLedger('2026-10-01', '2026-10-31'), { accounts_payable: '0.00', supplies: '80.00', bill_discounts: '4.00', net: '-76.00' });
    for (const asOf of ['2026-09-30', '2026-10-31']) {
      const b = await buildBalanceSheet(c.tenantId, asOf, 'cash', c.companyId);
      expect(m2(b.totalAssets), asOf).toBe(m2(b.totalLiabilities + b.totalEquity));
    }
  });

  it('Unapplied receipts: a voided unapplied payment and a remainder part applied, part refunded both end at 0.00', async () => {
    await seed(false);
    const oz = ids.clients.get('Ozark Outfitters')!;
    const chk = c.roles['checking']!;
    const pay = async (date: string, amount: string) => ok(await req('POST', '/api/v1/payments/receive', {
      customerId: oz, date, amount, depositTo: chk, applications: [],
    }))['payment'] as Body;
    const voided = await pay('2026-07-03', '60.00');
    expect((await cashLedger(null, '2026-07-31'))['unapplied_receipts_income']).toBe('60.00');
    ok(await req('POST', `/api/v1/transactions/${voided['id']}/void`, { reason: 'entered twice' }), 200);
    expect((await cashLedger(null, '2026-07-31'))['unapplied_receipts_income'] ?? '0.00').toBe('0.00');
    const inv = await invoice({ name: 'U-1', client: 'Ozark Outfitters', date: '2026-08-10', lines: [{ item: 'Plants', quantity: '1', unitPrice: '100.00' }] });
    const extra = await pay('2026-07-20', '150.00');
    ok(await req('POST', `/api/v1/payments/${extra['id']}/apply`, { date: '2026-08-10', applications: [{ invoiceId: inv, amount: '108.88' }] }), 200);
    ok(await req('POST', '/api/v1/customer-refunds', { txnDate: '2026-08-15', contactId: oz, refundFromAccountId: chk, amount: '41.12', sourceId: extra['id'] }));
    expect((await cashLedger(null, '2026-07-31'))['unapplied_receipts_income']).toBe('150.00');
    expect((await cashLedger(null, '2026-08-31'))['unapplied_receipts_income'] ?? '0.00').toBe('0.00');
    for (const asOf of ['2026-07-31', '2026-08-31']) {
      const b = await buildBalanceSheet(c.tenantId, asOf, 'cash', c.companyId);
      expect(m2(b.totalAssets), asOf).toBe(m2(b.totalLiabilities + b.totalEquity));
      const led = await cashLedger(null, asOf);
      expect([asOf, led['accounts_receivable'] ?? '0.00', led['customer_deposits'] ?? '0.00']).toEqual([asOf, '0.00', '0.00']);
    }
    await expectTies('2026-07-01', '2026-08-31');
  });
});

describe('daily sales (S9)', () => {
  it('a linked tax line writes rows on the sales tax\'s items; an unlinked line to Sales Tax Payable is an unassigned row; other lines none', async () => {
    await seed();
    const stp = c.roles['sales_tax_payable']!;
    const tpl = await dailySales.createTemplate(c.tenantId, { name: 'S9' } as never, c.userId, c.companyId);
    await dailySales.replaceTemplateLines(c.tenantId, tpl.id, [
      { section: 'sales', label: 'Sales', accountId: ids.accts.get('income'), normalSide: 'credit' },
      { section: 'tax', label: 'State tax', accountId: null, normalSide: 'credit', salesTaxId: ids.taxes.get('Springfield') },
      { section: 'tax', label: 'Event tax', accountId: stp, normalSide: 'credit' },
      { section: 'payment', label: 'Cash', accountId: c.roles['payments_clearing'], normalSide: 'debit' },
    ] as never, c.userId, c.companyId);
    const t = await dailySales.getTemplate(c.tenantId, tpl.id, c.companyId);
    const lineId = (label: string) => t.lines.find((l) => l.label === label && l.isActive)!.id;
    const values = [
      { templateLineId: lineId('Sales'), amount: '100.00' }, { templateLineId: lineId('State tax'), amount: '8.88' },
      { templateLineId: lineId('Event tax'), amount: '1.50' }, { templateLineId: lineId('Cash'), amount: '110.38' },
    ];
    const draft = await dailySales.createDraft(c.tenantId, { templateId: tpl.id, businessDate: '2026-11-20', values } as never, c.userId, c.companyId);
    const posted = await dailySales.postEntry(c.tenantId, draft.id, c.userId, c.companyId);
    const rows = await db.select().from(transactionTaxLines).where(eq(transactionTaxLines.transactionId, String(posted.transactionId)));
    const sum = (list: typeof rows) => m2(list.reduce((s, r) => s + Math.round(Number(r.tax) * 10000), 0) / 10000);
    expect(sum(rows.filter((r) => r.taxItemId))).toBe('8.88');
    expect(rows.filter((r) => r.taxItemId).every((r) => r.salesTaxId === ids.taxes.get('Springfield'))).toBe(true);
    expect(rows.filter((r) => !r.taxItemId).map((r) => m2(r.tax))).toEqual(['1.50']);
    const r = await liability({ startDate: '2026-11-01', endDate: '2026-11-30', basis: 'accrual' });
    expect([r['unassigned'], r['otherEntries']]).toEqual(['1.50', '0.00']);
  });
});

describe('role defaults (tenants and users created after 0253)', () => {
  it('owner, accountant and a bookkeeper with no permission row get sales_tax full; readonly gets view', () => {
    const base = { userType: 'staff', isSuperAdmin: false, hasPermissionRow: false, templateMap: null, overrides: null };
    for (const role of ['owner', 'accountant', 'bookkeeper']) expect(resolveEffectivePermissions({ ...base, role } as never)['sales_tax']).toBe('full');
    expect(resolveEffectivePermissions({ ...base, role: 'readonly' } as never)['sales_tax']).toBe('view');
  });
});

async function apId() {
  return (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'accounts_payable')) }))!.id;
}

describe('the cash Balance Sheet at every month end (missing test 1)', () => {
  it('own rows, credits applied later, deposits, refunds, discounts, write-offs and bounces dated before the invoice', async () => {
    await seed(false);
    const oz = ids.clients.get('Ozark Outfitters')!;
    const chk = c.roles['checking']!;
    const pay = async (date: string, amount: string, apps: Body[] = [], extra: Body = {}) => ok(await req('POST', '/api/v1/payments/receive', {
      customerId: oz, date, amount, depositTo: chk, applications: apps, discountAccountId: ids.accts.get('sales_discounts'),
      writeOffAccountId: ids.accts.get('bad_debts'), ...extra,
    }))['payment'] as Body;
    const inv1 = await invoice({ name: 'P-1', client: 'Ozark Outfitters', date: '2026-01-15', lines: [{ item: 'Plants', quantity: '1', unitPrice: '1000.00' }] });
    const inv2 = await invoice({ name: 'P-2', client: 'Ozark Outfitters', date: '2026-04-20', lines: [{ item: 'Plants', quantity: '1', unitPrice: '300.00' }] });
    // A deposit in January drawn in March on P-1; an unapplied payment in February applied to P-2 in April (before P-2 is dated? no: on its date).
    const depo = await pay('2026-01-05', '200.00', [], { holdAsDeposit: true });
    const early = await pay('2026-02-10', '150.00');
    ok(await req('POST', `/api/v1/payments/${depo['id']}/apply`, { date: '2026-03-03', applications: [{ invoiceId: inv1, amount: '200.00' }] }), 200);
    ok(await req('POST', `/api/v1/payments/${early['id']}/apply`, { date: '2026-04-20', applications: [{ invoiceId: inv2, amount: '150.00' }] }), 200);
    // P-1 rest: a payment with a discount and a write-off in May, then bounced in June.
    const p1 = await pay('2026-05-02', '800.00', [{ invoiceId: inv1, amount: '800.00', discountAmount: '50.00', writeOffAmount: '38.75' }]);
    // A refund in May of an unapplied 40.00.
    const extra = await pay('2026-05-10', '40.00');
    ok(await req('POST', '/api/v1/customer-refunds', { txnDate: '2026-05-11', contactId: oz, refundFromAccountId: chk, amount: '40.00', sourceId: extra['id'] }));
    ok(await req('POST', `/api/v1/payments/${p1['id']}/bounce`, { date: '2026-06-05' }));
    // A payment applied at save to an invoice dated later (review B1): income on the payment date, A/R untouched.
    const inv3 = await invoice({ name: 'P-3', client: 'Ozark Outfitters', date: '2026-06-20', lines: [{ item: 'Install labor', quantity: '1', unitPrice: '80.00' }] });
    await pay('2026-05-25', '80.00', [{ invoiceId: inv3, amount: '80.00' }]);
    for (const asOf of ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']) {
      const b = await buildBalanceSheet(c.tenantId, asOf, 'cash', c.companyId);
      expect(m2(b.totalAssets), asOf).toBe(m2(b.totalLiabilities + b.totalEquity));
      const led = await cashLedger(null, asOf);
      expect([asOf, led['accounts_receivable'] ?? '0.00', led['customer_deposits'] ?? '0.00', led['bad_debts'] ?? '0.00'])
        .toEqual([asOf, '0.00', '0.00', '0.00']);
    }
    // January: the held deposit is Unapplied receipts income; February adds the early payment.
    expect((await cashLedger(null, '2026-01-31'))['unapplied_receipts_income']).toBe('200.00');
    expect((await cashLedger(null, '2026-02-28'))['unapplied_receipts_income']).toBe('350.00');
    expect((await cashLedger(null, '2026-04-30'))['unapplied_receipts_income']).toBe('0.00');
    // Unapplied money is not a sale: cash Sales by Customer / Item leave it out.
    const feb = await buildSalesByCustomer(c.tenantId, '2026-02-01', '2026-02-28', c.companyId, null, 'cash');
    expect(feb.data).toEqual([]);
    const febItems = await buildSalesByItem(c.tenantId, '2026-02-01', '2026-02-28', c.companyId, null, 'cash');
    expect(febItems.data).toEqual([]);
    for (const [s, e] of [['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30']]) await expectTies(s!, e!);
  });
});

describe('owed, payments report, diagnostic, permissions and scope', () => {
  it('owed subtracts every payment line whatever its date (S1); opening lines count', async () => {
    await seed();
    await invoice({ name: 'O-1', client: 'Ozark Outfitters', date: '2026-11-02', lines: [{ item: 'Plants', quantity: '1', unitPrice: '1000.00' }] });
    const spr = ids.taxes.get('Springfield')!;
    const agency = ids.agencies.get('Sample State Revenue Dept.')!;
    await db.insert(salesTaxPaymentLines).values({ tenantId: c.tenantId, companyId: c.companyId, transactionId: null, taxItemId: spr, agencyId: agency,
      kind: 'opening', lineDate: '2026-12-15', amount: '10.0000' });
    const o = ok(await req('GET', `/api/v1/sales-tax/owed?asOf=2026-11-30&agencyId=${agency}`), 200);
    expect(o['basis']).toBe('accrual');
    expect(o['agencies'][0]['items'].find((i: Body) => i['name'] === 'Springfield')['owed']).toBe('78.75');
    const r = await liability({ startDate: '2026-11-01', endDate: '2026-11-30', basis: 'accrual' });
    // owedAtEnd counts lines dated on or before end_date only.
    expectLiability(r, { items: [{ item: 'Springfield', collected: '88.75', owedAtEnd: '88.75' }] });
    expect(r['openingPaid']).toBe('0.00');
    const r2 = await liability({ startDate: '2026-12-01', endDate: '2026-12-31', basis: 'accrual' });
    expect(r2['openingPaid']).toBe('10.00');
    expect(r2['balanceCheck']).toMatchObject({ stpBalance: '88.75', owedAtEnd: '78.75', openingPaid: '10.00' });
    // Bad requests and scope.
    expect((await req('GET', '/api/v1/sales-tax/owed')).status).toBe(400);
    expect((await req('GET', `/api/v1/sales-tax/owed?asOf=2026-11-30&agencyId=${crypto.randomUUID()}`)).status).toBe(404);
    expect((await req('GET', `/api/v1/reports/sales-tax-liability?start_date=2026-11-01&end_date=2026-11-30&agency_id=${crypto.randomUUID()}`)).status).toBe(404);
    const other = await h.secondCompany(c);
    const scoped = await h.request('GET', `/api/v1/sales-tax/owed?asOf=2026-11-30&agencyId=${agency}`, c.token, undefined, other);
    expect(scoped.status).toBe(404);
    expect(ok(await req('GET', '/api/v1/reports/sales-tax-payments?start_date=2026-01-01&end_date=2026-12-31'), 200)['data']).toEqual([]);
    // v1 numbers kept for MyBooks Online.
    expect(typeof r['totalTax']).toBe('number');
  });

  it('the company basis is the default; a cash company reads cash', async () => {
    await seed();
    await db.update(companies).set({ salesTaxBasis: 'cash' }).where(eq(companies.id, c.companyId));
    const r = ok(await req('GET', '/api/v1/reports/sales-tax-liability?start_date=2026-11-01&end_date=2026-11-30'), 200);
    expect(r['basis']).toBe('cash');
  });

  it('the Q-P23z diagnostic counts what moves on or before the closing date', async () => {
    await seed(false);
    const d0 = ok(await req('GET', '/api/v1/sales-tax/diagnostics/cash-basis'), 200);
    expect(d0['closingDate']).toBeNull();
    await invoice({ name: 'D-1', client: 'Ozark Outfitters', date: '2026-01-10', lines: [{ item: 'Plants', quantity: '1', unitPrice: '200.00' }] });
    await receive({ name: 'D-P', client: 'Ozark Outfitters', date: '2026-01-20', amount: '300.00', depositTo: 'operating_checking',
      applications: [{ invoice: 'D-1', amount: '100.00', writeOff: '117.75' }] });
    await db.update(companies).set({ lockDate: '2026-01-31' }).where(eq(companies.id, c.companyId));
    const d = ok(await req('GET', '/api/v1/sales-tax/diagnostics/cash-basis'), 200);
    expect(d).toMatchObject({ closingDate: '2026-01-31', unappliedReceipts: { count: 1, amount: '200.00' }, writeOffs: { count: 1, amount: '117.75' },
      customerDeposits: { count: 0, amount: '0.00' }, billDiscounts: { count: 0, amount: '0.00' } });
  });

  it('0253 grants sales_tax wherever invoices was granted, at the same level, and creates Unapplied receipts', async () => {
    const [tpl] = await db.insert(permissionTemplates).values({ tenantId: c.tenantId, name: `T-${key()}`, permissions: { invoices: 'view', bills: 'full' } as never }).returning();
    const [none] = await db.insert(permissionTemplates).values({ tenantId: c.tenantId, name: `N-${key()}`, permissions: { bills: 'full' } as never }).returning();
    const token = await h.staffToken(c, { invoices: 'full' });
    await db.delete(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'unapplied_receipts')));
    // Before the upgrade the bookkeeper (overrides only) can't reach /sales-tax.
    expect((await h.request('GET', '/api/v1/sales-tax/codes', token)).status).toBe(403);
    const r = await db.execute(sql`SELECT sales_tax_liability_upgrade_tenant(${c.tenantId}::uuid) AS r`);
    const out = (r.rows as Body[])[0]!['r'];
    expect(out).toMatchObject({ accountCreated: true, templatesGranted: 1, overridesGranted: 1 });
    expect((await db.select().from(permissionTemplates).where(eq(permissionTemplates.id, tpl!.id)))[0]!.permissions).toMatchObject({ sales_tax: 'view' });
    expect((await db.select().from(permissionTemplates).where(eq(permissionTemplates.id, none!.id)))[0]!.permissions).not.toHaveProperty('sales_tax');
    expect((await h.request('GET', '/api/v1/sales-tax/codes', token)).status).toBe(200);
    const ur = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'unapplied_receipts')) });
    expect([ur?.name, ur?.accountType]).toEqual(['Unapplied receipts', 'revenue']);
    // Idempotent.
    const again = (await db.execute(sql`SELECT sales_tax_liability_upgrade_tenant(${c.tenantId}::uuid) AS r`)).rows as Body[];
    expect(again[0]!['r']).toMatchObject({ accountCreated: false, templatesGranted: 0, overridesGranted: 0 });
    await db.delete(userPermissions).where(eq(userPermissions.tenantId, c.tenantId));
  });

  it('a daily sales template links one credit-side tax line to a sales tax of the company', async () => {
    await seed();
    const tpl = await dailySales.createTemplate(c.tenantId, { name: 'Two' } as never, c.userId, c.companyId);
    const spr = ids.taxes.get('Springfield')!;
    await expect(dailySales.replaceTemplateLines(c.tenantId, tpl.id, [
      { section: 'tax', label: 'A', normalSide: 'credit', salesTaxId: spr }, { section: 'tax', label: 'B', normalSide: 'credit', salesTaxId: spr },
    ] as never, c.userId, c.companyId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(dailySales.replaceTemplateLines(c.tenantId, tpl.id, [
      { section: 'sales', label: 'A', normalSide: 'credit', salesTaxId: spr },
    ] as never, c.userId, c.companyId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(dailySales.replaceTemplateLines(c.tenantId, tpl.id, [
      { section: 'tax', label: 'A', normalSide: 'credit', salesTaxId: crypto.randomUUID() },
    ] as never, c.userId, c.companyId)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('advertises sales-tax-liability-v2, cash-basis-spf-v1 and daily-sales-tax-v1', () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(['sales-tax-liability-v2', 'cash-basis-spf-v1', 'daily-sales-tax-v1']));
  });
});
