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
 * Documents that move stock: bills (billReceived true or false), checks
 * and card charges (txn_type expense) as receipts at their line amount;
 * vendor credits as vendor returns at their line amount; invoices and
 * sales receipts / cash sales as sales at cost; credit memos as customer
 * returns, at the original sale's cost when the line names the sale
 * (returnOf, Q-P24e) and at the current average otherwise; inventory
 * adjustments. Part lines on any other document type are 400
 * INVENTORY_DOCUMENT_UNSUPPORTED.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../db/index.js';
import { inventoryMovements, items, journalLines, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import {
  Decimal, walk, ZERO_STATE, type Dec, type MovementKind, type SaleLink, type WalkRow, type WalkState,
} from '../utils/inventory-walk.js';
import { INVENTORY_ASSET_TAG } from './inventory.service.js';
import { noteInventoryWarnings } from './inventory-warnings-context.js';

/** Line roles only the costing walk writes (U-157). */
export const DERIVED_LINE_ROLES = ['cogs', 'inventory_relief', 'cost_correction', 'cost_residual'] as const;
export type DerivedLineRole = typeof DERIVED_LINE_ROLES[number];
export function isDerivedRole(role: string | null | undefined): role is DerivedLineRole {
  return !!role && (DERIVED_LINE_ROLES as readonly string[]).includes(role);
}

// Document types that move stock, and the kind of their movement. Checks
// and card charges are txn_type expense (a check is an expense with a check
// number).
const RECEIPT_TYPES = new Set(['bill', 'expense']);
const VENDOR_RETURN_TYPES = new Set(['vendor_credit']);
const SALE_TYPES = new Set(['invoice', 'cash_sale']);
const CUSTOMER_RETURN_TYPES = new Set(['credit_memo']);
const ADJUST_TYPES = new Set(['inventory_adjustment']);
const STOCK_TYPES = new Set([...RECEIPT_TYPES, ...VENDOR_RETURN_TYPES, ...SALE_TYPES, ...CUSTOMER_RETURN_TYPES, ...ADJUST_TYPES]);
/** Document types that move inventory parts (for callers outside the core). */
export const INVENTORY_DOCUMENT_TYPES: ReadonlySet<string> = STOCK_TYPES;
// Types whose lines may sit on an inventory asset account without an item.
const DIRECT_OK_TYPES = new Set(['journal_entry', 'aje']);

const QTY_LIMIT = new Decimal('1e8');
const MONEY_LIMIT = new Decimal('1e15');

interface InputLine {
  accountId: string; debit?: string | null; credit?: string | null; itemId?: string | null; quantity?: string | null; lineRole?: string | null;
  /** A credit-memo part line returning units of a sale (Q-P24e, Q-P24u). */
  returnOf?: { transactionId: string } | null;
}

interface PartRow { id: string; assetAccountId: string | null; cogsAccountId: string | null; purchaseCost: string | null }

/**
 * A costing lock held by the caller's transaction. `links`: the sale each
 * linked credit-memo line returns, by line index (= journal_lines.line_order).
 */
export interface CostingLock { companyId: string; lockDate: string | null; itemIds: string[]; links: Map<number, string> }

/** NEGATIVE_STOCK (U-158): the first row per item whose running quantity newly went below 0. */
export interface InventoryWarning { code: 'NEGATIVE_STOCK'; itemId: string; date: string; onHand: string }

const d = (v: unknown) => new Decimal(v === null || v === undefined || v === '' ? '0' : String(v));

/**
 * A line's quantity in the item's base unit (P24 §2.1). Every costing read of
 * a quantity goes through here; until units of measure land (U-161, E5) it
 * is the line quantity.
 */
export function baseQuantity(line: { quantity?: string | null }): Dec {
  return d(line.quantity);
}

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

async function partsOf(tx: DbOrTx, tenantId: string, itemIds: readonly (string | null | undefined)[]): Promise<Map<string, PartRow>> {
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
    if (l.returnOf && (!CUSTOMER_RETURN_TYPES.has(txnType) || !l.itemId || !parts.has(l.itemId))) {
      throw AppError.badRequest(`Line ${i + 1}: returnOf goes on a credit memo line of an inventory item only`, 'VALIDATION_ERROR', { lineIndex: i });
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
    if (!ADJUST_TYPES.has(txnType) && (!hasQty || !baseQuantity(l).greaterThan(0))) {
      throw AppError.badRequest(`Line ${i + 1}: an inventory item line needs a quantity above 0`, 'VALIDATION_ERROR', { lineIndex: i });
    }
    if ((RECEIPT_TYPES.has(txnType) || VENDOR_RETURN_TYPES.has(txnType)) && l.accountId !== part.assetAccountId) {
      throw AppError.badRequest(`Line ${i + 1}: an inventory item line posts to the item's inventory asset account`, 'VALIDATION_ERROR',
        { lineIndex: i, expectedAccountId: part.assetAccountId });
    }
    if ((SALE_TYPES.has(txnType) || CUSTOMER_RETURN_TYPES.has(txnType)) && assetAccounts.has(l.accountId)) {
      throw AppError.badRequest(`Line ${i + 1}: a sale or return of an inventory item posts to an income account`, 'INVENTORY_ACCOUNT_DIRECT', { lineIndex: i });
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
  return { companyId: row.id, lockDate, itemIds: ids, links: new Map() };
}

async function movementItemIds(tx: Tx, tenantId: string, txnId: string): Promise<string[]> {
  const rows = await tx.select({ itemId: inventoryMovements.itemId }).from(inventoryMovements)
    .where(and(eq(inventoryMovements.tenantId, tenantId), eq(inventoryMovements.transactionId, txnId)));
  return rows.map((r) => r.itemId);
}

/** The linked lines of a posting: line index -> the sale it returns. */
function linksOf(lines: readonly InputLine[]): Map<number, string> {
  const out = new Map<number, string>();
  lines.forEach((l, i) => { if (l.returnOf?.transactionId) out.set(i, l.returnOf.transactionId); });
  return out;
}

/**
 * Linked returns (Q-P24e), under the item locks: each sale a credit-memo
 * line names is a posted invoice or sales receipt of this company with a
 * line of that item; the memo is dated on or after it (400
 * RETURN_BEFORE_SALE) and every linked return of the sale, this one
 * included, takes back at most what it sold (400 RETURN_EXCEEDS_SALE).
 */
async function assertReturns(tx: Tx, tenantId: string, held: CostingLock, txnId: string | null, txnDate: string, lines: readonly InputLine[]) {
  if (held.links.size === 0) return;
  const want = new Map<string, { saleId: string; itemId: string; qty: Dec; lineIndex: number }>();
  for (const [i, saleId] of held.links) {
    const l = lines[i]!;
    const k = `${saleId}|${l.itemId}`;
    const w = want.get(k) ?? { saleId, itemId: l.itemId!, qty: new Decimal(0), lineIndex: i };
    w.qty = w.qty.plus(baseQuantity(l));
    want.set(k, w);
  }
  for (const w of want.values()) {
    const [sale] = await tx.select({ id: transactions.id, txnType: transactions.txnType, status: transactions.status, txnDate: transactions.txnDate,
      companyId: transactions.companyId })
      .from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, w.saleId))).limit(1);
    const [mv] = sale ? await tx.select().from(inventoryMovements).where(and(eq(inventoryMovements.tenantId, tenantId),
      eq(inventoryMovements.transactionId, w.saleId), eq(inventoryMovements.itemId, w.itemId), sql`${inventoryMovements.sourceTransactionId} IS NULL`,
      eq(inventoryMovements.voided, false))).limit(1) : [];
    if (!sale || !SALE_TYPES.has(sale.txnType) || sale.status !== 'posted' || (sale.companyId && sale.companyId !== held.companyId) || !mv) {
      throw AppError.badRequest(`Line ${w.lineIndex + 1}: returnOf must name a posted invoice or sales receipt of this company that sold this item`,
        'VALIDATION_ERROR', { lineIndex: w.lineIndex, transactionId: w.saleId });
    }
    if (txnDate < sale.txnDate) {
      throw AppError.badRequest(`Line ${w.lineIndex + 1}: a return can't be dated before its sale (${sale.txnDate})`, 'RETURN_BEFORE_SALE',
        { lineIndex: w.lineIndex, transactionId: w.saleId, saleDate: sale.txnDate });
    }
    const sold = d(mv.quantity).negated();
    const r = await tx.execute(sql`
      SELECT COALESCE(SUM(m.quantity), 0)::text AS n FROM inventory_movements m
      WHERE m.tenant_id = ${tenantId} AND m.source_transaction_id = ${w.saleId} AND m.item_id = ${w.itemId} AND m.voided = false
        ${txnId ? sql`AND m.transaction_id <> ${txnId}` : sql``}`);
    const others = d((r.rows[0] as { n: string }).n);
    if (others.plus(w.qty).greaterThan(sold)) {
      throw AppError.badRequest(`Line ${w.lineIndex + 1}: only ${Decimal.max(sold.minus(others), 0).toFixed(4)} of the units this sale sold are left to return`,
        'RETURN_EXCEEDS_SALE', { lineIndex: w.lineIndex, transactionId: w.saleId, sold: sold.toFixed(4), returned: others.toFixed(4) });
    }
  }
}

/**
 * A sale with live linked returns (Q-P24x): can't be voided or deleted
 * (`next` null), lose the item, sell fewer units than were returned, or
 * move after a return (409 SALE_HAS_RETURNS). Read under the item locks.
 */
async function assertSaleReturnsKept(tx: Tx, tenantId: string, txnId: string,
  next: { txnDate: string; soldByItem: Map<string, Dec> } | null) {
  const r = await tx.execute(sql`
    SELECT m.item_id::text AS item_id, SUM(m.quantity)::text AS n, MIN(m.movement_date)::text AS first,
      array_agg(DISTINCT m.transaction_id::text) AS returns
    FROM inventory_movements m
    WHERE m.tenant_id = ${tenantId} AND m.source_transaction_id = ${txnId} AND m.voided = false
    GROUP BY m.item_id`);
  const rows = r.rows as Array<{ item_id: string; n: string; first: string; returns: string[] }>;
  const refuse = (why: string, row: typeof rows[number]) => AppError.conflict(
    `${why} Void the credit memo that returns it, or take the sale off it, first.`, 'SALE_HAS_RETURNS',
    { itemId: row.item_id, returned: d(row.n).toFixed(4), creditMemoIds: row.returns });
  for (const row of rows) {
    if (!next) throw refuse('Units of this sale were returned on a credit memo, so it can not be voided or deleted.', row);
    const sold = next.soldByItem.get(row.item_id);
    if (!sold) throw refuse('Units of this item were returned against this sale, so the item can not come off it.', row);
    if (sold.lessThan(d(row.n))) throw refuse(`${d(row.n).toFixed(4)} units of this item were returned against this sale, so it can not sell fewer.`, row);
    if (next.txnDate > String(row.first).slice(0, 10)) throw refuse('A return of this sale is dated before the new date.', row);
  }
}

/**
 * Before a new posting writes anything: the line guards, then the costing
 * lock when a part is involved, then the linked-return checks. Null when
 * nothing moves stock.
 */
export async function prepareNew(tx: Tx, tenantId: string, companyId: string | null | undefined, txnType: string, txnDate: string, lines: readonly InputLine[]): Promise<CostingLock | null> {
  const parts = await partsOf(tx, tenantId, lines.map((l) => l.itemId));
  await assertLines(tx, tenantId, txnType, lines, parts);
  if (parts.size === 0) return null;
  const held = await lock(tx, tenantId, companyId, [...parts.keys()], [txnDate]);
  held.links = linksOf(lines);
  await assertReturns(tx, tenantId, held, null, txnDate, lines);
  return held;
}

/** Before an edit writes anything: the guards on the new lines, then the lock over old and new parts. */
export async function prepareEdit(tx: Tx, tenantId: string, companyId: string | null | undefined, txnId: string, txnType: string,
  oldDate: string, newDate: string, lines: readonly InputLine[]): Promise<CostingLock | null> {
  const parts = await partsOf(tx, tenantId, lines.map((l) => l.itemId));
  await assertLines(tx, tenantId, txnType, lines, parts);
  const old = await movementItemIds(tx, tenantId, txnId);
  if (parts.size === 0 && old.length === 0) return null;
  // The old date counts only when the document holds stock today.
  const held = await lock(tx, tenantId, companyId, [...parts.keys(), ...old], [newDate, old.length > 0 ? oldDate : null]);
  held.links = linksOf(lines);
  await assertReturns(tx, tenantId, held, txnId, newDate, lines);
  if (SALE_TYPES.has(txnType)) {
    const soldByItem = new Map<string, Dec>();
    for (const l of lines) {
      if (l.itemId && parts.has(l.itemId)) soldByItem.set(l.itemId, (soldByItem.get(l.itemId) ?? new Decimal(0)).plus(baseQuantity(l)));
    }
    await assertSaleReturnsKept(tx, tenantId, txnId, { txnDate: newDate, soldByItem });
  }
  return held;
}

/** Before a void or delete writes anything: the lock over the document's parts; a sale with linked returns is 409 SALE_HAS_RETURNS. */
export async function prepareExisting(tx: Tx, tenantId: string, companyId: string | null | undefined, txnId: string, txnDate: string): Promise<CostingLock | null> {
  const old = await movementItemIds(tx, tenantId, txnId);
  if (old.length === 0) return null;
  const held = await lock(tx, tenantId, companyId, old, [txnDate]);
  await assertSaleReturnsKept(tx, tenantId, txnId, null);
  return held;
}

type MovementRow = typeof inventoryMovements.$inferSelect;

interface Spec {
  itemId: string; sourceId: string | null; kind: MovementKind; quantity: Dec; valueMode: 'given' | 'derived' | 'linked'; given: Dec | null;
  counterAccountId: string | null; tagId: string | null; lineIds: string[];
}

/** A movement's key on its document: the item and, for a linked return, the sale (S4, Q-P24u). */
const mkey = (itemId: string, sourceId: string | null | undefined) => `${itemId}|${sourceId ?? ''}`;

/**
 * The document's movements as its current lines say: one per (part, linked
 * sale), lines aggregated (S4). `links` maps a line's line_order to the sale
 * it returns (credit memos only).
 */
function specsFor(txnType: string, lines: Array<{ id: string; itemId: string; accountId: string; quantity: string | null; debit: string; credit: string; tagId: string | null; lineOrder: number | null }>,
  parts: Map<string, PartRow>, links: ReadonlyMap<number, string>): Map<string, Spec> {
  const out = new Map<string, Spec>();
  for (const l of lines) {
    const part = parts.get(l.itemId);
    if (!part) continue;
    const sourceId = CUSTOMER_RETURN_TYPES.has(txnType) ? links.get(l.lineOrder ?? -1) ?? null : null;
    const k = mkey(l.itemId, sourceId);
    let s = out.get(k);
    if (!s) {
      s = { itemId: l.itemId, sourceId, kind: 'receipt', quantity: new Decimal(0), valueMode: 'derived', given: null, counterAccountId: null, tagId: l.tagId, lineIds: [] };
      out.set(k, s);
    }
    s.lineIds.push(l.id);
    const qty = baseQuantity(l);
    const amount = d(l.debit).minus(d(l.credit));
    if (RECEIPT_TYPES.has(txnType)) {
      s.kind = 'receipt'; s.valueMode = 'given'; s.quantity = s.quantity.plus(qty); s.given = (s.given ?? new Decimal(0)).plus(amount);
    } else if (VENDOR_RETURN_TYPES.has(txnType)) {
      s.kind = 'vendor_return'; s.valueMode = 'given'; s.quantity = s.quantity.minus(qty); s.given = (s.given ?? new Decimal(0)).plus(amount);
    } else if (SALE_TYPES.has(txnType)) {
      s.kind = 'sale'; s.quantity = s.quantity.minus(qty);
    } else if (CUSTOMER_RETURN_TYPES.has(txnType)) {
      s.kind = 'customer_return'; s.quantity = s.quantity.plus(qty); s.valueMode = sourceId ? 'linked' : 'derived';
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
      debit: journalLines.debit, credit: journalLines.credit, tagId: journalLines.tagId, lineRole: journalLines.lineRole, lineOrder: journalLines.lineOrder,
    }).from(journalLines).where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)))
    : [];
  const itemLines = docLines.filter((l): l is typeof l & { itemId: string } => !!l.itemId && !isDerivedRole(l.lineRole));
  const parts = await partsOf(tx, tenantId, [...itemLines.map((l) => l.itemId), ...opts.lock.itemIds]);
  const specs = specsFor(txn.txnType, itemLines, parts, opts.lock.links);

  const existing = await tx.select().from(inventoryMovements)
    .where(and(eq(inventoryMovements.tenantId, tenantId), eq(inventoryMovements.transactionId, txnId)));
  const byKey = new Map(existing.map((m) => [mkey(m.itemId, m.sourceTransactionId), m]));
  const keys = [...new Set([...specs.keys(), ...byKey.keys()])].sort();

  const warnings: InventoryWarning[] = [];
  const deltas = new Map<string, Dec>();
  const changedDocs = new Map<string, { itemId: string; before: string; after: string }[]>();
  // Movements whose derived lines must be reconciled, with their row as written.
  const reconcile = new Map<string, MovementRow>();
  // Per item: where its walk starts, and the document's own movements to reconcile after it.
  const starts = new Map<string, ReturnType<typeof pos>>();
  const own = new Map<string, string[]>();
  const createdAt = txn.createdAt ?? new Date();

  // Phase 1: the document's movements as its lines now say (one per item and linked sale).
  for (const k of keys) {
    const spec = specs.get(k);
    const old = byKey.get(k);
    const itemId = spec?.itemId ?? old!.itemId;
    const part = parts.get(itemId);
    const oldLive = old && !old.voided ? old : undefined;
    let startPos: ReturnType<typeof pos> | null = oldLive ? pos(oldLive) : null;

    if (spec && part) {
      const fields = {
        movementDate: txn.txnDate, kind: spec.kind, quantity: spec.quantity.toFixed(4), valueMode: spec.valueMode, sourceTransactionId: spec.sourceId,
        // A derived or linked value is the walk's; it keeps the stored one until the walk rewrites it.
        value: spec.valueMode === 'given' ? (spec.given ?? new Decimal(0)).toFixed(4) : (oldLive?.valueMode === spec.valueMode ? oldLive.value : '0'),
      };
      const unchanged = !!oldLive && oldLive.movementDate === fields.movementDate && oldLive.kind === fields.kind
        && d(oldLive.quantity).equals(spec.quantity) && oldLive.valueMode === fields.valueMode
        && (spec.valueMode !== 'given' || d(oldLive.value).equals(spec.given ?? 0));
      let current: MovementRow | undefined;
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
        .where(and(eq(journalLines.tenantId, tenantId), inArray(journalLines.id, spec.lineIds)));
      if (unchanged) {
        // S4: nothing moved for this movement; its derived lines come back from the stored row.
        reconcile.set(current!.id, current!);
        continue;
      }
      own.set(itemId, [...(own.get(itemId) ?? []), current!.id]);
      const newPos = pos(current!);
      startPos = startPos && cmpPos(startPos, newPos) < 0 ? startPos : newPos;
    } else if (old) {
      if (txn.status === 'posted') {
        // An edit took the item (or this link) off the document: the movement goes.
        await tx.delete(inventoryMovements).where(eq(inventoryMovements.id, old.id));
      } else if (!old.voided) {
        // A void or delete: the row stays, voided (I7); its derived lines stay mirrored by the reversal.
        await tx.update(inventoryMovements).set({ voided: true, updatedAt: new Date() }).where(eq(inventoryMovements.id, old.id));
      }
      if (!oldLive) continue;
    }
    if (!startPos) continue;
    const prev = starts.get(itemId);
    starts.set(itemId, prev && cmpPos(prev, startPos) < 0 ? prev : startPos);
  }

  // Phase 2: one walk per item from its earliest affected position.
  for (const itemId of [...starts.keys()].sort()) {
    const res = await walkItem(tx, tenantId, companyId, itemId, starts.get(itemId)!, txnId, opts.lock.lockDate);
    if (res.warning) warnings.push(res.warning);
    for (const m of res.changed) {
      reconcile.set(m.row.id, m.row);
      if (m.row.transactionId !== txnId) {
        const list = changedDocs.get(m.row.transactionId) ?? [];
        list.push({ itemId, before: m.before, after: m.after });
        changedDocs.set(m.row.transactionId, list);
      }
    }
    for (const id of own.get(itemId) ?? []) {
      if (reconcile.has(id)) continue;
      const [fresh] = await tx.select().from(inventoryMovements).where(eq(inventoryMovements.id, id));
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
  // NEGATIVE_STOCK on the request's reply (U-158): warnings[] of the route.
  noteInventoryWarnings(warnings);
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
  triggerId: string, lockDate: string | null): Promise<{ changed: Changed[]; warning: InventoryWarning | null }> {
  const [sDate, sCreated, sTxn] = start;
  // I4: no walk starts at or before the closing date (the gate refused those documents).
  if (lockDate && sDate <= lockDate) throw AppError.internal('Costing: a walk would start in a closed period');
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
    id: m.id, transactionId: m.transactionId, date: m.movementDate, kind: m.kind, quantity: d(m.quantity), valueMode: m.valueMode,
    given: m.valueMode === 'given' ? d(m.value) : null, sourceId: m.sourceTransactionId,
    fallbackCost: m.fallbackCost === null ? null : d(m.fallbackCost),
  }));
  // Linked returns (Q-P24e) whose sale sits before the walk start: the sale's
  // stored relief and quantity, and what earlier returns already took back.
  const inWindow = new Set(rows.filter((m) => m.kind === 'sale').map((m) => m.transactionId));
  const outside = [...new Set(rows.filter((m) => m.valueMode === 'linked' && m.sourceTransactionId && !inWindow.has(m.sourceTransactionId))
    .map((m) => m.sourceTransactionId!))];
  const links = new Map<string, SaleLink>();
  for (const saleId of outside) {
    const r = await tx.execute(sql`
      SELECT (SELECT -value FROM inventory_movements WHERE tenant_id = ${tenantId} AND transaction_id = ${saleId} AND item_id = ${itemId}
          AND source_transaction_id IS NULL AND voided = false)::text AS r,
        (SELECT -quantity FROM inventory_movements WHERE tenant_id = ${tenantId} AND transaction_id = ${saleId} AND item_id = ${itemId}
          AND source_transaction_id IS NULL AND voided = false)::text AS s,
        (SELECT COALESCE(SUM(quantity), 0) FROM inventory_movements WHERE tenant_id = ${tenantId} AND source_transaction_id = ${saleId}
          AND item_id = ${itemId} AND voided = false AND ${key} < ${at})::text AS n`);
    const row = r.rows[0] as { r: string | null; s: string | null; n: string };
    if (row.r === null || row.s === null) throw AppError.internal('Costing: a linked return without its sale');
    links.set(saleId, { r: d(row.r), s: d(row.s), n: d(row.n) });
  }
  const result = walk(seed, walkRows, links);
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
  // A sale's relief, a return's value back in (linked or at average), a quantity-only adjustment.
  if (m.valueMode !== 'given') pair('inventory_relief', 'cogs', d(m.value), counterAccountId || cogs);
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
  const itemLine = all.find((l) => l.inventoryMovementId === m.id && !isDerivedRole(l.lineRole))
    ?? all.find((l) => l.itemId === m.itemId && !isDerivedRole(l.lineRole));
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

/** OpenAPI note for every posting route that takes inventory part lines (inventory-costing-v1). */
export const INVENTORY_ROUTE_NOTE = 'Inventory parts (inventory-costing-v1): a part line needs a quantity; on bills and vendor credits it posts '
  + 'to the part\'s inventory asset account (400 VALIDATION_ERROR otherwise); a line on an inventory asset account without a part is 400 '
  + 'INVENTORY_ACCOUNT_DIRECT outside journal entries; a client-sent lineRole cogs | inventory_relief | cost_correction | cost_residual is 400 '
  + 'VALIDATION_ERROR; parts on a document type that does not move stock yet are 400 INVENTORY_DOCUMENT_UNSUPPORTED; a document with parts '
  + 'dated on or before the closing date (old or new date) is 409 INVENTORY_PERIOD_CLOSED, closingPassword or not; 409 RETRY after a deadlock or '
  + 'lock timeout (nothing saved). Derived costing lines come back as inventoryLines, never in lines; NEGATIVE_STOCK is allowed.';

/**
 * NEGATIVE_STOCK for a preview (U-158): what posting `doc` would warn,
 * computed from the stored stock ledger in memory, with nothing written. The
 * document's movement (quantities only) is placed at its position (an
 * edited document keeps its created_at) and each item's running quantity is
 * replayed from its first affected position.
 */
export async function previewInventoryWarnings(executor: DbOrTx, tenantId: string, companyId: string | null | undefined,
  doc: { txnType: string; txnDate: string; editingId?: string | null; lines: ReadonlyArray<{ itemId?: string | null; quantity?: string | null }> }): Promise<InventoryWarning[]> {
  if (!STOCK_TYPES.has(doc.txnType) || ADJUST_TYPES.has(doc.txnType)) return [];
  const parts = await partsOf(executor, tenantId, doc.lines.map((l) => l.itemId));
  if (parts.size === 0 && !doc.editingId) return [];
  const sign = SALE_TYPES.has(doc.txnType) || VENDOR_RETURN_TYPES.has(doc.txnType) ? -1 : 1;
  const qtyByItem = new Map<string, Dec>();
  for (const l of doc.lines) {
    if (!l.itemId || !parts.has(l.itemId)) continue;
    let q: Dec;
    try { q = baseQuantity(l); } catch { continue; }
    qtyByItem.set(l.itemId, (qtyByItem.get(l.itemId) ?? new Decimal(0)).plus(q.times(sign)));
  }
  const co = companyId ? companyId : ((await executor.execute(sql`SELECT id FROM companies WHERE tenant_id = ${tenantId} ORDER BY created_at, id LIMIT 1`)).rows[0] as { id: string } | undefined)?.id;
  if (!co) return [];
  let createdAt = new Date();
  const oldByItem = new Map<string, { date: string; created: Date }>();
  const selfId = doc.editingId ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  if (doc.editingId) {
    const [t] = await executor.select({ createdAt: transactions.createdAt }).from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, doc.editingId))).limit(1);
    if (t?.createdAt) createdAt = t.createdAt;
    const olds = await executor.select().from(inventoryMovements).where(and(eq(inventoryMovements.tenantId, tenantId),
      eq(inventoryMovements.transactionId, doc.editingId), eq(inventoryMovements.voided, false)));
    for (const m of olds) {
      oldByItem.set(m.itemId, { date: m.movementDate, created: m.txnCreatedAt });
      if (!qtyByItem.has(m.itemId)) qtyByItem.set(m.itemId, new Decimal(0));
    }
  }
  const out: InventoryWarning[] = [];
  for (const [itemId, qty] of [...qtyByItem].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const rows = (await executor.select({ transactionId: inventoryMovements.transactionId, date: inventoryMovements.movementDate,
      created: inventoryMovements.txnCreatedAt, quantity: inventoryMovements.quantity }).from(inventoryMovements)
      .where(and(eq(inventoryMovements.tenantId, tenantId), eq(inventoryMovements.companyId, co), eq(inventoryMovements.itemId, itemId),
        eq(inventoryMovements.voided, false)))
      .orderBy(inventoryMovements.movementDate, inventoryMovements.txnCreatedAt, inventoryMovements.transactionId))
      .filter((r) => r.transactionId !== doc.editingId);
    const mine = { transactionId: selfId, date: doc.txnDate, created: createdAt, quantity: qty.toFixed(4) };
    const before = (r: { date: string; created: Date; transactionId: string }) => cmpPos(pos({ movementDate: r.date, txnCreatedAt: r.created, transactionId: r.transactionId }),
      pos({ movementDate: mine.date, txnCreatedAt: mine.created, transactionId: mine.transactionId })) < 0;
    const at = rows.findIndex((r) => !before(r));
    const merged = [...rows.slice(0, at < 0 ? rows.length : at), mine, ...(at < 0 ? [] : rows.slice(at))];
    const old = oldByItem.get(itemId);
    const start = old ? cmpPos(pos({ movementDate: old.date, txnCreatedAt: old.created, transactionId: selfId }), pos({ movementDate: mine.date, txnCreatedAt: mine.created, transactionId: selfId })) < 0
      ? { date: old.date, created: old.created } : { date: mine.date, created: mine.created } : { date: mine.date, created: mine.created };
    let q = new Decimal(0);
    for (const r of merged) {
      const prior = q;
      q = q.plus(d(r.quantity));
      const inWindow = cmpPos(pos({ movementDate: r.date, txnCreatedAt: r.created, transactionId: r.transactionId }),
        pos({ movementDate: start.date, txnCreatedAt: start.created, transactionId: selfId })) >= 0 || r === mine;
      if (inWindow && prior.greaterThanOrEqualTo(0) && q.lessThan(0)) {
        out.push({ code: 'NEGATIVE_STOCK', itemId, date: r.date, onHand: q.toFixed(4) });
        break;
      }
    }
  }
  return out;
}
