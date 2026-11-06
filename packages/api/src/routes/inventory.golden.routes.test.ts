// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-157 / U-158 inventory-costing-v1 (ClientLedger P24 E2a, E2b): golden
// cases A, B, V, X, M, D, N, K, K2, C, E and R of
// packages/shared/fixtures/inventory-golden.json through the real bill,
// vendor credit, invoice, credit memo, sales receipt, check and transaction
// routes, with the I2
// check after every step: per inventory asset account, the last running
// value of each item equals the accrual GL balance from journal lines, and
// accounts.balance equals the sum of lines for the asset and COGS accounts.
// Plus the B3 reader split, the B4 guards and the U-39b / U-25 checks that
// need the costing ledger.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, contacts, inventoryMovements, journalLines, transactions } from '../db/schema/index.js';
import { itemsRouter } from './items.routes.js';
import { companyRouter } from './company.routes.js';
import { billsRouter } from './bills.routes.js';
import { vendorCreditsRouter } from './vendor-credits.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { salesReceiptsRouter } from './sales-receipts.routes.js';
import { checksRouter } from './checks.routes.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { postAdjustment } from '../services/inventory-adjustment.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { Decimal } from '../utils/inventory-walk.js';

type Body = Record<string, any>;
const here = path.dirname(fileURLToPath(import.meta.url));
const golden = JSON.parse(readFileSync(path.resolve(here, '../../../shared/fixtures/inventory-golden.json'), 'utf8')) as Body;
const gcase = (id: string) => (golden['cases'] as Body[]).find((c) => c['id'] === id)!;

const h = new Harness();
let c: Co;

async function cleanInventory(tid: string) {
  await db.delete(inventoryMovements).where(eq(inventoryMovements.tenantId, tid));
}

beforeEach(async () => {
  h.extraCleanup = [cleanInventory];
  await h.start([['/api/v1/items', itemsRouter], ['/api/v1/company', companyRouter], ['/api/v1/bills', billsRouter],
    ['/api/v1/vendor-credits', vendorCreditsRouter], ['/api/v1/invoices', invoicesRouter], ['/api/v1/transactions', transactionsRouter],
    ['/api/v1/credit-memos', creditMemosRouter], ['/api/v1/sales-receipts', salesReceiptsRouter], ['/api/v1/checks', checksRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const req = (method: string, p: string, body?: unknown) =>
  h.request(method, `/api/v1${p}`, c.token, body, method === 'GET' ? {} : { 'Idempotency-Key': key() });
const idOf = (j: Body): string => String(j['id'] ?? j['bill']?.id ?? j['credit']?.id ?? j['vendorCredit']?.id ?? j['invoice']?.id
  ?? j['creditMemo']?.id ?? j['salesReceipt']?.id ?? j['check']?.id ?? j['transaction']?.id);

interface World {
  asset: string; cogs: string; adjustment: string; vendor: string; card: string; items: Map<string, string>; docs: Map<string, string>;
  bodies: Map<string, Body>; routes: Map<string, string>;
}

async function setup(): Promise<World> {
  const on = await req('PUT', '/company/settings', { inventoryEnabled: true });
  expect(on.status, JSON.stringify(on.json)).toBe(200);
  const tagged = async (tag: string) => (await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, tag))))[0]!.id;
  const asset = await tagged('inventory_asset');
  const [cogs] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountType, 'cogs'), eq(accounts.isActive, true)));
  const [adj] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Inventory Shrinkage', accountType: 'expense' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: golden['seed'].vendor }).returning();
  const [card] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Business card', accountType: 'liability', detailType: 'credit_card' }).returning();
  const world: World = { asset, cogs: cogs!.id, adjustment: adj!.id, vendor: vendor!.id, card: card!.id, items: new Map(), docs: new Map(), bodies: new Map(), routes: new Map() };
  for (const name of ['W']) {
    const r = await req('POST', '/items', {
      name, itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: c.roles['income'], assetAccountId: asset, cogsAccountId: world.cogs,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    world.items.set(name, r.json['item'].id);
  }
  return world;
}

/** The last step's reply (warnings[] of U-158). */
let lastReply: Body = {};

/**
 * Runs one golden step through the routes. `via` posts a receipt as a check
 * or card charge, a sale as a sales receipt or a POST /transactions cash
 * sale: the stock ledger must come out the same (U-158).
 */
async function step(w: World, s: Body, via?: string) {
  const item = s['item'] ? w.items.get(s['item'])! : '';
  let r: { status: number; json: Body } | null = null;
  lastReply = {};
  const event = via ?? s['event'];
  const expectStatus = s['expect']?.status as number | undefined;
  switch (event) {
    case 'bill': {
      const body = { contactId: w.vendor, txnDate: s['date'], lines: [{ accountId: w.asset, amount: s['amount'], itemId: item, quantity: s['quantity'], unitPrice: s['unitPrice'] }] };
      r = await req('POST', '/bills', body);
      w.bodies.set(s['doc'], body);
      w.routes.set(s['doc'], 'bills');
      break;
    }
    case 'check': {
      const body = { bankAccountId: c.roles['checking'], contactId: w.vendor, payeeNameOnCheck: golden['seed'].vendor, txnDate: s['date'], amount: s['amount'],
        lines: [{ accountId: w.asset, amount: s['amount'], itemId: item, quantity: s['quantity'], unitPrice: s['unitPrice'] }] };
      r = await req('POST', '/checks', body);
      w.bodies.set(s['doc'], body);
      w.routes.set(s['doc'], 'checks');
      break;
    }
    case 'card_charge': {
      const body = { txnType: 'expense', txnDate: s['date'], contactId: w.vendor, payFromAccountId: w.card,
        lines: [{ expenseAccountId: w.asset, amount: s['amount'], itemId: item, quantity: s['quantity'], unitPrice: s['unitPrice'] }] };
      r = await req('POST', '/transactions', body);
      w.bodies.set(s['doc'], body);
      w.routes.set(s['doc'], 'transactions');
      break;
    }
    case 'sales_receipt': {
      const body = { contactId: c.customer, txnDate: s['date'], depositToAccountId: c.roles['checking'],
        lines: [{ itemId: item, quantity: s['quantity'], unitPrice: golden['seed'].salePrice, isTaxable: false }] };
      r = await req('POST', '/sales-receipts', body);
      w.bodies.set(s['doc'], body);
      w.routes.set(s['doc'], 'sales-receipts');
      break;
    }
    case 'cash_sale': {
      const body = { txnType: 'cash_sale', contactId: c.customer, txnDate: s['date'], depositToAccountId: c.roles['checking'],
        lines: [{ accountId: c.roles['income'], itemId: item, quantity: s['quantity'], unitPrice: golden['seed'].salePrice, isTaxable: false }] };
      r = await req('POST', '/transactions', body);
      w.bodies.set(s['doc'], body);
      w.routes.set(s['doc'], 'transactions');
      break;
    }
    case 'credit_memo': {
      const body = { contactId: c.customer, txnDate: s['date'], lines: [{ itemId: item, quantity: s['quantity'], unitPrice: golden['seed'].salePrice, isTaxable: false,
        ...(s['returnOf'] ? { returnOf: { transactionId: w.docs.get(s['returnOf'])! } } : {}) }] };
      r = await req('POST', '/credit-memos', body);
      if (expectStatus) {
        expect([r.status, r.json['error']?.code], JSON.stringify(r.json)).toEqual([expectStatus, s['expect'].code]);
        return;
      }
      w.bodies.set(s['doc'], body);
      w.routes.set(s['doc'], 'credit-memos');
      break;
    }
    case 'vendor_credit':
      r = await req('POST', '/vendor-credits', { contactId: w.vendor, txnDate: s['date'], lines: [{ accountId: w.asset, amount: s['amount'], itemId: item, quantity: s['quantity'], unitPrice: s['unitPrice'] }] });
      break;
    case 'invoice': {
      const body = { contactId: c.customer, txnDate: s['date'], lines: [{ itemId: item, quantity: s['quantity'], unitPrice: golden['seed'].salePrice, isTaxable: false }] };
      r = await req('POST', '/invoices', body);
      w.bodies.set(s['doc'], body);
      w.routes.set(s['doc'], 'invoices');
      break;
    }
    case 'adjust_qty':
    case 'adjust_value': {
      const t = await postAdjustment(c.tenantId, c.companyId, {
        txnDate: s['date'], adjustmentAccountId: w.adjustment,
        lines: [{ itemId: item, ...(s['quantityChange'] ? { quantityChange: s['quantityChange'] } : {}), ...(s['valueChange'] ? { valueChange: s['valueChange'] } : {}) }],
      }, c.userId);
      w.docs.set(s['doc'], t.id);
      return;
    }
    case 'void':
      r = await req('POST', `/transactions/${w.docs.get(s['doc'])}/void`, { reason: 'golden' });
      if (typeof expectStatus === 'number') {
        expect([r.status, r.json['error']?.code], JSON.stringify(r.json)).toEqual([expectStatus, s['expect'].code]);
        return;
      }
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      lastReply = r.json;
      return;
    case 'delete':
      r = await req('DELETE', `/transactions/${w.docs.get(s['doc'])}`, { reason: 'golden' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      if (s['expect']?.status) expect(r.json['transaction']?.status ?? r.json['status']).toBe(s['expect'].status);
      lastReply = r.json;
      return;
    case 'edit': {
      const id = w.docs.get(s['doc'])!;
      const body = structuredClone(w.bodies.get(s['doc'])!) as Body;
      if (s['quantity']) body['lines'][0].quantity = s['quantity'];
      if (s['date']) body['txnDate'] = s['date'];
      const route = w.routes.get(s['doc']) ?? 'invoices';
      r = await req('PUT', `/${route}/${id}`, body);
      if (typeof expectStatus === 'number') {
        expect([r.status, r.json['error']?.code], JSON.stringify(r.json)).toEqual([expectStatus, s['expect'].code]);
        return;
      }
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      w.bodies.set(s['doc'], body);
      lastReply = r.json;
      return;
    }
    default:
      throw new Error(`step ${s['event']} is not run here`);
  }
  expect([200, 201], JSON.stringify(r!.json)).toContain(r!.status);
  if (s['doc']) w.docs.set(s['doc'], idOf(r!.json));
  lastReply = r!.json;
}

/** The item's movement rows in position order. */
async function rows(itemId: string) {
  return db.select().from(inventoryMovements)
    .where(and(eq(inventoryMovements.tenantId, c.tenantId), eq(inventoryMovements.itemId, itemId), eq(inventoryMovements.voided, false)))
    .orderBy(inventoryMovements.movementDate, inventoryMovements.txnCreatedAt, inventoryMovements.transactionId);
}

const m2 = (v: string) => Number(v).toFixed(2);

/** I1/I2 and B5: the stock ledger agrees with the GL and the cached balances. */
async function invariants(w: World) {
  const gl = async (accountId: string) => (await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,2)::text AS b FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id WHERE jl.tenant_id = ${c.tenantId} AND jl.account_id = ${accountId} AND t.status = 'posted'`)).rows[0] as { b: string };
  const valuation = (await db.execute(sql`
    SELECT COALESCE(SUM(last.running_value), 0)::numeric(19,2)::text AS v FROM (
      SELECT DISTINCT ON (m.item_id) m.running_value FROM inventory_movements m JOIN items i ON i.id = m.item_id
      WHERE m.tenant_id = ${c.tenantId} AND m.voided = false AND i.asset_account_id = ${w.asset}
      ORDER BY m.item_id, m.movement_date DESC, m.txn_created_at DESC, m.transaction_id DESC) last`)).rows[0] as { v: string };
  expect(valuation.v, 'I2 valuation = accrual GL').toBe((await gl(w.asset)).b);
  for (const id of [w.asset, w.cogs, w.adjustment]) {
    const [a] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, id));
    expect(m2(a!.balance!), 'B5 accounts.balance = sum of lines').toBe((await gl(id)).b);
    // Void and deleted documents net to zero: all lines, any status.
  }
  const all = (await db.execute(sql`SELECT COALESCE(SUM(debit - credit), 0)::numeric(19,2)::text AS b FROM journal_lines WHERE tenant_id = ${c.tenantId} AND account_id = ${w.asset}`)).rows[0] as { b: string };
  expect(all.b).toBe((await gl(w.asset)).b);
  // I1: running_value = sum of written figures.
  let p = 0;
  for (const r of await rows(w.items.get('W')!)) {
    p = Math.round((p + Number(r.value) + Number(r.correction) + Number(r.residual)) * 100) / 100;
    expect(m2(r.runningValue), 'I1').toBe(p.toFixed(2));
  }
}

async function figures(w: World, name = 'W') {
  return (await req('GET', `/items/${w.items.get(name)}`)).json['item'] as Body;
}

async function checkExpect(w: World, e: Body | undefined, docId: string | undefined) {
  if (!e || typeof e['status'] === 'number') return;
  if (e['warnings']) {
    // U-158: NEGATIVE_STOCK on the route's reply, warnings[].
    const got = ((lastReply['warnings'] ?? []) as Body[]).filter((x) => x['code'] === 'NEGATIVE_STOCK');
    expect(got, 'warnings[] NEGATIVE_STOCK').toEqual((e['warnings'] as Body[]).map((x) => ({ code: x['code'], itemId: w.items.get(x['item']), date: x['date'], onHand: x['onHand'] })));
  }
  const f = await figures(w);
  if (e['onHand']) expect(f['quantityOnHand']).toBe(e['onHand']);
  if (e['assetValue']) expect(f['assetValue']).toBe(e['assetValue']);
  if (e['averageCost']) expect(f['averageCost']).toBe(e['averageCost']);
  if (docId && (e['value'] || e['correction'] || e['residual'])) {
    const [m] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, docId));
    if (e['value']) expect(m2(m!.value), 'value').toBe(e['value']);
    expect(m2(m!.correction), 'correction').toBe(e['correction'] ?? '0.00');
    expect(m2(m!.residual), 'residual').toBe(e['residual'] ?? '0.00');
  }
}

async function runSteps(w: World, steps: Body[], via?: (s: Body) => string | undefined) {
  for (const s of steps) {
    await step(w, s, via?.(s));
    await checkExpect(w, s['expect'], s['doc'] ? w.docs.get(s['doc']) : undefined);
    await invariants(w);
  }
}

async function checkRows(w: World, expected: Body[], subset = false) {
  const name = new Map([...w.docs].map(([k, v]) => [v, k]));
  const want = new Set(expected.map((e) => e['doc'] as string));
  const got = (await rows(w.items.get('W')!)).filter((r) => !subset || want.has(name.get(r.transactionId)!));
  expect(got.map((r) => name.get(r.transactionId))).toEqual(expected.map((e) => e['doc']));
  expected.forEach((e, i) => {
    const r = got[i]!;
    expect(m2(r.value), `${e['doc']} value`).toBe(e['value']);
    if (e['correction']) expect(m2(r.correction), `${e['doc']} correction`).toBe(e['correction']);
    if (e['onHand']) expect(Number(r.runningQty).toFixed(4), `${e['doc']} onHand`).toBe(e['onHand']);
    if (e['assetValue']) expect(m2(r.runningValue), `${e['doc']} assetValue`).toBe(e['assetValue']);
  });
}

async function checkFinal(w: World, final: Body | undefined) {
  if (!final) return;
  const f = await figures(w);
  expect(f['quantityOnHand']).toBe(final['W'].onHand);
  expect(f['assetValue']).toBe(final['W'].assetValue);
  if (final['W'].averageCost) expect(f['averageCost']).toBe(final['W'].averageCost);
}

describe('inventory-costing-v1 golden cases (U-157)', () => {
  it('A: reference sequence with negative stock, correction and adjustments; tie-out', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    await checkFinal(w, gcase('A')['final']);
    const t = gcase('A')['tieOut'];
    const bal = async (id: string) => (await db.execute(sql`SELECT COALESCE(SUM(jl.debit), 0)::numeric(19,2)::text AS d, COALESCE(SUM(jl.credit), 0)::numeric(19,2)::text AS c,
      COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,2)::text AS b FROM journal_lines jl JOIN transactions x ON x.id = jl.transaction_id
      WHERE jl.tenant_id = ${c.tenantId} AND jl.account_id = ${id} AND x.status = 'posted'`)).rows[0] as { d: string; c: string; b: string };
    expect((await bal(w.asset)).b).toBe(t['inventory']);
    expect((await bal(w.cogs)).b).toBe(t['cogs']);
    expect([(await bal(w.adjustment)).d, (await bal(w.adjustment)).c]).toEqual([t['adjustmentDebit'], t['adjustmentCredit']]);
  });

  it('A step 5 warns NEGATIVE_STOCK; readers keep derived lines out of lines (B3)', async () => {
    const w = await setup();
    const steps = gcase('A')['steps'] as Body[];
    await runSteps(w, steps.slice(0, 4));
    // NEGATIVE_STOCK comes back from the ledger core (inventoryWarnings); warnings[] on route replies is E2b (U-158).
    const s5 = steps[4]!;
    const { createInvoice } = await import('../services/invoice.service.js');
    const inv5 = await createInvoice(c.tenantId, { contactId: c.customer, txnDate: s5['date'],
      lines: [{ itemId: w.items.get('W'), quantity: s5['quantity'], unitPrice: '10.00', isTaxable: false }] } as never, c.userId, c.companyId) as Body;
    const want = s5['expect']['warnings'][0];
    expect(inv5['inventoryWarnings']).toEqual([{ code: want.code, itemId: w.items.get('W'), date: want.date, onHand: want.onHand }]);
    const r = await req('POST', '/transactions', { txnType: 'journal_entry', txnDate: '2026-01-11', lines: [
      { accountId: w.asset, debit: '1.00', credit: '0' }, { accountId: c.roles['income'], debit: '0', credit: '1.00' }] });
    expect(r.status, 'a journal entry may post to an inventory asset account').toBe(201);
    await req('DELETE', `/transactions/${r.json['transaction'].id}`, {});
    const invRes = await req('GET', `/invoices/${w.docs.get('A3')}`);
    const inv = { json: (invRes.json['invoice'] ?? invRes.json) as Body };
    expect((inv.json['lines'] as Body[]).every((l) => !['cogs', 'inventory_relief'].includes(l['lineRole']))).toBe(true);
    expect((inv.json['inventoryLines'] as Body[]).map((l) => [l['role'], l['amount']]).sort()).toEqual([['cogs', '14.35'], ['inventory_relief', '-14.35']]);
    const viaTxn = await req('GET', `/transactions/${w.docs.get('A3')}`);
    expect((viaTxn.json['transaction']?.inventoryLines ?? viaTxn.json['inventoryLines']) as Body[]).toHaveLength(2);
  });

  it('B: a backdated receipt re-values every later sale and adjustment', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    await runSteps(w, gcase('B')['steps']);
    await checkRows(w, gcase('B')['rows']);
    await checkFinal(w, gcase('B')['final']);
  });

  it('V: voiding the Jan 5 bill re-walks the item; the void keeps mirrored lines', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    await runSteps(w, gcase('V')['steps']);
    await checkRows(w, gcase('V')['rows']);
    await checkFinal(w, gcase('V')['final']);
    const [m] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, w.docs.get('A2')!));
    expect(m!.voided).toBe(true);
  });

  it('X: deleting the Jan 5 bill gives case V numbers, status deleted, reversal lines', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    await runSteps(w, gcase('X')['steps']);
    await checkRows(w, gcase(gcase('X')['rowsAs'])['rows']);
    await checkFinal(w, gcase('X')['final']);
    const [t] = await db.select().from(transactions).where(eq(transactions.id, w.docs.get('A2')!));
    expect(t!.status).toBe('deleted');
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, w.docs.get('A2')!));
    expect(lines.some((l) => l.isVoidReversal)).toBe(true);
  });

  it('M: an invoice quantity edit, then a receipt moved earlier, re-walk from the earliest position', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    const m = gcase('M');
    const s10 = m['steps'][0] as Body;
    const s11 = m['steps'][1] as Body;
    await runSteps(w, [s10]);
    await checkRows(w, m['rowsAfter']['10']);
    await runSteps(w, [s11]);
    await checkRows(w, m['rowsAfter']['11']);
    await checkFinal(w, m['final']);
    const corr = await db.select().from(journalLines).where(and(eq(journalLines.transactionId, w.docs.get('A6')!), eq(journalLines.lineRole, 'cost_correction')));
    expect(corr).toHaveLength(0);
  });

  for (const id of ['D', 'N']) {
    it(`${id}: ${gcase(id)['title']}`, async () => {
      const w = await setup();
      await runSteps(w, gcase(id)['steps']);
      await checkFinal(w, gcase(id)['final']);
    });
  }
});

describe('closed periods are refused for inventory (owner decision 2026-11-06, golden C)', () => {
  it('C: a document with inventory lines on or before the closing date is 409 INVENTORY_PERIOD_CLOSED, password or not; nothing changes', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    const pw = await req('PUT', '/company/closing-password', { newPassword: 'closing-pass-1' });
    expect(pw.status, JSON.stringify(pw.json)).toBe(200);
    const close = await req('PUT', '/company/settings', { lockDate: '2026-01-10', closingPassword: 'closing-pass-1' });
    expect(close.status, JSON.stringify(close.json)).toBe(200);
    const before = await figures(w);
    const lines = [{ accountId: w.asset, amount: '12.00', itemId: w.items.get('W'), quantity: '6', unitPrice: '2.00' }];
    const err = (r: { status: number; json: Body }) => [r.status, r.json['error']?.code];
    for (const c5 of gcase('C')['refusals'] as Body[]) {
      let r: { status: number; json: Body };
      if (c5['event'] === 'bill') r = await req('POST', '/bills', { contactId: w.vendor, txnDate: c5['date'], closingPassword: 'closing-pass-1', lines });
      else if (c5['event'] === 'void') r = await req('POST', `/transactions/${w.docs.get(c5['doc'])}/void`, { reason: 'x', closingPassword: 'closing-pass-1' });
      else if (c5['event'] === 'delete') r = await req('DELETE', `/transactions/${w.docs.get(c5['doc'])}`, { closingPassword: 'closing-pass-1' });
      else if (c5['event'] === 'adjust_qty') {
        const e = await postAdjustment(c.tenantId, c.companyId, { txnDate: c5['date'], adjustmentAccountId: w.adjustment,
          lines: [{ itemId: w.items.get('W')!, quantityChange: c5['quantityChange'] }] }, c.userId).then(() => null, (x) => x as Body);
        r = { status: e?.['statusCode'] ?? 201, json: { error: { code: e?.['code'] } } };
      } else {
        const body = { ...structuredClone(w.bodies.get(c5['doc'])!), ...(c5['date'] ? { txnDate: c5['date'] } : {}), closingPassword: 'closing-pass-1' } as Body;
        if (c5['quantity']) body['lines'][0].quantity = c5['quantity'];
        r = await req('PUT', `/invoices/${w.docs.get(c5['doc'])}`, body);
      }
      expect(err(r), JSON.stringify(c5)).toEqual([409, 'INVENTORY_PERIOD_CLOSED']);
    }
    expect(await figures(w)).toEqual(before);
    await invariants(w);
    // After the closing date inventory posts as usual; a document without items keeps the password flow.
    const ok = await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-11', lines });
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const plain = await req('POST', '/transactions', { txnType: 'journal_entry', txnDate: '2026-01-09', closingPassword: 'closing-pass-1', lines: [
      { accountId: c.roles['expense'], debit: '1.00', credit: '0' }, { accountId: c.roles['checking'], debit: '0', credit: '1.00' }] });
    expect(plain.status, JSON.stringify(plain.json)).toBe(201);
    await invariants(w);
  });

  it('C: closing moved later refuses the newly closed documents with nothing recomputed; moved earlier reopens them (case M step 10 numbers)', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    const rowsBefore = await rows(w.items.get('W')!);
    expect((await req('PUT', '/company/settings', { lockDate: '2026-01-20' })).status).toBe(200);
    expect((await rows(w.items.get('W')!)).map((r) => [r.id, r.value, r.runningValue])).toEqual(rowsBefore.map((r) => [r.id, r.value, r.runningValue]));
    const body = { ...structuredClone(w.bodies.get('A6')!), txnDate: '2026-01-16' } as Body;
    const moved = await req('PUT', `/bills/${w.docs.get('A6')}`, body);
    expect([moved.status, moved.json['error']?.code]).toEqual([409, 'INVENTORY_PERIOD_CLOSED']);
    expect((await req('PUT', '/company/settings', { lockDate: '2026-01-05' })).status).toBe(200);
    await runSteps(w, [(gcase('M')['steps'] as Body[])[0]!]);
    await checkRows(w, gcase('M')['rowsAfter']['10']);
  });

  for (const id of ['K', 'K2']) {
    it(`${id}: ${gcase(id)['title']}`, async () => {
      const w = await setup();
      await runSteps(w, gcase('A')['steps']);
      expect((await req('PUT', '/company/settings', { lockDate: '2026-01-10' })).status).toBe(200);
      const closedLines = async () => (await db.execute(sql`
        SELECT jl.id, jl.account_id, jl.debit::text, jl.credit::text, jl.line_role FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
        WHERE jl.tenant_id = ${c.tenantId} AND t.txn_date <= '2026-01-10' ORDER BY jl.id`)).rows;
      const closedRows = async () => (await db.execute(sql`
        SELECT id, value::text, correction::text, residual::text, running_qty::text, running_value::text, last_cost::text FROM inventory_movements
        WHERE tenant_id = ${c.tenantId} AND movement_date <= '2026-01-10' ORDER BY id`)).rows;
      const [lines0, rows0] = [await closedLines(), await closedRows()];
      await runSteps(w, (gcase(id)['steps'] as Body[]).filter((s) => s['event'] !== 'closing_date'));
      await checkRows(w, gcase(id)['rows']);
      await checkFinal(w, gcase(id)['final']);
      expect(await closedLines(), 'every line dated on or before the closing date byte-identical').toEqual(lines0);
      expect(await closedRows(), 'no closed movement row changes').toEqual(rows0);
    });
  }
});

describe('inventory-costing-v1 guards (B3, B4)', () => {
  it('refuses client-sent derived roles, direct inventory lines, parts off their asset account and parts on unsupported documents', async () => {
    const w = await setup();
    const err = (r: { status: number; json: Body }) => [r.status, r.json['error']?.code];
    const direct = await req('POST', '/transactions', { txnType: 'expense', txnDate: '2026-01-02', contactId: w.vendor,
      payFromAccountId: c.roles['checking'], lines: [{ expenseAccountId: w.asset, amount: '5.00' }] });
    expect(err(direct), JSON.stringify(direct.json)).toEqual([400, 'INVENTORY_ACCOUNT_DIRECT']);
    expect(err(await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-02', lines: [{ accountId: c.roles['expense'], amount: '5.00', itemId: w.items.get('W'), quantity: '1', unitPrice: '5.00' }] })))
      .toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-02', lines: [{ accountId: w.asset, amount: '5.00', itemId: w.items.get('W') }] })))
      .toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-02', lines: [{ accountId: w.asset, amount: '5.00' }] })))
      .toEqual([400, 'INVENTORY_ACCOUNT_DIRECT']);
    const { postTransaction } = await import('../services/ledger.service.js');
    await expect(postTransaction(c.tenantId, { txnType: 'journal_entry', txnDate: '2026-01-02', lines: [
      { accountId: w.cogs, debit: '1', credit: '0', lineRole: 'cogs' }, { accountId: w.asset, debit: '0', credit: '1' }] } as never, c.userId, c.companyId))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    // A part on a document type that doesn't move stock (a journal entry here; checks and cash sales until E2b).
    await expect(postTransaction(c.tenantId, { txnType: 'journal_entry', txnDate: '2026-01-02', lines: [
      { accountId: w.asset, debit: '1', credit: '0', itemId: w.items.get('W'), quantity: '1' }, { accountId: c.roles['income'], debit: '0', credit: '1' }] } as never, c.userId, c.companyId))
      .rejects.toMatchObject({ code: 'INVENTORY_DOCUMENT_UNSUPPORTED' });
  });

  it('bulk moves are 409 INVENTORY_DOCUMENT; an asset-account change with movements is 409 ITEM_HAS_INVENTORY; inventory off with stock is 409', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 3));
    const bulk = await req('POST', '/transactions/bulk-update', { txnIds: [w.docs.get('A3')], setCategoryAccountId: c.roles['expense'] });
    expect([bulk.status, bulk.json['error']?.code]).toEqual([409, 'INVENTORY_DOCUMENT']);
    const [other] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Stock 2', accountType: 'asset', detailType: 'other_current_asset' }).returning();
    const put = await req('PUT', `/items/${w.items.get('W')}`, { assetAccountId: other!.id });
    expect([put.status, put.json['error']?.code]).toEqual([409, 'ITEM_HAS_INVENTORY']);
    const off = await req('PUT', '/company/settings', { inventoryEnabled: false });
    expect([off.status, off.json['error']?.code]).toEqual([409, 'INVENTORY_IN_USE']);
    expect((await figures(w))['quantityOnHand']).toBe('11.0000');
  });

  it('advertises inventory-costing-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('inventory-costing-v1');
  });
});

describe('inventory-costing-v1 returns, cash sales, checks and card charges (U-158, E2b)', () => {
  it('E: unlinked returns at the current average; a vendor credit at its line amount leaves a residual', async () => {
    const w = await setup();
    await runSteps(w, gcase('E')['steps']);
    await checkFinal(w, gcase('E')['final']);
    const [m] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, w.docs.get('E5')!));
    expect([m!.kind, m!.valueMode, m!.sourceTransactionId]).toEqual(['customer_return', 'derived', null]);
  });

  it('R: linked returns at the original sale cost, RETURN_EXCEEDS_SALE, SALE_HAS_RETURNS, re-valued when the sale re-costs', async () => {
    const w = await setup();
    const r = gcase('R');
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, r['fromSteps']));
    await runSteps(w, r['steps']);
    await checkRows(w, r['rows'], true);
    await checkFinal(w, r['final']);
    // I7: every unit of A3 returned gives back exactly its relief.
    const mv = async (doc: string) => (await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, w.docs.get(doc)!)))[0]!;
    const back = Number((await mv('R1')).value) + Number((await mv('R2')).value);
    expect(back.toFixed(2)).toBe((-Number((await mv('A3')).value)).toFixed(2));
    expect([(await mv('R1')).valueMode, (await mv('R1')).sourceTransactionId]).toEqual(['linked', w.docs.get('A3')]);
    // Readers: returnOf on the line, the asset / COGS pair in inventoryLines only.
    const got = await req('GET', `/credit-memos/${w.docs.get('R1')}`);
    const memo = got.json['creditMemo'] as Body;
    expect(memo['lines'][0].returnOf).toEqual({ transactionId: w.docs.get('A3') });
    expect((memo['lines'] as Body[]).every((l) => l['accountId'] !== w.asset)).toBe(true);
    expect((memo['inventoryLines'] as Body[]).map((l) => [l['role'], l['amount']]).sort()).toEqual([['cogs', '-6.27'], ['inventory_relief', '6.27']]);
    // A sale with linked returns: no void, no fewer units than returned, no item off it, no move after a return (Q-P24x).
    const code = (x: { status: number; json: Body }) => [x.status, x.json['error']?.code];
    // (An invoice is never deleted: 409 TXN_DELETE_UNSUPPORTED; its void is golden R step 10.)
    const a3 = structuredClone(w.bodies.get('A3')!) as Body;
    expect(code(await req('PUT', `/invoices/${w.docs.get('A3')}`, { ...a3, lines: [{ ...a3['lines'][0], quantity: '3' }] }))).toEqual([409, 'SALE_HAS_RETURNS']);
    expect(code(await req('PUT', `/invoices/${w.docs.get('A3')}`, { ...a3, txnDate: '2026-01-17' }))).toEqual([409, 'SALE_HAS_RETURNS']);
    expect(code(await req('PUT', `/invoices/${w.docs.get('A3')}`, { ...a3, lines: [{ accountId: c.roles['income'], quantity: '4', unitPrice: '10.00', isTaxable: false }] })))
      .toEqual([409, 'SALE_HAS_RETURNS']);
    // A move that stays before the returns re-costs the sale and its returns.
    expect((await req('PUT', `/invoices/${w.docs.get('A3')}`, { ...a3, txnDate: '2026-01-16' })).status).toBe(200);
    await invariants(w);
    expect(((await mv('R1')).value)).not.toBe('7.1800');
    // A credit memo edit that omits returnOf keeps the link; null unlinks (current average).
    const r2 = structuredClone(w.bodies.get('R2')!) as Body;
    const { returnOf: _drop, ...plain } = r2['lines'][0] as Body;
    expect((await req('PUT', `/credit-memos/${w.docs.get('R2')}`, { ...r2, memo: 'kept', lines: [plain] })).status).toBe(200);
    expect([(await mv('R2')).valueMode, (await mv('R2')).sourceTransactionId]).toEqual(['linked', w.docs.get('A3')]);
    expect((await req('PUT', `/credit-memos/${w.docs.get('R2')}`, { ...r2, lines: [{ ...plain, returnOf: null }] })).status).toBe(200);
    expect([(await mv('R2')).valueMode, (await mv('R2')).sourceTransactionId]).toEqual(['derived', null]);
    await invariants(w);
    // Once its last linked return is voided the sale can be voided.
    expect((await req('POST', `/transactions/${w.docs.get('R1')}/void`, { reason: 'x' })).status).toBe(200);
    expect((await req('POST', `/transactions/${w.docs.get('A3')}/void`, { reason: 'x' })).status).toBe(200);
    await invariants(w);
  });

  it('refuses a return dated before its sale, of an item the sale did not sell, or on a document that is not a credit memo', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 3));
    const code = (x: { status: number; json: Body }) => [x.status, x.json['error']?.code];
    const line = { itemId: w.items.get('W'), quantity: '1', unitPrice: '10.00', isTaxable: false };
    expect(code(await req('POST', '/credit-memos', { contactId: c.customer, txnDate: '2026-01-07', lines: [{ ...line, returnOf: { transactionId: w.docs.get('A3') } }] })))
      .toEqual([400, 'RETURN_BEFORE_SALE']);
    expect(code(await req('POST', '/credit-memos', { contactId: c.customer, txnDate: '2026-01-09', lines: [{ ...line, returnOf: { transactionId: w.docs.get('A1') } }] })))
      .toEqual([400, 'VALIDATION_ERROR']);
    const other = await req('POST', '/items', { name: 'Other part', itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: c.roles['income'], assetAccountId: w.asset, cogsAccountId: w.cogs });
    expect(code(await req('POST', '/credit-memos', { contactId: c.customer, txnDate: '2026-01-09',
      lines: [{ ...line, itemId: other.json['item'].id, returnOf: { transactionId: w.docs.get('A3') } }] }))).toEqual([400, 'VALIDATION_ERROR']);
    const { postTransaction } = await import('../services/ledger.service.js');
    await expect(postTransaction(c.tenantId, { txnType: 'invoice', txnDate: '2026-01-09', contactId: c.customer, lines: [
      { accountId: c.roles['accounts_receivable'], debit: '10', credit: '0' },
      { accountId: c.roles['income'], debit: '0', credit: '10', itemId: w.items.get('W'), quantity: '1', returnOf: { transactionId: w.docs.get('A3')! } }] } as never, c.userId, c.companyId))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await invariants(w);
  });

  it('A through checks, card charges, sales receipts and cash sales: the same stock ledger, warnings[] on replies, derived lines only in inventoryLines', async () => {
    const w = await setup();
    const via: Record<string, string> = { A1: 'check', A2: 'card_charge', A3: 'sales_receipt', A4: 'cash_sale', A6: 'check', A9: 'sales_receipt' };
    await runSteps(w, gcase('A')['steps'], (s) => via[s['doc']]);
    await checkFinal(w, gcase('A')['final']);
    for (const doc of ['A1', 'A2', 'A4', 'A6']) {
      const t = (await req('GET', `/transactions/${w.docs.get(doc)}`)).json as Body;
      const txn = (t['transaction'] ?? t) as Body;
      expect((txn['lines'] as Body[]).every((l) => !['cogs', 'inventory_relief', 'cost_correction', 'cost_residual'].includes(l['lineRole'])), doc).toBe(true);
      expect(Array.isArray(txn['inventoryLines']), doc).toBe(true);
    }
    const a4 = ((await req('GET', `/transactions/${w.docs.get('A4')}`)).json['transaction'] ?? {}) as Body;
    expect((a4['inventoryLines'] as Body[]).map((l) => [l['role'], l['amount']]).sort()).toEqual([['cogs', '39.48'], ['inventory_relief', '-39.48']]);
    const a6 = ((await req('GET', `/transactions/${w.docs.get('A6')}`)).json['transaction'] ?? {}) as Body;
    expect((a6['inventoryLines'] as Body[]).map((l) => [l['role'], l['amount']]).sort()).toEqual([['cost_correction', '-0.63'], ['cost_correction', '0.63']]);
    const sr = (await req('GET', `/sales-receipts/${w.docs.get('A3')}`)).json['salesReceipt'] as Body;
    expect((sr['inventoryLines'] as Body[]).map((l) => [l['role'], l['amount']]).sort()).toEqual([['cogs', '14.35'], ['inventory_relief', '-14.35']]);
    expect(sr['lines']).toHaveLength(1);
    // Voiding the card charge (A2) gives case V's numbers and warns on the reply.
    await runSteps(w, [{ n: 10, event: 'void', doc: 'A2', expect: gcase('V')['steps'][0].expect }]);
    await checkRows(w, gcase('V')['rows']);
    // A check line amount must be quantity x cost.
    const bad = await req('POST', '/checks', { bankAccountId: c.roles['checking'], payeeNameOnCheck: 'Prairie Mill Supply', txnDate: '2026-02-01', amount: '5.00',
      lines: [{ accountId: w.asset, amount: '5.00', itemId: w.items.get('W'), quantity: '2', unitPrice: '3.00' }] });
    expect([bad.status, bad.json['error']?.code]).toEqual([400, 'LINE_AMOUNT_MISMATCH']);
  });

  it('previews warn NEGATIVE_STOCK in warnings[] without writing anything', async () => {
    const w = await setup();
    const steps = gcase('A')['steps'] as Body[];
    await runSteps(w, steps.slice(0, 4));
    const before = await rows(w.items.get('W')!);
    const s5 = steps[4]!;
    const want = [{ code: 'NEGATIVE_STOCK', itemId: w.items.get('W'), date: s5['date'], onHand: '-3.0000' }];
    const line = { itemId: w.items.get('W'), quantity: s5['quantity'], unitPrice: '10.00', isTaxable: false };
    const inv = await req('POST', '/invoices/preview', { contactId: c.customer, txnDate: s5['date'], lines: [line] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(200);
    expect((inv.json['warnings'] as Body[]).filter((x) => x['code'] === 'NEGATIVE_STOCK')).toEqual(want);
    const sr = await req('POST', '/sales-receipts/preview', { contactId: c.customer, txnDate: s5['date'], depositToAccountId: c.roles['checking'], lines: [line] });
    expect((sr.json['warnings'] as Body[]).filter((x) => x['code'] === 'NEGATIVE_STOCK')).toEqual(want);
    // Editing the Jan 8 invoice up to 15 units would take Jan 10 below zero.
    const edit = await req('POST', '/invoices/preview', { ...w.bodies.get('A3'), invoiceId: w.docs.get('A3'), lines: [{ ...line, quantity: '15' }] });
    expect((edit.json['warnings'] as Body[]).filter((x) => x['code'] === 'NEGATIVE_STOCK')).toEqual([{ ...want[0], date: '2026-01-10', onHand: '-11.0000' }]);
    const cm = await req('POST', '/credit-memos/preview', { contactId: c.customer, txnDate: s5['date'], lines: [line] });
    expect(cm.json['warnings']).toEqual([]);
    expect(await rows(w.items.get('W')!)).toEqual(before);
  });
});

describe('inventory-costing-v1 on cash basis (golden G, U-158)', () => {
  it('G: rule 3 scales the invoice COGS and relief by payment / total; an applied credit memo and a $0 invoice show none', async () => {
    c = await h.company('0.081000');
    const w = await setup();
    const g = gcase('G');
    const steps = g['steps'] as Body[];
    const { payBills } = await import('../services/bill-payment.service.js');
    const { receivePayment } = await import('../services/payment.service.js');
    for (const s of steps) {
      if (s['event'] === 'bill_payment') {
        await payBills(c.tenantId, { bankAccountId: c.roles['checking'], txnDate: s['date'], method: 'check', printLater: true,
          bills: [{ billId: w.docs.get(s['bill'])!, amount: s['amount'] }] } as never, c.userId, c.companyId);
      } else if (s['event'] === 'customer_payment') {
        await receivePayment(c.tenantId, { customerId: c.customer, date: s['date'], amount: s['amount'], depositTo: c.roles['checking'],
          applications: [{ invoiceId: w.docs.get(s['invoice'])!, amount: s['amount'] }] } as never, c.userId, c.companyId);
      } else if (s['event'] === 'invoice') {
        const body = { contactId: c.customer, txnDate: s['date'], lines: [{ itemId: w.items.get('W'), quantity: s['quantity'], unitPrice: '10.00', isTaxable: true }] };
        const r = await req('POST', '/invoices', body);
        expect(r.status, JSON.stringify(r.json)).toBe(201);
        expect(r.json['invoice'].total).toMatch(new RegExp(`^${s['total'].replace('.', '\\.')}`));
        w.docs.set(s['doc'], idOf(r.json));
      } else {
        await step(w, s);
      }
      await invariants(w);
    }
    const want = g['asOf']['2026-01-31'];
    const reports = await import('../services/report.service.js');
    const pl = await reports.buildProfitAndLoss(c.tenantId, '2026-01-01', '2026-01-31', 'cash', c.companyId, null, null, { exactAmounts: true });
    const cogs = pl.cogs.find((e) => e.accountId === w.cogs)!;
    expect(cogs.amountExact && new Decimal(cogs.amountExact).toString(), 'cash COGS share, unrounded').toBe(new Decimal(want.cash.cogsShare).toString());
    expect(cogs.amount.toFixed(2)).toBe(want.cash.cogs);
    expect(pl.totalRevenue.toFixed(2)).toBe(want.cash.income);
    const bs = await reports.buildBalanceSheet(c.tenantId, '2026-01-31', 'cash', c.companyId);
    expect(bs.assets.find((a) => a.accountId === w.asset)!.balance.toFixed(2), 'cash inventory').toBe(want.cash.inventory);
    expect(bs.totalAssets.toFixed(2)).toBe((bs.totalLiabilities + bs.totalEquity).toFixed(2));
    const accrual = await reports.buildBalanceSheet(c.tenantId, '2026-01-31', 'accrual', c.companyId);
    expect(accrual.assets.find((a) => a.accountId === w.asset)!.balance.toFixed(2)).toBe(want.accrual.glInventory);
    expect((await figures(w))['assetValue']).toBe(want.accrual.valuation);
    // An applied (not refunded) credit memo is not cash: no inventory or COGS change on cash basis.
    const cm = await req('POST', '/credit-memos', { contactId: c.customer, txnDate: '2026-01-20',
      lines: [{ itemId: w.items.get('W'), quantity: '1', unitPrice: '10.00', isTaxable: true, returnOf: { transactionId: w.docs.get('A3') } }],
      applications: [{ invoiceId: w.docs.get('A3'), amount: '10.81' }] });
    expect(cm.status, JSON.stringify(cm.json)).toBe(201);
    // A $0 invoice of the item: its COGS never shows on cash basis (N3).
    const zero = await req('POST', '/invoices', { contactId: c.customer, txnDate: '2026-01-21', lines: [{ itemId: w.items.get('W'), quantity: '1', unitPrice: '0', isTaxable: false }] });
    expect(zero.status, JSON.stringify(zero.json)).toBe(201);
    await invariants(w);
    const pl2 = await reports.buildProfitAndLoss(c.tenantId, '2026-01-01', '2026-01-31', 'cash', c.companyId, null, null, { exactAmounts: true });
    expect(pl2.cogs.find((e) => e.accountId === w.cogs)!.amount.toFixed(2)).toBe(want.cash.cogs);
    const bs2 = await reports.buildBalanceSheet(c.tenantId, '2026-01-31', 'cash', c.companyId);
    expect(bs2.assets.find((a) => a.accountId === w.asset)!.balance.toFixed(2)).toBe(want.cash.inventory);
  });
});

// ─── Write paths, property, concurrency (U-157 / U-158 B4, I1-I7) ─────────

/**
 * Every write route whose body can carry an itemId (openapi.json), and what
 * it does with an inventory part. A new route fails this test until it is
 * classified here (fails closed).
 */
const ITEM_WRITE_ROUTES: Record<string, string> = {
  'POST /api/v1/bills': 'costs', 'PUT /api/v1/bills/{id}': 'costs',
  'POST /api/v1/vendor-credits': 'costs', 'PUT /api/v1/vendor-credits/{id}': 'costs',
  'POST /api/v1/checks': 'costs', 'PUT /api/v1/checks/{id}': 'costs',
  'POST /api/v1/invoices': 'costs', 'PUT /api/v1/invoices/{id}': 'costs',
  'POST /api/v1/credit-memos': 'costs', 'PUT /api/v1/credit-memos/{id}': 'costs',
  'POST /api/v1/sales-receipts': 'costs', 'PUT /api/v1/sales-receipts/{id}': 'costs',
  'POST /api/v1/transactions': 'costs (expense, cash_sale; every other txnType refuses parts)', 'PUT /api/v1/transactions/{id}': 'costs',
  'POST /api/v1/bill-captures/{id}/enter': 'costs (posts through bill.service and the ledger core)',
  'POST /api/v1/document-drafts/{id}/convert': 'costs (posts a bill or check through their services and the ledger core)',
  'POST /api/v1/invoices/preview': 'writes nothing', 'POST /api/v1/credit-memos/preview': 'writes nothing', 'POST /api/v1/sales-receipts/preview': 'writes nothing',
  'POST /api/v1/estimates': 'moves nothing (estimates store units)',
  'POST /api/v1/price-levels': 'moves nothing (prices)', 'PUT /api/v1/price-levels/{id}': 'moves nothing (prices)',
  'POST /api/v1/plaid/link-token/update': 'not an item of the item list (a Plaid item)',
};

function itemWriteRoutes(): string[] {
  const o = JSON.parse(readFileSync(path.resolve(here, '../../../../openapi.json'), 'utf8')) as Body;
  const has = (s: Body | undefined, seen = new Set<unknown>()): boolean => {
    if (!s || typeof s !== 'object' || seen.has(s)) return false;
    seen.add(s);
    if (s['$ref']) return has(o['components']['schemas'][String(s['$ref']).split('/').pop()!], seen);
    if (s['properties'] && 'itemId' in s['properties']) return true;
    return Object.values(s).some((v) => typeof v === 'object' && has(v as Body, seen));
  };
  const out: string[] = [];
  for (const [p, ops] of Object.entries(o['paths'] as Body)) {
    for (const [m, op] of Object.entries(ops as Body)) {
      if (['post', 'put', 'patch'].includes(m) && has((op as Body)['requestBody']?.content?.['application/json']?.schema)) out.push(`${m.toUpperCase()} ${p}`);
    }
  }
  return out.sort();
}

/** A seeded generator (mulberry32): the property runs are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)]! };
}

/** I5: a full replay of the item from zero gives every stored row's figures (the incremental walks agree with it). */
async function fullReplayMatches(itemId: string) {
  const { walk, ZERO_STATE } = await import('../utils/inventory-walk.js');
  const live = await rows(itemId);
  const res = walk(ZERO_STATE, live.map((m) => ({
    id: m.id, transactionId: m.transactionId, date: m.movementDate, kind: m.kind, quantity: new Decimal(m.quantity), valueMode: m.valueMode,
    given: m.valueMode === 'given' ? new Decimal(m.value) : null, sourceId: m.sourceTransactionId,
    fallbackCost: m.fallbackCost === null ? null : new Decimal(m.fallbackCost),
  })));
  live.forEach((m, i) => {
    const r = res.rows[i]!;
    const got = [m.value, m.correction, m.residual, m.runningQty, m.runningValue].map((v) => new Decimal(v).toFixed(4));
    const want = [r.fig.value, r.fig.correction, r.fig.residual, r.after.q, r.after.v].map((v) => v.toFixed(4));
    expect(got, `I5 row ${i}`).toEqual(want);
    // I3: nothing on hand holds no value.
    if (new Decimal(m.runningQty).isZero()) expect(new Decimal(m.runningValue).isZero(), 'I3').toBe(true);
  });
}

describe('inventory-costing-v1 write paths (B4)', () => {
  it('every write route that takes an itemId is classified: it costs, or moves nothing, or writes nothing', () => {
    expect(itemWriteRoutes()).toEqual(Object.keys(ITEM_WRITE_ROUTES).sort());
  });

  it('every ledger txnType either moves stock for a part line or refuses it (400 INVENTORY_DOCUMENT_UNSUPPORTED)', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 2));
    const { postTransaction } = await import('../services/ledger.service.js');
    const { INVENTORY_DOCUMENT_TYPES } = await import('../services/inventory-costing.service.js');
    const types = ['invoice', 'customer_payment', 'cash_sale', 'expense', 'deposit', 'transfer', 'journal_entry', 'credit_memo', 'customer_refund',
      'bill', 'vendor_credit', 'bill_payment', 'daily_sales', 'aje', 'returned_payment', 'sales_tax_payment', 'bad_debt_recovery', 'inventory_adjustment'];
    for (const txnType of types) {
      const stock = INVENTORY_DOCUMENT_TYPES.has(txnType);
      const buy = ['bill', 'expense', 'vendor_credit'].includes(txnType);
      const partAccount = buy ? w.asset : c.roles['income'];
      const lines = [
        { accountId: partAccount, debit: txnType === 'vendor_credit' || !buy ? '0' : '2', credit: txnType === 'vendor_credit' || !buy ? '2' : '0', itemId: w.items.get('W'), quantity: '1' },
        { accountId: c.roles['checking'], debit: txnType === 'vendor_credit' || !buy ? '2' : '0', credit: txnType === 'vendor_credit' || !buy ? '0' : '2' },
      ];
      if (txnType === 'credit_memo') { lines[0]!.debit = '2'; lines[0]!.credit = '0'; lines[1]!.debit = '0'; lines[1]!.credit = '2'; }
      if (txnType === 'inventory_adjustment') { lines[0]!.accountId = w.adjustment; lines[0]!.debit = '0'; lines[0]!.credit = '0'; lines[1]!.debit = '0'; lines[1]!.credit = '0'; }
      const outcome = await postTransaction(c.tenantId, { txnType, txnDate: '2026-01-06', contactId: buy ? w.vendor : c.customer, total: '2', lines } as never, c.userId, c.companyId)
        .then((t) => ({ ok: true as const, id: (t as Body)['id'] as string }), (e) => ({ ok: false as const, code: (e as Body)['code'] as string }));
      if (stock) {
        expect(outcome.ok, `${txnType} moves stock`).toBe(true);
        const mv = await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, (outcome as { id: string }).id));
        expect(mv, txnType).toHaveLength(1);
      } else {
        expect(outcome, `${txnType} refuses parts`).toEqual({ ok: false, code: 'INVENTORY_DOCUMENT_UNSUPPORTED' });
      }
      await invariants(w);
    }
  });

  it('property: random receipts, sales, linked and unlinked returns, vendor credits, voids and edits keep I1-I3, I5 and I7', async () => {
    for (const seed of [7, 2026, 31337]) {
      c = await h.company();
      const w = await setup();
      const r = rng(seed);
      const W = w.items.get('W')!;
      const sales: Array<{ doc: string; date: string; qty: number }> = [];
      const ok = (x: { status: number; json: Body }, allowed: string[] = []) => {
        if (x.status < 300) return true;
        expect(allowed, `seed ${seed}: ${JSON.stringify(x.json)}`).toContain(x.json['error']?.code);
        return false;
      };
      const day = () => `2026-01-${String(r.int(1, 28)).padStart(2, '0')}`;
      for (let n = 0; n < 30; n++) {
        const op = r.pick(['bill', 'bill', 'invoice', 'invoice', 'receipt', 'return', 'linked', 'vcredit', 'void', 'edit']);
        const doc = `P${seed}-${n}`;
        if (op === 'bill' || op === 'vcredit') {
          const qty = r.int(1, op === 'bill' ? 9 : 2);
          const price = (r.int(100, 999) / 100).toFixed(2);
          const amount = new Decimal(price).times(qty).toFixed(2);
          const x = await req('POST', op === 'bill' ? '/bills' : '/vendor-credits', { contactId: w.vendor, txnDate: day(),
            lines: [{ accountId: w.asset, amount, itemId: W, quantity: String(qty), unitPrice: price }] });
          if (ok(x)) w.docs.set(doc, idOf(x.json));
        } else if (op === 'invoice' || op === 'receipt') {
          const qty = r.int(1, 6);
          const date = day();
          const x = op === 'invoice'
            ? await req('POST', '/invoices', { contactId: c.customer, txnDate: date, lines: [{ itemId: W, quantity: String(qty), unitPrice: '10.00', isTaxable: false }] })
            : await req('POST', '/sales-receipts', { contactId: c.customer, txnDate: date, depositToAccountId: c.roles['checking'], lines: [{ itemId: W, quantity: String(qty), unitPrice: '10.00', isTaxable: false }] });
          if (ok(x)) { w.docs.set(doc, idOf(x.json)); sales.push({ doc, date, qty }); w.routes.set(doc, op === 'invoice' ? 'invoices' : 'sales-receipts'); }
        } else if (op === 'return' || op === 'linked') {
          const sale = op === 'linked' && sales.length > 0 ? r.pick(sales) : null;
          const date = sale ? `2026-01-${String(r.int(Number(sale.date.slice(8)), 28)).padStart(2, '0')}` : day();
          const x = await req('POST', '/credit-memos', { contactId: c.customer, txnDate: date, lines: [{ itemId: W, quantity: String(r.int(1, 2)), unitPrice: '10.00', isTaxable: false,
            ...(sale ? { returnOf: { transactionId: w.docs.get(sale.doc)! } } : {}) }] });
          if (ok(x, ['RETURN_EXCEEDS_SALE'])) w.docs.set(doc, idOf(x.json));
        } else if (op === 'void' && w.docs.size > 0) {
          const victim = r.pick([...w.docs.keys()]);
          const x = await req('POST', `/transactions/${w.docs.get(victim)}/void`, { reason: 'property' });
          if (ok(x, ['SALE_HAS_RETURNS'])) { w.docs.delete(victim); const i = sales.findIndex((s) => s.doc === victim); if (i >= 0) sales.splice(i, 1); }
        } else if (op === 'edit' && sales.length > 0) {
          const s = r.pick(sales);
          const qty = r.int(1, 6);
          const date = r.next() < 0.5 ? s.date : day();
          const route = w.routes.get(s.doc)!;
          const body = route === 'invoices'
            ? { contactId: c.customer, txnDate: date, lines: [{ itemId: W, quantity: String(qty), unitPrice: '10.00', isTaxable: false }] }
            : { contactId: c.customer, txnDate: date, depositToAccountId: c.roles['checking'], lines: [{ itemId: W, quantity: String(qty), unitPrice: '10.00', isTaxable: false }] };
          const x = await req('PUT', `/${route}/${w.docs.get(s.doc)}`, body);
          if (ok(x, ['SALE_HAS_RETURNS'])) { s.qty = qty; s.date = date; }
        }
        await invariants(w);
      }
      await fullReplayMatches(W);
      // I7: no sale gives back more than its relief.
      const over = await db.execute(sql`
        SELECT s.transaction_id FROM inventory_movements s JOIN inventory_movements r ON r.source_transaction_id = s.transaction_id AND r.item_id = s.item_id AND r.voided = false
        WHERE s.tenant_id = ${c.tenantId} AND s.voided = false AND s.source_transaction_id IS NULL AND s.kind = 'sale'
        GROUP BY s.transaction_id, s.value, s.quantity HAVING SUM(r.value) > -s.value OR SUM(r.quantity) > -s.quantity`);
      expect(over.rows, `I7 seed ${seed}`).toEqual([]);
    }
  }, 240_000);

  it('I5: with distinct dates the stock ledger does not depend on entry order', async () => {
    const w = await setup();
    const second = await req('POST', '/items', { name: 'W2', itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: c.roles['income'], assetAccountId: w.asset, cogsAccountId: w.cogs });
    const W2 = second.json['item'].id as string;
    const docs = [
      { kind: 'bill', date: '2026-02-02', qty: '10', price: '3.3333', amount: '33.33' }, { kind: 'invoice', date: '2026-02-04', qty: '4' },
      { kind: 'bill', date: '2026-02-05', qty: '5', price: '4.10', amount: '20.50' }, { kind: 'invoice', date: '2026-02-08', qty: '13' },
      { kind: 'credit_memo', date: '2026-02-09', qty: '1' }, { kind: 'vendor_credit', date: '2026-02-10', qty: '1', price: '2.00', amount: '2.00' },
      { kind: 'bill', date: '2026-02-12', qty: '7', price: '3.80', amount: '26.60' }, { kind: 'invoice', date: '2026-02-15', qty: '2' },
    ];
    const post = async (item: string, d: Body) => {
      const x = d['kind'] === 'bill' || d['kind'] === 'vendor_credit'
        ? await req('POST', d['kind'] === 'bill' ? '/bills' : '/vendor-credits', { contactId: w.vendor, txnDate: d['date'], lines: [{ accountId: w.asset, amount: d['amount'], itemId: item, quantity: d['qty'], unitPrice: d['price'] }] })
        : await req('POST', d['kind'] === 'invoice' ? '/invoices' : '/credit-memos', { contactId: c.customer, txnDate: d['date'], lines: [{ itemId: item, quantity: d['qty'], unitPrice: '10.00', isTaxable: false }] });
      expect(x.status, JSON.stringify(x.json)).toBeLessThan(300);
    };
    for (const d of docs) await post(w.items.get('W')!, d);
    for (const i of [5, 2, 7, 0, 3, 6, 1, 4]) await post(W2, docs[i]!);
    const shape = async (item: string) => (await rows(item)).map((m) => [m.movementDate, m.value, m.correction, m.residual, m.runningQty, m.runningValue, m.lastCost]);
    expect(await shape(W2)).toEqual(await shape(w.items.get('W')!));
    await fullReplayMatches(W2);
  });
});

describe('inventory-costing-v1 concurrency (P24 §5)', () => {
  it('a backdated bill and an edit of a later invoice at once: both commit or one is 409 RETRY; never a hang; I2 holds', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 6));
    const a5 = structuredClone(w.bodies.get('A5')!) as Body;
    a5['lines'][0].quantity = '2';
    const [bill, edit] = await Promise.all([
      req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-03', lines: [{ accountId: w.asset, amount: '12.00', itemId: w.items.get('W'), quantity: '6', unitPrice: '2.00' }] }),
      req('PUT', `/invoices/${w.docs.get('A5')}`, a5),
    ]);
    for (const x of [bill, edit]) expect(x.status < 300 || x.json['error']?.code === 'RETRY', JSON.stringify(x.json)).toBe(true);
    expect([bill, edit].some((x) => x.status < 300)).toBe(true);
    await invariants(w);
    await fullReplayMatches(w.items.get('W')!);
  });

  it('a closing-date move and a posting at once: the close waits for the posting, then refuses later inventory writes', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 2));
    const [close, posted] = await Promise.all([
      req('PUT', '/company/settings', { lockDate: '2026-01-20' }),
      req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-18', lines: [{ accountId: w.asset, amount: '6.00', itemId: w.items.get('W'), quantity: '2', unitPrice: '3.00' }] }),
    ]);
    expect(close.status, JSON.stringify(close.json)).toBe(200);
    expect(posted.status === 201 || posted.json['error']?.code === 'INVENTORY_PERIOD_CLOSED', JSON.stringify(posted.json)).toBe(true);
    const late = await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-19', lines: [{ accountId: w.asset, amount: '6.00', itemId: w.items.get('W'), quantity: '2', unitPrice: '3.00' }] });
    expect([late.status, late.json['error']?.code]).toEqual([409, 'INVENTORY_PERIOD_CLOSED']);
    await invariants(w);
  });

  it('a linked credit memo and an edit of its sale at once: never more returned than sold', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 3));
    const a3 = structuredClone(w.bodies.get('A3')!) as Body;
    a3['lines'][0].quantity = '1';
    const [memo, edit] = await Promise.all([
      req('POST', '/credit-memos', { contactId: c.customer, txnDate: '2026-01-09', lines: [{ itemId: w.items.get('W'), quantity: '3', unitPrice: '10.00', isTaxable: false, returnOf: { transactionId: w.docs.get('A3') } }] }),
      req('PUT', `/invoices/${w.docs.get('A3')}`, a3),
    ]);
    const codes = [memo, edit].map((x) => (x.status < 300 ? 'ok' : x.json['error']?.code));
    expect(codes.filter((x) => x === 'ok'), JSON.stringify(codes)).toHaveLength(1);
    expect(codes.some((x) => ['RETURN_EXCEEDS_SALE', 'SALE_HAS_RETURNS', 'RETRY'].includes(x))).toBe(true);
    await invariants(w);
  });

  it('an item lock held past lock_timeout (5 s) answers 409 RETRY and saves nothing', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 1));
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM items WHERE id = ${w.items.get('W')!} FOR UPDATE`);
      locked();
      await held;
    });
    await isLocked;
    const before = (await rows(w.items.get('W')!)).length;
    const x = await req('POST', '/invoices', { contactId: c.customer, txnDate: '2026-01-04', lines: [{ itemId: w.items.get('W'), quantity: '1', unitPrice: '10.00', isTaxable: false }] });
    release();
    await holder;
    expect([x.status, x.json['error']?.code]).toEqual([409, 'RETRY']);
    expect((await rows(w.items.get('W')!)).length).toBe(before);
    await invariants(w);
  }, 30_000);
});
