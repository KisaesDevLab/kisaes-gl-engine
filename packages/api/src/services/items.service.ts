// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, ilike, count, asc, desc, sql, isNull, or, type SQL } from 'drizzle-orm';
import type { CreateItemInput, UpdateItemInput, ItemFilters } from '@kis-books/shared';
import { db, type DbOrTx } from '../db/index.js';
import * as salesTaxSvc from './sales-tax.service.js';
import * as inventory from './inventory.service.js';
import * as units from './units.service.js';
import { items, accounts, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import { toCsvRow } from './export.service.js';
import { escapeLike } from '../utils/sql-like.js';
import { assertNotStale } from './ledger.service.js';

export async function list(tenantId: string, filters?: ItemFilters, companyId?: string | null) {
  const conditions = [eq(items.tenantId, tenantId)];
  if (filters?.isActive !== undefined) conditions.push(eq(items.isActive, filters.isActive));
  if (filters?.isTaxable !== undefined) conditions.push(eq(items.isTaxable, filters.isTaxable));
  if (filters?.itemType) conditions.push(eq(items.itemType, filters.itemType));
  if (filters?.search) conditions.push(ilike(items.name, `%${escapeLike(filters.search)}%`));

  // Whitelisted column sort (the list paginates); name + id tiebreak.
  const dir = filters?.sortDir === 'asc' ? asc : desc;
  const orderBy: SQL[] = (() => {
    switch (filters?.sortBy) {
      case 'price': return [sql`CAST(${items.unitPrice} AS DECIMAL) ${filters?.sortDir === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`];
      case 'taxable': return [dir(items.isTaxable)];
      case 'status': return [dir(items.isActive)];
      case 'name': return [dir(items.name)];
      default: return [asc(items.name)];
    }
  })();

  const where = and(...conditions);
  const [data, total] = await Promise.all([
    db.select().from(items).where(where).orderBy(...orderBy, asc(items.name), asc(items.id)).limit(filters?.limit ?? 100).offset(filters?.offset ?? 0),
    db.select({ count: count() }).from(items).where(where),
  ]);
  // Parts carry their read-only stock figures (U-39b); other kinds null.
  return { data: await withFigures(db, tenantId, data, companyId), total: total[0]?.count ?? 0 };
}

export async function getById(tenantId: string, id: string, executor: DbOrTx = db) {
  const [item] = await executor.select().from(items).where(and(eq(items.tenantId, tenantId), eq(items.id, id))).limit(1);
  if (!item) throw AppError.notFound('Item not found');
  return item;
}

/** Items with their read-only stock figures (U-39b) and default prices per unit (U-161, unitPrices; null without a unit set). */
async function withFigures<T extends typeof items.$inferSelect>(executor: DbOrTx, tenantId: string, rows: T[], companyId?: string | null) {
  return units.withUnitPrices(executor, tenantId, await inventory.withStockFigures(executor, tenantId, rows, companyId));
}

/** One item with its read-only stock figures (U-39b, item-types-v1) and unit prices (U-161). */
export async function getWithFigures(tenantId: string, id: string, executor: DbOrTx = db, companyId?: string | null) {
  const [item] = await withFigures(executor, tenantId, [await getById(tenantId, id, executor)], companyId);
  return item!;
}

type KindFields = {
  itemType?: string | null; unitPrice?: string | null; discountPercent?: string | null;
  assetAccountId?: string | null; cogsAccountId?: string | null; reorderPoint?: string | null; reorderQuantity?: string | null;
};

const given = (v: unknown) => v !== undefined && v !== null && v !== '';

/**
 * Item kinds (U-39a, item-kinds-sales-v1): a discount item has a percent
 * off (discountPercent) or an amount off (unitPrice, 0 or more), not both; a
 * subtotal item has neither; other kinds have no discountPercent.
 * Inventory parts (U-39b, item-types-v1) need an asset and a COGS account;
 * only parts take those accounts and the reorder fields; reorderQuantity is
 * above 0.
 */
function assertKindFields(item: KindFields) {
  const type = item.itemType ?? 'service';
  const hasPrice = given(item.unitPrice);
  const hasPercent = given(item.discountPercent);
  const bad = (message: string, field?: string) => AppError.badRequest(message, 'VALIDATION_ERROR', field ? { field } : undefined);
  if (type === 'discount') {
    if (hasPrice && hasPercent) throw bad('A discount item takes a percent or an amount, not both');
    if (hasPrice && Number(item.unitPrice) < 0) throw bad('A discount amount must be 0 or more');
  } else if (type === 'subtotal') {
    if (hasPrice || hasPercent) throw bad('A subtotal item has no price or percent');
  } else if (hasPercent) {
    throw bad('Only a discount item takes a discount percent');
  }
  if (type === 'inventory_part') {
    if (!given(item.assetAccountId)) throw bad('An inventory item needs an inventory asset account', 'assetAccountId');
    if (!given(item.cogsAccountId)) throw bad('An inventory item needs a cost of goods sold account', 'cogsAccountId');
  } else {
    for (const f of ['assetAccountId', 'cogsAccountId', 'reorderPoint', 'reorderQuantity'] as const) {
      if (given(item[f])) throw bad(`Only an inventory item takes ${f}`, f);
    }
  }
  if (given(item.reorderQuantity) && Number(item.reorderQuantity) <= 0) throw bad('The reorder quantity must be above 0', 'reorderQuantity');
}

/**
 * The accounts and vendor an item names (U-39b), on the caller's
 * transaction: each an account of the tenant in the company scope;
 * assetAccountId an active asset account that is not a bank or A/R
 * account (and carries no system tag other than inventory_asset);
 * cogsAccountId an active cost of goods sold account; preferredVendorId a
 * vendor of the company. Else 400 VALIDATION_ERROR with details.field.
 */
async function assertItemRefs(executor: DbOrTx, tenantId: string, companyId: string | null | undefined, input: Record<string, unknown>) {
  const bad = (message: string, field: string) => AppError.badRequest(message, 'VALIDATION_ERROR', { field });
  const scope = companyId ? or(isNull(accounts.companyId), eq(accounts.companyId, companyId)) : undefined;
  const account = async (field: string) => {
    const id = input[field];
    if (!given(id)) return null;
    const [row] = await executor.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id as string), scope)).limit(1);
    if (!row) throw bad(`${field} is not an account of this company`, field);
    return row;
  };
  for (const field of ['incomeAccountId', 'expenseAccountId']) await account(field);
  const asset = await account('assetAccountId');
  if (asset && (asset.accountType !== 'asset' || asset.isActive === false || ['bank', 'accounts_receivable'].includes(asset.detailType ?? '')
    || (asset.systemTag && asset.systemTag !== inventory.INVENTORY_ASSET_TAG))) {
    throw bad('Choose an active other asset account (not a bank or receivables account) for inventory', 'assetAccountId');
  }
  const cogs = await account('cogsAccountId');
  if (cogs && (cogs.accountType !== 'cogs' || cogs.isActive === false)) {
    throw bad('Choose an active cost of goods sold account', 'cogsAccountId');
  }
  const vendorId = input['preferredVendorId'];
  if (given(vendorId)) {
    const [v] = await executor.select({ id: contacts.id, type: contacts.contactType, companyId: contacts.companyId }).from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, vendorId as string))).limit(1);
    if (!v || !['vendor', 'both'].includes(v.type) || (companyId && v.companyId && v.companyId !== companyId)) {
      throw bad('preferredVendorId is not a vendor of this company', 'preferredVendorId');
    }
  }
}

/** Whether any posted transaction has a line with this item (Q-P24r: the kind can't move to or from inventory_part then). */
async function itemHasPostedLines(executor: DbOrTx, tenantId: string, itemId: string): Promise<boolean> {
  const r = await executor.execute(sql`
    SELECT 1 FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND jl.item_id = ${itemId} AND t.status = 'posted' LIMIT 1`);
  return r.rows.length > 0;
}

/** A name another item of the tenant uses: 409. */
async function assertNameFree(executor: DbOrTx, tenantId: string, name: string, exceptId?: string) {
  const [dup] = await executor.select({ id: items.id }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.name, name))).limit(1);
  if (dup && dup.id !== exceptId) throw AppError.conflict('An item with this name already exists');
}

export async function create(tenantId: string, input: CreateItemInput, userId?: string, companyId?: string) {
  assertKindFields(input);

  // The insert, its audit row and an Idempotency-Key (U-18) commit together.
  return await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    // Inside the transaction (U-39b).
    await assertNameFree(tx, tenantId, input.name);
    if (input.itemType === 'inventory_part') await inventory.assertInventoryOn(tx, tenantId, companyId);
    await assertItemRefs(tx, tenantId, companyId, input as unknown as Record<string, unknown>);
    // The item's sales tax code (U-147): an active code of the item's company.
    await salesTaxSvc.assertTaxRefs(tx, tenantId, (input as { companyId?: string | null }).companyId ?? null, { taxCodeId: (input as { taxCodeId?: string | null }).taxCodeId });
    // Units of measure (U-161): an active set of the company; default units of that set.
    await units.assertItemUnits(tx, tenantId, companyId, input);
    const { opening, ...fields } = input;
    if (opening && input.itemType !== 'inventory_part') {
      throw AppError.badRequest('Only an inventory item takes opening stock', 'VALIDATION_ERROR', { field: 'opening' });
    }
    const [item] = await tx.insert(items).values({ tenantId, ...fields }).returning();
    if (!item) throw AppError.internal('Failed to create item');
    await recordIdempotentEntity(tx, 'item', item.id);
    await auditLog(tenantId, 'create', 'item', item.id, null, item, userId, tx);
    // Opening stock (U-159, Q-P24h): an adjustment against Opening Balances in the same transaction;
    // dated on or before the closing date it is 409 INVENTORY_PERIOD_CLOSED and nothing is saved.
    if (opening) {
      const { postOpening } = await import('./inventory-adjustment.service.js');
      await postOpening(tx, tenantId, companyId, item.id, opening, userId);
    }
    return (await withFigures(tx, tenantId, [item], companyId))[0]!;
  });
}

const PART_ONLY_FIELDS = ['assetAccountId', 'cogsAccountId', 'reorderPoint', 'reorderQuantity'] as const;

/**
 * Edits an item (U-39b, item-types-v1): the row is read FOR UPDATE and
 * expectedUpdatedAt checked (409 STALE); the name check runs inside the
 * transaction. Moving the kind to or from inventory_part while any posted
 * line names the item is 409 ITEM_IN_USE (Q-P24r); a new part needs
 * inventory on (400 INVENTORY_OFF). Changing a part's asset account once it
 * has stock movements is 409 ITEM_HAS_INVENTORY. Moving away from
 * inventory_part clears the part-only fields.
 */
export async function update(tenantId: string, id: string, input: UpdateItemInput, userId?: string, companyId?: string) {
  const { expectedUpdatedAt, ...changes } = input;
  return await db.transaction(async (tx) => {
    // U-161: a unit set change first locks the old set's units (a posting naming one finishes first), before the item row.
    const setMoves = changes.unitSetId !== undefined;
    if (setMoves) {
      const [peek] = await tx.select({ setId: items.unitSetId }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.id, id))).limit(1);
      await units.lockForSetChange(tx, tenantId, peek?.setId ?? null);
    }
    const [existing] = await tx.select().from(items).where(and(eq(items.tenantId, tenantId), eq(items.id, id))).for('update').limit(1);
    if (!existing) throw AppError.notFound('Item not found');
    assertNotStale(existing, expectedUpdatedAt, 'This item');
    const set: Record<string, unknown> = { ...changes };
    const nextType = changes.itemType ?? existing.itemType;
    const kindMoves = changes.itemType !== undefined && changes.itemType !== existing.itemType
      && (changes.itemType === 'inventory_part' || existing.itemType === 'inventory_part');
    if (kindMoves && await itemHasPostedLines(tx, tenantId, id)) {
      throw AppError.conflict('This item is on posted transactions, so it can not become or stop being an inventory item. Make a new item instead.', 'ITEM_IN_USE');
    }
    if (kindMoves && nextType !== 'inventory_part') {
      for (const f of PART_ONLY_FIELDS) if (set[f] === undefined) set[f] = null;
    }
    const pick = (k: keyof KindFields) => (set[k] !== undefined ? set[k] : (existing as Record<string, unknown>)[k]) as string | null;
    assertKindFields({
      itemType: nextType,
      unitPrice: pick('unitPrice'),
      discountPercent: pick('discountPercent'),
      assetAccountId: pick('assetAccountId'),
      cogsAccountId: pick('cogsAccountId'),
      reorderPoint: pick('reorderPoint'),
      reorderQuantity: pick('reorderQuantity'),
    });
    if (kindMoves && nextType === 'inventory_part') await inventory.assertInventoryOn(tx, tenantId, companyId ?? existing.companyId);
    if (changes.assetAccountId !== undefined && changes.assetAccountId !== existing.assetAccountId
      && existing.itemType === 'inventory_part' && await inventory.itemHasMovements(tx, tenantId, id)) {
      throw AppError.conflict('This item already has stock on its inventory asset account, so the account can not change.', 'ITEM_HAS_INVENTORY');
    }
    if (changes.name && changes.name !== existing.name) await assertNameFree(tx, tenantId, changes.name, id);
    // Units of measure (U-161, Q-P24w): the set changes only while no line names the item; defaults stay in the set.
    if (setMoves && (changes.unitSetId ?? null) !== (existing.unitSetId ?? null)) {
      await units.assertSetChangeAllowed(tx, tenantId, id);
      if (changes.defaultPurchaseUnitId === undefined) set['defaultPurchaseUnitId'] = null;
      if (changes.defaultSaleUnitId === undefined) set['defaultSaleUnitId'] = null;
    }
    if (setMoves || changes.defaultPurchaseUnitId !== undefined || changes.defaultSaleUnitId !== undefined) {
      const pickU = (k: 'unitSetId' | 'defaultPurchaseUnitId' | 'defaultSaleUnitId') => (set[k] !== undefined ? set[k] : existing[k]) as string | null;
      await units.assertItemUnits(tx, tenantId, companyId ?? existing.companyId, {
        unitSetId: pickU('unitSetId'), defaultPurchaseUnitId: pickU('defaultPurchaseUnitId'), defaultSaleUnitId: pickU('defaultSaleUnitId') });
    }
    const refs: Record<string, unknown> = {};
    for (const f of ['incomeAccountId', 'expenseAccountId', 'assetAccountId', 'cogsAccountId', 'preferredVendorId'] as const) {
      if (set[f] !== undefined && set[f] !== existing[f]) refs[f] = set[f];
    }
    await assertItemRefs(tx, tenantId, companyId ?? existing.companyId, refs);
    const taxCodeId = (changes as { taxCodeId?: string | null }).taxCodeId;
    if (taxCodeId && taxCodeId !== existing.taxCodeId) await salesTaxSvc.assertTaxRefs(tx, tenantId, existing.companyId ?? null, { taxCodeId });
    const [updated] = await tx.update(items).set({ ...set, updatedAt: new Date() })
      .where(and(eq(items.tenantId, tenantId), eq(items.id, id))).returning();
    if (!updated) throw AppError.notFound('Item not found');
    await auditLog(tenantId, 'update', 'item', id, existing, updated, userId, tx);
    return (await withFigures(tx, tenantId, [updated], companyId))[0]!;
  });
}

export async function deactivate(tenantId: string, id: string, userId?: string) {
  return update(tenantId, id, { isActive: false }, userId);
}

export async function importFromCsv(tenantId: string, csvData: Array<{ name: string; description?: string; unitPrice?: string; incomeAccountId: string; isTaxable?: boolean }>) {
  const results = [];
  for (const row of csvData) {
    const [item] = await db.insert(items).values({ tenantId, ...row }).returning();
    if (item) results.push(item);
  }
  return results;
}

export async function exportToCsv(tenantId: string): Promise<string> {
  const data = await db.select().from(items).where(eq(items.tenantId, tenantId)).orderBy(items.name);
  const header = 'Name,Description,Unit Price,Income Account ID,Taxable,Active\n';
  const rows = data.map((i) =>
    toCsvRow([i.name, i.description || '', i.unitPrice || '', i.incomeAccountId, String(i.isTaxable), String(i.isActive)]),
  ).join('\n');
  return header + rows;
}
