// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tenant-defined custom account detail types. Built-ins live in
// @kis-books/shared (DETAIL_TYPES); this service layers per-tenant
// custom entries (tenant_detail_types, migration 0114) on top and
// exposes the merged list the account forms consume.

import { and, asc, eq, sql } from 'drizzle-orm';
import {
  ACCOUNT_TYPES,
  DETAIL_TYPES,
  formatDetailTypeLabel,
  createDetailTypeSchema,
  updateDetailTypeSchema,
  type AccountType,
  type CreateDetailTypeInput,
  type CustomDetailType,
  type DetailTypeOption,
  type MergedDetailTypes,
  type UpdateDetailTypeInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenantDetailTypes } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

type Row = typeof tenantDetailTypes.$inferSelect;

function toDto(row: Row): CustomDetailType {
  return {
    id: row.id,
    tenantId: row.tenantId,
    accountType: row.accountType as AccountType,
    value: row.value,
    label: row.label,
    sortOrder: row.sortOrder ?? null,
    createdAt: row.createdAt?.toISOString() ?? '',
    updatedAt: row.updatedAt?.toISOString() ?? '',
  };
}

// Presentation ordering for custom detail types: explicit sort_order
// first (ASC — Postgres puts NULLs last), label as the tiebreak so
// unpositioned types keep a stable alphabetical tail. Shared by the
// merged dropdown list, the settings page list, and the report group
// ordering below so every surface agrees.
const presentationOrder = [
  asc(tenantDetailTypes.accountType),
  sql`${tenantDetailTypes.sortOrder} ASC NULLS LAST`,
  asc(tenantDetailTypes.label),
];

/** Merged builtin + custom detail types per account type. Built-ins keep
 *  their humanized labels; custom entries use the tenant-provided label
 *  and sort after the built-ins in presentation order (sort_order, label). */
export async function listMerged(tenantId: string): Promise<MergedDetailTypes> {
  const custom = await db
    .select()
    .from(tenantDetailTypes)
    .where(eq(tenantDetailTypes.tenantId, tenantId))
    .orderBy(...presentationOrder);

  const merged = {} as MergedDetailTypes;
  for (const type of ACCOUNT_TYPES) {
    const builtins: DetailTypeOption[] = (DETAIL_TYPES[type] || []).map((value) => ({
      value,
      label: formatDetailTypeLabel(value),
      isCustom: false,
      id: null,
    }));
    const customForType: DetailTypeOption[] = custom
      .filter((c) => c.accountType === type)
      .map((c) => ({ value: c.value, label: c.label, isCustom: true, id: c.id }));
    merged[type] = [...builtins, ...customForType];
  }
  return merged;
}

export async function listCustom(tenantId: string): Promise<CustomDetailType[]> {
  const rows = await db
    .select()
    .from(tenantDetailTypes)
    .where(eq(tenantDetailTypes.tenantId, tenantId))
    .orderBy(...presentationOrder);
  return rows.map(toDto);
}

// ─── Report group ordering ────────────────────────────────────────
//
// Grouped reports (?group_by=detail_type) build one group per distinct
// detail type per section. Stock detail types keep the report's native
// ordering (first occurrence in account-number order); CUSTOM detail
// types are placed after them, ordered by their tenant-defined
// sort_order (label tiebreak, matching the merged dropdown). Groups
// with no detail type ('Other', the BS's 'Equity (Calculated)') stay
// trailing. ONE helper shared by the standard P&L/BS builders and the
// comparative variants — exports (CSV/PDF) and the condensed display
// mode mirror the builders' group arrays, so they inherit this order.

/** value → presentation rank, keyed `${accountType}:${value}` (custom
 *  slugs are unique per account type, not globally). */
export async function getCustomDetailTypeRanks(tenantId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({
      accountType: tenantDetailTypes.accountType,
      value: tenantDetailTypes.value,
    })
    .from(tenantDetailTypes)
    .where(eq(tenantDetailTypes.tenantId, tenantId))
    .orderBy(...presentationOrder);
  const ranks = new Map<string, number>();
  rows.forEach((r, i) => ranks.set(`${r.accountType}:${r.value}`, i));
  return ranks;
}

/**
 * Reorder a report section's detail-type groups for presentation:
 * stock groups keep their existing relative order, custom groups
 * follow (by tenant sort_order), null-detail groups trail. Pure and
 * stable — safe on any group shape that carries `detailType`.
 */
export function orderDetailTypeGroups<T extends { detailType: string | null }>(
  groups: T[],
  ranks: Map<string, number>,
  accountType: AccountType,
): T[] {
  const bucketOf = (g: T): number => {
    if (g.detailType === null) return 2;
    return ranks.has(`${accountType}:${g.detailType}`) ? 1 : 0;
  };
  return groups
    .map((g, i) => ({ g, i, bucket: bucketOf(g) }))
    .sort((a, b) => {
      if (a.bucket !== b.bucket) return a.bucket - b.bucket;
      if (a.bucket === 1) {
        const ra = ranks.get(`${accountType}:${a.g.detailType}`)!;
        const rb = ranks.get(`${accountType}:${b.g.detailType}`)!;
        if (ra !== rb) return ra - rb;
      }
      return a.i - b.i; // stable within bucket
    })
    .map((x) => x.g);
}

export async function create(
  tenantId: string,
  input: CreateDetailTypeInput,
  userId?: string,
): Promise<CustomDetailType> {
  const validated = createDetailTypeSchema.parse(input);

  // A custom slug may not shadow a built-in of the same account type —
  // the merged dropdown would show duplicates and deletion could never
  // free the slug.
  if ((DETAIL_TYPES[validated.accountType] || []).includes(validated.value)) {
    throw AppError.conflict(
      `'${validated.value}' is already a built-in detail type for ${validated.accountType}`,
      'DETAIL_TYPE_BUILTIN',
    );
  }

  const existing = await db
    .select({ id: tenantDetailTypes.id })
    .from(tenantDetailTypes)
    .where(and(
      eq(tenantDetailTypes.tenantId, tenantId),
      eq(tenantDetailTypes.accountType, validated.accountType),
      eq(tenantDetailTypes.value, validated.value),
    ));
  if (existing.length > 0) {
    throw AppError.conflict(
      `'${validated.value}' already exists for ${validated.accountType}`,
      'DETAIL_TYPE_EXISTS',
    );
  }

  const [row] = await db
    .insert(tenantDetailTypes)
    .values({
      tenantId,
      accountType: validated.accountType,
      value: validated.value,
      label: validated.label,
      // Omitted = NULL = end of the presentation order (NULLS LAST).
      sortOrder: validated.sortOrder ?? null,
    })
    .returning();

  const dto = toDto(row!);
  await auditLog(tenantId, 'create', 'detail_type', dto.id, null, dto, userId);
  return dto;
}

/** Rename and/or reorder a custom detail type. `value` is immutable —
 *  it's stored on accounts.detail_type. */
export async function update(
  tenantId: string,
  id: string,
  input: UpdateDetailTypeInput,
  userId?: string,
): Promise<CustomDetailType> {
  const validated = updateDetailTypeSchema.parse(input);

  const [existing] = await db
    .select()
    .from(tenantDetailTypes)
    .where(and(eq(tenantDetailTypes.tenantId, tenantId), eq(tenantDetailTypes.id, id)));
  if (!existing) throw AppError.notFound('Detail type not found');

  const [row] = await db
    .update(tenantDetailTypes)
    .set({
      ...(validated.label !== undefined ? { label: validated.label } : {}),
      ...(validated.sortOrder !== undefined ? { sortOrder: validated.sortOrder } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(tenantDetailTypes.tenantId, tenantId), eq(tenantDetailTypes.id, id)))
    .returning();

  const dto = toDto(row!);
  await auditLog(tenantId, 'update', 'detail_type', id, toDto(existing), dto, userId);
  return dto;
}

export async function remove(tenantId: string, id: string, userId?: string): Promise<void> {
  const [row] = await db
    .select()
    .from(tenantDetailTypes)
    .where(and(eq(tenantDetailTypes.tenantId, tenantId), eq(tenantDetailTypes.id, id)));
  if (!row) throw AppError.notFound('Detail type not found');

  // Deletion guard: refuse when any account still uses this detail type.
  const inUse = await db.execute(sql`
    SELECT COUNT(*)::int AS count FROM accounts
    WHERE tenant_id = ${tenantId} AND detail_type = ${row.value}
  `);
  const count = (inUse.rows as Array<{ count: number }>)[0]?.count ?? 0;
  if (count > 0) {
    throw AppError.conflict(
      `Cannot delete '${row.label}' — ${count} account${count === 1 ? '' : 's'} still use${count === 1 ? 's' : ''} it. Reassign those accounts first.`,
      'DETAIL_TYPE_IN_USE',
      { count },
    );
  }

  await db
    .delete(tenantDetailTypes)
    .where(and(eq(tenantDetailTypes.tenantId, tenantId), eq(tenantDetailTypes.id, id)));
  await auditLog(tenantId, 'delete', 'detail_type', id, toDto(row), null, userId);
}
