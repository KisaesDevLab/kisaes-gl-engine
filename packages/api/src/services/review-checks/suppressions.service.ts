// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type {
  CheckSuppression,
  FindingDraft,
  SuppressionPattern,
} from '@kis-books/shared';
import { db } from '../../db/index.js';
import { checkSuppressions } from '../../db/schema/index.js';

// Phase 6 §6.4 — suppression matcher. Loaded once per
// orchestrator run and applied to every candidate finding
// before insert.

export async function listActive(
  tenantId: string,
  checkKey?: string,
): Promise<CheckSuppression[]> {
  const now = new Date();
  const conditions = [
    eq(checkSuppressions.tenantId, tenantId),
    or(isNull(checkSuppressions.expiresAt), gt(checkSuppressions.expiresAt, now))!,
  ];
  if (checkKey) conditions.push(eq(checkSuppressions.checkKey, checkKey));
  const rows = await db.select().from(checkSuppressions).where(and(...conditions));
  return rows.map(mapRow);
}

export async function listAll(tenantId: string): Promise<CheckSuppression[]> {
  const rows = await db
    .select()
    .from(checkSuppressions)
    .where(eq(checkSuppressions.tenantId, tenantId));
  return rows.map(mapRow);
}

export async function create(input: {
  tenantId: string;
  companyId: string | null;
  checkKey: string;
  matchPattern: SuppressionPattern;
  reason?: string;
  expiresAt?: string;
  createdBy?: string;
}): Promise<CheckSuppression> {
  const [row] = await db
    .insert(checkSuppressions)
    .values({
      tenantId: input.tenantId,
      companyId: input.companyId,
      checkKey: input.checkKey,
      matchPattern: input.matchPattern,
      reason: input.reason ?? null,
      createdBy: input.createdBy ?? null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    })
    .returning();
  return mapRow(row!);
}

export async function remove(tenantId: string, id: string): Promise<void> {
  await db
    .delete(checkSuppressions)
    .where(and(eq(checkSuppressions.tenantId, tenantId), eq(checkSuppressions.id, id)));
}

// Returns true when the candidate finding matches at least one
// of the given suppressions. Multiple suppressions are OR-ed;
// fields within a single suppression are AND-ed (per plan §D9).
export function shouldSuppress(
  candidate: FindingDraft,
  suppressions: CheckSuppression[],
  companyId: string | null,
): boolean {
  for (const sup of suppressions) {
    if (sup.checkKey !== candidate.checkKey) continue;
    if (sup.companyId !== null && sup.companyId !== companyId) continue;
    if (matchesPattern(candidate, sup.matchPattern)) return true;
  }
  return false;
}

function matchesPattern(candidate: FindingDraft, pattern: SuppressionPattern): boolean {
  if (pattern.transactionId !== undefined) {
    if (candidate.transactionId !== pattern.transactionId) return false;
  }
  if (pattern.vendorId !== undefined) {
    if (candidate.vendorId !== pattern.vendorId) return false;
  }
  if (pattern.payloadEquals) {
    for (const [k, v] of Object.entries(pattern.payloadEquals)) {
      // Loose equality via JSON.stringify keeps nested objects
      // comparable without a deep-equality dep.
      if (JSON.stringify(candidate.payload?.[k]) !== JSON.stringify(v)) return false;
    }
  }
  return true;
}

function mapRow(row: typeof checkSuppressions.$inferSelect): CheckSuppression {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    checkKey: row.checkKey,
    matchPattern: row.matchPattern as SuppressionPattern,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

// sql tag retained for future raw-SQL needs; unused-import lint silencer.
export const _sqlRef = sql`SELECT 1`;
