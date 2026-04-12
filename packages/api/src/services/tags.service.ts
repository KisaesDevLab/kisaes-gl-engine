import { eq, and, sql, ilike, count } from 'drizzle-orm';
import type { CreateTagInput, UpdateTagInput, TagFilters } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tags, tagGroups, transactionTags, savedReportFilters } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// ─── Tag CRUD ────────────────────────────────────────────────────

export async function list(tenantId: string, filters?: TagFilters) {
  const conditions = [eq(tags.tenantId, tenantId)];
  if (filters?.groupId) conditions.push(eq(tags.groupId, filters.groupId));
  if (filters?.isActive !== undefined) conditions.push(eq(tags.isActive, filters.isActive));
  if (filters?.search) conditions.push(ilike(tags.name, `%${filters.search}%`));

  return db.select().from(tags).where(and(...conditions))
    .orderBy(tags.sortOrder, tags.name);
}

export async function getById(tenantId: string, id: string) {
  const tag = await db.query.tags.findFirst({
    where: and(eq(tags.tenantId, tenantId), eq(tags.id, id)),
  });
  if (!tag) throw AppError.notFound('Tag not found');
  return tag;
}

export async function create(tenantId: string, input: CreateTagInput) {
  // Check unique name
  const existing = await db.query.tags.findFirst({
    where: and(eq(tags.tenantId, tenantId), eq(tags.name, input.name)),
  });
  if (existing) throw AppError.conflict('A tag with this name already exists');

  const [tag] = await db.insert(tags).values({
    tenantId,
    name: input.name,
    color: input.color || null,
    groupId: input.groupId || null,
    description: input.description || null,
  }).returning();
  return tag;
}

export async function update(tenantId: string, id: string, input: UpdateTagInput) {
  if (input.name) {
    const existing = await db.query.tags.findFirst({
      where: and(eq(tags.tenantId, tenantId), eq(tags.name, input.name)),
    });
    if (existing && existing.id !== id) throw AppError.conflict('A tag with this name already exists');
  }

  const [updated] = await db.update(tags)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(tags.tenantId, tenantId), eq(tags.id, id)))
    .returning();
  if (!updated) throw AppError.notFound('Tag not found');
  return updated;
}

export async function remove(tenantId: string, id: string) {
  await db.delete(transactionTags).where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.tagId, id)));
  await db.delete(tags).where(and(eq(tags.tenantId, tenantId), eq(tags.id, id)));
}

export async function merge(tenantId: string, sourceId: string, targetId: string) {
  const source = await getById(tenantId, sourceId);
  const target = await getById(tenantId, targetId);
  void source;

  // Merge + source delete are now in a single db.transaction so a
  // partial failure (e.g., FK constraint on the delete) rolls back
  // the re-tagging. Also every statement is scoped by tenant_id.
  await db.transaction(async (tx) => {
    // Re-tag: update transaction_tags from source to target (skip duplicates)
    await tx.execute(sql`
      UPDATE transaction_tags SET tag_id = ${targetId}
      WHERE tenant_id = ${tenantId} AND tag_id = ${sourceId}
        AND transaction_id NOT IN (
          SELECT transaction_id FROM transaction_tags WHERE tag_id = ${targetId} AND tenant_id = ${tenantId}
        )
    `);
    // Delete remaining (duplicates)
    await tx.delete(transactionTags).where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.tagId, sourceId)));

    // Update usage count on target
    const countResult = await tx.select({ cnt: count() }).from(transactionTags)
      .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.tagId, targetId)));
    await tx.update(tags)
      .set({ usageCount: countResult[0]?.cnt ?? 0 })
      .where(and(eq(tags.tenantId, tenantId), eq(tags.id, targetId)));

    // Delete source
    await tx.delete(tags).where(and(eq(tags.tenantId, tenantId), eq(tags.id, sourceId)));
  });

  return target;
}

export async function getUsageSummary(tenantId: string) {
  return db.select().from(tags).where(eq(tags.tenantId, tenantId)).orderBy(sql`${tags.usageCount} DESC`);
}

// ─── Tag Group CRUD ──────────────────────────────────────────────

export async function listGroups(tenantId: string) {
  const groups = await db.select().from(tagGroups).where(eq(tagGroups.tenantId, tenantId)).orderBy(tagGroups.sortOrder, tagGroups.name);
  const allTags = await list(tenantId, { isActive: true });

  return groups.map((g) => ({
    ...g,
    tags: allTags.filter((t) => t.groupId === g.id),
  }));
}

export async function createGroup(tenantId: string, input: { name: string; description?: string; isSingleSelect?: boolean }) {
  const [group] = await db.insert(tagGroups).values({
    tenantId,
    name: input.name,
    description: input.description || null,
    isSingleSelect: input.isSingleSelect || false,
  }).returning();
  return group;
}

export async function updateGroup(tenantId: string, id: string, input: { name?: string; description?: string | null; isSingleSelect?: boolean }) {
  const [updated] = await db.update(tagGroups)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(tagGroups.tenantId, tenantId), eq(tagGroups.id, id)))
    .returning();
  if (!updated) throw AppError.notFound('Tag group not found');
  return updated;
}

export async function deleteGroup(tenantId: string, id: string) {
  // Ungroup tags (set group_id = null)
  await db.update(tags).set({ groupId: null }).where(and(eq(tags.tenantId, tenantId), eq(tags.groupId, id)));
  await db.delete(tagGroups).where(and(eq(tagGroups.tenantId, tenantId), eq(tagGroups.id, id)));
}

export async function reorderGroups(tenantId: string, orderedIds: string[]) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db.update(tagGroups).set({ sortOrder: i }).where(and(eq(tagGroups.tenantId, tenantId), eq(tagGroups.id, orderedIds[i]!)));
  }
}

// ─── Transaction Tagging ─────────────────────────────────────────

export async function addTags(tenantId: string, transactionId: string, tagIds: string[]) {
  if (tagIds.length === 0) return;

  // Enforce single-select group rules
  const tagsToAdd = await db.select().from(tags).where(and(eq(tags.tenantId, tenantId)));
  for (const tagId of tagIds) {
    const tag = tagsToAdd.find((t) => t.id === tagId);
    if (!tag || !tag.groupId) continue;

    const group = await db.query.tagGroups.findFirst({
      where: and(eq(tagGroups.tenantId, tenantId), eq(tagGroups.id, tag.groupId)),
    });
    if (group?.isSingleSelect) {
      // Remove other tags from this group on this transaction
      const groupTagIds = tagsToAdd.filter((t) => t.groupId === tag.groupId).map((t) => t.id);
      if (groupTagIds.length > 0) {
        await db.execute(sql`
          DELETE FROM transaction_tags
          WHERE transaction_id = ${transactionId} AND tenant_id = ${tenantId}
            AND tag_id IN (${sql.join(groupTagIds.map((id) => sql`${id}`), sql`,`)})
        `);
      }
    }
  }

  for (const tagId of tagIds) {
    // Upsert (skip if already exists)
    await db.execute(sql`
      INSERT INTO transaction_tags (transaction_id, tag_id, tenant_id)
      VALUES (${transactionId}, ${tagId}, ${tenantId})
      ON CONFLICT (transaction_id, tag_id) DO NOTHING
    `);
    // Increment usage count (tenant-scoped per CLAUDE.md #17)
    await db.update(tags).set({ usageCount: sql`${tags.usageCount} + 1` })
      .where(and(eq(tags.tenantId, tenantId), eq(tags.id, tagId)));
  }
}

export async function removeTags(tenantId: string, transactionId: string, tagIds: string[]) {
  for (const tagId of tagIds) {
    await db.delete(transactionTags).where(and(
      eq(transactionTags.tenantId, tenantId),
      eq(transactionTags.transactionId, transactionId),
      eq(transactionTags.tagId, tagId),
    ));
    await db.update(tags).set({ usageCount: sql`GREATEST(${tags.usageCount} - 1, 0)` })
      .where(and(eq(tags.tenantId, tenantId), eq(tags.id, tagId)));
  }
}

export async function replaceTags(tenantId: string, transactionId: string, tagIds: string[]) {
  // Get existing
  const existing = await db.select().from(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, transactionId)));
  const existingIds = existing.map((r) => r.tagId);

  // Remove old
  const toRemove = existingIds.filter((id) => !tagIds.includes(id));
  if (toRemove.length > 0) await removeTags(tenantId, transactionId, toRemove);

  // Add new
  const toAdd = tagIds.filter((id) => !existingIds.includes(id));
  if (toAdd.length > 0) await addTags(tenantId, transactionId, toAdd);
}

export async function bulkAddTags(tenantId: string, transactionIds: string[], tagIds: string[]) {
  for (const txnId of transactionIds) {
    await addTags(tenantId, txnId, tagIds);
  }
}

export async function bulkRemoveTags(tenantId: string, transactionIds: string[], tagIds: string[]) {
  for (const txnId of transactionIds) {
    await removeTags(tenantId, txnId, tagIds);
  }
}

export async function getTagsForTransactions(tenantId: string, transactionIds: string[]) {
  if (transactionIds.length === 0) return new Map<string, typeof tags.$inferSelect[]>();

  const result = await db.execute(sql`
    SELECT tt.transaction_id, t.id, t.name, t.color, t.group_id, t.is_active, t.usage_count, t.sort_order, t.description, t.tenant_id, t.created_at, t.updated_at
    FROM transaction_tags tt
    JOIN tags t ON t.id = tt.tag_id
    WHERE tt.tenant_id = ${tenantId}
      AND tt.transaction_id IN (${sql.join(transactionIds.map((id) => sql`${id}`), sql`,`)})
  `);

  const map = new Map<string, any[]>();
  for (const row of result.rows as any[]) {
    const txnId = row.transaction_id;
    if (!map.has(txnId)) map.set(txnId, []);
    map.get(txnId)!.push(row);
  }
  return map;
}

// ─── Saved Report Filters ────────────────────────────────────────

export async function listSavedFilters(tenantId: string, reportType?: string) {
  const conditions = [eq(savedReportFilters.tenantId, tenantId)];
  if (reportType) conditions.push(eq(savedReportFilters.reportType, reportType));
  return db.select().from(savedReportFilters).where(and(...conditions)).orderBy(savedReportFilters.name);
}

export async function createSavedFilter(tenantId: string, input: { name: string; reportType: string; filters: Record<string, unknown>; isDefault?: boolean }) {
  if (input.isDefault) {
    await db.update(savedReportFilters).set({ isDefault: false })
      .where(and(eq(savedReportFilters.tenantId, tenantId), eq(savedReportFilters.reportType, input.reportType)));
  }
  const [filter] = await db.insert(savedReportFilters).values({
    tenantId,
    name: input.name,
    reportType: input.reportType,
    filters: JSON.stringify(input.filters),
    isDefault: input.isDefault || false,
  }).returning();
  return filter;
}

export async function deleteSavedFilter(tenantId: string, id: string) {
  await db.delete(savedReportFilters).where(and(eq(savedReportFilters.tenantId, tenantId), eq(savedReportFilters.id, id)));
}
