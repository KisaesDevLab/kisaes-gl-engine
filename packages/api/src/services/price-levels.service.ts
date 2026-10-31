// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Price levels (U-40, price-levels-v1, Q-P20l): a name and a signed percent
 * (-7.5 = 7.5 % down) applied to an item's price, plus optional fixed prices
 * for chosen items, stored rounded half away from zero to the cent. A client
 * has at most one level (contacts.price_level_id); invoices use it for lines
 * that send no unitPrice (U-129, utils/invoice-compute.ts). An inactive level
 * prices nothing and can't be given to a client. Company scope: a level of
 * another company is 404; rows without a company pass (as items).
 */

import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { CreatePriceLevelInput, UpdatePriceLevelInput } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { priceLevels, priceLevelItems, items, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { roundLevelItemPrice, type PricingLevel } from '../utils/invoice-compute.js';
import * as ledger from './ledger.service.js';

type LevelRow = typeof priceLevels.$inferSelect;

export interface PriceLevelView extends LevelRow {
  itemPrices: Array<{ itemId: string; unitPrice: string }>;
}

function scope(companyId?: string | null) {
  return companyId ? or(eq(priceLevels.companyId, companyId), isNull(priceLevels.companyId)) : undefined;
}

export async function list(tenantId: string, filters: { isActive?: boolean }, companyId?: string) {
  const conditions = [eq(priceLevels.tenantId, tenantId)];
  const s = scope(companyId);
  if (s) conditions.push(s);
  if (filters.isActive !== undefined) conditions.push(eq(priceLevels.isActive, filters.isActive));
  const rows = await db.select().from(priceLevels).where(and(...conditions)).orderBy(asc(priceLevels.name), asc(priceLevels.id));
  const counts = rows.length === 0 ? [] : await db.select({ id: priceLevelItems.priceLevelId, n: sql<number>`count(*)::int` })
    .from(priceLevelItems)
    .where(and(eq(priceLevelItems.tenantId, tenantId), inArray(priceLevelItems.priceLevelId, rows.map((r) => r.id))))
    .groupBy(priceLevelItems.priceLevelId);
  const byId = new Map(counts.map((c) => [c.id, c.n]));
  return { data: rows.map((r) => ({ ...r, itemPriceCount: byId.get(r.id) ?? 0 })) };
}

async function loadRow(executor: DbOrTx, tenantId: string, id: string, companyId?: string | null, lock = false): Promise<LevelRow> {
  const q = executor.select().from(priceLevels).where(and(eq(priceLevels.tenantId, tenantId), eq(priceLevels.id, id)));
  const [row] = lock ? await q.for('update').limit(1) : await q.limit(1);
  if (!row || ledger.inOtherCompany(row, companyId)) throw AppError.notFound('Price level not found');
  return row;
}

async function itemPricesOf(executor: DbOrTx, tenantId: string, levelId: string) {
  const rows = await executor.select({ itemId: priceLevelItems.itemId, unitPrice: priceLevelItems.unitPrice })
    .from(priceLevelItems)
    .where(and(eq(priceLevelItems.tenantId, tenantId), eq(priceLevelItems.priceLevelId, levelId)))
    .orderBy(asc(priceLevelItems.createdAt), asc(priceLevelItems.id));
  return rows.map((r) => ({ itemId: r.itemId, unitPrice: r.unitPrice }));
}

export async function getById(tenantId: string, id: string, companyId?: string): Promise<PriceLevelView> {
  const row = await loadRow(db, tenantId, id, companyId);
  return { ...row, itemPrices: await itemPricesOf(db, tenantId, id) };
}

async function assertNameFree(executor: DbOrTx, tenantId: string, name: string, companyId: string | null | undefined, exceptId?: string) {
  const conditions = [eq(priceLevels.tenantId, tenantId), sql`lower(${priceLevels.name}) = lower(${name})`];
  const s = scope(companyId);
  if (s) conditions.push(s);
  const rows = await executor.select({ id: priceLevels.id }).from(priceLevels).where(and(...conditions));
  if (rows.some((r) => r.id !== exceptId)) {
    throw AppError.conflict('A price level with this name already exists', 'PRICE_LEVEL_NAME_IN_USE');
  }
}

/**
 * The fixed prices, checked and rounded: each item once, an item of the
 * tenant and of the company (or of none), not a discount or subtotal item.
 */
async function normalizeItemPrices(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined,
  input: ReadonlyArray<{ itemId: string; unitPrice: string }>,
) {
  const ids = input.map((p) => p.itemId);
  if (new Set(ids).size !== ids.length) throw AppError.badRequest('An item is listed more than once', 'VALIDATION_ERROR');
  if (ids.length === 0) return [];
  const rows = await executor.select({ id: items.id, companyId: items.companyId, itemType: items.itemType }).from(items)
    .where(and(eq(items.tenantId, tenantId), inArray(items.id, ids)));
  if (rows.length !== ids.length || rows.some((r) => ledger.inOtherCompany(r, companyId))) {
    throw AppError.badRequest('One or more items do not belong to this company', 'VALIDATION_ERROR');
  }
  if (rows.some((r) => r.itemType === 'discount' || r.itemType === 'subtotal')) {
    throw AppError.badRequest('Discount and subtotal items don’t take a level price', 'VALIDATION_ERROR');
  }
  return input.map((p, i) => ({ itemId: p.itemId, unitPrice: roundLevelItemPrice(p.unitPrice, `itemPrices[${i}].unitPrice`) }));
}

async function writeItemPrices(tx: Tx, tenantId: string, levelId: string, prices: Array<{ itemId: string; unitPrice: string }>) {
  await tx.delete(priceLevelItems).where(and(eq(priceLevelItems.tenantId, tenantId), eq(priceLevelItems.priceLevelId, levelId)));
  if (prices.length > 0) {
    await tx.insert(priceLevelItems).values(prices.map((p) => ({ tenantId, priceLevelId: levelId, itemId: p.itemId, unitPrice: p.unitPrice })));
  }
}

export async function create(tenantId: string, input: CreatePriceLevelInput, userId?: string, companyId?: string): Promise<PriceLevelView> {
  const id = await db.transaction(async (tx) => {
    await assertNameFree(tx, tenantId, input.name, companyId);
    const prices = await normalizeItemPrices(tx, tenantId, companyId, input.itemPrices ?? []);
    const [row] = await tx.insert(priceLevels).values({
      tenantId, companyId: companyId ?? null, name: input.name, percent: input.percent ?? '0',
    }).returning();
    if (!row) throw AppError.internal('Failed to create price level');
    await writeItemPrices(tx, tenantId, row.id, prices);
    await auditLog(tenantId, 'create', 'price_level', row.id, null, { ...row, itemPrices: prices }, userId, tx);
    return row.id;
  });
  return getById(tenantId, id, companyId);
}

export async function update(
  tenantId: string, id: string, input: UpdatePriceLevelInput, userId?: string, companyId?: string,
): Promise<PriceLevelView> {
  await db.transaction(async (tx) => {
    const existing = await loadRow(tx, tenantId, id, companyId, true);
    const before = { ...existing, itemPrices: await itemPricesOf(tx, tenantId, id) };
    if (input.name !== undefined && input.name.toLowerCase() !== existing.name.toLowerCase()) {
      await assertNameFree(tx, tenantId, input.name, existing.companyId ?? companyId, id);
    }
    const prices = input.itemPrices === undefined ? undefined
      : await normalizeItemPrices(tx, tenantId, existing.companyId ?? companyId, input.itemPrices);
    const [row] = await tx.update(priceLevels).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.percent !== undefined ? { percent: input.percent } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    }).where(and(eq(priceLevels.tenantId, tenantId), eq(priceLevels.id, id))).returning();
    if (prices) await writeItemPrices(tx, tenantId, id, prices);
    await auditLog(tenantId, 'update', 'price_level', id, before, { ...row, itemPrices: prices ?? before.itemPrices }, userId, tx);
  });
  return getById(tenantId, id, companyId);
}

/** Deletes a level no client has (409 PRICE_LEVEL_IN_USE otherwise; make it inactive instead). */
export async function remove(tenantId: string, id: string, userId?: string, companyId?: string) {
  await db.transaction(async (tx) => {
    const existing = await loadRow(tx, tenantId, id, companyId, true);
    const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.priceLevelId, id)));
    if ((used?.n ?? 0) > 0) {
      throw AppError.conflict('Clients still use this price level; make it inactive or change their level first', 'PRICE_LEVEL_IN_USE', { clients: used!.n });
    }
    const itemPrices = await itemPricesOf(tx, tenantId, id);
    await tx.delete(priceLevelItems).where(and(eq(priceLevelItems.tenantId, tenantId), eq(priceLevelItems.priceLevelId, id)));
    await tx.delete(priceLevels).where(and(eq(priceLevels.tenantId, tenantId), eq(priceLevels.id, id)));
    await auditLog(tenantId, 'delete', 'price_level', id, { ...existing, itemPrices }, null, userId, tx);
  });
}

/** A client's price level may be set to an active level of the tenant and of the company (or of none). */
export async function assertAssignable(executor: DbOrTx, tenantId: string, levelId: string, companyId?: string | null) {
  const [row] = await executor.select().from(priceLevels)
    .where(and(eq(priceLevels.tenantId, tenantId), eq(priceLevels.id, levelId))).limit(1);
  if (!row || ledger.inOtherCompany(row, companyId)) throw AppError.badRequest('Price level not found', 'VALIDATION_ERROR');
  if (!row.isActive) throw AppError.badRequest('That price level is inactive', 'VALIDATION_ERROR');
}

/**
 * The pricing a client's level gives (U-129): null when the client has no
 * level, or it is inactive or of another company.
 */
export async function loadPricingLevel(
  executor: DbOrTx, tenantId: string, levelId: string | null | undefined, companyId?: string | null,
): Promise<(PricingLevel & { id: string; name: string }) | null> {
  if (!levelId) return null;
  const [row] = await executor.select().from(priceLevels)
    .where(and(eq(priceLevels.tenantId, tenantId), eq(priceLevels.id, levelId))).limit(1);
  if (!row || !row.isActive || ledger.inOtherCompany(row, companyId)) return null;
  const prices = await itemPricesOf(executor, tenantId, levelId);
  return {
    id: row.id, name: row.name, percent: row.percent,
    itemPrices: Object.fromEntries(prices.map((p) => [p.itemId, p.unitPrice])),
  };
}
