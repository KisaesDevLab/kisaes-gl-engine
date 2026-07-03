// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Tenant-defined custom account detail types. Built-ins live in
// @kis-books/shared (DETAIL_TYPES); this service layers per-tenant
// custom entries (tenant_detail_types, migration 0114) on top and
// exposes the merged list the account forms consume.

import { and, eq, sql } from 'drizzle-orm';
import {
  ACCOUNT_TYPES,
  DETAIL_TYPES,
  formatDetailTypeLabel,
  createDetailTypeSchema,
  type AccountType,
  type CreateDetailTypeInput,
  type CustomDetailType,
  type DetailTypeOption,
  type MergedDetailTypes,
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
    createdAt: row.createdAt?.toISOString() ?? '',
    updatedAt: row.updatedAt?.toISOString() ?? '',
  };
}

/** Merged builtin + custom detail types per account type. Built-ins keep
 *  their humanized labels; custom entries use the tenant-provided label
 *  and sort after the built-ins. */
export async function listMerged(tenantId: string): Promise<MergedDetailTypes> {
  const custom = await db
    .select()
    .from(tenantDetailTypes)
    .where(eq(tenantDetailTypes.tenantId, tenantId))
    .orderBy(tenantDetailTypes.label);

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
    .orderBy(tenantDetailTypes.accountType, tenantDetailTypes.label);
  return rows.map(toDto);
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
    })
    .returning();

  const dto = toDto(row!);
  await auditLog(tenantId, 'create', 'detail_type', dto.id, null, dto, userId);
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
