// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Average-cost inventory costing in the ledger core (U-157, U-158;
 * inventory-costing-v1).
 *
 * The stock ledger is inventory_movements: one row per (transaction, item),
 * written in the posting's database transaction. postTransaction,
 * updateTransaction, voidTransactionInTx and deleteTransactionInTx call
 * prepare*() before their first balance write (guards, then the lock order
 * companies row -> items in id order) and apply() after their own lines are
 * written. apply() stores the document's movements, re-walks each item from
 * the first affected position (utils/inventory-walk.ts) and rewrites the
 * derived lines (line_role cogs, inventory_relief, cost_correction,
 * cost_residual) of every open-period document whose figures changed, with
 * one balance delta per account. Derived lines are never in a reader's
 * `lines` (they come back as `inventoryLines`) and clients can't send them.
 *
 * Lock order (P24 §5, with the counter slot first): document row ->
 * companies row (FOR UPDATE; its lock_date drives the frozen rule) -> items
 * (id order) -> accounts (id order). Invoices and vendor credits take the
 * companies row for their number before postTransaction, so the companies
 * row comes before the items here. lock_timeout is 5 s for the rest of the
 * transaction; a deadlock, a serialization failure or a lock timeout is 409
 * RETRY (error-handler).
 *
 * Closed periods are refused, not restated (owner decision 2026-11-06,
 * replacing Q-P24b / Q-P24t): adding, editing, voiding or deleting a
 * document with inventory lines dated on or before the closing date is 409
 * INVENTORY_PERIOD_CLOSED, closing-date password or not (an edit checks the
 * old and the new date). So every walk starts after the closing date and no
 * row on or before it ever changes.
 *
 * E2a scope: bills (billReceived true or false), vendor credits, invoices
 * and inventory adjustments; part lines on other document types are 400
 * INVENTORY_DOCUMENT_UNSUPPORTED until E2b.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { inventoryMovements, items, journalLines, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import {
  Decimal, walk, ZERO_STATE, type Dec, type MovementKind, type WalkRow, type WalkState,
} from '../utils/inventory-walk.js';
import { INVENTORY_ASSET_TAG } from './inventory.service.js';

/** Line roles only the costing walk writes (U-157). */
export const DERIVED_LINE_ROLES = ['cogs', 'inventory_relief', 'cost_correction', 'cost_residual'] as const;
export type DerivedLineRole = typeof DERIVED_LINE_ROLES[number];
export function isDerivedRole(role: string | null | undefined): role is DerivedLineRole {
  return !!role && (DERIVED_LINE_ROLES as readonly string[]).includes(role);
}

// Document types that move stock (E2a), and the kind of their movement.
const RECEIPT_TYPES = new Set(['bill']);
const VENDOR_RETURN_TYPES = new Set(['vendor_credit']);
const SALE_TYPES = new Set(['invoice']);
const ADJUST_TYPES = new Set(['inventory_adjustment']);
const STOCK_TYPES = new Set([...RECEIPT_TYPES, ...VENDOR_RETURN_TYPES, ...SALE_TYPES, ...ADJUST_TYPES]);
// Types whose lines may sit on an inventory asset account without an item.
const DIRECT_OK_TYPES = new Set(['journal_entry', 'aje']);

const QTY_LIMIT = new Decimal('1e8');
const MONEY_LIMIT = new Decimal('1e15');

interface InputLine {
  accountId: string; debit?: string | null; credit?: string | null; itemId?: string | null; quantity?: string | null; lineRole?: string | null;
}

interface PartRow { id: string; assetAccountId: string | null; cogsAccountId: string | null; purchaseCost: string | null }

/** A costing lock held by the caller's transaction. */
export interface CostingLock { companyId: string; lockDate: string | null; itemIds: string[] }

/** NEGATIVE_STOCK (U-158): the first row per item whose running quantity newly went below 0. */
export interface InventoryWarning { code: 'NEGATIVE_STOCK'; itemId: string; date: string; onHand: string }

const d = (v: unknown) => new Decimal(v === null || v === undefined || v === '' ? '0' : String(v));

/** The accounts of `accountIds` that are inventory asset accounts: tagged inventory_asset or named by a part. */
export async function inventoryAssetAccounts(tx: Tx, tenantId: string, accountIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(accountIds.filter(Boolean))];
  if (ids.length === 0) return new Set();
  const r = await tx.execute(sql`
    SELECT a.id FROM accounts a
    WHERE a.tenant_id = ${tenantId} AND a.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
      AND (a.system_tag = ${INVENTORY_ASSET_TAG} OR EXISTS (
        SELECT 1 FROM items i WHERE i.tenant_id = a.tenant_id AND i.item_type = 'inventory_part' AND i.asset_account_id = a.id))`);
  return new Set((r.rows as Array<{ id: string }>).map((x) => x.id));
}

async function partsOf(tx: Tx, tenantId: string, itemIds: readonly (string | null | undefined)[]): Promise<Map<string, PartRow>> {
  const ids = [...new Set(itemIds.filter((v): v is string => !!v))];
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: items.id, assetAccountId: items.assetAccountId, cogsAccountId: items.cogsAccountId, purchaseCost: items.purchaseCost })
    .from(items).where(and(eq(items.tenantId, tenantId), inArray(items.id, ids), eq(items.itemType, 'inventory_part')));
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Guards on a posting's lines (B3, B4): a derived lineRole from a caller is
 * 400 VALIDATION_ERROR; outside journal entries a line on an inventory
 * asset account must be an inventory part's line on its own asset account
 * (else 400 INVENTORY_ACCOUNT_DIRECT); a part line needs a quantity, sits on
 * the part's asset account on receipts and vendor returns and off every
 * inventory asset account on sales; part lines on a document type that
 * doesn't move stock yet are 400 INVENTORY_DOCUMENT_UNSUPPORTED.
 */
async function assertLines(tx: Tx, tenantId: string, txnType: string, lines: readonly InputLine[], parts: Map<string, PartRow>) {
  lines.forEach((l, i) => {
    if (isDerivedRole(l.lineRole)) {
      throw AppError.badRequest(`Line ${i + 1}: lineRole ${l.lineRole} is written by the engine's costing only`, 'VALIDATION_ERROR', { lineIndex: i });
    }
  });
  const assetAccounts = await inventoryAssetAccounts(tx, tenantId, lines.map((l) => l.accountId));
  lines.forEach((l, i) => {
    const part = l.itemId ? parts.get(l.itemId) : undefined;
    if (!part) {
      if (assetAccounts.has(l.accountId) && !DIRECT_OK_TYPES.has(txnType)) {
        throw AppError.badRequest(
          `Line ${i + 1} posts to an inventory asset account without an inventory item. Use an inventory item, an inventory adjustment or a journal entry.`,
          'INVENTORY_ACCOUNT_DIRECT', { lineIndex: i, accountId: l.accountId },
        );
      }
      return;
    }
    if (!STOCK_TYPES.has(txnType)) {
      throw AppError.badRequest(`Line ${i + 1}: inventory items can't be used on this kind of transaction yet`, 'INVENTORY_DOCUMENT_UNSUPPORTED',
        { lineIndex: i, txnType });
    }
    const hasQty = l.quantity !== undefined && l.quantity !== null && l.quantity !== '';
    if (!ADJUST_TYPES.has(txnType) && (!hasQty || !d(l.quantity).greaterThan(0))) {
      throw AppError.badRequest(`Line ${i + 1}: an inventory item line needs a quantity above 0`, 'VALIDATION_ERROR', { lineIndex: i });
    }
    if ((RECEIPT_TYPES.has(txnType) || VENDOR_RETURN_TYPES.has(txnType)) && l.accountId !== part.assetAccountId) {
      throw AppError.badRequest(`Line ${i + 1}: an inventory item line posts to the item's inventory asset account`, 'VALIDATION_ERROR',
        { lineIndex: i, expectedAccountId: part.assetAccountId });
    }
    if (SALE_TYPES.has(txnType) && assetAccounts.has(l.accountId)) {
      throw AppError.badRequest(`Line ${i + 1}: a sale of an inventory item posts to an income account`, 'INVENTORY_ACCOUNT_DIRECT', { lineIndex: i });
    }
    if (ADJUST_TYPES.has(txnType) && l.accountId !== part.assetAccountId && !(d(l.debit).isZero() && d(l.credit).isZero())) {
      throw AppError.badRequest(`Line ${i + 1}: an adjustment's value posts to the item's inventory asset account`, 'VALIDATION_ERROR', { lineIndex: i });
    }
  });
}

/**
 * The costing lock (P24 §5): lock_timeout 5 s, the companies row FOR UPDATE
 * (its lock_date read there), then the items in id order. A document date
 * on or before the closing date is 409 INVENTORY_PERIOD_CLOSED (owner
 * decision 2026-11-06), read under the row lock so a concurrent close waits.
 */
async function lock(tx: Tx, tenantId: string, companyId: string | null | undefined, itemIds: readonly string[], dates: ReadonlyArray<string | null | undefined>): Promise<CostingLock> {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  const r = await tx.execute(companyId
    ? sql`SELECT id, lock_date::text AS lock_date FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId} FOR UPDATE`
    : sql`SELECT id, lock_date::text AS lock_date FROM companies WHERE tenant_id = ${tenantId} ORDER BY created_at, id LIMIT 1 FOR UPDATE`);
  const row = r.rows[0] as { id: string; lock_date: string | null } | undefined;
  if (!row) throw AppError.notFound('Company not found');
  const lockDate = row.lock_date ? String(row.lock_date).slice(0, 10) : null;
  if (lockDate && dates.some((dt) => !!dt && dt <= lockDate)) {
    throw AppError.conflict(
      `This transaction has inventory items and is dated on or before the closing date (${lockDate}). Inventory in a closed period can't change; date it after the closing date or move the closing date.`,
      'INVENTORY_PERIOD_CLOSED', { closingDate: lockDate },
    );
  }
  const ids = [...new Set(itemIds)].sort();
  if (ids.length > 0) {
    await tx.select({ id: items.id }).from(items).where(and(eq(items.tenantId, tenantId), inArray(items.id, ids))).orderBy(items.id).for('update');
  }
  return { companyId: row.id, lockDate, itemIds: ids };
}

async function movementItemIds(tx: Tx, tenantId: string, txnId: string): Promise<string[]> {
  const rows = await tx.select({ itemId: inventoryMovements.itemId }).from(inventoryMovements)
    .where(and(eq(inventoryMovements.tenantId, tenantId), eq(inventoryMovements.transactionId, txnId)));
  return rows.map((r) => r.itemId);
}

/**
 * Before a new posting writes anything: the line guards, then the costing
 * lock when a part is involved. Null when nothing moves stock.
 */
export async function prepareNew(tx: Tx, tenantId: string, companyId: string | null | undefined, txnType: string, txnDate: string, lines: readonly InputLine[]): Promise<CostingLock | null> {
  const parts = await partsOf(tx, tenantId, lines.map((l) => l.itemId));
  await assertLines(tx, tenantId, txnType, lines, parts);
  if (parts.size === 0) return null;
  return lock(tx, tenantId, companyId, [...parts.keys()], [txnDate]);
}

/** Before an edit writes anything: the guards on the new lines, then the lock over old and new parts. */
export async function prepareEdit(tx: Tx, tenantId: string, companyId: string | null | undefined, txnId: string, txnType: string,
  oldDate: string, newDate: string, lines: readonly InputLine[]): Promise<CostingLock | null> {
  const parts = await partsOf(tx, tenantId, lines.map((l) => l.itemId));
  await assertLines(tx, tenantId, txnType, lines, parts);
  const old = await movementItemIds(tx, tenantId, txnId);
  if (parts.size === 0 && old.length === 0) return null;
  // The old date counts only when the document holds stock today.
  return lock(tx, tenantId, companyId, [...parts.keys(), ...old], [newDate, old.length > 0 ? oldDate : null]);
}

/** Before a void or delete writes anything: the lock over the document's parts. */
export async function prepareExisting(tx: Tx, tenantId: string, companyId: string | null | undefined, txnId: string, txnDate: string): Promise<CostingLock | null> {
  const old = await movementItemIds(tx, tenantId, txnId);
  if (old.length === 0) return null;
  return lock(tx, tenantId, companyId, old, [txnDate]);
}

type MovementRow = typeof inventoryMovements.$inferSelect;

interface Spec { itemId: string; kind: MovementKind; quantity: Dec; valueMode: 'given' | 'derived'; given: Dec | null; counterAccountId: string | null; tagId: string | null }

/** The document's movements as its current lines say (one per part, lines aggregated, S4). */
function specsFor(txnType: string, lines: Array<{ itemId: string; accountId: string; quantity: string | null; debit: string; credit: string; tagId: string | null }>, parts: Map<string, PartRow>): Map<string, Spec> {
  const out = new Map<string, Spec>();
  for (const l of lines) {
    const part = parts.get(l.itemId);
    if (!part) continue;
    let s = out.get(l.itemId);
    if (!s) {
      s = { itemId: l.itemId, kind: 'receipt', quantity: new Decimal(0), valueMode: 'derived', given: null, counterAccountId: null, tagId: l.tagId };
      out.set(l.itemId, s);
    }
    const qty = d(l.quantity);
    const amount = d(l.debit).minus(d(l.credit));
    if (RECEIPT_TYPES.has(txnType)) {
      s.kind = 'receipt'; s.valueMode = 'given'; s.quantity = s.quantity.plus(qty); s.given = (s.given ?? new Decimal(0)).plus(amount);
    } else if (VENDOR_RETURN_TYPES.has(txnType)) {
      s.kind = 'vendor_return'; s.valueMode = 'given'; s.quantity = s.quantity.minus(qty); s.given = (s.given ?? new Decimal(0)).plus(amount);
    } else if (SALE_TYPES.has(txnType)) {
      s.kind = 'sale'; s.quantity = s.quantity.minus(qty);
    } else if (ADJUST_TYPES.has(txnType)) {
      s.quantity = s.quantity.plus(qty);
      if (l.accountId === part.assetAccountId) {
        s.valueMode = 'given'; s.given = (s.given ?? new Decimal(0)).plus(amount);
      } else {
        s.counterAccountId = s.counterAccountId ?? l.accountId;
      }
    }
  }
  for (const s of out.values()) {
    if (ADJUST_TYPES.has(txnType)) s.kind = s.quantity.isZero() ? 'adjust_value' : 'adjust_qty';
  }
  return out;
}

const pos = (m: { movementDate: string; txnCreatedAt: Date; transactionId: string }) =>
  [m.movementDate, m.txnCreatedAt.getTime(), m.transactionId] as const;
function cmpPos(a: ReturnType<typeof pos>, b: ReturnType<typeof pos>): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

export interface ApplyOptions {
  lock: CostingLock;
  userId?: string;
}

/**
 * After the core function wrote the document's own lines (and, for a void
 * or delete, its status and reversal lines): stores the document's
 * movements, walks every affected item and rewrites derived lines. Returns
 * the NEGATIVE_STOCK warnings.
 */
export async function apply(tx: Tx, tenantId: string, txnId: string, opts: ApplyOptions): Promise<InventoryWarning[]> {
  const [txn] = await tx.select({
    id: transactions.id, txnType: transactions.txnType, txnDate: transactions.txnDate, status: transactions.status,
    createdAt: transactions.createdAt, companyId: transactions.companyId,
  }).from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId))).limit(1);
  if (!txn) throw AppError.internal('Costing: transaction not found');
  const companyId = txn.companyId ?? opts.lock.companyId;

  const docLines = txn.status === 'posted' && STOCK_TYPES.has(txn.txnType)
    ? await tx.select({
      id: journalLines.id, itemId: journalLines.itemId, accountId: journalLines.accountId, quantity: journalLines.quantity,
      debit: journalLines.debit, credit: journalLines.credit, tagId: journalLines.tagId, lineRole: journalLines.lineRole,
    }).from(journalLines).where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)))
    : [];
  const itemLines = docLines.filter((l): l is typeof l & { itemId: string } => !!l.itemId && !isDerivedRole(l.lineRole));
  const parts = await partsOf(tx, tenantId, [...itemLines.map((l) => l.itemId), ...opts.lock.itemIds]);
  const specs = specsFor(txn.txnType, itemLines, parts);

  const existing = await tx.select().from(inventoryMovements)
    .where(and(eq(inventoryMovements.tenantId, tenantId), eq(inventoryMovements.transactionId, txnId)));
  const byItem = new Map(existing.map((m) => [m.itemId, m]));
  const itemIds = [...new Set([...specs.keys(), ...byItem.keys()])].sort();

  const warnings: InventoryWarning[] = [];
  const deltas = new Map<string, Dec>();
  const changedDocs = new Map<string, { itemId: string; before: string; after: string }[]>();
  // Movements whose derived lines must be reconciled, with their row as written.
  const reconcile = new Map<string, MovementRow>();

  for (const itemId of itemIds) {
    const part = parts.get(itemId);
    const spec = specs.get(itemId);
    const old = byItem.get(itemId);
    const oldLive = old && !old.voided ? old : undefined;
    const createdAt = txn.createdAt ?? new Date();
    let current: MovementRow | undefined;
    let startPos: ReturnType<typeof pos> | null = oldLive ? pos(oldLive) : null;

    if (spec && part) {
      const fields = {
        movementDate: txn.txnDate, kind: spec.kind, quantity: spec.quantity.toFixed(4), valueMode: spec.valueMode,
        value: spec.valueMode === 'given' ? (spec.given ?? new Decimal(0)).toFixed(4) : (oldLive?.valueMode === 'derived' ? oldLive.value : '0'),
      };
      const unchanged = !!oldLive && oldLive.movementDate === fields.movementDate && oldLive.kind === fields.kind
        && d(oldLive.quantity).equals(spec.quantity) && oldLive.valueMode === fields.valueMode
        && (spec.valueMode === 'derived' || d(oldLive.value).equals(spec.given ?? 0));
      if (old) {
        [current] = await tx.update(inventoryMovements).set({
          ...fields,
          // The item's purchase cost when the line was posted or last edited (Q-P24d); kept when nothing moved.
          fallbackCost: unchanged ? old.fallbackCost : (part.purchaseCost ?? null),
          voided: false, updatedAt: new Date(),
        }).where(eq(inventoryMovements.id, old.id)).returning();
      } else {
        [current] = await tx.insert(inventoryMovements).values({
          tenantId, companyId, itemId, transactionId: txnId, txnCreatedAt: createdAt, ...fields, fallbackCost: part.purchaseCost ?? null,
        }).returning();
      }
      await tx.update(journalLines).set({ inventoryMovementId: current!.id })
        .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId), eq(journalLines.itemId, itemId),
          eq(journalLines.isVoidReversal, false)));
      if (unchanged) {
        // S4: nothing moved for this item; its derived lines come back from the stored row.
        reconcile.set(current!.id, current!);
        continue;
      }
      const newPos = pos(current!);
      startPos = startPos && cmpPos(startPos, newPos) < 0 ? startPos : newPos;
    } else if (old) {
      if (txn.status === 'posted') {
        // An edit took the item off the document: the movement goes.
        await tx.delete(inventoryMovements).where(eq(inventoryMovements.id, old.id));
      } else if (!old.voided) {
        // A void or delete: the row stays, voided (I7); its derived lines stay mirrored by the reversal.
        await tx.update(inventoryMovements).set({ voided: true, updatedAt: new Date() }).where(eq(inventoryMovements.id, old.id));
      }
      if (!oldLive) continue;
    }
    if (!startPos) continue;
    const res = await walkItem(tx, tenantId, companyId, itemId, startPos, txnId);
    if (res.warning) warnings.push(res.warning);
    for (const m of res.changed) {
      reconcile.set(m.row.id, m.row);
      if (m.row.transactionId !== txnId) {
        const list = changedDocs.get(m.row.transactionId) ?? [];
        list.push({ itemId, before: m.before, after: m.after });
        changedDocs.set(m.row.transactionId, list);
      }
    }
    if (current && !reconcile.has(current.id)) {
      const [fresh] = await tx.select().from(inventoryMovements).where(eq(inventoryMovements.id, current.id));
      if (fresh) reconcile.set(fresh.id, fresh);
    }
  }

  // Derived lines of every movement whose figures changed (and the trigger's).
  const touched = new Set<string>([txnId]);
  for (const m of reconcile.values()) {
    touched.add(m.transactionId);
    await reconcileLines(tx, tenantId, m, parts, deltas);
  }
  // One balance delta per account, in account-id order (B5).
  const { applyAccountDeltas } = await import('./ledger.service.js');
  await applyAccountDeltas(tx, tenantId, deltas);

  // One compact audit row per other document whose derived lines the walk changed (S5).
  for (const [docId, changes] of changedDocs) {
    await auditLog(tenantId, 'update', 'transaction', docId, { inventoryCost: changes.map((c) => ({ itemId: c.itemId, cents: c.before })) },
      { inventoryCost: changes.map((c) => ({ itemId: c.itemId, cents: c.after })), costingTrigger: txnId }, opts.userId, tx);
  }
  await backstop(tx, tenantId, [...touched]);
  return warnings;
}

interface Changed { row: MovementRow; before: string; after: string }

const cents = (m: { value: string; correction: string; residual: string }) =>
  [m.value, m.correction, m.residual].map((v) => d(v).times(100).toFixed(0)).join('/');

/**
 * Re-walks one item from `start` (P24 §2.2): seeded from the stored row just
 * before it; every row's figures and running figures rewritten in batched
 * statements (S3, S13). Returns the rows whose figures changed (or that
 * belong to the trigger) and the NEGATIVE_STOCK warning. The start is always
 * after the closing date (lock() refuses earlier documents).
 */
async function walkItem(tx: Tx, tenantId: string, companyId: string, itemId: string, start: ReturnType<typeof pos>,
  triggerId: string): Promise<{ changed: Changed[]; warning: InventoryWarning | null }> {
  const [sDate, sCreated, sTxn] = start;
  const startCreated = new Date(sCreated).toISOString();
  const key = sql`(movement_date, txn_created_at, transaction_id)`;
  const at = sql`(${sDate}::date, ${startCreated}::timestamptz, ${sTxn}::uuid)`;
  const seedRows = await tx.execute(sql`
    SELECT running_qty::text AS q, running_value::text AS v, last_cost::text AS l
    FROM inventory_movements
    WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND item_id = ${itemId} AND voided = false AND ${key} < ${at}
    ORDER BY movement_date DESC, txn_created_at DESC, transaction_id DESC LIMIT 1`);
  const seedRow = seedRows.rows[0] as { q: string; v: string; l: string } | undefined;
  const seed: WalkState = seedRow ? { q: d(seedRow.q), v: d(seedRow.v), l: d(seedRow.l) } : { ...ZERO_STATE };
  const rows = await tx.select().from(inventoryMovements)
    .where(and(eq(inventoryMovements.tenantId, tenantId), eq(inventoryMovements.companyId, companyId), eq(inventoryMovements.itemId, itemId),
      eq(inventoryMovements.voided, false), sql`${key} >= ${at}`))
    .orderBy(inventoryMovements.movementDate, inventoryMovements.txnCreatedAt, inventoryMovements.transactionId);
  const walkRows: WalkRow[] = rows.map((m) => ({
    id: m.id, date: m.movementDate, kind: m.kind, quantity: d(m.quantity), valueMode: m.valueMode,
    given: m.valueMode === 'given' ? d(m.value) : null,
    fallbackCost: m.fallbackCost === null ? null : d(m.fallbackCost),
  }));
  const result = walk(seed, walkRows);
  const changed: Changed[] = [];
  const values: ReturnType<typeof sql>[] = [];
  rows.forEach((m, i) => {
    const r = result.rows[i]!;
    const f = r.fig;
    const a = r.after;
    if (a.q.abs().greaterThanOrEqualTo(QTY_LIMIT) || a.v.abs().greaterThanOrEqualTo(MONEY_LIMIT)) {
      throw AppError.badRequest('The quantity on hand or the inventory value would be too large', 'VALIDATION_ERROR', { itemId });
    }
    const next = { value: f.value.toFixed(4), correction: f.correction.toFixed(4), residual: f.residual.toFixed(4) };
    const differs = !d(m.value).equals(f.value) || !d(m.correction).equals(f.correction) || !d(m.residual).equals(f.residual);
    if (differs || m.transactionId === triggerId) {
      changed.push({ row: { ...m, ...next }, before: cents(m), after: cents(next) });
    }
    values.push(sql`(${m.id}::uuid, ${next.value}::numeric, ${next.correction}::numeric, ${next.residual}::numeric, ${a.q.toFixed(4)}::numeric,
      ${a.v.toFixed(4)}::numeric, ${a.l.toFixed(6)}::numeric)`);
  });
  // Batched: one UPDATE ... FROM (VALUES ...) per 500 rows (S13).
  for (let i = 0; i < values.length; i += 500) {
    await tx.execute(sql`
      UPDATE inventory_movements m SET value = v.value, correction = v.correction, residual = v.residual, running_qty = v.q,
        running_value = v.v, last_cost = v.l, updated_at = now()
      FROM (VALUES ${sql.join(values.slice(i, i + 500), sql`, `)}) AS v(id, value, correction, residual, q, v, l)
      WHERE m.id = v.id`);
  }
  const neg = result.negative;
  const warning: InventoryWarning | null = neg
    ? { code: 'NEGATIVE_STOCK', itemId, date: neg.date, onHand: neg.onHand.toFixed(4) }
    : null;
  return { changed, warning };
}

interface LineSpec { role: DerivedLineRole; accountId: string; debit: string; credit: string }

/** Desired derived lines of a movement (signs: asset effect; the counter line mirrors it). */
function desiredLines(m: MovementRow, part: PartRow, counterAccountId: string, existingCounter: Map<string, string>): LineSpec[] {
  const out: LineSpec[] = [];
  const asset = part.assetAccountId!;
  const pair = (role: DerivedLineRole, counterRole: DerivedLineRole, effect: Dec, counter: string) => {
    if (effect.isZero()) return;
    const amt = effect.abs().toFixed(4);
    const assetDebit = effect.greaterThan(0);
    out.push({ role, accountId: asset, debit: assetDebit ? amt : '0', credit: assetDebit ? '0' : amt });
    // A stored derived line keeps its account (N7): a COGS account change applies to new lines only.
    const acct = existingCounter.get(counterRole) ?? counter;
    out.push({ role: counterRole, accountId: acct, debit: assetDebit ? '0' : amt, credit: assetDebit ? amt : '0' });
  };
  const cogs = part.cogsAccountId!;
  if (m.valueMode === 'derived') pair('inventory_relief', 'cogs', d(m.value), counterAccountId || cogs);
  pair('cost_correction', 'cost_correction', d(m.correction), cogs);
  pair('cost_residual', 'cost_residual', d(m.residual), cogs);
  return out;
}

async function reconcileLines(tx: Tx, tenantId: string, m: MovementRow, parts: Map<string, PartRow>, deltas: Map<string, Dec>) {
  const [doc] = await tx.select({ status: transactions.status, companyId: transactions.companyId, txnType: transactions.txnType })
    .from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, m.transactionId))).limit(1);
  if (!doc || doc.status !== 'posted' || m.voided) return;
  let part = parts.get(m.itemId);
  if (!part) {
    part = (await partsOf(tx, tenantId, [m.itemId])).get(m.itemId);
    if (!part) throw AppError.internal('Costing: movement of an item that is not an inventory part');
    parts.set(m.itemId, part);
  }
  const all = await tx.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, m.transactionId), eq(journalLines.isVoidReversal, false)));
  const existing = all.filter((l) => isDerivedRole(l.lineRole) && l.inventoryMovementId === m.id);
  const itemLine = all.find((l) => l.itemId === m.itemId && !isDerivedRole(l.lineRole));
  // An adjustment's quantity-only line names the adjustment account; everything else counters on the item's COGS account.
  const counter = ADJUST_TYPES.has(doc.txnType) && itemLine && itemLine.accountId !== part.assetAccountId ? itemLine.accountId : part.cogsAccountId!;
  const existingCounter = new Map<string, string>();
  for (const l of existing) if (l.accountId !== part.assetAccountId) existingCounter.set(l.lineRole!, l.accountId);
  const want = desiredLines(m, part, counter, existingCounter);
  const key = (l: { role?: string | null; lineRole?: string | null; accountId: string; debit: string; credit: string }) =>
    `${l.role ?? l.lineRole}|${l.accountId}|${d(l.debit).toFixed(4)}|${d(l.credit).toFixed(4)}`;
  const have = existing.map((l) => key({ ...l, role: l.lineRole })).sort().join(';');
  if (have === want.map((l) => key(l)).sort().join(';')) return;
  const add = (accountId: string, v: Dec) => deltas.set(accountId, (deltas.get(accountId) ?? new Decimal(0)).plus(v));
  if (existing.length > 0) {
    await tx.delete(journalLines).where(and(eq(journalLines.tenantId, tenantId), inArray(journalLines.id, existing.map((l) => l.id))));
    for (const l of existing) add(l.accountId, d(l.credit).minus(d(l.debit)));
  }
  if (want.length > 0) {
    const maxOrder = all.reduce((mx, l) => Math.max(mx, l.lineOrder ?? 0), 0);
    await tx.insert(journalLines).values(want.map((l, i) => ({
      tenantId, companyId: doc.companyId, transactionId: m.transactionId, accountId: l.accountId, debit: l.debit, credit: l.credit,
      lineRole: l.role, inventoryMovementId: m.id, tagId: itemLine?.tagId ?? null, lineOrder: maxOrder + 1 + i,
    })));
    for (const l of want) add(l.accountId, d(l.debit).minus(d(l.credit)));
  }
}

/**
 * B4 backstop before commit: for every touched posted document with
 * movements, the lines on inventory asset accounts add up to its movements'
 * written figures. Anything else is a bug: 500, everything rolls back.
 */
async function backstop(tx: Tx, tenantId: string, txnIds: string[]) {
  if (txnIds.length === 0) return;
  const r = await tx.execute(sql`
    WITH mv AS (
      SELECT m.transaction_id, SUM(m.value + m.correction + m.residual) AS v
      FROM inventory_movements m
      WHERE m.tenant_id = ${tenantId} AND m.voided = false AND m.transaction_id IN (${sql.join(txnIds.map((i) => sql`${i}::uuid`), sql`, `)})
      GROUP BY m.transaction_id
    ), gl AS (
      SELECT jl.transaction_id, SUM(jl.debit - jl.credit) AS v
      FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
      WHERE jl.tenant_id = ${tenantId} AND jl.is_void_reversal = false AND jl.transaction_id IN (${sql.join(txnIds.map((i) => sql`${i}::uuid`), sql`, `)})
        AND (a.system_tag = ${INVENTORY_ASSET_TAG} OR EXISTS (
          SELECT 1 FROM items i WHERE i.tenant_id = a.tenant_id AND i.item_type = 'inventory_part' AND i.asset_account_id = a.id))
      GROUP BY jl.transaction_id
    )
    SELECT t.id FROM transactions t
    LEFT JOIN mv ON mv.transaction_id = t.id LEFT JOIN gl ON gl.transaction_id = t.id
    WHERE t.tenant_id = ${tenantId} AND t.id IN (${sql.join(txnIds.map((i) => sql`${i}::uuid`), sql`, `)}) AND t.status = 'posted'
      AND mv.transaction_id IS NOT NULL AND COALESCE(mv.v, 0) <> COALESCE(gl.v, 0)`);
  if (r.rows.length > 0) throw AppError.internal('Costing: inventory lines and stock movements disagree');
}

/** The lines of a document as a reader returns them (B3): derived lines out of `lines`, into `inventoryLines`. */
export function splitDerived<L extends { lineRole?: string | null; accountId: string; debit: string | null; credit: string | null; inventoryMovementId?: string | null }>(lines: L[]) {
  const kept: L[] = [];
  const inventoryLines: Array<{ role: string; accountId: string; amount: string; movementId: string | null }> = [];
  for (const l of lines) {
    if (isDerivedRole(l.lineRole)) {
      inventoryLines.push({ role: l.lineRole!, accountId: l.accountId, amount: d(l.debit).minus(d(l.credit)).toFixed(2), movementId: l.inventoryMovementId ?? null });
    } else kept.push(l);
  }
  return { lines: kept, inventoryLines };
}


/**
 * Whether a bulk account move would touch inventory (Q-P24q): the document
 * has stock movements, or one of the accounts is an inventory asset account.
 */
export async function touchesInventory(tx: Tx, tenantId: string, txnId: string, accountIds: ReadonlyArray<string | undefined>): Promise<boolean> {
  if ((await movementItemIds(tx, tenantId, txnId)).length > 0) return true;
  return (await inventoryAssetAccounts(tx, tenantId, accountIds.filter((a): a is string => !!a))).size > 0;
}
