// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Inventory adjustments, physical counts and opening stock (U-157 core,
 * U-159 inventory-adjust-v1). An adjustment is a transaction of type
 * inventory_adjustment posted through the ledger core, so the costing walk
 * values it like any other movement:
 * - with a valueChange: Dr/Cr the part's inventory asset account (the part
 *   line, with the quantity change if any) vs the adjustment account; the
 *   movement's value is given. A value-only line needs stock on hand at its
 *   date (400 INVENTORY_NO_STOCK, Q-P24s; checked by the walk).
 * - quantity only: one part line on the adjustment account with the signed
 *   quantity and no amount; the walk values it at average cost and writes
 *   the derived pair (inventory_relief on the asset account, cogs on the
 *   adjustment account).
 * Dated on or before the closing date: 409 INVENTORY_PERIOD_CLOSED (the
 * costing gate), password or not.
 */

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { accounts, contacts, inventoryMovements, items, journalLines, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import { Decimal } from '../utils/inventory-walk.js';
import { inventoryAssetAccounts, lockForInventory, splitDerived } from './inventory-costing.service.js';
import { assertInventoryOn } from './inventory.service.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';

type Dec = InstanceType<typeof Decimal>;

export interface AdjustmentLineInput { itemId: string; quantityChange?: string | null; valueChange?: string | null }
export interface AdjustmentInput {
  txnDate: string; adjustmentAccountId: string; memo?: string; lines: AdjustmentLineInput[]; expectedUpdatedAt?: string;
}

// Signed quantity change: non-zero, |q| < 100,000,000, at most 4 places.
const QTY_CHANGE_RE = /^-?\d{1,8}(\.\d{1,4})?$/;
// Signed money: at most 2 places, below the money column.
const VALUE_CHANGE_RE = /^-?\d{1,15}(\.\d{1,2})?$/;
// A count: 0 or more, at most 4 places.
const COUNT_RE = /^\d{1,8}(\.\d{1,4})?$/;

/** A signed, non-zero quantity change (U-159): 400 VALIDATION_ERROR otherwise. */
export function parseQuantityChange(value: unknown, field: string): Dec {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!QTY_CHANGE_RE.test(s) || new Decimal(s).isZero()) {
    throw AppError.badRequest(`${field} must be a non-zero quantity change below 100,000,000 with at most 4 decimal places`, 'VALIDATION_ERROR', { field });
  }
  return new Decimal(s);
}

function parseValueChange(value: unknown, field: string, allowZero = false): Dec {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!VALUE_CHANGE_RE.test(s) || (!allowZero && new Decimal(s).isZero())) {
    throw AppError.badRequest(`${field} must be a ${allowZero ? '' : 'non-zero '}amount with at most 2 decimal places`, 'VALIDATION_ERROR', { field });
  }
  return new Decimal(s);
}

function parseCount(value: unknown, field: string): Dec {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!COUNT_RE.test(s)) throw AppError.badRequest(`${field} must be a quantity of 0 or more with at most 4 decimal places`, 'VALIDATION_ERROR', { field });
  return new Decimal(s);
}

function parseSignedQuantity(value: unknown, field: string): Dec {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!/^-?\d{1,8}(\.\d{1,4})?$/.test(s)) throw AppError.badRequest(`${field} must be a quantity with at most 4 decimal places`, 'VALIDATION_ERROR', { field });
  return new Decimal(s);
}

/** The adjustment account: an active account of the company that is not an inventory asset account (400 VALIDATION_ERROR). */
async function assertAdjustmentAccount(executor: DbOrTx, tenantId: string, companyId: string | undefined, accountId: string) {
  const [a] = await executor.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))).limit(1);
  if (!a || a.isActive === false || ledger.inOtherCompany(a, companyId)) {
    throw AppError.badRequest('adjustmentAccountId must be an active account of this company', 'VALIDATION_ERROR', { field: 'adjustmentAccountId' });
  }
  if ((await inventoryAssetAccounts(executor as Tx, tenantId, [accountId])).size > 0) {
    throw AppError.badRequest('The adjustment account can not be an inventory asset account', 'VALIDATION_ERROR', { field: 'adjustmentAccountId' });
  }
}

/** The journal lines of an adjustment (one or two per item line). `openingZero`: the opening path's given value of 0.00. */
async function adjustmentLines(executor: DbOrTx, tenantId: string, companyId: string | undefined, input: AdjustmentInput, opts: { openingZero?: boolean } = {}) {
  if (input.lines.length === 0) throw AppError.badRequest('An adjustment needs at least one line', 'VALIDATION_ERROR');
  const ids = [...new Set(input.lines.map((l) => l.itemId))];
  if (ids.length !== input.lines.length) throw AppError.badRequest('One line per item', 'VALIDATION_ERROR');
  const parts = await executor.select({ id: items.id, assetAccountId: items.assetAccountId, itemType: items.itemType, companyId: items.companyId }).from(items)
    .where(and(eq(items.tenantId, tenantId), inArray(items.id, ids)));
  const byId = new Map(parts.map((p) => [p.id, p]));
  const lines: Array<{ accountId: string; itemId?: string; quantity?: string; debit: string; credit: string; description?: string }> = [];
  input.lines.forEach((l, i) => {
    const part = byId.get(l.itemId);
    if (!part || part.itemType !== 'inventory_part' || !part.assetAccountId || ledger.inOtherCompany(part, companyId)) {
      throw AppError.badRequest(`lines[${i}].itemId is not an inventory item of this company`, 'VALIDATION_ERROR', { lineIndex: i });
    }
    const hasQty = l.quantityChange !== undefined && l.quantityChange !== null && l.quantityChange !== '';
    const hasValue = l.valueChange !== undefined && l.valueChange !== null && l.valueChange !== '';
    if (!hasQty && !hasValue) throw AppError.badRequest(`lines[${i}] needs a quantityChange or a valueChange`, 'VALIDATION_ERROR', { lineIndex: i });
    const qty = hasQty ? parseQuantityChange(l.quantityChange, `lines[${i}].quantityChange`).toFixed() : undefined;
    if (hasValue) {
      const v = parseValueChange(l.valueChange, `lines[${i}].valueChange`, opts.openingZero === true);
      const amt = v.abs().toFixed(2);
      const up = !v.isNegative();
      lines.push({ accountId: part.assetAccountId, itemId: part.id, ...(qty ? { quantity: qty } : {}), debit: up ? amt : '0', credit: up ? '0' : amt });
      lines.push({ accountId: input.adjustmentAccountId, debit: up ? '0' : amt, credit: up ? amt : '0' });
    } else {
      lines.push({ accountId: input.adjustmentAccountId, itemId: part.id, quantity: qty!, debit: '0', credit: '0' });
    }
  });
  await assertAdjustmentAccount(executor, tenantId, companyId, input.adjustmentAccountId);
  return lines;
}

/** Posts an inventory adjustment (one line per part) through the ledger core; `outerTx`: inside the caller's transaction. */
export async function postAdjustment(tenantId: string, companyId: string | undefined, input: AdjustmentInput, userId?: string, outerTx?: Tx,
  opts: { openingZero?: boolean } = {}) {
  const run = async (tx: Tx) => {
    await claimIdempotency(tx);
    await assertInventoryOn(tx, tenantId, companyId);
    const lines = await adjustmentLines(tx, tenantId, companyId, input, opts);
    return ledger.postTransaction(tenantId, {
      txnType: 'inventory_adjustment', txnDate: input.txnDate, memo: input.memo, lines,
    } as never, userId, companyId, tx);
  };
  return outerTx ? run(outerTx) : db.transaction(run);
}

async function loadAdjustment(executor: DbOrTx, tenantId: string, id: string, companyId?: string, lock = false) {
  const q = executor.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row || row.txnType !== 'inventory_adjustment' || row.status === 'deleted' || ledger.inOtherCompany(row, companyId)) {
    throw AppError.notFound('Inventory adjustment not found');
  }
  return row;
}

export interface AdjustmentRecord {
  id: string; date: string; adjustmentAccountId: string | null; memo: string | null; status: string; updatedAt: string | null;
  lines: Array<{ itemId: string; quantityChange: string | null; valueChange: string | null; value: string; movementId: string | null }>;
  inventoryLines: Array<{ role: string; accountId: string; amount: string; movementId: string | null }>;
}

/** GET /inventory/adjustments/:id: the form's lines (quantity and value as entered, value as costed) and the derived lines. */
export async function getAdjustment(executor: DbOrTx, tenantId: string, id: string, companyId?: string): Promise<AdjustmentRecord> {
  const row = await loadAdjustment(executor, tenantId, id, companyId);
  const all = await executor.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, id), eq(journalLines.isVoidReversal, false)))
    .orderBy(journalLines.lineOrder);
  const { lines: entered, inventoryLines } = splitDerived(all);
  const mv = await executor.select().from(inventoryMovements).where(and(eq(inventoryMovements.tenantId, tenantId), eq(inventoryMovements.transactionId, id)));
  const mvByItem = new Map(mv.map((m) => [m.itemId, m]));
  const partLines = entered.filter((l) => l.itemId);
  const counter = entered.find((l) => !l.itemId)?.accountId ?? partLines.find((l) => new Decimal(l.debit).isZero() && new Decimal(l.credit).isZero())?.accountId ?? null;
  return {
    id: row.id, date: row.txnDate, adjustmentAccountId: counter, memo: row.memo, status: row.status,
    updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null,
    lines: partLines.map((l) => {
      const m = mvByItem.get(l.itemId!);
      const given = new Decimal(l.debit).minus(l.credit);
      const valueLine = !given.isZero() || (m?.valueMode === 'given');
      return {
        itemId: l.itemId!,
        quantityChange: l.quantity !== null && !new Decimal(l.quantity).isZero() ? new Decimal(l.quantity).toFixed(4) : null,
        valueChange: valueLine ? given.toFixed(2) : null,
        value: new Decimal(m?.value ?? '0').toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        movementId: m?.id ?? null,
      };
    }),
    inventoryLines,
  };
}

/** PUT /inventory/adjustments/:id: row lock, expectedUpdatedAt (409 STALE), re-posted through the ledger core. */
export async function updateAdjustment(tenantId: string, id: string, input: AdjustmentInput, userId?: string, companyId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await loadAdjustment(tx, tenantId, id, companyId, true);
    if (row.status !== 'posted') throw AppError.badRequest('Cannot update a void transaction');
    ledger.assertNotStale(row, input.expectedUpdatedAt, 'This adjustment');
    await assertInventoryOn(tx, tenantId, companyId ?? row.companyId ?? undefined);
    const lines = await adjustmentLines(tx, tenantId, companyId ?? row.companyId ?? undefined, input);
    await ledger.updateTransaction(tenantId, id, {
      txnType: 'inventory_adjustment', txnDate: input.txnDate, memo: input.memo, lines,
    } as never, userId, companyId, tx);
    return getAdjustment(tx, tenantId, id, companyId);
  });
}

export async function voidAdjustment(tenantId: string, id: string, reason: string, userId?: string, opts: { expectedUpdatedAt?: string; companyId?: string } = {}) {
  await loadAdjustment(db, tenantId, id, opts.companyId);
  await ledger.voidTransaction(tenantId, id, reason, userId, { ...opts, expectType: 'inventory_adjustment' });
  return getAdjustment(db, tenantId, id, opts.companyId);
}

export async function deleteAdjustment(tenantId: string, id: string, userId?: string, opts: { expectedUpdatedAt?: string; companyId?: string; reason?: string } = {}) {
  await loadAdjustment(db, tenantId, id, opts.companyId);
  return ledger.deleteTransaction(tenantId, id, { ...opts, userId });
}

// ─── Counts (U-159, Q-P24g) ──────────────────────────────────────────

/** On hand and value of each part as of a date: the latest live movement dated on or before it (base units). */
async function stockAsOf(executor: DbOrTx, tenantId: string, companyId: string, itemIds: readonly string[], asOf: string) {
  const out = new Map<string, { onHand: Dec; value: Dec }>();
  if (itemIds.length === 0) return out;
  const r = await executor.execute(sql`
    SELECT DISTINCT ON (m.item_id) m.item_id::text AS item_id, m.running_qty::text AS q, m.running_value::text AS v
    FROM inventory_movements m
    WHERE m.tenant_id = ${tenantId} AND m.company_id = ${companyId} AND m.voided = false AND m.movement_date <= ${asOf}::date
      AND m.item_id IN (${sql.join(itemIds.map((i) => sql`${i}::uuid`), sql`, `)})
    ORDER BY m.item_id, m.movement_date DESC, m.txn_created_at DESC, m.transaction_id DESC`);
  for (const row of r.rows as Array<{ item_id: string; q: string; v: string }>) out.set(row.item_id, { onHand: new Decimal(row.q), value: new Decimal(row.v) });
  return out;
}

async function companyIdOf(executor: DbOrTx, tenantId: string, companyId?: string): Promise<string> {
  if (companyId) return companyId;
  const r = await executor.execute(sql`SELECT id FROM companies WHERE tenant_id = ${tenantId} ORDER BY created_at, id LIMIT 1`);
  const row = r.rows[0] as { id: string } | undefined;
  if (!row) throw AppError.notFound('Company not found');
  return row.id;
}

export interface CountSheetRow {
  itemId: string; name: string; description: string | null; unit: string | null;
  preferredVendor: { id: string; name: string } | null; onHand: string; value: string;
}

/** GET /inventory/count-sheet: every active part of the company with on hand and value as of asOf (base unit). */
export async function countSheet(tenantId: string, asOf: string, companyId?: string): Promise<{ asOf: string; items: CountSheetRow[] }> {
  await assertInventoryOn(db, tenantId, companyId);
  const co = await companyIdOf(db, tenantId, companyId);
  const parts = await db.select({ id: items.id, name: items.name, description: items.description, unit: items.unitLabel, vendorId: items.preferredVendorId, companyId: items.companyId })
    .from(items).where(and(eq(items.tenantId, tenantId), eq(items.itemType, 'inventory_part'), eq(items.isActive, true))).orderBy(items.name, items.id);
  const mine = parts.filter((p) => !p.companyId || p.companyId === co);
  const stock = await stockAsOf(db, tenantId, co, mine.map((p) => p.id), asOf);
  const vendorIds = [...new Set(mine.map((p) => p.vendorId).filter((v): v is string => !!v))];
  const vendors = vendorIds.length === 0 ? [] : await db.select({ id: contacts.id, name: contacts.displayName }).from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, vendorIds)));
  const vname = new Map(vendors.map((v) => [v.id, v.name]));
  return {
    asOf,
    items: mine.map((p) => {
      const s = stock.get(p.id);
      return {
        itemId: p.id, name: p.name, description: p.description ?? null, unit: p.unit ?? null,
        preferredVendor: p.vendorId && vname.has(p.vendorId) ? { id: p.vendorId, name: vname.get(p.vendorId)! } : null,
        onHand: (s?.onHand ?? new Decimal(0)).toFixed(4),
        value: (s?.value ?? new Decimal(0)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
      };
    }),
  };
}

/**
 * POST /inventory/counts (Q-P24g): under the item locks (companies row
 * first, the costing lock order), on hand as of asOf is recomputed; any
 * line whose sheetOnHand differs is 409 STALE listing every such item;
 * otherwise one adjustment dated asOf for the non-zero differences. All
 * equal: nothing is posted ({adjustment: null}).
 */
export async function postCount(tenantId: string, input: {
  asOf: string; adjustmentAccountId: string; memo?: string; lines: Array<{ itemId: string; sheetOnHand: string; countedQuantity: string }>;
}, userId?: string, companyId?: string) {
  const ids = [...new Set(input.lines.map((l) => l.itemId))];
  if (ids.length !== input.lines.length) throw AppError.badRequest('One line per item', 'VALIDATION_ERROR');
  const parsed = input.lines.map((l, i) => ({
    itemId: l.itemId, sheet: parseSignedQuantity(l.sheetOnHand, `lines[${i}].sheetOnHand`), counted: parseCount(l.countedQuantity, `lines[${i}].countedQuantity`),
  }));
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    await assertInventoryOn(tx, tenantId, companyId);
    const co = await companyIdOf(tx, tenantId, companyId);
    // The costing lock order: companies row, then the items; asOf on or before the closing date is 409 INVENTORY_PERIOD_CLOSED.
    await lockForInventory(tx, tenantId, co, ids, [input.asOf]);
    const stock = await stockAsOf(tx, tenantId, co, ids, input.asOf);
    const stale = parsed.filter((l) => !(stock.get(l.itemId)?.onHand ?? new Decimal(0)).equals(l.sheet))
      .map((l) => ({ itemId: l.itemId, sheetOnHand: l.sheet.toFixed(4), onHand: (stock.get(l.itemId)?.onHand ?? new Decimal(0)).toFixed(4) }));
    if (stale.length > 0) {
      throw AppError.conflict('On hand changed since the count sheet was printed. Reload the sheet and count those items again.', 'STALE', { items: stale });
    }
    const changes = parsed.map((l) => ({ itemId: l.itemId, delta: l.counted.minus(stock.get(l.itemId)?.onHand ?? 0) })).filter((l) => !l.delta.isZero());
    await auditLog(tenantId, 'create', 'inventory_count', null, null,
      { asOf: input.asOf, items: parsed.length, changed: changes.length }, userId, tx);
    if (changes.length === 0) {
      await recordIdempotentEntity(tx, 'inventory_count', co);
      return { adjustment: null };
    }
    const posted = await postAdjustment(tenantId, companyId, {
      txnDate: input.asOf, adjustmentAccountId: input.adjustmentAccountId, memo: input.memo ?? 'Physical count',
      lines: changes.map((c) => ({ itemId: c.itemId, quantityChange: c.delta.toFixed(4) })),
    }, userId, tx);
    return { adjustment: await getAdjustment(tx, tenantId, posted.id, companyId) };
  });
}

// ─── Opening stock on item create (U-159, Q-P24h) ───────────────────

/**
 * The company's Opening Balances equity account (system tag opening_balances: one of the company or a tenant-wide one,
 * P24 review), created for the company when missing; never another company's.
 */
async function openingBalancesAccount(tx: Tx, tenantId: string, companyId: string | undefined): Promise<string> {
  const scope = companyId ? or(isNull(accounts.companyId), eq(accounts.companyId, companyId)) : undefined;
  const [a] = await tx.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'opening_balances'), scope))
    .orderBy(sql`${accounts.companyId} IS NULL`, accounts.createdAt).limit(1);
  if (a) return a.id;
  const [made] = await tx.insert(accounts).values({
    tenantId, companyId: companyId ?? null, name: 'Opening Balances', accountType: 'equity', detailType: 'opening_balance_equity', systemTag: 'opening_balances', isSystem: true,
  } as never).returning({ id: accounts.id });
  return made!.id;
}

/** An inventory part's opening stock (item create's `opening`): an adjustment against Opening Balances, in the item's transaction. */
export async function postOpening(tx: Tx, tenantId: string, companyId: string | undefined, itemId: string,
  opening: { quantity: string; value: string; asOf: string }, userId?: string) {
  const qty = parseQuantityChange(opening.quantity, 'opening.quantity');
  if (!qty.greaterThan(0)) throw AppError.badRequest('opening.quantity must be above 0', 'VALIDATION_ERROR', { field: 'opening.quantity' });
  const value = parseValueChange(opening.value, 'opening.value', true);
  if (value.isNegative()) throw AppError.badRequest('opening.value must be 0 or more', 'VALIDATION_ERROR', { field: 'opening.value' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(opening.asOf)) throw AppError.badRequest('opening.asOf must be a date YYYY-MM-DD', 'VALIDATION_ERROR', { field: 'opening.asOf' });
  const account = await openingBalancesAccount(tx, tenantId, companyId);
  return postAdjustment(tenantId, companyId, {
    txnDate: opening.asOf, adjustmentAccountId: account, memo: 'Opening stock',
    lines: [{ itemId, quantityChange: qty.toFixed(4), valueChange: value.toFixed(2) }],
  }, userId, tx, { openingZero: true });
}
