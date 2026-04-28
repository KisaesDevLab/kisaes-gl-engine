// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq } from 'drizzle-orm';
import {
  PRACTICE_FEATURE_FLAGS,
  isPracticeFeatureFlagKey,
  type PracticeFeatureFlagKey,
  type FeatureFlagStatus,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenantFeatureFlags } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

export interface FlagRow {
  flagKey: PracticeFeatureFlagKey;
  enabled: boolean;
  rolloutPercent: number;
  activatedAt: string | null;
}

// Returns the full status map for a tenant. The sidebar hits this
// exactly once per session (TanStack Query staleTime 5 min), so no
// caching layer is needed at the service boundary. Missing rows are
// synthesized as disabled so a tenant that pre-dates a new flag
// addition still gets a well-formed response.
export async function listFlagsForTenant(tenantId: string): Promise<Record<PracticeFeatureFlagKey, FeatureFlagStatus>> {
  const rows = await db
    .select()
    .from(tenantFeatureFlags)
    .where(eq(tenantFeatureFlags.tenantId, tenantId));

  const out: Partial<Record<PracticeFeatureFlagKey, FeatureFlagStatus>> = {};
  for (const flag of PRACTICE_FEATURE_FLAGS) {
    out[flag] = { enabled: false, rolloutPercent: 0, activatedAt: null };
  }
  for (const row of rows) {
    if (!isPracticeFeatureFlagKey(row.flagKey)) continue;
    out[row.flagKey] = {
      enabled: row.enabled,
      rolloutPercent: row.rolloutPercent,
      activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
    };
  }
  return out as Record<PracticeFeatureFlagKey, FeatureFlagStatus>;
}

// Single-flag boolean. Used by server-side guards that only care
// whether a surface is on.
export async function isEnabled(tenantId: string, flagKey: PracticeFeatureFlagKey): Promise<boolean> {
  const [row] = await db
    .select({ enabled: tenantFeatureFlags.enabled })
    .from(tenantFeatureFlags)
    .where(and(eq(tenantFeatureFlags.tenantId, tenantId), eq(tenantFeatureFlags.flagKey, flagKey)))
    .limit(1);
  return !!row?.enabled;
}

export interface SetFlagInput {
  enabled: boolean;
  rolloutPercent?: number;
}

export interface FlagChange {
  before: FeatureFlagStatus;
  after: FeatureFlagStatus;
}

// Super-admin toggle. Returns before/after so the caller can emit
// the audit log entry with both sides of the diff.
export async function setFlag(
  tenantId: string,
  flagKey: string,
  input: SetFlagInput,
): Promise<FlagChange> {
  if (!isPracticeFeatureFlagKey(flagKey)) {
    throw AppError.badRequest(`Unknown feature flag key: ${flagKey}`);
  }
  const before = await getOrDefault(tenantId, flagKey);

  const values = {
    tenantId,
    flagKey,
    enabled: input.enabled,
    rolloutPercent: typeof input.rolloutPercent === 'number' ? input.rolloutPercent : before.rolloutPercent,
    activatedAt: input.enabled && !before.enabled ? new Date() : (input.enabled ? (before.activatedAt ? new Date(before.activatedAt) : new Date()) : null),
    updatedAt: new Date(),
  };

  await db.insert(tenantFeatureFlags)
    .values(values)
    .onConflictDoUpdate({
      target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey],
      set: {
        enabled: values.enabled,
        rolloutPercent: values.rolloutPercent,
        activatedAt: values.activatedAt,
        updatedAt: values.updatedAt,
      },
    });

  const after: FeatureFlagStatus = {
    enabled: values.enabled,
    rolloutPercent: values.rolloutPercent,
    activatedAt: values.activatedAt ? values.activatedAt.toISOString() : null,
  };
  return { before, after };
}

// Insert all eight Practice flags for a fresh tenant with enabled =
// TRUE. Called from every tenant-creation code path:
//   - auth.service.register (self-signup)
//   - auth.service.createClientTenant (CPA creating a client)
//   - setup.service (first-run wizard)
//   - demo-data.service (dev demo tenant)
// ON CONFLICT DO NOTHING so re-running or partial overlap with a
// pre-existing disabled row is harmless — if the migration already
// seeded a disabled row (e.g. test fixture), the registration path
// will not overwrite it. Callers that want "start enabled" should
// invoke this BEFORE the migration seed would have applied, i.e. in
// the creation transaction, when only the newly-created tenant's
// row would exist.
// 3-tier rules plan, Phase 2 — flags that should default OFF for
// new tenants. Every other PRACTICE_FEATURE_FLAG defaults ON.
const FLAGS_DEFAULT_OFF_FOR_NEW_TENANTS: ReadonlySet<string> = new Set([
  'RULES_TIERED_V1',
  'RECURRING_DOC_REQUESTS_V1',
  'DOC_REQUEST_SMS_V1',
  'RECURRING_CRON_V1',
  'STATEMENT_AUTO_IMPORT_V1',
]);

export async function seedDefaultsForNewTenant(tenantId: string): Promise<void> {
  const rows = PRACTICE_FEATURE_FLAGS.map((flagKey) => {
    const enabled = !FLAGS_DEFAULT_OFF_FOR_NEW_TENANTS.has(flagKey);
    return {
      tenantId,
      flagKey,
      enabled,
      rolloutPercent: enabled ? 100 : 0,
      activatedAt: enabled ? new Date() : null,
      updatedAt: new Date(),
    };
  });
  await db.insert(tenantFeatureFlags).values(rows).onConflictDoNothing();
}

async function getOrDefault(tenantId: string, flagKey: PracticeFeatureFlagKey): Promise<FeatureFlagStatus> {
  const [row] = await db
    .select()
    .from(tenantFeatureFlags)
    .where(and(eq(tenantFeatureFlags.tenantId, tenantId), eq(tenantFeatureFlags.flagKey, flagKey)))
    .limit(1);
  if (!row) return { enabled: false, rolloutPercent: 0, activatedAt: null };
  return {
    enabled: row.enabled,
    rolloutPercent: row.rolloutPercent,
    activatedAt: row.activatedAt ? row.activatedAt.toISOString() : null,
  };
}
