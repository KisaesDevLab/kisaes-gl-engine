// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// The sales tax liability and payments report routes (sales-tax-liability-v2)
// own JSON, CSV and PDF: `?scope=consolidated` reads every company of the
// tenant, the per-user report rate limiter is in the chain, and the CSV / PDF
// totals are the JSON totals. Two companies in one tenant, rows written
// directly (the report reads transaction_tax_lines and
// sales_tax_payment_lines of posted transactions).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'express-async-errors';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from 'express';

const toPdfCalls: Array<{ html: string; orientation?: string }> = [];
vi.mock('../services/report-export.service.js', async (orig) => {
  const real = await orig<typeof import('../services/report-export.service.js')>();
  return {
    ...real,
    toPdf: async (html: string, opts: { orientation?: 'portrait' | 'landscape' } = {}) => {
      toPdfCalls.push({ html, orientation: opts.orientation });
      return Buffer.from('%PDF-1.4 mock');
    },
  };
});

// The limiter skips itself under NODE_ENV=test, and express-async-errors
// wraps every layer, so the wiring is observed (each request passes through
// it) rather than compared by identity.
const limiterCalls: string[] = [];
vi.mock('../middleware/expensive-op-limiter.js', async (orig) => {
  const real = await orig<typeof import('../middleware/expensive-op-limiter.js')>();
  const observed: RequestHandler = (req, res, next) => {
    limiterCalls.push(req.path);
    return real.expensiveOpLimiter(req, res, next);
  };
  return { ...real, expensiveOpLimiter: observed as unknown as typeof real.expensiveOpLimiter };
});

const { db } = await import('../db/index.js');
const { contacts, transactions, transactionTaxLines, salesTaxPaymentLines, salesTaxItems, salesTaxAgencies } = await import('../db/schema/index.js');
const { salesTaxReportsRouter } = await import('./sales-tax.routes.js');
const { reportsRouter } = await import('./reports.routes.js');
const { Harness } = await import('./receivables.test-support.js');
type Co = Awaited<ReturnType<InstanceType<typeof Harness>['company']>>;

type Body = Record<string, any>;

async function cleanSalesTax(tid: string) {
  for (const t of [transactionTaxLines, salesTaxPaymentLines, salesTaxItems, salesTaxAgencies]) await db.delete(t).where(eq(t.tenantId, tid));
}

const h = new Harness();
let c: Co;
let companyB = '';

beforeEach(async () => {
  h.extraCleanup = [cleanSalesTax];
  await h.start([['/api/v1/reports', salesTaxReportsRouter], ['/api/v1/reports', reportsRouter]]);
  c = await h.company();
  companyB = (await h.secondCompany(c))['X-Company-Id']!;
  toPdfCalls.length = 0;
});
afterEach(async () => { await h.stop(); });

/** One agency, one 8% item, one posted invoice with `tax` of sales tax, one payment of `paid`: the company's whole sales tax history. */
async function seedCompany(companyId: string, agencyName: string, base: string, tax: string, paid: string) {
  const [vendor] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId, contactType: 'vendor', displayName: agencyName }).returning();
  const [agency] = await db.insert(salesTaxAgencies).values({ tenantId: c.tenantId, companyId, vendorId: vendor!.id }).returning();
  const [item] = await db.insert(salesTaxItems).values({
    tenantId: c.tenantId, companyId, kind: 'item', name: `${agencyName} 8%`, rate: '0.080000', agencyId: agency!.id,
  }).returning();
  const [inv] = await db.insert(transactions).values({
    tenantId: c.tenantId, companyId, txnType: 'invoice', txnDate: '2026-03-10', status: 'posted', total: String(Number(base) + Number(tax)),
  }).returning();
  await db.insert(transactionTaxLines).values({
    tenantId: c.tenantId, companyId, transactionId: inv!.id, kind: 'sale', eventDate: '2026-03-10', salesTaxId: item!.id, taxItemId: item!.id,
    agencyId: agency!.id, rate: '0.080000', base, tax,
  });
  const [pay] = await db.insert(transactions).values({
    tenantId: c.tenantId, companyId, txnType: 'sales_tax_payment', txnDate: '2026-03-20', status: 'posted', total: paid, txnNumber: `STP-${agencyName.slice(0, 1)}`,
  }).returning();
  await db.insert(salesTaxPaymentLines).values({
    tenantId: c.tenantId, companyId, transactionId: pay!.id, taxItemId: item!.id, agencyId: agency!.id, kind: 'paid', lineDate: '2026-03-20', amount: paid,
  });
}

const range = 'start_date=2026-03-01&end_date=2026-03-31';
const get = (p: string, headers: Record<string, string> = {}) => h.request('GET', p, c.token, undefined, headers);
const ok = (r: { status: number; json: Body }) => { expect(r.status, JSON.stringify(r.json)).toBe(200); return r.json; };

/** The unquoted cells of a CSV line (every cell is quoted by toCsv; money carries en-US commas). */
const cells = (line: string): string[] => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));

/** The cells of the CSV row whose column `col` is `label`. */
function csvRow(csv: string, label: string, col = 1): string[] {
  const line = csv.split('\n').map(cells).find((l) => l[col] === label);
  expect(line, `row ${label} in\n${csv}`).toBeDefined();
  return line!;
}
const plain = (money: string) => money.replace(/,/g, '');

describe('sales tax report routes: scope, limiter, exports', () => {
  it('every request passes the report rate limiter', async () => {
    limiterCalls.length = 0;
    ok(await get(`/api/v1/reports/sales-tax-liability?${range}`));
    ok(await get(`/api/v1/reports/sales-tax-payments?${range}`));
    expect(limiterCalls).toEqual(['/sales-tax-liability', '/sales-tax-payments']);
  });

  it('liability: the company by default, every company with scope=consolidated, another company by header', async () => {
    await seedCompany(c.companyId, 'Alpha Revenue', '100.0000', '8.0000', '3.0000');
    await seedCompany(companyB, 'Beta Revenue', '200.0000', '16.0000', '5.0000');

    const a = ok(await get(`/api/v1/reports/sales-tax-liability?${range}`));
    expect(a['totals']).toMatchObject({ taxableSales: '100.00', collected: '8.00', paid: '3.00', owedAtEnd: '5.00' });
    expect(a['agencies'].map((g: Body) => g['name'])).toEqual(['Alpha Revenue']);

    const b = ok(await get(`/api/v1/reports/sales-tax-liability?${range}`, { 'X-Company-Id': companyB }));
    expect(b['totals']).toMatchObject({ taxableSales: '200.00', collected: '16.00', paid: '5.00', owedAtEnd: '11.00' });

    const all = ok(await get(`/api/v1/reports/sales-tax-liability?${range}&scope=consolidated`));
    expect(all['totals']).toMatchObject({ taxableSales: '300.00', collected: '24.00', paid: '8.00', owedAtEnd: '16.00' });
    expect(all['agencies'].map((g: Body) => g['name']).sort()).toEqual(['Alpha Revenue', 'Beta Revenue']);
    // No company to read a basis from: accrual.
    expect(all['basis']).toBe('accrual');
    // v1 keys stay (MyBooks web reads them).
    expect(typeof all['totalTax']).toBe('number');
    expect(all['balanceCheck']).not.toBeNull();
  });

  it('payments: scoped, consolidated, and the other company', async () => {
    await seedCompany(c.companyId, 'Alpha Revenue', '100.0000', '8.0000', '3.0000');
    await seedCompany(companyB, 'Beta Revenue', '200.0000', '16.0000', '5.0000');
    const a = ok(await get(`/api/v1/reports/sales-tax-payments?${range}`));
    expect(a['data'].map((r: Body) => [r['agencyName'], r['paid'], r['linked']])).toEqual([['Alpha Revenue', '3.00', false]]);
    const b = ok(await get(`/api/v1/reports/sales-tax-payments?${range}`, { 'X-Company-Id': companyB }));
    expect(b['data'].map((r: Body) => r['paid'])).toEqual(['5.00']);
    const all = ok(await get(`/api/v1/reports/sales-tax-payments?${range}&scope=consolidated`));
    expect(all['data'].map((r: Body) => r['paid']).sort()).toEqual(['3.00', '5.00']);
  });

  it('CSV and PDF are the JSON figures, on both scopes', async () => {
    await seedCompany(c.companyId, 'Alpha Revenue', '100.0000', '8.0000', '3.0000');
    await seedCompany(companyB, 'Beta Revenue', '1250.0000', '100.0000', '5.0000');
    for (const scope of ['', '&scope=consolidated']) {
      const json = ok(await get(`/api/v1/reports/sales-tax-liability?${range}${scope}`));
      const csv = ok(await get(`/api/v1/reports/sales-tax-liability?${range}${scope}&format=csv`))['text'] as string;
      expect(csv.split('\n')[0]).toBe('"Agency","Tax item","Rate","Taxable sales","Collected","Discounts","Bad debts","Recoveries","Adjustments","Paid","Owed at end"');
      const total = csvRow(csv, 'Total');
      expect(plain(total[3]!)).toBe(json['totals']['taxableSales']);
      expect(plain(total[4]!)).toBe(json['totals']['collected']);
      expect(plain(total[9]!)).toBe(json['totals']['paid']);
      expect(plain(total[10]!)).toBe(json['totals']['owedAtEnd']);
      // One row per agency item, with the item's figures and its rate as a percent.
      const alpha = csvRow(csv, 'Alpha Revenue 8%');
      expect(alpha.slice(0, 3)).toEqual(['Alpha Revenue', 'Alpha Revenue 8%', '8%']);
      expect(plain(alpha[4]!)).toBe(json['agencies'].find((g: Body) => g['name'] === 'Alpha Revenue')['items'][0]['collected']);
      expect(csv.split('\n')).toHaveLength(1 + json['agencies'].length + 1);

      toPdfCalls.length = 0;
      const pdf = await get(`/api/v1/reports/sales-tax-liability?${range}${scope}&format=pdf`);
      expect(pdf.status).toBe(200);
      expect(toPdfCalls).toHaveLength(1);
      expect(toPdfCalls[0]!.orientation).toBe('landscape');
      expect(toPdfCalls[0]!.html).toContain(Number(json['totals']['collected']).toLocaleString('en-US', { minimumFractionDigits: 2 }));
      expect(toPdfCalls[0]!.html).toContain(scope ? 'Consolidated' : 'Bluestem Books');
    }
    // Payments: the rows plus a totals row, both scopes.
    const pj = ok(await get(`/api/v1/reports/sales-tax-payments?${range}&scope=consolidated`));
    const pc = ok(await get(`/api/v1/reports/sales-tax-payments?${range}&scope=consolidated&format=csv`))['text'] as string;
    expect(pc.split('\n')[0]).toBe('"Date","Type","Number","Agency","Paid","Adjustments","Total","Linked"');
    const ptotal = csvRow(pc, 'Total', 2);
    expect(plain(ptotal[4]!)).toBe(pj['data'].reduce((s: number, r: Body) => s + Number(r['paid']), 0).toFixed(2));
    expect(pc.split('\n')).toHaveLength(1 + pj['data'].length + 1);
    toPdfCalls.length = 0;
    expect((await get(`/api/v1/reports/sales-tax-payments?${range}&format=pdf`)).status).toBe(200);
    expect(toPdfCalls[0]!.html).toContain('3.00');
  });

  it('a company with nothing to export is 404 No data on csv, like the other reports', async () => {
    const r = await get(`/api/v1/reports/sales-tax-payments?${range}&format=csv`);
    expect(r.status).toBe(404);
  });
});
