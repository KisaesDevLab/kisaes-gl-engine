// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq } from 'drizzle-orm';
import {
  CLASSIFICATION_THRESHOLDS_DEFAULT,
  type ClassificationThresholds,
  type ClassificationThresholdsInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// Read tenant thresholds, merged with defaults. Missing rows or
// fields fall back to the plan-specified defaults. Result is
// always a complete ClassificationThresholds — the caller never
// has to re-check for missing keys.
export async function getThresholds(tenantId: string): Promise<ClassificationThresholds> {
  const [row] = await db
    .select({ settings: tenants.practiceSettings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const raw = row?.settings as { classificationThresholds?: Partial<ClassificationThresholds> } | null;
  const overrides = raw?.classificationThresholds ?? {};
  return {
    bucket3HighConfidence: overrides.bucket3HighConfidence ?? CLASSIFICATION_THRESHOLDS_DEFAULT.bucket3HighConfidence,
    bucket3HighVendorConsistency: overrides.bucket3HighVendorConsistency ?? CLASSIFICATION_THRESHOLDS_DEFAULT.bucket3HighVendorConsistency,
    bucket3MediumConfidence: overrides.bucket3MediumConfidence ?? CLASSIFICATION_THRESHOLDS_DEFAULT.bucket3MediumConfidence,
    bucket4Floor: overrides.bucket4Floor ?? CLASSIFICATION_THRESHOLDS_DEFAULT.bucket4Floor,
  };
}

// Write a partial override. Only fields present in the input are
// persisted; unspecified fields fall back to the defaults. To
// reset to full defaults, pass an empty object.
export async function setThresholds(
  tenantId: string,
  input: ClassificationThresholdsInput,
): Promise<ClassificationThresholds> {
  const [row] = await db
    .select({ settings: tenants.practiceSettings })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  if (!row) throw AppError.notFound('Tenant not found');

  const existing = (row.settings ?? {}) as Record<string, unknown>;
  const merged = {
    ...existing,
    classificationThresholds: {
      ...((existing['classificationThresholds'] as object | undefined) ?? {}),
      ...input,
    },
  };

  await db
    .update(tenants)
    .set({ practiceSettings: merged, updatedAt: new Date() })
    .where(eq(tenants.id, tenantId));

  return getThresholds(tenantId);
}
