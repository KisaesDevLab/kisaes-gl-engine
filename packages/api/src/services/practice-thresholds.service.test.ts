// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { CLASSIFICATION_THRESHOLDS_DEFAULT } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants } from '../db/schema/index.js';
import * as thresholdsService from './practice-thresholds.service.js';

let tenantId: string;

async function createTenant(): Promise<string> {
  const [t] = await db.insert(tenants).values({
    name: 'Thresholds Test',
    slug: 'thresholds-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  return t!.id;
}

async function cleanup(id: string) {
  await db.delete(tenants).where(eq(tenants.id, id));
}

describe('practice-thresholds.service', () => {
  beforeEach(async () => {
    tenantId = await createTenant();
  });

  afterEach(async () => {
    await cleanup(tenantId);
  });

  it('returns full defaults for a tenant with no overrides', async () => {
    const t = await thresholdsService.getThresholds(tenantId);
    expect(t).toEqual(CLASSIFICATION_THRESHOLDS_DEFAULT);
  });

  it('persists partial overrides and merges with defaults on read', async () => {
    await thresholdsService.setThresholds(tenantId, { bucket3HighConfidence: 0.97 });
    const t = await thresholdsService.getThresholds(tenantId);
    expect(t.bucket3HighConfidence).toBe(0.97);
    expect(t.bucket3MediumConfidence).toBe(CLASSIFICATION_THRESHOLDS_DEFAULT.bucket3MediumConfidence);
    expect(t.bucket4Floor).toBe(CLASSIFICATION_THRESHOLDS_DEFAULT.bucket4Floor);
  });

  it('later set calls merge with existing overrides rather than replace', async () => {
    await thresholdsService.setThresholds(tenantId, { bucket3HighConfidence: 0.97 });
    await thresholdsService.setThresholds(tenantId, { bucket4Floor: 0.5 });
    const t = await thresholdsService.getThresholds(tenantId);
    expect(t.bucket3HighConfidence).toBe(0.97);
    expect(t.bucket4Floor).toBe(0.5);
  });

  it('preserves other practice_settings keys when writing thresholds', async () => {
    await db
      .update(tenants)
      .set({ practiceSettings: { otherKey: 'preserve-me' } })
      .where(eq(tenants.id, tenantId));
    await thresholdsService.setThresholds(tenantId, { bucket4Floor: 0.4 });
    const [row] = await db
      .select({ settings: tenants.practiceSettings })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const settings = row?.settings as Record<string, unknown>;
    expect(settings['otherKey']).toBe('preserve-me');
    expect((settings['classificationThresholds'] as any).bucket4Floor).toBe(0.4);
  });

  it('empty-object input resets nothing but returns defaults-merged', async () => {
    await thresholdsService.setThresholds(tenantId, { bucket4Floor: 0.5 });
    const t = await thresholdsService.setThresholds(tenantId, {});
    expect(t.bucket4Floor).toBe(0.5);
  });
});
