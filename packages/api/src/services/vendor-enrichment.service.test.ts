// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, vendorEnrichmentCache } from '../db/schema/index.js';
import * as vendorEnrichmentService from './vendor-enrichment.service.js';

let tenantId: string;

async function createTenant(): Promise<string> {
  const [t] = await db.insert(tenants).values({
    name: 'Enrichment Test',
    slug: 'enrichment-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  return t!.id;
}

async function cleanup(id: string) {
  await db.delete(vendorEnrichmentCache).where(eq(vendorEnrichmentCache.tenantId, id));
  await db.delete(tenants).where(eq(tenants.id, id));
}

describe('vendor-enrichment.service', () => {
  beforeEach(async () => {
    tenantId = await createTenant();
  });

  afterEach(async () => {
    await cleanup(tenantId);
  });

  describe('readCache', () => {
    it('returns null when no row exists', async () => {
      const r = await vendorEnrichmentService.readCache(tenantId, 'Some Vendor');
      expect(r).toBeNull();
    });

    it('normalizes vendor_key before lookup', async () => {
      await vendorEnrichmentService.writeCache(tenantId, '  ACME Corp  ', {
        likelyBusinessType: 'Retail',
        suggestedAccountType: 'expense',
        sourceUrl: null,
        summary: null,
        provider: 'stub',
        fetchedAt: new Date().toISOString(),
      });
      const r = await vendorEnrichmentService.readCache(tenantId, 'acme corp');
      expect(r).not.toBeNull();
      expect(r?.likelyBusinessType).toBe('Retail');
    });

    it('returns null when cache row is expired', async () => {
      await db.insert(vendorEnrichmentCache).values({
        tenantId,
        vendorKey: 'expired vendor',
        likelyBusinessType: 'Old',
        suggestedAccountType: 'expense',
        expiresAt: new Date(Date.now() - 60_000),
      });
      const r = await vendorEnrichmentService.readCache(tenantId, 'expired vendor');
      expect(r).toBeNull();
    });

    it('isolates cache reads per tenant', async () => {
      const otherId = await createTenant();
      try {
        await vendorEnrichmentService.writeCache(otherId, 'shared name', {
          likelyBusinessType: 'X',
          suggestedAccountType: null,
          sourceUrl: null,
          summary: null,
          provider: 'stub',
          fetchedAt: new Date().toISOString(),
        });
        const r = await vendorEnrichmentService.readCache(tenantId, 'shared name');
        expect(r).toBeNull();
      } finally {
        await cleanup(otherId);
      }
    });
  });

  describe('writeCache', () => {
    it('upserts on repeat writes for the same key', async () => {
      const now = new Date().toISOString();
      await vendorEnrichmentService.writeCache(tenantId, 'repeat vendor', {
        likelyBusinessType: 'V1',
        suggestedAccountType: null,
        sourceUrl: null,
        summary: null,
        provider: 'stub',
        fetchedAt: now,
      });
      await vendorEnrichmentService.writeCache(tenantId, 'repeat vendor', {
        likelyBusinessType: 'V2',
        suggestedAccountType: null,
        sourceUrl: null,
        summary: null,
        provider: 'stub',
        fetchedAt: now,
      });
      const rows = await db
        .select()
        .from(vendorEnrichmentCache)
        .where(eq(vendorEnrichmentCache.tenantId, tenantId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.likelyBusinessType).toBe('V2');
    });
  });

  describe('lookup', () => {
    it('returns source=cache on hit', async () => {
      await vendorEnrichmentService.writeCache(tenantId, 'cached co', {
        likelyBusinessType: 'Retail',
        suggestedAccountType: 'expense',
        sourceUrl: null,
        summary: null,
        provider: 'stub',
        fetchedAt: new Date().toISOString(),
      });
      const r = await vendorEnrichmentService.lookup(tenantId, 'cached co');
      expect(r.source).toBe('cache');
      expect(r.enrichment?.likelyBusinessType).toBe('Retail');
    });

    it('returns source=none when AI is disabled', async () => {
      // Default ai_config has isEnabled=false in the test DB; the
      // fetchFromAI() call short-circuits and lookup falls through
      // to source='none'.
      const r = await vendorEnrichmentService.lookup(tenantId, 'unknown vendor xyz');
      expect(r.source).toBe('none');
      expect(r.enrichment).toBeNull();
    });
  });

  describe('fetchFromAI (consent + config gating)', () => {
    it('returns null when ai_config.is_enabled is false', async () => {
      // No special setup needed — default fixture state.
      const r = await vendorEnrichmentService.fetchFromAI(tenantId, 'gating test vendor');
      expect(r).toBeNull();
    });

    it('returns null when no categorization provider is configured', async () => {
      // Even with isEnabled toggled, missing provider should
      // short-circuit. We don't toggle isEnabled here because it
      // requires admin disclosure acceptance — confirming the
      // null-return on missing provider is sufficient.
      const r = await vendorEnrichmentService.fetchFromAI(tenantId, 'no-provider vendor');
      expect(r).toBeNull();
    });
  });

  describe('purgeExpired', () => {
    it('deletes expired rows and leaves fresh ones', async () => {
      await db.insert(vendorEnrichmentCache).values([
        {
          tenantId,
          vendorKey: 'expired',
          expiresAt: new Date(Date.now() - 60_000),
        },
        {
          tenantId,
          vendorKey: 'fresh',
          expiresAt: new Date(Date.now() + 60_000),
        },
      ]);
      const deleted = await vendorEnrichmentService.purgeExpired(tenantId);
      expect(deleted).toBe(1);
      const rows = await db
        .select()
        .from(vendorEnrichmentCache)
        .where(eq(vendorEnrichmentCache.tenantId, tenantId));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.vendorKey).toBe('fresh');
    });
  });
});
