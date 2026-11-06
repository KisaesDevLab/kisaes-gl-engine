// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-157 inventory-costing-v1 (ClientLedger P24 E2a): golden cases A, B, V,
// X, M, D and N of packages/shared/fixtures/inventory-golden.json through
// the real bill, vendor credit, invoice and transaction routes, with the I2
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
import { Harness, type Co, key } from './receivables.test-support.js';
import { postAdjustment } from '../services/inventory-adjustment.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

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
    ['/api/v1/vendor-credits', vendorCreditsRouter], ['/api/v1/invoices', invoicesRouter], ['/api/v1/transactions', transactionsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const req = (method: string, p: string, body?: unknown) =>
  h.request(method, `/api/v1${p}`, c.token, body, method === 'GET' ? {} : { 'Idempotency-Key': key() });
const idOf = (j: Body): string => String(j['id'] ?? j['bill']?.id ?? j['credit']?.id ?? j['vendorCredit']?.id ?? j['invoice']?.id ?? j['transaction']?.id);

interface World {
  asset: string; cogs: string; adjustment: string; vendor: string; items: Map<string, string>; docs: Map<string, string>;
  bodies: Map<string, Body>;
}

async function setup(): Promise<World> {
  const on = await req('PUT', '/company/settings', { inventoryEnabled: true });
  expect(on.status, JSON.stringify(on.json)).toBe(200);
  const tagged = async (tag: string) => (await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, tag))))[0]!.id;
  const asset = await tagged('inventory_asset');
  const [cogs] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountType, 'cogs'), eq(accounts.isActive, true)));
  const [adj] = await db.insert(accounts).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Inventory Shrinkage', accountType: 'expense' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: golden['seed'].vendor }).returning();
  const world: World = { asset, cogs: cogs!.id, adjustment: adj!.id, vendor: vendor!.id, items: new Map(), docs: new Map(), bodies: new Map() };
  for (const name of ['W']) {
    const r = await req('POST', '/items', {
      name, itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: c.roles['income'], assetAccountId: asset, cogsAccountId: world.cogs,
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    world.items.set(name, r.json['item'].id);
  }
  return world;
}

const stepWarnings: Body[][] = [];

/** Runs one golden step through the routes. */
async function step(w: World, s: Body) {
  const item = s['item'] ? w.items.get(s['item'])! : '';
  let r: { status: number; json: Body } | null = null;
  switch (s['event']) {
    case 'bill': {
      const body = { contactId: w.vendor, txnDate: s['date'], lines: [{ accountId: w.asset, amount: s['amount'], itemId: item, quantity: s['quantity'], unitPrice: s['unitPrice'] }] };
      r = await req('POST', '/bills', body);
      w.bodies.set(s['doc'], body);
      break;
    }
    case 'vendor_credit':
      r = await req('POST', '/vendor-credits', { contactId: w.vendor, txnDate: s['date'], lines: [{ accountId: w.asset, amount: s['amount'], itemId: item, quantity: s['quantity'], unitPrice: s['unitPrice'] }] });
      break;
    case 'invoice': {
      const body = { contactId: c.customer, txnDate: s['date'], lines: [{ itemId: item, quantity: s['quantity'], unitPrice: golden['seed'].salePrice, isTaxable: false }] };
      r = await req('POST', '/invoices', body);
      w.bodies.set(s['doc'], body);
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
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return;
    case 'delete':
      r = await req('DELETE', `/transactions/${w.docs.get(s['doc'])}`, { reason: 'golden' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      if (s['expect']?.status) expect(r.json['transaction']?.status ?? r.json['status']).toBe(s['expect'].status);
      return;
    case 'edit': {
      const id = w.docs.get(s['doc'])!;
      const body = structuredClone(w.bodies.get(s['doc'])!) as Body;
      if (s['quantity']) body['lines'][0].quantity = s['quantity'];
      if (s['date']) body['txnDate'] = s['date'];
      const kind = (await db.select({ t: transactions.txnType }).from(transactions).where(eq(transactions.id, id)))[0]!.t;
      r = await req('PUT', `/${kind === 'bill' ? 'bills' : 'invoices'}/${id}`, body);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      w.bodies.set(s['doc'], body);
      return;
    }
    default:
      throw new Error(`step ${s['event']} is not run in E2a`);
  }
  expect([200, 201], JSON.stringify(r!.json)).toContain(r!.status);
  if (s['doc']) w.docs.set(s['doc'], idOf(r!.json));
  stepWarnings.push([]);
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
  if (!e) return;
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

async function runSteps(w: World, steps: Body[]) {
  for (const s of steps) {
    await step(w, s);
    await checkExpect(w, s['expect'], s['doc'] ? w.docs.get(s['doc']) : undefined);
    await invariants(w);
  }
}

async function checkRows(w: World, expected: Body[]) {
  const got = await rows(w.items.get('W')!);
  const name = new Map([...w.docs].map(([k, v]) => [v, k]));
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
