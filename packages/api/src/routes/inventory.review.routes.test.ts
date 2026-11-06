// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// ClientLedger P24 combined review (2026-11-06) of inventory-costing-v1 and
// the rows that build on it: one test per finding and per missing test,
// through the real routes where a route exists. The golden cases live in
// inventory.golden.routes.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, companies, contacts, inventoryMovements, journalLines } from '../db/schema/index.js';
import { itemsRouter } from './items.routes.js';
import { companyRouter } from './company.routes.js';
import { billsRouter } from './bills.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { errorHandler } from '../middleware/error-handler.js';

type Body = Record<string, any>;

const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [async (tid) => { await db.delete(inventoryMovements).where(eq(inventoryMovements.tenantId, tid)); }];
  await h.start([['/api/v1/items', itemsRouter], ['/api/v1/company', companyRouter], ['/api/v1/bills', billsRouter],
    ['/api/v1/invoices', invoicesRouter], ['/api/v1/transactions', transactionsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const req = (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) =>
  h.request(method, `/api/v1${p}`, c.token, body, method === 'GET' ? headers : { 'Idempotency-Key': key(), ...headers });
const err = (r: { status: number; json: Body }) => [r.status, r.json['error']?.code];

interface World { asset: string; cogs: string; vendor: string; part: string }

async function setup(): Promise<World> {
  const on = await req('PUT', '/company/settings', { inventoryEnabled: true });
  expect(on.status, JSON.stringify(on.json)).toBe(200);
  const [asset] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'inventory_asset')));
  const [cogs] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountType, 'cogs'), eq(accounts.isActive, true)));
  const [vendor] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Cedar Supply' }).returning();
  const w = { asset: asset!.id, cogs: cogs!.id, vendor: vendor!.id, part: '' };
  w.part = await part(w, 'W');
  return w;
}

async function part(w: World, name: string, cogsAccountId = w.cogs): Promise<string> {
  const r = await req('POST', '/items', { name, itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: c.roles['income'],
    assetAccountId: w.asset, cogsAccountId });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return String(r.json['item'].id);
}

async function bill(w: World, date: string, lines: Array<{ itemId: string; quantity: string; amount: string }>) {
  const r = await req('POST', '/bills', { contactId: w.vendor, txnDate: date,
    lines: lines.map((l) => ({ accountId: w.asset, amount: l.amount, itemId: l.itemId, quantity: l.quantity, unitPrice: (Number(l.amount) / Number(l.quantity)).toFixed(4) })) });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return String(r.json['bill']?.id ?? r.json['id']);
}

async function invoice(itemId: string, date: string, quantity: string) {
  const r = await req('POST', '/invoices', { contactId: c.customer, txnDate: date, lines: [{ itemId, quantity, unitPrice: '10.00', isTaxable: false }] });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return String(r.json['invoice']?.id ?? r.json['id']);
}

describe('P24 review: inventory-costing-v1 (E2a)', () => {
  it('S7: an inactive part with stock history keeps its accounts; one without movements does not', async () => {
    const w = await setup();
    const accountsService = await import('../services/accounts.service.js');
    await bill(w, '2026-01-05', [{ itemId: w.part, quantity: '2', amount: '6.00' }]);
    expect((await req('DELETE', `/items/${w.part}`)).status).toBe(200);
    await expect(accountsService.deactivate(c.tenantId, w.cogs, c.userId)).rejects.toMatchObject({ code: 'ACCOUNT_IN_USE' });
    const [cogs2] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'COGS 2', accountType: 'cogs', detailType: 'cost_of_goods_sold' }).returning();
    const idle = await part(w, 'Idle', cogs2!.id);
    await expect(accountsService.deactivate(c.tenantId, cogs2!.id, c.userId)).rejects.toMatchObject({ code: 'ACCOUNT_IN_USE' });
    expect((await req('DELETE', `/items/${idle}`)).status).toBe(200);
    await expect(accountsService.deactivate(c.tenantId, cogs2!.id, c.userId)).resolves.toBeTruthy();
  });

  it('memorizing a document with parts is 409 INVENTORY_DOCUMENT', async () => {
    const w = await setup();
    const id = await bill(w, '2026-01-05', [{ itemId: w.part, quantity: '2', amount: '6.00' }]);
    const { snapshotForCreate } = await import('../services/templates/snapshot.js');
    await expect(snapshotForCreate(db, c.tenantId, c.companyId, id)).rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT' });
  });

  it('the invoice PDF shows the form lines only, never the derived costing lines', async () => {
    const w = await setup();
    await bill(w, '2026-01-05', [{ itemId: w.part, quantity: '10', amount: '33.30' }]);
    const inv = await invoice(w.part, '2026-01-06', '3');
    const relief = await db.select().from(journalLines).where(and(eq(journalLines.transactionId, inv), eq(journalLines.lineRole, 'cogs')));
    expect(relief.map((l) => l.debit)).toEqual(['9.9900']);
    const { getInvoiceHtml } = await import('../services/pdf.service.js');
    const html = await getInvoiceHtml(c.tenantId, inv);
    expect(html).toContain('30.00');
    expect(html).not.toContain('9.99');
  });

  it('lines can not be moved onto or off an inventory asset account (409 INVENTORY_DOCUMENT; blockedLineReason inventory)', async () => {
    const w = await setup();
    await bill(w, '2026-01-05', [{ itemId: w.part, quantity: '2', amount: '6.00' }]);
    const { moveAllLinesBetweenAccounts, blockedLineReason } = await import('../services/system-accounts.service.js');
    await expect(db.transaction((tx) => moveAllLinesBetweenAccounts(tx, c.tenantId, c.roles['expense']!, w.asset)))
      .rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT' });
    expect(await blockedLineReason(c.tenantId, w.asset)).toBe('inventory');
  });

  it('S8: a posting without a company is gated by the latest closing date of the tenant, as checkLockDate gates it', async () => {
    const w = await setup();
    await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Second Books', setupComplete: true, lockDate: '2026-03-31' });
    const { postTransaction } = await import('../services/ledger.service.js');
    const ap = (await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'accounts_payable'))))[0]!.id;
    await expect(postTransaction(c.tenantId, { txnType: 'bill', txnDate: '2026-02-01', contactId: w.vendor, lines: [
      { accountId: w.asset, debit: '3', credit: '0', itemId: w.part, quantity: '1' }, { accountId: ap, debit: '0', credit: '3' }] } as never, c.userId))
      .rejects.toMatchObject({ code: 'INVENTORY_PERIOD_CLOSED', details: { closingDate: '2026-03-31' } });
    expect(await db.select().from(inventoryMovements).where(eq(inventoryMovements.tenantId, c.tenantId))).toEqual([]);
  });

  it('GET /items stock figures are the request company\'s stock (items are tenant-wide)', async () => {
    const w = await setup();
    await bill(w, '2026-01-05', [{ itemId: w.part, quantity: '2', amount: '6.00' }]);
    const other = await h.secondCompany(c);
    await db.insert(inventoryMovements).values({ tenantId: c.tenantId, companyId: other['X-Company-Id']!, itemId: w.part, transactionId: crypto.randomUUID(),
      movementDate: '2026-02-01', txnCreatedAt: new Date(), kind: 'receipt', quantity: '999', valueMode: 'given', value: '999', runningQty: '999',
      runningValue: '999', lastCost: '1' });
    expect((await req('GET', `/items/${w.part}`)).json['item'].quantityOnHand).toBe('2.0000');
    const list = (await req('GET', '/items')).json['data'] as Body[];
    expect(list.find((i) => i['id'] === w.part)!['quantityOnHand']).toBe('2.0000');
    expect((await req('GET', `/items/${w.part}`, undefined, other)).json['item'].quantityOnHand).toBe('999.0000');
  });

  it('a kind change into inventory_part waits for an in-flight posting that names the item (KEY SHARE), then sees its line', async () => {
    const w = await setup();
    const svc = await req('POST', '/items', { name: 'Svc', itemType: 'service', unitPrice: '5.00', incomeAccountId: c.roles['income'] });
    const id = String(svc.json['item'].id);
    const { prepareNew } = await import('../services/inventory-costing.service.js');
    let released = 0;
    const hold = db.transaction(async (tx) => {
      await prepareNew(tx, c.tenantId, c.companyId, 'invoice', '2026-02-01', [{ accountId: c.roles['income']!, credit: '5', itemId: id, quantity: '1' }]);
      await new Promise((r) => setTimeout(r, 700));
      released = Date.now();
    });
    await new Promise((r) => setTimeout(r, 150));
    const put = await req('PUT', `/items/${id}`, { itemType: 'inventory_part', assetAccountId: w.asset, cogsAccountId: w.cogs });
    const done = Date.now();
    await hold;
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(released).toBeGreaterThan(0);
    expect(done).toBeGreaterThanOrEqual(released);
  });

  it('S10: outside a route that maps it, a lock timeout is 409 RETRY without promising that nothing was saved', async () => {
    const app = express();
    app.get('/x', () => { throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }); });
    app.use(errorHandler);
    const server = app.listen(0);
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await new Promise<{ status: number; body: Body }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/x' }, (r) => {
          let s = '';
          r.on('data', (ch) => { s += ch; });
          r.on('end', () => resolve({ status: r.statusCode ?? 0, body: JSON.parse(s) as Body }));
        }).on('error', reject);
      });
      expect([res.status, res.body['error'].code]).toEqual([409, 'RETRY']);
      expect(res.body['error'].message).not.toMatch(/nothing was saved/i);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  /**
   * A backdated 20-part bill over `LATER` later rows of each part: every later sale re-costs. Returns the bill's
   * posting time. The later invoices (each selling 1 of every part at 1.00, with its derived lines) are seeded in
   * SQL: routes are far too slow.
   */
  async function backdatedOver(LATER: number): Promise<number> {
    const w = await setup();
    const N = 20;
    const parts = [w.part];
    for (let i = 1; i < N; i++) parts.push(await part(w, `P${i}`));
    await bill(w, '2026-01-01', parts.map((id) => ({ itemId: id, quantity: '100000', amount: '100000.00' })));
    await db.execute(sql`
      INSERT INTO transactions (tenant_id, company_id, txn_type, txn_date, status, created_at)
      SELECT ${c.tenantId}::uuid, ${c.companyId}::uuid, 'invoice', DATE '2026-01-03' + (g % 300), 'posted', now() + g * interval '1 millisecond'
      FROM generate_series(1, ${LATER}::int) g`);
    await db.execute(sql`
      INSERT INTO inventory_movements (tenant_id, company_id, item_id, transaction_id, movement_date, txn_created_at, kind, quantity, value_mode, value,
        running_qty, running_value, last_cost)
      SELECT t.tenant_id, t.company_id, i.id, t.id, t.txn_date, t.created_at, 'sale', -1, 'derived', -1, 0, 0, 1
      FROM transactions t CROSS JOIN items i
      WHERE t.tenant_id = ${c.tenantId} AND t.txn_type = 'invoice' AND i.tenant_id = ${c.tenantId} AND i.item_type = 'inventory_part'`);
    await db.execute(sql`
      INSERT INTO journal_lines (tenant_id, company_id, transaction_id, account_id, debit, credit, line_role, inventory_movement_id, line_order)
      SELECT m.tenant_id, m.company_id, m.transaction_id, ${w.asset}::uuid, 0, 1, 'inventory_relief', m.id, 1 FROM inventory_movements m
      WHERE m.tenant_id = ${c.tenantId} AND m.kind = 'sale'
      UNION ALL
      SELECT m.tenant_id, m.company_id, m.transaction_id, ${w.cogs}::uuid, 1, 0, 'cogs', m.id, 2 FROM inventory_movements m
      WHERE m.tenant_id = ${c.tenantId} AND m.kind = 'sale'`);
    await db.execute(sql`ANALYZE inventory_movements`);
    await db.execute(sql`ANALYZE journal_lines`);

    const t0 = Date.now();
    const backdated = await bill(w, '2026-01-02', parts.map((id) => ({ itemId: id, quantity: '1000', amount: '2000.00' })));
    const ms = Date.now() - t0;
    // Every later sale re-costs at the new average (102,000 / 101,000).
    const sample = await db.select().from(inventoryMovements)
      .where(and(eq(inventoryMovements.tenantId, c.tenantId), eq(inventoryMovements.itemId, w.part), eq(inventoryMovements.kind, 'sale'))).limit(1);
    expect(sample[0]!.value).toBe('-1.0100');
    const cogs = await db.select().from(journalLines).where(and(eq(journalLines.inventoryMovementId, sample[0]!.id), eq(journalLines.lineRole, 'cogs')));
    expect(cogs.map((l) => l.debit)).toEqual(['1.0100']);
    // One audit row per re-costed document (batched inserts).
    const audits = await db.execute(sql`SELECT COUNT(*)::int AS n FROM audit_log WHERE tenant_id = ${c.tenantId} AND after_data::text LIKE ${'%' + backdated + '%'}`);
    expect((audits.rows[0] as { n: number }).n).toBe(LATER);
    console.log(`[perf] backdated 20-part bill over ${LATER} later rows each: ${ms} ms`);
    return ms;
  }

  it('S9: a backdated 20-part bill re-costs every later row in batched statements (20 x 250 rows)', async () => {
    await backdatedOver(250);
  }, 120_000);

  // The P24 budget (S13): 20 parts x 5,000 later rows each under 3 s. Heavy (it seeds 100,000 movements and 200,000
  // lines), so it runs when INVENTORY_PERF=1. Measured 2026-11-06 on the ClientLedger dev box: about 14.5 s; the
  // budget is not met yet (row writes dominate: about 35 us per rewritten journal line and per movement).
  it.runIf(process.env['INVENTORY_PERF'] === '1')('S9 performance budget: 20 parts x 5,000 later rows each post in under 3 s', async () => {
    expect(await backdatedOver(5000)).toBeLessThan(3000);
  }, 300_000);
});
