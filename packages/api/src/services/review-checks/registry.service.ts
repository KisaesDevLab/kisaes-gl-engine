// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, isNull } from 'drizzle-orm';
import type { CheckRegistryEntry, FindingSeverity } from '@kis-books/shared';
import type { CheckCategory } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { checkRegistry, checkParamsOverrides } from '../../db/schema/index.js';

// Phase 6 — registry reader + per-(tenant, company) param
// resolver. Handlers receive the merged params object: defaults
// from check_registry < tenant-wide override < company-specific
// override.

export async function listEnabled(): Promise<CheckRegistryEntry[]> {
  const rows = await db
    .select()
    .from(checkRegistry)
    .where(eq(checkRegistry.enabled, true));
  return rows.map(mapRegistryRow);
}

export async function listAll(): Promise<CheckRegistryEntry[]> {
  const rows = await db.select().from(checkRegistry);
  return rows.map(mapRegistryRow);
}

// Resolves the effective params for a given (tenant, company,
// checkKey). Layered merge: registry defaults ⊕ tenant-wide ⊕
// company-specific override. Object spread is shallow on
// purpose — per-key overrides win, no deep merge.
export async function resolveParams(
  tenantId: string,
  companyId: string | null,
  registryEntry: CheckRegistryEntry,
): Promise<Record<string, unknown>> {
  const tenantWideRows = await db
    .select({ params: checkParamsOverrides.params })
    .from(checkParamsOverrides)
    .where(
      and(
        eq(checkParamsOverrides.tenantId, tenantId),
        isNull(checkParamsOverrides.companyId),
        eq(checkParamsOverrides.checkKey, registryEntry.checkKey),
      ),
    );

  let merged = { ...registryEntry.defaultParams };
  for (const row of tenantWideRows) {
    if (row.params) {
      merged = { ...merged, ...(row.params as Record<string, unknown>) };
    }
  }
  if (companyId) {
    const companyRows = await db
      .select({ params: checkParamsOverrides.params })
      .from(checkParamsOverrides)
      .where(
        and(
          eq(checkParamsOverrides.tenantId, tenantId),
          eq(checkParamsOverrides.companyId, companyId),
          eq(checkParamsOverrides.checkKey, registryEntry.checkKey),
        ),
      );
    for (const row of companyRows) {
      if (row.params) merged = { ...merged, ...(row.params as Record<string, unknown>) };
    }
  }
  return merged;
}

// Reader — returns every override row for a tenant so the
// settings UI can show per-(check, company) values alongside
// the registry default. companyId === null on a row = tenant-wide.
export interface CheckOverrideRow {
  checkKey: string;
  companyId: string | null;
  params: Record<string, unknown>;
}

export async function listOverrides(tenantId: string): Promise<CheckOverrideRow[]> {
  const rows = await db
    .select({
      checkKey: checkParamsOverrides.checkKey,
      companyId: checkParamsOverrides.companyId,
      params: checkParamsOverrides.params,
    })
    .from(checkParamsOverrides)
    .where(eq(checkParamsOverrides.tenantId, tenantId));
  return rows.map((r) => ({
    checkKey: r.checkKey,
    companyId: r.companyId,
    params: (r.params as Record<string, unknown>) ?? {},
  }));
}

// Remove — drops a single (tenant, company, check) override so
// the resolver falls back to the next layer (tenant-wide if a
// company override is removed; registry default if the
// tenant-wide one is removed).
export async function deleteOverride(
  tenantId: string,
  companyId: string | null,
  checkKey: string,
): Promise<void> {
  if (companyId === null) {
    await db
      .delete(checkParamsOverrides)
      .where(
        and(
          eq(checkParamsOverrides.tenantId, tenantId),
          isNull(checkParamsOverrides.companyId),
          eq(checkParamsOverrides.checkKey, checkKey),
        ),
      );
    return;
  }
  await db
    .delete(checkParamsOverrides)
    .where(
      and(
        eq(checkParamsOverrides.tenantId, tenantId),
        eq(checkParamsOverrides.companyId, companyId),
        eq(checkParamsOverrides.checkKey, checkKey),
      ),
    );
}

// Setter — used by the override admin endpoint. Postgres treats
// NULLs as distinct by default, so the unique index on
// (tenant_id, company_id, check_key) does not catch a duplicate
// tenant-wide row. Explicitly check + update for the NULL-company
// path; otherwise fall through to onConflictDoUpdate for the
// company-scoped path.
export async function setOverride(
  tenantId: string,
  companyId: string | null,
  checkKey: string,
  params: Record<string, unknown>,
): Promise<void> {
  if (companyId === null) {
    const existing = await db
      .select({ id: checkParamsOverrides.id })
      .from(checkParamsOverrides)
      .where(
        and(
          eq(checkParamsOverrides.tenantId, tenantId),
          isNull(checkParamsOverrides.companyId),
          eq(checkParamsOverrides.checkKey, checkKey),
        ),
      )
      .limit(1);
    if (existing.length > 0) {
      await db
        .update(checkParamsOverrides)
        .set({ params })
        .where(eq(checkParamsOverrides.id, existing[0]!.id));
    } else {
      await db
        .insert(checkParamsOverrides)
        .values({ tenantId, companyId: null, checkKey, params });
    }
    return;
  }
  await db
    .insert(checkParamsOverrides)
    .values({ tenantId, companyId, checkKey, params })
    .onConflictDoUpdate({
      target: [checkParamsOverrides.tenantId, checkParamsOverrides.companyId, checkParamsOverrides.checkKey],
      set: { params },
    });
}

function mapRegistryRow(row: typeof checkRegistry.$inferSelect): CheckRegistryEntry {
  return {
    checkKey: row.checkKey,
    name: row.name,
    description: row.description,
    handlerName: row.handlerName,
    defaultSeverity: row.defaultSeverity as FindingSeverity,
    defaultParams: (row.defaultParams as Record<string, unknown>) ?? {},
    category: row.category as CheckCategory,
    enabled: row.enabled,
    createdAt: row.createdAt.toISOString(),
  };
}
