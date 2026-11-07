// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-157 / U-158 (inventory-costing-v1) in tenant archives: the stock ledger
// (inventory_movements, including a linked return's source_transaction_id
// and the position tiebreak txn_created_at), the derived costing lines and
// their journal_lines.inventory_movement_id survive export -> verify ->
// import with remapped ids. On the imported tenant I1 and I2 hold, and a
// backdated bill re-walks to the same figures as on the original (the
// positions came across exactly). Runs in server mode against the test
// database.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, companies, contacts, items } from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as companyService from '../company.service.js';
import * as itemsService from '../items.service.js';
import * as billService from '../bill.service.js';
import * as invoiceService from '../invoice.service.js';
import * as salesDocs from '../sales-docs.service.js';
import * as unitsService from '../units.service.js';
import { runExport, type ExportResult } from './export.service.js';
import { runImport } from './import.service.js';
import { IdMap } from './remap.js';
import { rewalkCompany } from '../inventory-costing.service.js';
import { ArchiveReader } from './archive-reader.js';
import { buildPortabilityPlan, SOFT_REFS, scopeSql, type PortabilityPlan } from './plan.js';

const PASS = 'inventory round trip passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
let plan: PortabilityPlan;
let archiveRoot = '';
const createdTenants: string[] = [];
const createdUsers: string[] = [];
let tenantId = '';
let callerId = '';
let archive: ExportResult;
let importedId = '';

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

/** The tenant's stock ledger and derived lines with ids replaced by document numbers and names. */
async function stockShape(tid: string) {
  const rows = await q(`
    SELECT i.name AS item, COALESCE(t.txn_number, t.vendor_invoice_number) AS doc, src.txn_number AS returns, m.kind, m.value_mode, m.movement_date::text AS d,
      m.txn_created_at = t.created_at AS pos_ok, m.quantity::text AS q, m.value::text AS v, m.correction::text AS c, m.residual::text AS r,
      m.running_qty::text AS rq, m.running_value::text AS rv, m.last_cost::text AS l, m.voided
    FROM inventory_movements m JOIN items i ON i.id = m.item_id JOIN transactions t ON t.id = m.transaction_id
    LEFT JOIN transactions src ON src.id = m.source_transaction_id
    WHERE m.tenant_id = $1 ORDER BY m.movement_date, m.txn_created_at, 2, 3 NULLS FIRST`, [tid]);
  const lines = await q(`
    SELECT COALESCE(t.txn_number, t.vendor_invoice_number) AS doc, jl.line_role AS role, a.name AS account, jl.debit::text AS dr, jl.credit::text AS cr,
      (mt.id = jl.transaction_id) AS movement_same_doc
    FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN inventory_movements mv ON mv.id = jl.inventory_movement_id LEFT JOIN transactions mt ON mt.id = mv.transaction_id
    WHERE jl.tenant_id = $1 AND jl.line_role IN ('cogs', 'inventory_relief', 'cost_correction', 'cost_residual')
    ORDER BY 1, jl.line_role, a.name, jl.debit, jl.credit`, [tid]);
  return { rows, lines };
}

/** I1 per item and I2 for the inventory asset account. */
async function invariantsHold(tid: string) {
  const i2 = await q<{ v: string; gl: string }>(`
    SELECT (SELECT COALESCE(SUM(x.running_value), 0) FROM (SELECT DISTINCT ON (m.item_id) m.running_value FROM inventory_movements m
        WHERE m.tenant_id = $1 AND m.voided = false ORDER BY m.item_id, m.movement_date DESC, m.txn_created_at DESC, m.transaction_id DESC, m.source_movement_date DESC NULLS LAST, m.source_txn_created_at DESC NULLS LAST, m.source_transaction_id DESC NULLS LAST, m.id DESC) x)::numeric(19,2)::text AS v,
      (SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        JOIN transactions t ON t.id = jl.transaction_id
        WHERE jl.tenant_id = $1 AND a.system_tag = 'inventory_asset' AND t.status = 'posted')::numeric(19,2)::text AS gl`, [tid]);
  expect(i2[0]!.v, 'I2').toBe(i2[0]!.gl);
  const i1 = await q<{ n: number }>(`
    SELECT count(*)::int AS n FROM (
      SELECT m.running_value, SUM(m.value + m.correction + m.residual) OVER (PARTITION BY m.item_id
        ORDER BY m.movement_date, m.txn_created_at, m.transaction_id, m.source_movement_date NULLS FIRST, m.source_txn_created_at NULLS FIRST, m.source_transaction_id NULLS FIRST, m.id) AS s
      FROM inventory_movements m WHERE m.tenant_id = $1 AND m.voided = false) x WHERE x.running_value <> x.s`, [tid]);
  expect(i1[0]!.n, 'I1').toBe(0);
}

interface Co { tenantId: string; companyId: string; vendor: string; asset: string; itemId: string }

async function companyOf(tid: string): Promise<Co> {
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tid)).limit(1);
  const [asset] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tid), eq(accounts.systemTag, 'inventory_asset')));
  const [vendor] = await db.select().from(contacts).where(and(eq(contacts.tenantId, tid), eq(contacts.contactType, 'vendor')));
  const [item] = await db.select().from(items).where(and(eq(items.tenantId, tid), eq(items.name, 'Widget')));
  return { tenantId: tid, companyId: company!.id, vendor: vendor!.id, asset: asset!.id, itemId: item!.id };
}

const bill = (co: Co, date: string, qty: string, price: string, amount: string, num: string) => billService.createBill(co.tenantId, {
  contactId: co.vendor, txnDate: date, vendorInvoiceNumber: num,
  lines: [{ accountId: co.asset, amount, itemId: co.itemId, quantity: qty, unitPrice: price }],
} as never, undefined, co.companyId);

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-inventory-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  const reg = await authService.register({
    email: `rti-${stamp}@example.test`, password: 'password123', displayName: 'Owner', companyName: `RTI ${stamp}`,
  });
  tenantId = reg.user.tenantId;
  createdTenants.push(tenantId);
  callerId = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, $4, 'Caller', 'owner', true, true)`,
  [callerId, tenantId, `rti-caller-${stamp}@example.test`, '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']);
  createdUsers.push(callerId);

  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const companyId = company!.id;
  await companyService.updateCompany(tenantId, companyId, { inventoryEnabled: true } as never);
  const [asset] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'inventory_asset')));
  const cogs = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'cogs')) }))!.id;
  const revenue = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) }))!.id;
  await db.insert(contacts).values({ tenantId, companyId, contactType: 'vendor', displayName: 'Prairie Mill Supply' });
  const [customer] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'Bluestem Veterinary Clinic' }).returning();
  await itemsService.create(tenantId, { name: 'Widget', itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: revenue,
    assetAccountId: asset!.id, cogsAccountId: cogs } as never, undefined, companyId);
  const co = await companyOf(tenantId);
  // Units of measure (U-161): a unit set on the item, set before its first posting.
  const set = await unitsService.createUnitSet(tenantId, { name: 'Counts', baseUnitName: 'each', units: [{ name: 'Case', factor: '12' }] } as never,
    undefined, companyId);
  await itemsService.update(tenantId, co.itemId, { unitSetId: set.id } as never, undefined, companyId);
  // Golden A's receipts and sales (negative stock and a correction), then a linked return.
  await bill(co, '2026-01-02', '10', '3.3333', '33.33', 'B1');
  await bill(co, '2026-01-05', '5', '4.10', '20.50', 'B2');
  const sale = await invoiceService.createInvoice(tenantId, { contactId: customer!.id, txnDate: '2026-01-08', txnNumber: `I1-${stamp}`,
    lines: [{ itemId: co.itemId, quantity: '4', unitPrice: '10.00', isTaxable: false }] } as never, undefined, companyId);
  await invoiceService.createInvoice(tenantId, { contactId: customer!.id, txnDate: '2026-01-12', txnNumber: `I2-${stamp}`,
    lines: [{ itemId: co.itemId, quantity: '14', unitPrice: '10.00', isTaxable: false }] } as never, undefined, companyId);
  await bill(co, '2026-01-15', '10', '3.80', '38.00', 'B3');
  // Units of measure (U-161): a bill line in cases (2 cases = 24 base units).
  await billService.createBill(tenantId, { contactId: co.vendor, txnDate: '2026-01-15', vendorInvoiceNumber: 'B4',
    lines: [{ accountId: co.asset, amount: '72.00', itemId: co.itemId, quantity: '2', unitPrice: '36.00', unitId: set.units.find((u) => u.name === 'Case')!.id }],
  } as never, undefined, companyId);
  await salesDocs.createCreditMemoDocument(tenantId, { contactId: customer!.id, txnDate: '2026-01-16', txnNumber: `CM-${stamp}`,
    lines: [{ itemId: co.itemId, quantity: '2', unitPrice: '10.00', isTaxable: false, returnOf: { transactionId: sale.id } }] } as never, undefined, companyId);
  await invariantsHold(tenantId);
  archive = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
}, 180_000);

afterAll(async () => {
  for (const id of createdTenants) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await q(`DELETE FROM "${t}" a WHERE ${where}`).catch(() => undefined);
    }
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE tenant_id = $1`, [id]).catch(() => undefined);
  }
  for (const u of createdUsers) await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  for (const id of createdTenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('the stock ledger in tenant archives (U-157, U-158)', () => {
  it('classifies the stock ledger references', () => {
    expect(SOFT_REFS['inventory_movements.source_transaction_id']).toBe('tenant-ref:transactions');
    expect(SOFT_REFS['journal_lines.inventory_movement_id']).toBe('tenant-ref:inventory_movements');
    expect(plan.byName.get('inventory_movements')).toBeTruthy();
  });

  it('movements, links, positions and derived lines survive with remapped ids; I1, I2 hold; a later re-walk matches the original', async () => {
    const reader = await ArchiveReader.open(archive.path!, PASS);
    await reader.verifyAll();
    const before = await stockShape(tenantId);
    expect(before.rows.length).toBe(7);
    expect(before.rows.find((r) => r['kind'] === 'customer_return')).toMatchObject({ value_mode: 'linked', returns: `I1-${stamp}` });
    const imported = await runImport({ filePath: archive.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    importedId = imported.tenantId;
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    expect(await stockShape(imported.tenantId)).toEqual(before);
    await invariantsHold(imported.tenantId);
    const leaked = await q<{ n: number }>(`SELECT count(*)::int AS n FROM inventory_movements m WHERE m.tenant_id = $1
      AND (m.transaction_id IN (SELECT id FROM transactions WHERE tenant_id = $2) OR m.source_transaction_id IN (SELECT id FROM transactions WHERE tenant_id = $2)
        OR m.item_id IN (SELECT id FROM items WHERE tenant_id = $2))`, [imported.tenantId, tenantId]);
    expect(leaked[0]!.n).toBe(0);
    // The same backdated bill on both tenants re-walks every later row (the linked return included) to the same figures.
    await bill(await companyOf(tenantId), '2026-01-03', '6', '2.00', '12.00', 'B0');
    await bill(await companyOf(imported.tenantId), '2026-01-03', '6', '2.00', '12.00', 'B0');
    await invariantsHold(tenantId);
    await invariantsHold(imported.tenantId);
    expect(await stockShape(imported.tenantId)).toEqual(await stockShape(tenantId));
  }, 600_000);

  it('unit sets, the set of the item and line units survive with remapped ids (U-161)', async () => {
    expect(importedId).not.toBe('');
    const units = async (tid: string) => ({
      sets: await q(`SELECT s.name, s.base_unit_name AS base, u.name AS unit, u.factor::text AS factor FROM unit_sets s
        JOIN unit_set_units u ON u.unit_set_id = s.id WHERE s.tenant_id = $1 ORDER BY 1, 3`, [tid]),
      items: await q(`SELECT i.name, s.name AS set FROM items i JOIN unit_sets s ON s.id = i.unit_set_id WHERE i.tenant_id = $1 ORDER BY 1`, [tid]),
      lines: await q(`SELECT t.vendor_invoice_number AS doc, u.name AS unit, jl.quantity::text AS q, jl.base_quantity::text AS bq
        FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id JOIN unit_set_units u ON u.id = jl.unit_id
        WHERE jl.tenant_id = $1 ORDER BY 1`, [tid]),
    });
    const original = await units(tenantId);
    expect(original.lines).toEqual([{ doc: 'B4', unit: 'Case', q: '2.0000', bq: '24.0000' }]);
    expect(original.items).toEqual([{ name: 'Widget', set: 'Counts' }]);
    expect(await units(importedId)).toEqual(original);
    const leaked = await q<{ n: number }>(`SELECT count(*)::int AS n FROM journal_lines jl WHERE jl.tenant_id = $1
      AND jl.unit_id IN (SELECT u.id FROM unit_set_units u JOIN unit_sets s ON s.id = u.unit_set_id WHERE s.tenant_id = $2)`, [importedId, tenantId]);
    expect(leaked[0]!.n).toBe(0);
  });
});

/** A fresh tenant with inventory on, a vendor, a customer and the part Widget (no stock). */
async function stockedTenant(label: string): Promise<Co & { customer: string }> {
  const reg = await authService.register({
    email: `rti-${label}-${stamp}@example.test`, password: 'password123', displayName: 'Owner', companyName: `RTI ${label} ${stamp}`,
  });
  const tid = reg.user.tenantId;
  createdTenants.push(tid);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tid)).limit(1);
  await companyService.updateCompany(tid, company!.id, { inventoryEnabled: true } as never);
  const [asset] = await db.select().from(accounts).where(and(eq(accounts.tenantId, tid), eq(accounts.systemTag, 'inventory_asset')));
  const cogs = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tid), eq(accounts.accountType, 'cogs')) }))!.id;
  const revenue = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tid), eq(accounts.accountType, 'revenue')) }))!.id;
  await db.insert(contacts).values({ tenantId: tid, companyId: company!.id, contactType: 'vendor', displayName: 'Prairie Mill Supply' });
  const [customer] = await db.insert(contacts).values({ tenantId: tid, companyId: company!.id, contactType: 'customer', displayName: 'Bluestem Veterinary Clinic' }).returning();
  await itemsService.create(tid, { name: 'Widget', itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: revenue,
    assetAccountId: asset!.id, cogsAccountId: cogs } as never, undefined, company!.id);
  return { ...(await companyOf(tid)), customer: customer!.id };
}

const sell = (co: Co & { customer: string }, date: string, qty: string, num: string) => invoiceService.createInvoice(co.tenantId, {
  contactId: co.customer, txnDate: date, txnNumber: `${num}-${stamp}`, lines: [{ itemId: co.itemId, quantity: qty, unitPrice: '10.00', isTaxable: false }],
} as never, undefined, co.companyId);

/**
 * Imports `file` with the new ids of `flip` (two transaction ids of the
 * archive) chosen so they sort the other way round than on the original.
 */
async function importFlipped(file: string, flip: [string, string]) {
  const [a, b] = flip.map((x) => x.toLowerCase()) as [string, string];
  const tail = () => crypto.randomUUID().slice(-12);
  const [low, high] = [`00000000-0000-4000-8000-${tail()}`, `ffffffff-ffff-4fff-bfff-${tail()}`];
  // a < b on the original: a gets the high id, b the low one (and the other way round).
  const forced = new Map(a < b ? [[a, high], [b, low]] : [[a, low], [b, high]]);
  const fresh = IdMap.prototype.fresh;
  const spy = vi.spyOn(IdMap.prototype, 'fresh').mockImplementation(function (this: IdMap, oldId: string) {
    const want = forced.get(oldId.toLowerCase());
    if (want && !this.get(oldId)) { this.set(oldId, want); return want; }
    return fresh.call(this, oldId);
  });
  try {
    const imported = await runImport({ filePath: file, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    return imported;
  } finally {
    spy.mockRestore();
  }
}

/** What the items list and the valuation read: the latest row of each part. */
async function onHand(tid: string) {
  return q(`SELECT DISTINCT ON (m.item_id) i.name, m.running_qty::text AS q, m.running_value::text AS v, m.last_cost::text AS l
    FROM inventory_movements m JOIN items i ON i.id = m.item_id WHERE m.tenant_id = $1 AND m.voided = false
    ORDER BY m.item_id, m.movement_date DESC, m.txn_created_at DESC, m.transaction_id DESC, m.source_movement_date DESC NULLS LAST,
      m.source_txn_created_at DESC NULLS LAST, m.source_transaction_id DESC NULLS LAST, m.id DESC`, [tid]);
}

describe('a credit memo with two linked rows of one part survives an import whose ids sort the other way (PR-4 RB1)', () => {
  it('rows order by their sale\'s position on both sides: the same rows, running figures, on hand and value; valuation = GL', async () => {
    expect(callerId).not.toBe('');
    const co = await stockedTenant('rb1');
    await bill(co, '2026-02-02', '10', '3.00', '30.00', 'M1');
    const x = await sell(co, '2026-02-03', '3', 'X');
    const y = await sell(co, '2026-02-04', '2', 'Y');
    await bill(co, '2026-02-05', '5', '5.00', '25.00', 'M2');
    // One memo: 1 unit back against X (9.00 / 3), 2 against Y (6.00 / 2 x 2); the walk meets X's row first (X sold first).
    await salesDocs.createCreditMemoDocument(co.tenantId, { contactId: co.customer, txnDate: '2026-02-06', txnNumber: `RB1-${stamp}`,
      lines: [
        { itemId: co.itemId, quantity: '2', unitPrice: '10.00', isTaxable: false, returnOf: { transactionId: y.id } },
        { itemId: co.itemId, quantity: '1', unitPrice: '10.00', isTaxable: false, returnOf: { transactionId: x.id } },
      ] } as never, undefined, co.companyId);
    const memoRows = await q<{ src: string; v: string; rq: string; rv: string; sd: string }>(`SELECT m.source_transaction_id::text AS src, m.value::text AS v,
      m.running_qty::text AS rq, m.running_value::text AS rv, m.source_movement_date::text AS sd
      FROM inventory_movements m WHERE m.tenant_id = $1 AND m.kind = 'customer_return'
      ORDER BY m.movement_date, m.txn_created_at, m.transaction_id, m.source_movement_date NULLS FIRST, m.source_txn_created_at NULLS FIRST,
        m.source_transaction_id NULLS FIRST, m.id`, [co.tenantId]);
    expect(memoRows).toEqual([
      { src: x.id, v: '3.0000', rq: '11.0000', rv: '43.0000', sd: '2026-02-03' },
      { src: y.id, v: '6.0000', rq: '13.0000', rv: '49.0000', sd: '2026-02-04' },
    ]);
    await invariantsHold(co.tenantId);
    const file = (await runExport(co.tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } })).path!;
    const before = { shape: await stockShape(co.tenantId), onHand: await onHand(co.tenantId) };
    const imported = await importFlipped(file, [x.id, y.id]);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    const ids = await q<{ id: string; n: string }>(`SELECT id::text AS id, txn_number AS n FROM transactions WHERE tenant_id = $1 AND txn_number IN ($2, $3)`,
      [imported.tenantId, `X-${stamp}`, `Y-${stamp}`]);
    const newX = ids.find((r) => r.n === `X-${stamp}`)!.id;
    const newY = ids.find((r) => r.n === `Y-${stamp}`)!.id;
    expect(newX < newY, 'the import flipped the id order of the two sales').toBe(!(x.id < y.id));
    expect(await stockShape(imported.tenantId)).toEqual(before.shape);
    expect(await onHand(imported.tenantId)).toEqual(before.onHand);
    expect(before.onHand).toEqual([{ name: 'Widget', q: '13.0000', v: '49.0000', l: '3.769231' }]);
    await invariantsHold(imported.tenantId);
    // Nothing moved, so the import's re-walk wrote no audit row.
    const audits = await q(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND (CASE WHEN jsonb_typeof(after_data) = 'string' THEN (after_data #>> '{}')::jsonb ELSE after_data END)->>'costingTrigger' = 'tenant_import'`, [imported.tenantId]);
    expect(audits).toHaveLength(0);
  }, 600_000);
});

describe('the import re-walks every item (PR-4 RB1: documents that tie on date and created_at)', () => {
  it('a sale and a bill entered together sort by id; on the imported tenant they sort the other way, and the re-walk re-costs the sale: valuation = GL, audited', async () => {
    expect(callerId).not.toBe('');
    const co = await stockedTenant('tie');
    await bill(co, '2026-02-02', '4', '2.00', '8.00', 'T1');
    const sale = await sell(co, '2026-02-03', '2', 'TS');
    const late = await bill(co, '2026-02-03', '4', '8.00', '32.00', 'T2');
    const lateId = (late as { id: string }).id;
    // As if both were entered in one database transaction: same date, same created_at; the id decides.
    const tied = '2026-02-03T12:00:00.000Z';
    await q(`UPDATE transactions SET created_at = $1::timestamptz WHERE id IN ($2, $3)`, [tied, sale.id, lateId]);
    await q(`UPDATE inventory_movements SET txn_created_at = $1::timestamptz WHERE transaction_id IN ($2, $3)`, [tied, sale.id, lateId]);
    // The original re-walked once in its own id order (the repair any company can run).
    await db.transaction(async (tx) => { await rewalkCompany(tx, co.tenantId, co.companyId, 'test'); });
    await invariantsHold(co.tenantId);
    const relief = async (tid: string, num: string) => (await q<{ v: string }>(`SELECT m.value::text AS v FROM inventory_movements m
      JOIN transactions t ON t.id = m.transaction_id WHERE m.tenant_id = $1 AND t.txn_number = $2`, [tid, num]))[0]!.v;
    const saleFirst = sale.id < lateId;
    expect(await relief(co.tenantId, `TS-${stamp}`)).toBe(saleFirst ? '-4.0000' : '-10.0000');
    const file = (await runExport(co.tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } })).path!;
    const imported = await importFlipped(file, [sale.id, lateId]);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    // The other order: the sale costs the other average, its derived lines and the balances follow, I1 and I2 hold.
    expect(await relief(imported.tenantId, `TS-${stamp}`)).toBe(saleFirst ? '-10.0000' : '-4.0000');
    await invariantsHold(imported.tenantId);
    const balances = await q<{ n: number }>(`SELECT count(*)::int AS n FROM accounts a WHERE a.tenant_id = $1 AND a.balance <>
      (SELECT COALESCE(SUM(jl.debit - jl.credit), 0) FROM journal_lines jl WHERE jl.tenant_id = a.tenant_id AND jl.account_id = a.id)
      AND a.account_type IN ('asset', 'cogs')`, [imported.tenantId]);
    expect(balances[0]!.n, 'accounts.balance follows the rewritten lines').toBe(0);
    const audits = await q<{ id: string }>(`SELECT entity_id::text AS id FROM audit_log WHERE tenant_id = $1 AND (CASE WHEN jsonb_typeof(after_data) = 'string' THEN (after_data #>> '{}')::jsonb ELSE after_data END)->>'costingTrigger' = 'tenant_import'`,
      [imported.tenantId]);
    expect(audits.length).toBeGreaterThan(0);
    // A later posting on the imported tenant walks from the re-walked rows.
    await bill(await companyOf(imported.tenantId), '2026-02-10', '1', '5.00', '5.00', 'T3');
    await invariantsHold(imported.tenantId);
  }, 600_000);

  it('a linked return that ties with its sale: on whichever side it sorts first, every unit back still brings exactly the sale\'s R (#230 residual)', async () => {
    expect(callerId).not.toBe('');
    const co = await stockedTenant('tie-return');
    await bill(co, '2026-02-01', '1', '4.00', '4.00', 'L1');
    await sell(co, '2026-02-02', '1', 'L0');
    const sale = await sell(co, '2026-02-03', '2', 'LS');
    const memo = async (date: string, num: string) => (await salesDocs.createCreditMemoDocument(co.tenantId, { contactId: co.customer, txnDate: date,
      txnNumber: `${num}-${stamp}`, lines: [{ itemId: co.itemId, quantity: '1', unitPrice: '10.00', isTaxable: false, returnOf: { transactionId: sale.id } }] } as never,
    undefined, co.companyId)).creditMemo;
    const first = await memo('2026-02-03', 'LM1');
    await bill(co, '2026-02-04', '1', '10.00', '10.00', 'L2');
    await memo('2026-02-05', 'LM2');
    // The sale and its first return as if entered in one database transaction: the ids decide which comes first.
    const tied = '2026-02-03T12:00:00.000Z';
    await q(`UPDATE transactions SET created_at = $1::timestamptz WHERE id IN ($2, $3)`, [tied, sale.id, first.id]);
    await q(`UPDATE inventory_movements SET txn_created_at = $1::timestamptz WHERE transaction_id IN ($2, $3)`, [tied, sale.id, first.id]);
    await db.transaction(async (tx) => { await rewalkCompany(tx, co.tenantId, co.companyId, 'test'); });
    const file = (await runExport(co.tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } })).path!;
    const imported = await importFlipped(file, [sale.id, first.id]);
    // One side walks the return before its sale. On both, all units are back, so the returns add up to relief + correction_share.
    for (const tid of [co.tenantId, imported.tenantId]) {
      const r = await q<{ back: string; r: string }>(`SELECT (SELECT SUM(m.value) FROM inventory_movements m WHERE m.tenant_id = $1 AND m.source_transaction_id = s.transaction_id
          AND m.voided = false)::numeric(19,2)::text AS back, (-s.value + s.correction_share)::numeric(19,2)::text AS r
        FROM inventory_movements s JOIN transactions t ON t.id = s.transaction_id WHERE s.tenant_id = $1 AND t.txn_number = $2`, [tid, `LS-${stamp}`]);
      expect(r[0]!.back, tid === co.tenantId ? 'original' : 'imported').toBe(r[0]!.r);
      await invariantsHold(tid);
    }
  }, 600_000);
});
