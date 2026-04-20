// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, ilike, count, inArray } from 'drizzle-orm';
import type { CreateTagInput, UpdateTagInput, TagFilters } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tags, tagGroups, transactionTags, savedReportFilters, transactions, journalLines, items, contacts, budgets, bankRules } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// Defense-in-depth tenant checks for transaction-tag mutations. Without
// these, a caller who knows (or guesses) a txn/tag UUID from another
// tenant could pollute transaction_tags with mismatched tenant_id + id
// combinations. The rows wouldn't surface to either side's scoped
// queries, but the write itself is still a tenant-isolation breach.
async function assertTransactionInTenant(tenantId: string, transactionId: string): Promise<void> {
  const row = await db.select({ id: transactions.id }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)))
    .limit(1);
  if (row.length === 0) throw AppError.notFound('Transaction not found');
}

async function assertTagsInTenant(tenantId: string, tagIds: string[]): Promise<void> {
  if (tagIds.length === 0) return;
  const unique = [...new Set(tagIds)];
  const rows = await db.select({ id: tags.id }).from(tags)
    .where(and(eq(tags.tenantId, tenantId), inArray(tags.id, unique)));
  if (rows.length !== unique.length) {
    throw AppError.badRequest('One or more tags do not belong to this tenant');
  }
}

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

// ADR 0XX §8 / ADR 0XY §5 — Every place a tag_id is stored with ON DELETE
// RESTRICT. Counting them up front lets the UI surface "this tag is used
// by N transactions / M budgets / …" before the user tries to delete,
// and lets the API return a structured 409 instead of a raw FK violation.
export interface TagUsage {
  transactionLines: number;   // journal_lines.tag_id
  transactions: number;       // distinct transaction_tags rows
  budgets: number;            // budgets.tag_id
  items: number;              // items.default_tag_id
  vendorContacts: number;     // contacts.default_tag_id on vendor/both contacts
  customerContacts: number;   // contacts.default_tag_id on customer-only contacts (ignored by resolver, still FK-blocks delete)
  bankRules: number;          // bank_rules.assign_tag_id
  total: number;              // sum, for "can delete?" short-circuit
}

export async function getUsage(tenantId: string, tagId: string): Promise<TagUsage> {
  // One query per surface, parallelized. Counts are tenant-scoped on every
  // table. transaction_tags may carry multiple rows per transaction so we
  // COUNT DISTINCT to match the UI's "N transactions" framing.
  //
  // The contacts check is split by contact_type so the UI can report
  // "N vendors / M customers" separately — the resolver only consults
  // vendor/both contacts (ADR 0XY §2.1), but `contacts.default_tag_id`
  // is a real FK on every row regardless of type. Counting only the
  // vendor half would let the service greenlight a delete that then
  // explodes at the DB with a 23503 when a lingering customer-type
  // contact still references the tag.
  const [
    jlRow,
    txnRow,
    budgetRow,
    itemRow,
    vendorContactRow,
    customerContactRow,
    ruleRow,
  ] = await Promise.all([
    db.select({ c: count() }).from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.tagId, tagId))),
    db.select({ c: sql<number>`count(DISTINCT ${transactionTags.transactionId})` }).from(transactionTags)
      .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.tagId, tagId))),
    db.select({ c: count() }).from(budgets)
      .where(and(eq(budgets.tenantId, tenantId), eq(budgets.tagId, tagId))),
    db.select({ c: count() }).from(items)
      .where(and(eq(items.tenantId, tenantId), eq(items.defaultTagId, tagId))),
    db.select({ c: count() }).from(contacts)
      .where(and(
        eq(contacts.tenantId, tenantId),
        eq(contacts.defaultTagId, tagId),
        inArray(contacts.contactType, ['vendor', 'both']),
      )),
    db.select({ c: count() }).from(contacts)
      .where(and(
        eq(contacts.tenantId, tenantId),
        eq(contacts.defaultTagId, tagId),
        eq(contacts.contactType, 'customer'),
      )),
    db.select({ c: count() }).from(bankRules)
      .where(and(eq(bankRules.tenantId, tenantId), eq(bankRules.assignTagId, tagId))),
  ]);

  const transactionLines = Number(jlRow[0]?.c ?? 0);
  const transactionsCount = Number(txnRow[0]?.c ?? 0);
  const budgetsCount = Number(budgetRow[0]?.c ?? 0);
  const itemsCount = Number(itemRow[0]?.c ?? 0);
  const vendorContacts = Number(vendorContactRow[0]?.c ?? 0);
  const customerContacts = Number(customerContactRow[0]?.c ?? 0);
  const bankRulesCount = Number(ruleRow[0]?.c ?? 0);

  return {
    transactionLines,
    transactions: transactionsCount,
    budgets: budgetsCount,
    items: itemsCount,
    vendorContacts,
    customerContacts,
    bankRules: bankRulesCount,
    total:
      transactionLines + transactionsCount + budgetsCount
      + itemsCount + vendorContacts + customerContacts + bankRulesCount,
  };
}

export async function remove(tenantId: string, id: string) {
  // Surface a structured 409 before the raw FK violation hits, so the UI
  // can show "this tag is used by N transactions / M budgets / …" and
  // offer reassignment / merge instead of failing with an opaque
  // Postgres 23503 at the transaction_tags or journal_lines layer.
  const tag = await getById(tenantId, id);
  const usage = await getUsage(tenantId, id);
  if (usage.total > 0) {
    throw AppError.conflict(
      `Tag "${tag.name}" is in use and cannot be deleted. Reassign or merge first.`,
      'TAG_IN_USE',
      { tag: { id: tag.id, name: tag.name }, usage: usage as unknown as Record<string, unknown> },
    );
  }
  // transaction_tags is already empty when usage.transactions is 0, but we
  // still sweep it defensively to handle any race between the usage count
  // and the delete.
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
  await assertTransactionInTenant(tenantId, transactionId);
  await assertTagsInTenant(tenantId, tagIds);

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
  if (tagIds.length === 0) return;
  await assertTransactionInTenant(tenantId, transactionId);
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
  await assertTransactionInTenant(tenantId, transactionId);
  if (tagIds.length > 0) await assertTagsInTenant(tenantId, tagIds);

  // ADR 0XX §4 — split-level tags are line-authoritative. A 0- or 1-tag
  // replace is the common single-tag case and must land on every
  // journal line, not just the legacy junction. Delegating to
  // `setTransactionLineTag` also takes care of the junction re-sync,
  // so the dedupe logic below only applies to the legacy multi-tag
  // path. Once the junction is retired in Phase 10, the multi-tag
  // branch goes away with it.
  if (tagIds.length <= 1) {
    await setTransactionLineTag(tenantId, transactionId, tagIds[0] ?? null);
    return;
  }

  // Multi-tag replace: junction-only (legacy). Lines keep whatever
  // tag they already had — multi-tag-per-line is future work (ADR
  // 0XX §5.3) and the junction is the only current home for it.
  const existing = await db.select().from(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, transactionId)));
  const existingIds = existing.map((r) => r.tagId);

  const toRemove = existingIds.filter((id) => !tagIds.includes(id));
  if (toRemove.length > 0) await removeTags(tenantId, transactionId, toRemove);

  const toAdd = tagIds.filter((id) => !existingIds.includes(id));
  if (toAdd.length > 0) await addTags(tenantId, transactionId, toAdd);
}

// ADR 0XX §4 — set a single tag (or clear) on every journal line of a
// transaction AND re-sync the transaction_tags junction to match. This
// is the right entry point for "apply tag X to this whole transaction"
// under the split-level model. Bank-feed bulk-set-tag already uses the
// same pattern; this helper hoists it to a shared service so junction
// callers (API v2 POST /transactions/:id/tags, MCP tag_transaction)
// stop silently overwriting line tags on next ledger edit.
export async function setTransactionLineTag(
  tenantId: string,
  transactionId: string,
  tagId: string | null,
): Promise<void> {
  await assertTransactionInTenant(tenantId, transactionId);
  if (tagId) await assertTagsInTenant(tenantId, [tagId]);

  await db.transaction(async (tx) => {
    await tx.update(journalLines).set({ tagId })
      .where(and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.transactionId, transactionId),
      ));

    await tx.delete(transactionTags).where(and(
      eq(transactionTags.tenantId, tenantId),
      eq(transactionTags.transactionId, transactionId),
    ));

    if (tagId) {
      // Look up company_id from the transaction so multi-company
      // tenants don't lose the scope. One query is cheap here — the
      // ledger path already reads the row, but this helper lives
      // outside that path so we pay the extra fetch ourselves.
      const [txn] = await tx.select({ companyId: transactions.companyId }).from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)))
        .limit(1);

      await tx.insert(transactionTags).values({
        tenantId,
        companyId: txn?.companyId ?? null,
        transactionId,
        tagId,
      });
      await tx.update(tags).set({ usageCount: sql`${tags.usageCount} + 1` })
        .where(and(eq(tags.tenantId, tenantId), eq(tags.id, tagId)));
    }
  });
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
