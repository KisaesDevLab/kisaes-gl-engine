import { eq, and, ilike, count } from 'drizzle-orm';
import type { CreateItemInput, UpdateItemInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { items } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

export async function list(tenantId: string, filters?: { isActive?: boolean; search?: string; limit?: number; offset?: number }) {
  const conditions = [eq(items.tenantId, tenantId)];
  if (filters?.isActive !== undefined) conditions.push(eq(items.isActive, filters.isActive));
  if (filters?.search) conditions.push(ilike(items.name, `%${filters.search}%`));

  const where = and(...conditions);
  const [data, total] = await Promise.all([
    db.select().from(items).where(where).orderBy(items.name).limit(filters?.limit ?? 100).offset(filters?.offset ?? 0),
    db.select({ count: count() }).from(items).where(where),
  ]);
  return { data, total: total[0]?.count ?? 0 };
}

export async function getById(tenantId: string, id: string) {
  const item = await db.query.items.findFirst({ where: and(eq(items.tenantId, tenantId), eq(items.id, id)) });
  if (!item) throw AppError.notFound('Item not found');
  return item;
}

export async function create(tenantId: string, input: CreateItemInput, userId?: string) {
  const existing = await db.query.items.findFirst({ where: and(eq(items.tenantId, tenantId), eq(items.name, input.name)) });
  if (existing) throw AppError.conflict('An item with this name already exists');

  const [item] = await db.insert(items).values({ tenantId, ...input }).returning();
  if (!item) throw AppError.internal('Failed to create item');
  await auditLog(tenantId, 'create', 'item', item.id, null, item, userId);
  return item;
}

export async function update(tenantId: string, id: string, input: UpdateItemInput, userId?: string) {
  const existing = await getById(tenantId, id);
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
    `"${i.name}","${i.description || ''}","${i.unitPrice || ''}","${i.incomeAccountId}","${i.isTaxable}","${i.isActive}"`,
  ).join('\n');
  return header + rows;
}
