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
import { accounts, companies, contacts, inventoryMovements, items, journalLines, transactions } from '../db/schema/index.js';
import { itemsRouter } from './items.routes.js';
import { companyRouter } from './company.routes.js';
import { billsRouter } from './bills.routes.js';
import { vendorCreditsRouter } from './vendor-credits.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { creditMemosRouter } from './credit-memos.routes.js';
import { salesReceiptsRouter } from './sales-receipts.routes.js';
import { checksRouter } from './checks.routes.js';
import { inventoryRouter } from './inventory.routes.js';
import { inventoryReportsRouter } from './inventory-reports.routes.js';
import { unitSetsRouter } from './unit-sets.routes.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { postAdjustment } from '../services/inventory-adjustment.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { Decimal } from '../utils/inventory-walk.js';
import { positionAsc, positionDesc } from '../services/inventory-position.js';

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
    ['/api/v1/credit-memos', creditMemosRouter], ['/api/v1/sales-receipts', salesReceiptsRouter], ['/api/v1/checks', checksRouter], ['/api/v1/inventory', inventoryRouter],
    ['/api/v1/reports', inventoryReportsRouter], ['/api/v1/unit-sets', unitSetsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const req = (method: string, p: string, body?: unknown) =>
  h.request(method, `/api/v1${p}`, c.token, body, method === 'GET' ? {} : { 'Idempotency-Key': key() });
const idOf = (j: Body): string => String(j['id'] ?? j['bill']?.id ?? j['credit']?.id ?? j['vendorCredit']?.id ?? j['invoice']?.id
  ?? j['creditMemo']?.id ?? j['salesReceipt']?.id ?? j['check']?.id ?? j['adjustment']?.id ?? j['transaction']?.id);

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
      // One line (item, quantity, returnOf), or several (`lines`, PR-4 B1).
      const memoLines = (s['lines'] as Body[] | undefined) ?? [{ item: s['item'], quantity: s['quantity'], returnOf: s['returnOf'] }];
      const body = { contactId: c.customer, txnDate: s['date'], lines: memoLines.map((l) => ({ itemId: w.items.get(l['item'])!, quantity: l['quantity'],
        unitPrice: golden['seed'].salePrice, isTaxable: false, ...(l['returnOf'] ? { returnOf: { transactionId: w.docs.get(l['returnOf'])! } } : {}) })) };
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
      // U-159: through POST /inventory/adjustments.
      const body = { txnDate: s['date'], adjustmentAccountId: w.adjustment,
        lines: [{ itemId: item, ...(s['quantityChange'] ? { quantityChange: s['quantityChange'] } : {}), ...(s['valueChange'] ? { valueChange: s['valueChange'] } : {}) }] };
      r = await req('POST', '/inventory/adjustments', body);
      w.bodies.set(s['doc'], body);
      w.routes.set(s['doc'], 'inventory/adjustments');
      break;
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
    .orderBy(positionAsc());
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
      ORDER BY m.item_id, ${positionDesc('m')}) last`)).rows[0] as { v: string };
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
    if ('returnOf' in e) expect(r.sourceTransactionId, `${e['doc']} returnOf`).toBe(e['returnOf'] ? w.docs.get(e['returnOf']) : null);
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

  it('V2: voiding the receipt that cured negative stock warns, and so does each sale while below 0 (PR-4 S1)', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    await runSteps(w, gcase('V2')['steps']);
    await checkRows(w, gcase('V2')['rows']);
    await checkFinal(w, gcase('V2')['final']);
    await fullReplayMatches(w.items.get('W')!);
    // The preview of another sale while below 0 warns as the posting does.
    const pv = await req('POST', '/invoices/preview', { contactId: c.customer, txnDate: '2026-01-27', lines: [{ itemId: w.items.get('W'), quantity: '1', unitPrice: '10.00', isTaxable: false }] });
    expect((pv.json['warnings'] as Body[]).filter((x) => x['code'] === 'NEGATIVE_STOCK'))
      .toEqual([{ code: 'NEGATIVE_STOCK', itemId: w.items.get('W'), date: '2026-01-27', onHand: '-8.0000' }]);
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

  it('inventory off: parts on a new or edited document are 400 INVENTORY_OFF on every path (routes, recurring copy); void stays allowed (PR-4 S2)', async () => {
    const w = await setup();
    const W = w.items.get('W')!;
    const err = (r: { status: number; json: Body }) => [r.status, r.json['error']?.code];
    await runSteps(w, [{ n: 1, doc: 'S1', event: 'bill', date: '2026-01-02', item: 'W', quantity: '2', unitPrice: '3.00', amount: '6.00' },
      { n: 2, doc: 'S2', event: 'invoice', date: '2026-01-03', item: 'W', quantity: '2' }]);
    const off = await req('PUT', '/company/settings', { inventoryEnabled: false });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const sale = { contactId: c.customer, txnDate: '2026-02-01', lines: [{ itemId: W, quantity: '1', unitPrice: '10.00', isTaxable: false }] };
    expect(err(await req('POST', '/invoices', sale))).toEqual([400, 'INVENTORY_OFF']);
    expect(err(await req('POST', '/sales-receipts', { ...sale, depositToAccountId: c.roles['checking'] }))).toEqual([400, 'INVENTORY_OFF']);
    expect(err(await req('POST', '/transactions', { txnType: 'cash_sale', contactId: c.customer, txnDate: '2026-02-01', depositToAccountId: c.roles['checking'],
      lines: [{ accountId: c.roles['income'], itemId: W, quantity: '1', unitPrice: '10.00', isTaxable: false }] }))).toEqual([400, 'INVENTORY_OFF']);
    expect(err(await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-02-01', lines: [{ accountId: w.asset, amount: '3.00', itemId: W, quantity: '1', unitPrice: '3.00' }] })))
      .toEqual([400, 'INVENTORY_OFF']);
    expect(err(await req('PUT', `/invoices/${w.docs.get('S2')}`, { ...w.bodies.get('S2'), memo: 'edited' }))).toEqual([400, 'INVENTORY_OFF']);
    // A recurring copy of the sale (the schedule runner's path) is refused too, and nothing posts.
    const { postLegacyClone } = await import('../services/recurring.service.js');
    await expect(postLegacyClone(c.tenantId, { id: crypto.randomUUID(), templateTransactionId: w.docs.get('S2')!, nextOccurrence: '2026-03-01' } as never))
      .rejects.toMatchObject({ code: 'INVENTORY_OFF' });
    expect(await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.tenantId, c.tenantId), eq(inventoryMovements.voided, false)))).toHaveLength(2);
    // A document without parts posts as usual; voiding an inventory document stays allowed.
    expect((await req('POST', '/invoices', { contactId: c.customer, txnDate: '2026-02-01', lines: [{ accountId: c.roles['income'], quantity: '1', unitPrice: '10.00', isTaxable: false }] })).status)
      .toBe(201);
    expect((await req('POST', `/transactions/${w.docs.get('S2')}/void`, { reason: 'x' })).status).toBe(200);
    await invariants(w);
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

  it('R3: a return linked to a sale sold below 0 comes back at the corrected cost; edits and backdated receipts re-derive it (PR-4 S5)', async () => {
    const w = await setup();
    const r3 = gcase('R3');
    await runSteps(w, gcase('A')['steps']);
    const W = w.items.get('W')!;
    const share = async (doc: string) => m2((await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, w.docs.get(doc)!)))[0]!.correctionShare);
    expect(await share('A5'), 'A6 cured A5\'s 3 short units').toBe('0.63');
    await runSteps(w, (r3['steps'] as Body[]).slice(0, 2));
    await fullReplayMatches(W);
    // Engine-only: re-pricing the curing bill walks from it (on hand below 0 before it): the sale sold short is replayed, not rewritten.
    const a6 = structuredClone(w.bodies.get('A6')!) as Body;
    expect((await req('PUT', `/bills/${w.docs.get('A6')}`, { ...a6, lines: [{ ...a6['lines'][0], amount: '41.00', unitPrice: '4.10' }] })).status).toBe(200);
    expect(await share('A5'), 'round2(41.00 x 3 / 10) - 10.77').toBe('1.53');
    const memo = async () => m2((await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, w.docs.get('R3a')!)))[0]!.value);
    expect(await memo(), 'round2(12.30 x 2 / 3)').toBe('8.20');
    await invariants(w);
    await fullReplayMatches(W);
    // A walk that starts after the cure (the memo moved a day) reads the stored share.
    const memoBody = structuredClone(w.bodies.get('R3a')!) as Body;
    expect((await req('PUT', `/credit-memos/${w.docs.get('R3a')}`, { ...memoBody, txnDate: '2026-01-27' })).status).toBe(200);
    expect(await memo()).toBe('8.20');
    expect((await req('PUT', `/credit-memos/${w.docs.get('R3a')}`, memoBody)).status).toBe(200);
    expect((await req('PUT', `/bills/${w.docs.get('A6')}`, a6)).status).toBe(200);
    expect(await memo()).toBe('7.60');
    await runSteps(w, (r3['steps'] as Body[]).slice(2));
    expect(await share('A5'), 'no longer short').toBe('0.00');
    await checkRows(w, r3['rows'], true);
    await checkFinal(w, r3['final']);
    await fullReplayMatches(W);
  });

  it('R2: two rows of one part on one credit memo walk in one order everywhere (PR-4 B1); physical row order never matters', async () => {
    const w = await setup();
    const r2 = gcase('R2');
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, r2['fromSteps']));
    await runSteps(w, r2['steps']);
    await checkRows(w, r2['rows'], true);
    await checkFinal(w, r2['final']);
    const W = w.items.get('W')!;
    await fullReplayMatches(W);
    const snap = async () => (await rows(W)).map((m) => [m.id, m.value, m.correction, m.residual, m.runningQty, m.runningValue, m.lastCost]);
    const before = await snap();
    // Move the unlinked row of the memo to a new heap position (a non-HOT update), so a scan meets it after the linked row.
    const memoRows = await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, w.docs.get('T1')!));
    expect(memoRows).toHaveLength(2);
    await db.execute(sql`UPDATE inventory_movements SET updated_at = now(), quantity = quantity WHERE id = ${memoRows.find((m) => m.sourceTransactionId === null)!.id}`);
    // Every stock read sees the latest row of the memo the same way.
    expect((await figures(w))['assetValue']).toBe('30.06');
    // A backdated bill re-walks across the memo, and its void walks back: every row is as before.
    const b = await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-03', lines: [{ accountId: w.asset, amount: '12.00', itemId: W, quantity: '6', unitPrice: '2.00' }] });
    expect(b.status, JSON.stringify(b.json)).toBe(201);
    await invariants(w);
    await fullReplayMatches(W);
    expect((await req('POST', `/transactions/${idOf(b.json)}/void`, { reason: 'x' })).status).toBe(200);
    await invariants(w);
    expect(await snap()).toEqual(before);
    // The count sheet and Stock Status read the same latest row.
    const sheet = await req('GET', '/inventory/count-sheet?asOf=2026-01-16');
    expect((sheet.json['items'] as Body[]).find((x) => x['itemId'] === W)).toMatchObject({ onHand: '10.0000', value: '37.58' });
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
  it('G: rule 3 scales the invoice COGS and relief by payment / total; settlement by credit memo, a $0 sale or a write-off recognises the rest (Q-PR4a)', async () => {
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
    // Q-PR4a (PR-4 S3): settlement by an applied credit memo, a $0 sale and a write-off recognise COGS and relief in proportion.
    const [badDebts] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Bad debts', accountType: 'expense' }).returning();
    for (const s of g['settlements']['steps'] as Body[]) {
      if (s['event'] === 'credit_memo') {
        const cm = await req('POST', '/credit-memos', { contactId: c.customer, txnDate: s['date'],
          lines: [{ itemId: w.items.get('W'), quantity: s['quantity'], unitPrice: '10.00', isTaxable: s['taxable'], returnOf: { transactionId: w.docs.get(s['returnOf']) } }],
          applications: [{ invoiceId: w.docs.get(s['applyTo']), amount: s['applied'] }] });
        expect(cm.status, JSON.stringify(cm.json)).toBe(201);
        w.docs.set(s['doc'], idOf(cm.json));
        const [t] = await db.select({ total: transactions.total }).from(transactions).where(eq(transactions.id, w.docs.get(s['doc'])!));
        expect(m2(t!.total!), 'memo total').toBe(s['total']);
      } else if (s['event'] === 'invoice') {
        const zero = await req('POST', '/invoices', { contactId: c.customer, txnDate: s['date'], lines: [{ itemId: w.items.get('W'), quantity: s['quantity'], unitPrice: s['unitPrice'], isTaxable: false }] });
        expect(zero.status, JSON.stringify(zero.json)).toBe(201);
        w.docs.set(s['doc'], idOf(zero.json));
      } else {
        await receivePayment(c.tenantId, { customerId: c.customer, date: s['date'], amount: '0.00', depositTo: c.roles['checking'], writeOffAccountId: badDebts!.id,
          applications: [{ invoiceId: w.docs.get(s['invoice'])!, amount: '0.00', writeOffAmount: s['amount'] }] } as never, c.userId, c.companyId);
      }
      await invariants(w);
      const e = s['expect'] as Body;
      if (e['value']) {
        const [m] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, w.docs.get(s['doc'])!));
        expect(m2(m!.value), `${s['doc']} value`).toBe(e['value']);
      }
      const plx = await reports.buildProfitAndLoss(c.tenantId, '2026-01-01', e['asOf'], 'cash', c.companyId, null, null, { exactAmounts: true });
      const cg = plx.cogs.find((x) => x.accountId === w.cogs)!;
      expect(new Decimal(cg.amountExact!).toString(), `step ${s['n']} cash COGS share`).toBe(new Decimal(e['cash'].cogsShare).toString());
      if (e['cash'].income) expect(plx.totalRevenue.toFixed(2), `step ${s['n']} cash income`).toBe(e['cash'].income);
      const bsx = await reports.buildBalanceSheet(c.tenantId, e['asOf'], 'cash', c.companyId);
      expect(Math.abs(bsx.assets.find((a) => a.accountId === w.asset)!.balance - Number(e['cash'].inventoryShare)), `step ${s['n']} cash inventory`).toBeLessThan(1e-6);
      expect(Math.abs(bsx.totalAssets - (bsx.totalLiabilities + bsx.totalEquity)), 'the cash balance sheet balances (half-cent shares)').toBeLessThan(1e-6);
    }
    // Accrual is untouched by settlements: valuation = accrual GL.
    const accrual2 = await reports.buildBalanceSheet(c.tenantId, '2026-02-28', 'accrual', c.companyId);
    expect(accrual2.assets.find((a) => a.accountId === w.asset)!.balance.toFixed(2)).toBe((await figures(w))['assetValue']);
    // U-160 on a cash-basis company: the valuation stays accrual (= accrual GL) and carries basisNote (N3).
    await db.update(companies).set({ accountingMethod: 'cash' }).where(eq(companies.id, c.companyId));
    const v = await req('GET', '/reports/inventory-valuation?asOf=2026-01-19');
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect((v.json['accounts'] as Body[]).find((a) => a['accountId'] === w.asset)).toMatchObject({
      valuation: want.accrual.valuation, glBalance: want.accrual.glInventory, difference: '0.00' });
    expect(typeof v.json['basisNote'] === 'string').toBe(want.basisNote);
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
  'POST /api/v1/inventory/adjustments': 'costs (an inventory_adjustment through the ledger core)', 'PUT /api/v1/inventory/adjustments/{id}': 'costs',
  'POST /api/v1/inventory/counts': 'costs (one adjustment for the differences)',
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

/**
 * Every read route that filters by itemId or reports stock (U-160, U-78):
 * each reads the stock ledger, so its figures equal the GL by construction.
 * A new one fails this test until it is listed here.
 */
const STOCK_READ_ROUTES: Record<string, string> = {
  'GET /api/v1/reports/inventory-valuation': 'stock ledger as of a date + accrual GL per asset account',
  'GET /api/v1/reports/inventory-valuation-detail': 'stock ledger rows (itemId filter)',
  'GET /api/v1/reports/inventory-stock-status': 'stock ledger as of a date',
  'GET /api/v1/reports/reorder': 'stock ledger, latest row',
  'GET /api/v1/items/reorder-alerts': 'stock ledger, latest row',
};

function stockReadRoutes(): string[] {
  const o = JSON.parse(readFileSync(path.resolve(here, '../../../../openapi.json'), 'utf8')) as Body;
  const out: string[] = [];
  for (const [p, ops] of Object.entries(o['paths'] as Body)) {
    const op = (ops as Body)['get'] as Body | undefined;
    if (!op) continue;
    const text = `${op['summary'] ?? ''} ${op['description'] ?? ''}`;
    if (((op['parameters'] ?? []) as Body[]).some((x) => x['name'] === 'itemId') || /inventory-reports-v1|reorder-alerts-v1/.test(text)) out.push(`GET ${p}`);
  }
  return out.sort();
}

describe('inventory-costing-v1 write paths (B4)', () => {
  it('every write route that takes an itemId is classified: it costs, or moves nothing, or writes nothing', () => {
    expect(itemWriteRoutes()).toEqual(Object.keys(ITEM_WRITE_ROUTES).sort());
  });

  it('every stock report route (itemId filter or inventory-reports-v1 / reorder-alerts-v1) is listed: each reads the stock ledger', () => {
    expect(stockReadRoutes()).toEqual(Object.keys(STOCK_READ_ROUTES).sort());
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
        const op = r.pick(['bill', 'bill', 'invoice', 'invoice', 'receipt', 'return', 'linked', 'multi', 'vcredit', 'void', 'edit']);
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
        } else if (op === 'multi' && sales.length > 0) {
          // PR-4 B1: one memo, several rows of the part (two linked sales and the unlinked units).
          const picks = [r.pick(sales), r.pick(sales)];
          const from = Math.max(...picks.map((s) => Number(s.date.slice(8))));
          const lines = [...new Set(picks)].map((s) => ({ itemId: W, quantity: '1', unitPrice: '10.00', isTaxable: false, returnOf: { transactionId: w.docs.get(s.doc)! } }));
          const x = await req('POST', '/credit-memos', { contactId: c.customer, txnDate: `2026-01-${String(r.int(from, 28)).padStart(2, '0')}`,
            lines: [...lines, { itemId: W, quantity: String(r.int(1, 2)), unitPrice: '10.00', isTaxable: false }] });
          if (ok(x, ['RETURN_EXCEEDS_SALE', 'RETURN_BEFORE_SALE'])) w.docs.set(doc, idOf(x.json));
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
      // I7: no sale gives back more than its relief plus the corrections of the units it sold short (PR-4 S5).
      const over = await db.execute(sql`
        SELECT s.transaction_id FROM inventory_movements s JOIN inventory_movements r ON r.source_transaction_id = s.transaction_id AND r.item_id = s.item_id AND r.voided = false
        WHERE s.tenant_id = ${c.tenantId} AND s.voided = false AND s.source_transaction_id IS NULL AND s.kind = 'sale'
        GROUP BY s.transaction_id, s.value, s.quantity, s.correction_share
        HAVING SUM(r.value) > -s.value + GREATEST(s.correction_share, 0) OR SUM(r.quantity) > -s.quantity`);
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

describe('copies of inventory documents (P24 §2.3)', () => {
  it('POST /transactions/:id/duplicate of a cash sale and of a check reposts their parts through the costing core', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 4), (s) => ({ A1: 'check', A3: 'cash_sale' } as Record<string, string>)[s['doc']]);
    for (const doc of ['A3', 'A1']) {
      const copy = await req('POST', `/transactions/${w.docs.get(doc)}/duplicate`, {});
      expect(copy.status, JSON.stringify(copy.json)).toBe(201);
      const id = (copy.json['transaction'] as Body)['id'] as string;
      const [mv] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, id));
      expect(mv?.kind, doc).toBe(doc === 'A3' ? 'sale' : 'receipt');
      await invariants(w);
    }
  });
});

describe('inventory-adjust-v1: adjustments, counts and opening stock (U-159, E3)', () => {
  const code = (x: { status: number; json: Body }) => [x.status, x.json['error']?.code];

  it('F: a count posts one adjustment for the differences at average cost; an equal count posts no line', async () => {
    const w = await setup();
    for (const name of ['X', 'Y']) {
      const r = await req('POST', '/items', { name, itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: c.roles['income'], assetAccountId: w.asset, cogsAccountId: w.cogs });
      w.items.set(name, r.json['item'].id);
    }
    for (const name of ['W', 'X', 'Y']) {
      // X and Y run case A as W does (the per-step figures checked are W's, so only W keeps them).
      await runSteps(w, (gcase('A')['steps'] as Body[]).map((st) => ({ ...st, item: name, doc: `${name}${st['doc']}`, ...(name === 'W' ? {} : { expect: undefined }) })));
    }
    const f = gcase('F')['steps'][0] as Body;
    const sheet = await req('GET', `/inventory/count-sheet?asOf=${f['date']}`);
    expect(sheet.status, JSON.stringify(sheet.json)).toBe(200);
    const sheetItems = sheet.json['items'] as Body[];
    for (const l of f['lines'] as Body[]) expect(sheetItems.find((i) => i['itemId'] === w.items.get(l['item']))!['onHand']).toBe(l['sheetOnHand']);
    expect(sheetItems.find((i) => i['itemId'] === w.items.get('W'))!['value']).toBe('16.20');
    const count = await req('POST', '/inventory/counts', { asOf: f['date'], adjustmentAccountId: w.adjustment,
      lines: (f['lines'] as Body[]).map((l) => ({ itemId: w.items.get(l['item']), sheetOnHand: l['sheetOnHand'], countedQuantity: l['countedQuantity'] })) });
    expect(count.status, JSON.stringify(count.json)).toBe(201);
    const adj = count.json['adjustment'] as Body;
    const want = f['expect'] as Body;
    expect((adj['lines'] as Body[]).map((l) => [l['itemId'], l['quantityChange'], l['value']]))
      .toEqual((want['lines'] as Body[]).map((l) => [w.items.get(l['item']), l['quantityChange'], l['value']]));
    for (const l of want['lines'] as Body[]) {
      const fig = await figures(w, l['item']);
      expect([fig['quantityOnHand'], fig['assetValue']], l['item']).toEqual([l['onHand'], l['assetValue']]);
    }
    expect((adj['lines'] as Body[]).some((l) => l['itemId'] === w.items.get('X'))).toBe(false);
    await invariants(w);
    // The same sheet again is now stale for W and Y (not X): 409 STALE listing both, nothing saved.
    const again = await req('POST', '/inventory/counts', { asOf: f['date'], adjustmentAccountId: w.adjustment,
      lines: (f['lines'] as Body[]).map((l) => ({ itemId: w.items.get(l['item']), sheetOnHand: l['sheetOnHand'], countedQuantity: l['countedQuantity'] })) });
    expect(code(again)).toEqual([409, 'STALE']);
    expect((again.json['error']['details']['items'] as Body[]).map((i) => i['itemId']).sort()).toEqual([w.items.get('W'), w.items.get('Y')].sort());
    // Counted equal everywhere: nothing posts.
    const same = await req('POST', '/inventory/counts', { asOf: f['date'], adjustmentAccountId: w.adjustment,
      lines: [{ itemId: w.items.get('X'), sheetOnHand: '4.0000', countedQuantity: '4' }] });
    expect([same.status, same.json['adjustment']]).toEqual([201, null]);
  });

  it('adjustment routes: read, edit with expectedUpdatedAt, idempotent replay, void, delete; guards', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 8));
    const W = w.items.get('W')!;
    const a7 = await req('GET', `/inventory/adjustments/${w.docs.get('A7')}`);
    expect(a7.status).toBe(200);
    expect(a7.json['adjustment']).toMatchObject({ date: '2026-01-20', adjustmentAccountId: w.adjustment, status: 'posted',
      lines: [{ itemId: W, quantityChange: '-1.0000', valueChange: null, value: '-3.80' }] });
    expect((a7.json['adjustment']['inventoryLines'] as Body[]).map((l) => [l['role'], l['amount']]).sort()).toEqual([['cogs', '3.80'], ['inventory_relief', '-3.80']]);
    const a8 = (await req('GET', `/inventory/adjustments/${w.docs.get('A8')}`)).json['adjustment'] as Body;
    expect(a8['lines']).toEqual([expect.objectContaining({ quantityChange: null, valueChange: '1.50', value: '1.50' })]);
    // Edit: stale token 409; current token re-walks.
    const body = { ...w.bodies.get('A7')!, lines: [{ itemId: W, quantityChange: '-2' }] };
    expect(code(await req('PUT', `/inventory/adjustments/${w.docs.get('A7')}`, { ...body, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }))).toEqual([409, 'STALE']);
    const ed = await req('PUT', `/inventory/adjustments/${w.docs.get('A7')}`, { ...body, expectedUpdatedAt: a7.json['adjustment'].updatedAt });
    expect(ed.status, JSON.stringify(ed.json)).toBe(200);
    expect(ed.json['adjustment'].lines[0].value).toBe('-7.60');
    await invariants(w);
    // Idempotency-Key: the same key and body replays the first answer, nothing posted twice.
    const k = key();
    const once = { txnDate: '2026-01-26', adjustmentAccountId: w.adjustment, lines: [{ itemId: W, quantityChange: '1' }] };
    const r1 = await h.request('POST', '/api/v1/inventory/adjustments', c.token, once, { 'Idempotency-Key': k });
    const r2 = await h.request('POST', '/api/v1/inventory/adjustments', c.token, once, { 'Idempotency-Key': k });
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(r2.json['adjustment'].id).toBe(r1.json['adjustment'].id);
    // Void and delete re-walk.
    expect((await req('POST', `/inventory/adjustments/${r1.json['adjustment'].id}/void`, { reason: 'x' })).json['adjustment'].status).toBe('void');
    expect((await req('DELETE', `/inventory/adjustments/${w.docs.get('A8')}`, {})).json).toMatchObject({ status: 'deleted' });
    await invariants(w);
    await fullReplayMatches(W);
    // Guards: the asset account as adjustment account, an unknown line, nothing on hand for a value-only line.
    expect(code(await req('POST', '/inventory/adjustments', { ...once, adjustmentAccountId: w.asset }))).toEqual([400, 'VALIDATION_ERROR']);
    expect(code(await req('POST', '/inventory/adjustments', { ...once, lines: [{ itemId: W }] }))).toEqual([400, 'VALIDATION_ERROR']);
    expect(code(await req('POST', '/inventory/adjustments', { ...once, txnDate: '2026-01-11', lines: [{ itemId: W, valueChange: '1.00' }] })))
      .toEqual([400, 'INVENTORY_NO_STOCK']);
    expect(code(await req('GET', `/inventory/adjustments/${w.docs.get('A3')}`))).toEqual([404, 'NOT_FOUND']);
    await invariants(w);
  });

  it('closed periods: adjustments, counts and opening stock on or before the closing date are 409 INVENTORY_PERIOD_CLOSED', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    expect((await req('PUT', '/company/settings', { lockDate: '2026-01-20' })).status).toBe(200);
    const W = w.items.get('W')!;
    const closed = [409, 'INVENTORY_PERIOD_CLOSED'];
    expect(code(await req('POST', '/inventory/adjustments', { txnDate: '2026-01-20', adjustmentAccountId: w.adjustment, lines: [{ itemId: W, quantityChange: '-1' }] }))).toEqual(closed);
    expect(code(await req('PUT', `/inventory/adjustments/${w.docs.get('A8')}`, { ...w.bodies.get('A8')!, txnDate: '2026-01-23' }))).toEqual([200, undefined]);
    expect(code(await req('PUT', `/inventory/adjustments/${w.docs.get('A7')}`, { ...w.bodies.get('A7')!, txnDate: '2026-01-21' }))).toEqual(closed);
    expect(code(await req('POST', `/inventory/adjustments/${w.docs.get('A7')}/void`, {}))).toEqual(closed);
    expect(code(await req('DELETE', `/inventory/adjustments/${w.docs.get('A7')}`, {}))).toEqual(closed);
    expect(code(await req('POST', '/inventory/counts', { asOf: '2026-01-20', adjustmentAccountId: w.adjustment, lines: [{ itemId: W, sheetOnHand: '6.0000', countedQuantity: '5' }] }))).toEqual(closed);
    const made = await req('POST', '/items', { name: 'Opening closed', itemType: 'inventory_part', unitPrice: '1.00', incomeAccountId: c.roles['income'],
      assetAccountId: w.asset, cogsAccountId: w.cogs, opening: { quantity: '5', value: '10.00', asOf: '2026-01-15' } });
    expect(code(made)).toEqual(closed);
    expect((await db.select().from(items).where(and(eq(items.tenantId, c.tenantId), eq(items.name, 'Opening closed'))))).toHaveLength(0);
    await invariants(w);
  });

  it('opening stock on item create (Q-P24h): an adjustment against Opening Balances in the same transaction', async () => {
    const w = await setup();
    const made = await req('POST', '/items', { name: 'Seed part', itemType: 'inventory_part', unitPrice: '5.00', incomeAccountId: c.roles['income'],
      assetAccountId: w.asset, cogsAccountId: w.cogs, opening: { quantity: '12', value: '30.00', asOf: '2026-01-01' } });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    expect([made.json['item'].quantityOnHand, made.json['item'].assetValue, made.json['item'].averageCost]).toEqual(['12.0000', '30.00', '2.500000']);
    const [mv] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.itemId, made.json['item'].id));
    const lines = await db.select({ accountId: journalLines.accountId, debit: journalLines.debit, credit: journalLines.credit }).from(journalLines)
      .where(eq(journalLines.transactionId, mv!.transactionId));
    const [ob] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'opening_balances')));
    expect(lines.find((l) => l.accountId === ob!.id)).toMatchObject({ credit: '30.0000' });
    expect([mv!.kind, mv!.valueMode]).toEqual(['adjust_qty', 'given']);
    // A free opening (value 0.00) keeps the quantity at zero value; a non-part can't take opening stock.
    const free = await req('POST', '/items', { name: 'Free part', itemType: 'inventory_part', unitPrice: '5.00', incomeAccountId: c.roles['income'],
      assetAccountId: w.asset, cogsAccountId: w.cogs, opening: { quantity: '3', value: '0.00', asOf: '2026-01-01' } });
    expect([free.status, free.json['item']?.assetValue]).toEqual([201, '0.00']);
    expect(code(await req('POST', '/items', { name: 'Service', itemType: 'service', unitPrice: '5.00', incomeAccountId: c.roles['income'],
      opening: { quantity: '3', value: '1.00', asOf: '2026-01-01' } }))).toEqual([400, 'VALIDATION_ERROR']);
    await invariants(w);
  });

  it('a count and a sale at once: the count is 409 STALE, or the sale lands after it; never a count against an old on hand', async () => {
    const w = await setup();
    await runSteps(w, (gcase('A')['steps'] as Body[]).slice(0, 3));
    const W = w.items.get('W')!;
    const [count, sale] = await Promise.all([
      req('POST', '/inventory/counts', { asOf: '2026-01-31', adjustmentAccountId: w.adjustment, lines: [{ itemId: W, sheetOnHand: '11.0000', countedQuantity: '10' }] }),
      req('POST', '/invoices', { contactId: c.customer, txnDate: '2026-01-30', lines: [{ itemId: W, quantity: '1', unitPrice: '10.00', isTaxable: false }] }),
    ]);
    // Either may lose a lock race and answer 409 RETRY (nothing saved; the desktop resends once), never both.
    expect(sale.status === 201 || sale.json['error']?.code === 'RETRY', JSON.stringify(sale.json)).toBe(true);
    expect(count.status === 201 || ['STALE', 'RETRY'].includes(count.json['error']?.code), JSON.stringify(count.json)).toBe(true);
    expect(sale.status === 201 || count.status === 201).toBe(true);
    const onHand = 11 - (count.status === 201 ? 1 : 0) - (sale.status === 201 ? 1 : 0);
    expect((await figures(w))['quantityOnHand']).toBe(onHand.toFixed(4));
    await invariants(w);
  });

  it('advertises inventory-adjust-v1 after inventory-costing-v1', () => {
    const i = DESKTOP_CAPABILITIES.indexOf('inventory-adjust-v1');
    expect(i).toBeGreaterThan(DESKTOP_CAPABILITIES.indexOf('inventory-costing-v1'));
  });
});

// ─── Reports (U-160 inventory-reports-v1, U-78 reorder-alerts-v1; P24 E4) ──

describe('inventory-reports-v1 and reorder-alerts-v1 (golden S, U-160, U-78)', () => {
  const code = (x: { status: number; json: Body }) => [x.status, x.json['error']?.code];
  const s = () => gcase('S');
  /** The accrual GL balance of an account from posted lines dated on or before asOf. */
  const glAsOf = async (accountId: string, asOf: string) => ((await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::numeric(19,2)::text AS b FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${c.tenantId} AND jl.account_id = ${accountId} AND t.status = 'posted' AND t.txn_date <= ${asOf}::date`)).rows[0] as { b: string }).b;

  it('S: valuation as of each date equals the accrual GL (difference 0.00); a direct journal entry is the only difference', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    const W = w.items.get('W')!;
    for (const [asOf, want] of Object.entries(s()['valuation'] as Record<string, Body>)) {
      const r = await req('GET', `/reports/inventory-valuation?asOf=${asOf}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(r.json).toMatchObject({ asOf, basis: 'accrual', basisNote: null });
      const row = (r.json['rows'] as Body[]).find((x) => x['itemId'] === W)!;
      expect([row['onHand'], row['averageCost'], row['value'], row['percentOfTotal']], asOf)
        .toEqual([want['onHand'], want['averageCost'], want['value'], want['percentOfTotal']]);
      expect(row['assetAccountId']).toBe(w.asset);
      const acct = (r.json['accounts'] as Body[]).find((x) => x['accountId'] === w.asset)!;
      expect([acct['valuation'], acct['glBalance'], acct['difference']], asOf).toEqual([want['value'], want['glBalance'], want['difference']]);
      expect(acct['glBalance']).toBe(await glAsOf(w.asset, asOf));
      expect(r.json['totalValue']).toBe(want['value']);
      // Every figure is a string (no JS numbers on the wire).
      for (const v of [...Object.values(row), ...Object.values(acct)]) expect(typeof v === 'number').toBe(false);
    }
    // A journal entry straight to the asset account: the GL moves, the valuation doesn't; difference shows it.
    const { postTransaction } = await import('../services/ledger.service.js');
    await postTransaction(c.tenantId, { txnType: 'journal_entry', txnDate: '2026-01-26', memo: 'direct', lines: [
      { accountId: w.asset, debit: '5.00', credit: '0' }, { accountId: w.adjustment, debit: '0', credit: '5.00' },
    ] } as never, c.userId, c.companyId);
    const after = await req('GET', '/reports/inventory-valuation?asOf=2026-01-31');
    expect((after.json['accounts'] as Body[]).find((x) => x['accountId'] === w.asset)).toMatchObject({ valuation: '16.20', glBalance: '21.20', difference: '5.00' });
    const before = await req('GET', '/reports/inventory-valuation?asOf=2026-01-25');
    expect((before.json['accounts'] as Body[]).find((x) => x['accountId'] === w.asset)).toMatchObject({ glBalance: '16.20', difference: '0.00' });
    // Cash-basis companies get the note; the figures stay accrual.
    await db.update(companies).set({ accountingMethod: 'cash' }).where(eq(companies.id, c.companyId));
    const cash = await req('GET', '/reports/inventory-valuation?asOf=2026-01-25');
    expect(typeof cash.json['basisNote']).toBe('string');
    expect(cash.json['totalValue']).toBe('16.20');
  });

  it('S: valuation detail rows follow the stock ledger with running figures; opening before from', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    const W = w.items.get('W')!;
    const want = s()['detail'] as Body;
    const r = await req('GET', `/reports/inventory-valuation-detail?from=${want['from']}&to=${want['to']}&itemId=${W}`);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json['opening']).toEqual([{ itemId: W, ...want['opening'] }]);
    const name = new Map([...w.docs].map(([k, v]) => [v, k]));
    expect((r.json['data'] as Body[]).map((x) => ({ doc: name.get(x['transactionId']), kind: x['kind'], quantity: x['quantity'], value: x['value'],
      correction: x['correction'], runningQuantity: x['runningQuantity'], runningValue: x['runningValue'], averageCost: x['averageCost'] })))
      .toEqual(want['rows']);
    expect(r.json['total']).toBe((want['rows'] as Body[]).length);
    // The whole month: one row per stored movement; runningValue = previous + value (I1); paging.
    const all = await req('GET', `/reports/inventory-valuation-detail?from=2026-01-01&to=2026-01-31`);
    const stored = await rows(W);
    expect((all.json['data'] as Body[]).map((x) => x['movementId'])).toEqual(stored.map((m) => m.id));
    let run = new Decimal(0);
    for (const x of all.json['data'] as Body[]) {
      run = run.plus(x['value']);
      expect(x['runningValue']).toBe(run.toFixed(2));
      expect(new Decimal(x['movementValue']).plus(x['correction']).plus(x['residual']).toFixed(2)).toBe(x['value']);
    }
    const page = await req('GET', `/reports/inventory-valuation-detail?from=2026-01-01&to=2026-01-31&limit=2&offset=2`);
    expect((page.json['data'] as Body[]).map((x) => x['movementId'])).toEqual(stored.slice(2, 4).map((m) => m.id));
    expect(page.json['total']).toBe(stored.length);
    expect(page.json['opening']).toEqual([]);
    // Guards: to before from, a bad date, an item that is not an inventory item of the company.
    expect(code(await req('GET', '/reports/inventory-valuation-detail?from=2026-01-31&to=2026-01-01'))).toEqual([400, 'VALIDATION_ERROR']);
    expect(code(await req('GET', '/reports/inventory-valuation-detail?from=2026-1-1&to=2026-01-31'))).toEqual([400, 'VALIDATION_ERROR']);
    expect(code(await req('GET', '/reports/inventory-valuation-detail?from=2026-01-01'))).toEqual([400, 'VALIDATION_ERROR']);
    expect((await req('GET', `/reports/inventory-valuation-detail?from=2026-01-01&to=2026-01-31&itemId=${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).status).toBe(404);
  });

  it('S: stock status as of a date, reorder alerts and the reorder report', async () => {
    const w = await setup();
    await runSteps(w, gcase('A')['steps']);
    const W = w.items.get('W')!;
    // No reorder point yet: never flagged, no alerts.
    expect((await req('GET', '/items/reorder-alerts')).json).toEqual({ data: [], total: 0 });
    const put = await req('PUT', `/items/${W}`, { reorderPoint: s()['reorderPoint'], reorderQuantity: '20', preferredVendorId: w.vendor });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    for (const [asOf, want] of Object.entries(s()['stockStatus'] as Record<string, Body>)) {
      const r = await req('GET', `/reports/inventory-stock-status?asOf=${asOf}`);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const row = (r.json['data'] as Body[]).find((x) => x['itemId'] === W)!;
      expect([row['onHand'], row['reorder'], row['reorderPoint'], row['reorderQuantity']], asOf).toEqual([want['onHand'], want['reorder'], '5.0000', '20.0000']);
      expect(row['preferredVendor']).toEqual({ id: w.vendor, name: golden['seed'].vendor });
    }
    const alerts = await req('GET', '/items/reorder-alerts');
    expect(alerts.status, JSON.stringify(alerts.json)).toBe(200);
    expect((alerts.json['data'] as Body[]).map((x) => [x['itemId'], x['onHand'], x['reorderPoint'], x['reorder']]))
      .toEqual((s()['reorderAlerts'] as Body[]).map((a) => [w.items.get(a['item']), a['onHand'], a['reorderPoint'], true]));
    const report = await req('GET', '/reports/reorder');
    expect(report.status).toBe(200);
    expect((report.json['data'] as Body[]).map((x) => [x['itemId'], x['reorderQuantity']])).toEqual([[W, '20.0000']]);
    // A receipt above the point clears the alert.
    await step(w, { event: 'bill', doc: 'S1', date: '2026-01-26', item: 'W', quantity: '2', unitPrice: '4.05', amount: '8.10' });
    expect((await req('GET', '/items/reorder-alerts')).json['total']).toBe(0);
    await invariants(w);
  });

  it('inventory off is 400 INVENTORY_OFF on every report; a user without reports access is refused', async () => {
    for (const p of ['/reports/inventory-valuation', '/reports/inventory-valuation-detail?from=2026-01-01&to=2026-01-31',
      '/reports/inventory-stock-status', '/reports/reorder', '/items/reorder-alerts']) {
      expect(code(await req('GET', p)), p).toEqual([400, 'INVENTORY_OFF']);
    }
    await setup();
    const staff = await h.staffToken(c, { banking: 'full' });
    expect((await h.request('GET', '/api/v1/reports/inventory-valuation', staff)).status).toBe(403);
  });

  it('advertises inventory-reports-v1 and reorder-alerts-v1 after inventory-adjust-v1', () => {
    const i = DESKTOP_CAPABILITIES.indexOf('inventory-reports-v1');
    expect(i).toBeGreaterThan(DESKTOP_CAPABILITIES.indexOf('inventory-adjust-v1'));
    expect(DESKTOP_CAPABILITIES.indexOf('reorder-alerts-v1')).toBeGreaterThan(i);
  });
});

// ─── Units of measure (U-161 units-of-measure-v1; P24 E5, golden U) ──────

describe('units-of-measure-v1 (golden U, U-161)', () => {
  const code = (x: { status: number; json: Body }) => [x.status, x.json['error']?.code];

  async function unitWorld() {
    const w = await setup();
    const u = gcase('U');
    const made = await req('POST', '/unit-sets', { name: u['unitSet'].name, baseUnitName: u['unitSet'].base,
      units: (u['unitSet'].units as Body[]).map((x) => ({ name: x['name'], factor: x['factor'] })) });
    expect(made.status, JSON.stringify(made.json)).toBe(201);
    const set = made.json['unitSet'] as Body;
    const unit = new Map<string, string | null>((set['units'] as Body[]).map((x) => [x['name'] as string, x['id'] as string]));
    unit.set(u['unitSet'].base, null);
    const W = w.items.get('W')!;
    const put = await req('PUT', `/items/${W}`, { unitSetId: set['id'], defaultPurchaseUnitId: unit.get('case') });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    return { w, W, set, unit };
  }

  it('U: lines in a unit move stock by round4(quantity x factor); the amount stays in the entered unit; UNIT_QUANTITY_TOO_SMALL; UNIT_IN_USE', async () => {
    const { w, W, set, unit } = await unitWorld();
    for (const s of gcase('U')['steps'] as Body[]) {
      const unitId = s['unit'] !== undefined ? unit.get(s['unit']) ?? null : undefined;
      let r: { status: number; json: Body } | null = null;
      if (s['event'] === 'bill') {
        r = await req('POST', '/bills', { contactId: w.vendor, txnDate: s['date'], lines: [{ accountId: w.asset, amount: s['amount'], itemId: W, quantity: s['quantity'], unitPrice: s['unitPrice'], unitId }] });
      } else if (s['event'] === 'invoice') {
        r = await req('POST', '/invoices', { contactId: c.customer, txnDate: s['date'], lines: [{ itemId: W, quantity: s['quantity'], unitPrice: '10.00', unitId, isTaxable: false }] });
      } else if (s['event'] === 'item_unit_prices') {
        const put = await req('PUT', `/items/${W}`, { unitPrice: s['basePrice'] });
        const prices = put.json['item']['unitPrices'] as Body[];
        expect(prices.find((p) => p['unitId'] === null)).toMatchObject({ name: 'bottle', factor: '1.000000', unitPrice: '4.5000' });
        for (const [name, price] of Object.entries(s['expect'] as Record<string, string>)) expect(prices.find((p) => p['name'] === name)!['unitPrice'], name).toBe(price);
        continue;
      } else if (s['event'] === 'unit_factor_change') {
        const units = (set['units'] as Body[]).map((x) => ({ id: x['id'], name: x['name'], factor: x['name'] === s['unit'] ? s['factor'] : x['factor'] }));
        r = await req('PUT', `/unit-sets/${set['id']}`, { units });
      }
      const e = s['expect'] as Body;
      if (typeof e['status'] === 'number') {
        expect(code(r!), `step ${s['n']}`).toEqual([e['status'], e['code']]);
        continue;
      }
      expect([200, 201], JSON.stringify(r!.json)).toContain(r!.status);
      const id = idOf(r!.json);
      const [mv] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.transactionId, id));
      if (e['value']) expect(m2(mv!.value), `step ${s['n']} value`).toBe(e['value']);
      if (e['baseQuantity']) {
        const [line] = await db.select().from(journalLines).where(and(eq(journalLines.transactionId, id), eq(journalLines.itemId, W)));
        expect([line!.unitId, Number(line!.baseQuantity).toFixed(4), new Decimal(line!.quantity!).toFixed()], `step ${s['n']} line`)
          .toEqual([unitId ?? null, e['baseQuantity'], new Decimal(s['quantity']).toFixed()]);
        expect(new Decimal(mv!.quantity).abs().toFixed(4)).toBe(e['baseQuantity']);
      }
      const f = await figures(w);
      expect([f['quantityOnHand'], f['assetValue']], `step ${s['n']}`).toEqual([e['onHand'], e['assetValue']]);
      await invariants(w);
    }
    const f = await figures(w);
    const fin = gcase('U')['final']['W'];
    expect([f['quantityOnHand'], f['assetValue']]).toEqual([fin.onHand, fin.assetValue]);
    // The bill's amount stayed in the entered unit: 2 cases x 30.00.
    const billLine = (await db.select().from(journalLines).where(and(eq(journalLines.tenantId, c.tenantId), eq(journalLines.itemId, W), eq(journalLines.unitId, unit.get('case')!))))[0]!;
    expect([m2(billLine.debit), new Decimal(billLine.unitPrice!).toFixed(2)]).toEqual(['60.00', '30.00']);
  });

  it('readers return unitId and baseQuantity; edits re-resolve; guards: unit outside the set, unit without an item, no price, set change after use', async () => {
    const { w, W, set, unit } = await unitWorld();
    const bill = await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-02', lines: [{ accountId: w.asset, amount: '60.00', itemId: W, quantity: '2', unitPrice: '30.00', unitId: unit.get('case') }] });
    expect(bill.status, JSON.stringify(bill.json)).toBe(201);
    const inv = await req('POST', '/invoices', { contactId: c.customer, txnDate: '2026-01-03', lines: [{ itemId: W, quantity: '1', unitPrice: '60.00', unitId: unit.get('half-case'), isTaxable: false }] });
    expect(inv.status, JSON.stringify(inv.json)).toBe(201);
    const invId = idOf(inv.json);
    const got = await req('GET', `/invoices/${invId}`);
    const line = (got.json['invoice']?.lines ?? got.json['lines']) as Body[];
    expect(line.find((l) => l['itemId'] === W)).toMatchObject({ unitId: unit.get('half-case'), baseQuantity: '6.0000' });
    // An edit in another unit re-resolves: 1 case = 12 bottles.
    const ed = await req('PUT', `/invoices/${invId}`, { contactId: c.customer, txnDate: '2026-01-03', lines: [{ itemId: W, quantity: '1', unitPrice: '120.00', unitId: unit.get('case'), isTaxable: false }] });
    expect(ed.status, JSON.stringify(ed.json)).toBe(200);
    expect((await figures(w))['quantityOnHand']).toBe('12.0000');
    await invariants(w);
    // Credit memo and sales receipt lines carry the unit too.
    const cm = await req('POST', '/credit-memos', { contactId: c.customer, txnDate: '2026-01-04', lines: [{ itemId: W, quantity: '1', unitPrice: '60.00', unitId: unit.get('half-case'), isTaxable: false, returnOf: { transactionId: invId } }] });
    expect(cm.status, JSON.stringify(cm.json)).toBe(201);
    expect((cm.json['creditMemo']['lines'] as Body[])[0]).toMatchObject({ unitId: unit.get('half-case'), baseQuantity: '6.0000' });
    expect((await figures(w))['quantityOnHand']).toBe('18.0000');
    await invariants(w);
    // Guards.
    const [other] = await db.insert(items).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Loose', incomeAccountId: c.roles['income']!, itemType: 'service' }).returning();
    expect(code(await req('POST', '/invoices', { contactId: c.customer, txnDate: '2026-01-05', lines: [{ itemId: other!.id, quantity: '1', unitPrice: '1.00', unitId: unit.get('case'), isTaxable: false }] })))
      .toEqual([400, 'UNIT_NOT_IN_SET']);
    expect(code(await req('POST', '/invoices', { contactId: c.customer, txnDate: '2026-01-05', lines: [{ itemId: W, quantity: '1', unitId: unit.get('case'), isTaxable: false }] })))
      .toEqual([400, 'VALIDATION_ERROR']);
    expect(code(await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-05', lines: [{ accountId: c.roles['expense'], amount: '5.00', unitId: unit.get('case') }] })))
      .toEqual([400, 'VALIDATION_ERROR']);
    const set2 = await req('POST', '/unit-sets', { name: 'Box', baseUnitName: 'piece', units: [{ name: 'box', factor: '10' }] });
    expect(code(await req('PUT', `/items/${W}`, { unitSetId: set2.json['unitSet'].id }))).toEqual([409, 'UNIT_IN_USE']);
    expect(code(await req('PUT', `/items/${other!.id}`, { defaultSaleUnitId: unit.get('case') }))).toEqual([400, 'VALIDATION_ERROR']);
    // A used unit can't be removed; a new unit can be added; a stale token is 409 STALE.
    const units = (set['units'] as Body[]).map((x) => ({ id: x['id'], name: x['name'], factor: x['factor'] }));
    expect(code(await req('PUT', `/unit-sets/${set['id']}`, { units: units.filter((x) => x['name'] !== 'case') }))).toEqual([409, 'UNIT_IN_USE']);
    expect(code(await req('PUT', `/unit-sets/${set['id']}`, { units, expectedUpdatedAt: '2020-01-01T00:00:00.000Z' }))).toEqual([409, 'STALE']);
    const added = await req('PUT', `/unit-sets/${set['id']}`, { units: [...units, { name: 'pallet', factor: '480' }] });
    expect(added.status, JSON.stringify(added.json)).toBe(200);
    expect((added.json['unitSet']['units'] as Body[]).map((x) => x['name'])).toContain('pallet');
    expect(added.json['unitSet']['inUse']).toBe(true);
    expect(code(await req('DELETE', `/unit-sets/${set['id']}`))).toEqual([409, 'UNIT_IN_USE']);
    expect(code(await req('POST', '/unit-sets', { name: 'Bottle', baseUnitName: 'x', units: [] }))).toEqual([409, 'DUPLICATE_NAME']);
    expect(code(await req('POST', '/unit-sets', { name: 'Bad', baseUnitName: 'x', units: [{ name: 'y', factor: '0' }] }))).toEqual([400, 'VALIDATION_ERROR']);
    expect(code(await req('POST', '/unit-sets', { name: 'Bad2', baseUnitName: 'x', units: [{ name: 'X', factor: '2' }] }))).toEqual([400, 'VALIDATION_ERROR']);
    const unused = await req('POST', '/unit-sets', { name: 'Spare', baseUnitName: 'each', units: [{ name: 'dozen', factor: '12' }] });
    expect((await req('DELETE', `/unit-sets/${unused.json['unitSet'].id}`)).json).toEqual({ id: unused.json['unitSet'].id, deleted: true });
  });

  it('adjustments, counts and the reorder report in units; the count sheet shows the base unit', async () => {
    const { w, W, unit } = await unitWorld();
    await req('POST', '/bills', { contactId: w.vendor, txnDate: '2026-01-02', lines: [{ accountId: w.asset, amount: '60.00', itemId: W, quantity: '2', unitPrice: '30.00', unitId: unit.get('case') }] });
    const adj = await req('POST', '/inventory/adjustments', { txnDate: '2026-01-03', adjustmentAccountId: w.adjustment, lines: [{ itemId: W, quantityChange: '-1', unitId: unit.get('half-case') }] });
    expect(adj.status, JSON.stringify(adj.json)).toBe(201);
    expect(adj.json['adjustment'].lines[0]).toMatchObject({ quantityChange: '-1.0000', unitId: unit.get('half-case'), baseQuantityChange: '-6.0000', value: '-15.00' });
    expect((await figures(w))['quantityOnHand']).toBe('18.0000');
    const sheet = await req('GET', '/inventory/count-sheet?asOf=2026-01-31');
    expect((sheet.json['items'] as Body[]).find((i) => i['itemId'] === W)).toMatchObject({ unit: 'bottle', onHand: '18.0000' });
    // Counted 1 case and 0.5 half-case = 15 bottles: one adjustment of -3.
    const count = await req('POST', '/inventory/counts', { asOf: '2026-01-31', adjustmentAccountId: w.adjustment,
      lines: [{ itemId: W, sheetOnHand: '18.0000', countedQuantity: '1.25', unitId: unit.get('case') }] });
    expect(count.status, JSON.stringify(count.json)).toBe(201);
    expect(count.json['adjustment'].lines[0]).toMatchObject({ quantityChange: '-3.0000' });
    expect((await figures(w))['quantityOnHand']).toBe('15.0000');
    await invariants(w);
    // Reorder: point 20 bottles, reorder 48 bottles = 4 cases (the default purchase unit).
    await req('PUT', `/items/${W}`, { reorderPoint: '20', reorderQuantity: '48' });
    const rep = await req('GET', '/reports/reorder');
    expect(rep.json['data'][0]).toMatchObject({ itemId: W, reorderQuantity: '48.0000', reorderQuantityInPurchaseUnit: '4.0000', baseUnit: 'bottle',
      purchaseUnit: { id: unit.get('case'), name: 'case', abbreviation: null, factor: '12.000000' } });
  });

  it('advertises units-of-measure-v1 after reorder-alerts-v1', () => {
    expect(DESKTOP_CAPABILITIES.indexOf('units-of-measure-v1')).toBeGreaterThan(DESKTOP_CAPABILITIES.indexOf('reorder-alerts-v1'));
  });
});
