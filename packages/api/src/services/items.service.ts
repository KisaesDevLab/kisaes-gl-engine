// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, ilike, count, asc, desc, sql, type SQL } from 'drizzle-orm';
import type { CreateItemInput, UpdateItemInput, ItemFilters } from '@kis-books/shared';
import { db } from '../db/index.js';
import { items } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import { toCsvRow } from './export.service.js';
import { escapeLike } from '../utils/sql-like.js';

export async function list(tenantId: string, filters?: ItemFilters) {
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
  return { data, total: total[0]?.count ?? 0 };
}

export async function getById(tenantId: string, id: string) {
  const item = await db.query.items.findFirst({ where: and(eq(items.tenantId, tenantId), eq(items.id, id)) });
  if (!item) throw AppError.notFound('Item not found');
  return item;
}

/**
 * Item kinds (U-39a, item-kinds-sales-v1): a discount item has a percent
 * off (discountPercent) or an amount off (unitPrice, 0 or more), not both; a
 * subtotal item has neither; other kinds have no discountPercent.
 */
function assertKindFields(item: { itemType?: string | null; unitPrice?: string | null; discountPercent?: string | null }) {
  const type = item.itemType ?? 'service';
  const hasPrice = item.unitPrice !== undefined && item.unitPrice !== null && item.unitPrice !== '';
  const hasPercent = item.discountPercent !== undefined && item.discountPercent !== null && item.discountPercent !== '';
  const bad = (message: string) => AppError.badRequest(message, 'VALIDATION_ERROR');
  if (type === 'discount') {
    if (hasPrice && hasPercent) throw bad('A discount item takes a percent or an amount, not both');
    if (hasPrice && Number(item.unitPrice) < 0) throw bad('A discount amount must be 0 or more');
  } else if (type === 'subtotal') {
    if (hasPrice || hasPercent) throw bad('A subtotal item has no price or percent');
  } else if (hasPercent) {
    throw bad('Only a discount item takes a discount percent');
  }
}

export async function create(tenantId: string, input: CreateItemInput, userId?: string) {
  assertKindFields(input);
  const existing = await db.query.items.findFirst({ where: and(eq(items.tenantId, tenantId), eq(items.name, input.name)) });
  if (existing) throw AppError.conflict('An item with this name already exists');

  // The insert, its audit row and an Idempotency-Key (U-18) commit together.
  return await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const [item] = await tx.insert(items).values({ tenantId, ...input }).returning();
    if (!item) throw AppError.internal('Failed to create item');
    await recordIdempotentEntity(tx, 'item', item.id);
    await auditLog(tenantId, 'create', 'item', item.id, null, item, userId, tx);
    return item;
  });
}

export async function update(tenantId: string, id: string, input: UpdateItemInput, userId?: string) {
  const existing = await getById(tenantId, id);
  assertKindFields({
    itemType: input.itemType ?? existing.itemType,
    unitPrice: input.unitPrice !== undefined ? input.unitPrice : existing.unitPrice,
    discountPercent: input.discountPercent !== undefined ? input.discountPercent : existing.discountPercent,
  });
  if (input.name && input.name !== existing.name) {
    const dup = await db.query.items.findFirst({ where: and(eq(items.tenantId, tenantId), eq(items.name, input.name)) });
    if (dup) throw AppError.conflict('An item with this name already exists');
  }
  const [updated] = await db.update(items).set({ ...input, updatedAt: new Date() })
    .where(and(eq(items.tenantId, tenantId), eq(items.id, id))).returning();
  if (!updated) throw AppError.notFound('Item not found');
  await auditLog(tenantId, 'update', 'item', id, existing, updated, userId);
  return updated;
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
