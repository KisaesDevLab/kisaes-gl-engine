// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { PRACTICE_FEATURE_FLAGS } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, tenantFeatureFlags } from '../db/schema/index.js';
import * as featureFlagsService from './feature-flags.service.js';

let tenantId: string;

async function createTenant(): Promise<string> {
  const [tenant] = await db.insert(tenants).values({
    name: 'Flag Test',
    slug: 'flag-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  return tenant!.id;
}

async function cleanup(id: string) {
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, id));
  await db.delete(tenants).where(eq(tenants.id, id));
}

describe('feature-flags.service', () => {
  beforeEach(async () => {
    tenantId = await createTenant();
  });

  afterEach(async () => {
    await cleanup(tenantId);
  });

  describe('seedDefaultsForNewTenant', () => {
    it('inserts a row for every Practice flag, honoring the per-flag default', async () => {
      await featureFlagsService.seedDefaultsForNewTenant(tenantId);
      const flags = await featureFlagsService.listFlagsForTenant(tenantId);
      // Every flag in the catalog should have a row.
      expect(Object.keys(flags)).toHaveLength(PRACTICE_FEATURE_FLAGS.length);
      // FLAGS_DEFAULT_OFF_FOR_NEW_TENANTS is the source of truth for which
      // flags ship disabled on a fresh tenant. Re-deriving expected here
      // (rather than asserting all-true) prevents test/impl drift when the
      // OFF list changes.
      for (const key of PRACTICE_FEATURE_FLAGS) {
        const expected = !featureFlagsService.FLAGS_DEFAULT_OFF_FOR_NEW_TENANTS.has(key);
        expect(flags[key]?.enabled, `flag ${key} expected enabled=${expected}`).toBe(expected);
      }
    });

    it('is idempotent — re-running does not overwrite existing rows', async () => {
      await featureFlagsService.seedDefaultsForNewTenant(tenantId);
      // Flip one off
      await featureFlagsService.setFlag(tenantId, 'CLIENT_PORTAL_V1', { enabled: false });
      // Re-seed; the flipped row should stay off because of
      // ON CONFLICT DO NOTHING.
      await featureFlagsService.seedDefaultsForNewTenant(tenantId);
      const flags = await featureFlagsService.listFlagsForTenant(tenantId);
      expect(flags.CLIENT_PORTAL_V1?.enabled).toBe(false);
    });
  });

  describe('listFlagsForTenant', () => {
    it('returns disabled defaults for all eight flags when no rows exist', async () => {
      const flags = await featureFlagsService.listFlagsForTenant(tenantId);
      for (const key of PRACTICE_FEATURE_FLAGS) {
        expect(flags[key]?.enabled).toBe(false);
        expect(flags[key]?.rolloutPercent).toBe(0);
      }
    });

    it('ignores unknown flag keys stored in the DB', async () => {
      await db.insert(tenantFeatureFlags).values({
        tenantId,
        flagKey: 'SOMETHING_NOT_IN_CATALOG',
        enabled: true,
      });
      const flags = await featureFlagsService.listFlagsForTenant(tenantId);
      // Key isn't in the catalog, so the synthesized default for
      // every known flag is the only thing we see.
      expect(Object.keys(flags)).toHaveLength(PRACTICE_FEATURE_FLAGS.length);
    });

    it('scopes reads to the given tenant', async () => {
      const otherTenantId = await createTenant();
      try {
        await featureFlagsService.seedDefaultsForNewTenant(otherTenantId);
        // Our tenant has no rows; the listing should still show
        // disabled defaults for our tenant, not leak the other
        // tenant's enabled rows.
        const flags = await featureFlagsService.listFlagsForTenant(tenantId);
        for (const key of PRACTICE_FEATURE_FLAGS) {
          expect(flags[key]?.enabled).toBe(false);
        }
      } finally {
        await cleanup(otherTenantId);
      }
    });
  });

  describe('setFlag', () => {
    it('creates a row when none exists and returns before/after', async () => {
      const { before, after } = await featureFlagsService.setFlag(tenantId, 'CLOSE_REVIEW_V1', { enabled: true });
      expect(before.enabled).toBe(false);
      expect(after.enabled).toBe(true);
      expect(after.activatedAt).not.toBeNull();

      const [row] = await db
        .select()
        .from(tenantFeatureFlags)
        .where(and(eq(tenantFeatureFlags.tenantId, tenantId), eq(tenantFeatureFlags.flagKey, 'CLOSE_REVIEW_V1')));
      expect(row?.enabled).toBe(true);
    });

    it('updates an existing row', async () => {
      await featureFlagsService.seedDefaultsForNewTenant(tenantId);
      const { before, after } = await featureFlagsService.setFlag(tenantId, 'CLOSE_REVIEW_V1', { enabled: false });
      expect(before.enabled).toBe(true);
      expect(after.enabled).toBe(false);
    });

    it('rejects an unknown flag key', async () => {
      await expect(featureFlagsService.setFlag(tenantId, 'NOT_A_REAL_FLAG', { enabled: true }))
        .rejects.toThrow(/Unknown feature flag key/);
    });

    it('clears activatedAt when disabling', async () => {
      await featureFlagsService.setFlag(tenantId, 'CLOSE_REVIEW_V1', { enabled: true });
      await featureFlagsService.setFlag(tenantId, 'CLOSE_REVIEW_V1', { enabled: false });
      const flags = await featureFlagsService.listFlagsForTenant(tenantId);
      expect(flags.CLOSE_REVIEW_V1?.enabled).toBe(false);
      expect(flags.CLOSE_REVIEW_V1?.activatedAt).toBeNull();
    });
  });

  describe('isEnabled', () => {
    it('returns false when no row exists', async () => {
      expect(await featureFlagsService.isEnabled(tenantId, 'CLOSE_REVIEW_V1')).toBe(false);
    });

    it('returns the row value when present', async () => {
      await featureFlagsService.setFlag(tenantId, 'CLOSE_REVIEW_V1', { enabled: true });
      expect(await featureFlagsService.isEnabled(tenantId, 'CLOSE_REVIEW_V1')).toBe(true);
    });
  });
});
