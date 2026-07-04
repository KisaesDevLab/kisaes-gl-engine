// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// System-default storage resolution (system-level B2/S3 file storage).
// Verifies the factory's fallback chain for tenants WITHOUT their own
// storage_providers row: env override > DB system setting > local —
// and that tenants WITH their own active row are never affected.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { tenants, storageProviders, systemSettings } from '../../db/schema/index.js';
import { encrypt } from '../../utils/encryption.js';
import { env } from '../../config/env.js';
import { saveSystemStorageConfig } from '../admin.service.js';
import {
  getProviderForTenant,
  getSystemStorageProvider,
  invalidateProviderCache,
  invalidateSystemProviderCache,
} from './storage-provider.factory.js';

const SETTING_KEYS = ['storage_system_provider', 'storage_system_config'];
const TENANT_SLUG = 'storage-factory-system-test';

let tenantId: string;

async function cleanup() {
  await db.delete(systemSettings).where(inArray(systemSettings.key, SETTING_KEYS));
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.slug, TENANT_SLUG) });
  if (tenant) {
    await db.delete(storageProviders).where(eq(storageProviders.tenantId, tenant.id));
    await db.delete(tenants).where(eq(tenants.id, tenant.id));
  }
  invalidateSystemProviderCache();
}

function b2SystemConfig() {
  return JSON.stringify({
    bucket: 'system-bucket',
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    keyId: 'system-key-id',
    application_key_encrypted: encrypt('system-app-key'),
    region: '',
    prefix: '',
  });
}

beforeEach(async () => {
  await cleanup();
  const [tenant] = await db.insert(tenants).values({ name: 'Factory Test', slug: TENANT_SLUG }).returning();
  tenantId = tenant!.id;
});

afterEach(async () => {
  await cleanup();
});

describe('system-default storage provider', () => {
  it('defaults to local when no system setting exists (historical behavior)', async () => {
    const provider = await getProviderForTenant(crypto.randomUUID());
    expect(provider.name).toBe('local');
  });

  it('resolves tenants without their own provider to the system B2 setting', async () => {
    await saveSystemStorageConfig({ storageSystemProvider: 'b2', storageSystemConfig: b2SystemConfig() });
    invalidateSystemProviderCache();

    const provider = await getProviderForTenant(crypto.randomUUID());
    expect(provider.name).toBe('b2');
  });

  it('falls back to local when the b2 system config is incomplete', async () => {
    await saveSystemStorageConfig({
      storageSystemProvider: 'b2',
      storageSystemConfig: JSON.stringify({ bucket: 'only-a-bucket' }),
    });
    invalidateSystemProviderCache();

    const provider = await getProviderForTenant(crypto.randomUUID());
    expect(provider.name).toBe('local');
  });

  it('resolves a system s3 setting for tenants without their own provider', async () => {
    await saveSystemStorageConfig({
      storageSystemProvider: 's3',
      storageSystemConfig: JSON.stringify({
        bucket: 'sys-s3-bucket',
        accessKeyId: 'sys-access-key',
        secret_access_key_encrypted: encrypt('sys-secret'),
        region: 'us-east-1',
      }),
    });
    invalidateSystemProviderCache();

    const provider = await getProviderForTenant(crypto.randomUUID());
    expect(provider.name).toBe('s3');
  });

  it('never affects a tenant with their own active provider', async () => {
    await saveSystemStorageConfig({ storageSystemProvider: 'b2', storageSystemConfig: b2SystemConfig() });
    invalidateSystemProviderCache();

    await db.insert(storageProviders).values({
      tenantId,
      provider: 's3',
      isActive: true,
      config: {
        bucket: 'tenant-bucket',
        accessKeyId: 'tenant-key',
        secretAccessKey: encrypt('tenant-secret'),
        region: 'us-east-1',
      },
      healthStatus: 'healthy',
      displayName: 'S3 Storage',
    });
    invalidateProviderCache(tenantId);

    const provider = await getProviderForTenant(tenantId);
    expect(provider.name).toBe('s3');
  });

  it('resolves a tenant-configured b2 row via the factory switch', async () => {
    await db.insert(storageProviders).values({
      tenantId,
      provider: 'b2',
      isActive: true,
      config: {
        bucket: 'tenant-b2-bucket',
        endpoint: 'https://s3.eu-central-003.backblazeb2.com',
        keyId: 'tenant-key-id',
        applicationKey: encrypt('tenant-app-key'),
      },
      healthStatus: 'healthy',
      displayName: 'Backblaze B2',
    });
    invalidateProviderCache(tenantId);

    const provider = await getProviderForTenant(tenantId);
    expect(provider.name).toBe('b2');
  });

  it('invalidateSystemProviderCache picks up a changed system setting', async () => {
    // Prime the cache with 'local'
    const before = await getProviderForTenant(crypto.randomUUID());
    expect(before.name).toBe('local');

    await saveSystemStorageConfig({ storageSystemProvider: 'b2', storageSystemConfig: b2SystemConfig() });
    invalidateSystemProviderCache();

    const after = await getSystemStorageProvider();
    expect(after.name).toBe('b2');

    // Flip back to local and confirm the change takes effect too
    await saveSystemStorageConfig({ storageSystemProvider: 'local' });
    invalidateSystemProviderCache();
    expect((await getSystemStorageProvider()).name).toBe('local');
  });

  it('honors the STORAGE_SYSTEM_PROVIDER env override over the DB setting', async () => {
    await saveSystemStorageConfig({ storageSystemProvider: 'local' });
    const original = {
      provider: env.STORAGE_SYSTEM_PROVIDER,
      endpoint: env.B2_ENDPOINT,
      bucket: env.B2_BUCKET,
      keyId: env.B2_KEY_ID,
      appKey: env.B2_APPLICATION_KEY,
    };
    try {
      env.STORAGE_SYSTEM_PROVIDER = 'b2';
      env.B2_ENDPOINT = 'https://s3.us-west-004.backblazeb2.com';
      env.B2_BUCKET = 'env-bucket';
      env.B2_KEY_ID = 'env-key-id';
      env.B2_APPLICATION_KEY = 'env-app-key';
      invalidateSystemProviderCache();

      const provider = await getSystemStorageProvider();
      expect(provider.name).toBe('b2');
    } finally {
      env.STORAGE_SYSTEM_PROVIDER = original.provider;
      env.B2_ENDPOINT = original.endpoint;
      env.B2_BUCKET = original.bucket;
      env.B2_KEY_ID = original.keyId;
      env.B2_APPLICATION_KEY = original.appKey;
      invalidateSystemProviderCache();
    }
  });

  it('falls back to the DB setting when the env override is incomplete', async () => {
    await saveSystemStorageConfig({ storageSystemProvider: 'local' });
    const original = { provider: env.STORAGE_SYSTEM_PROVIDER, bucket: env.B2_BUCKET };
    try {
      env.STORAGE_SYSTEM_PROVIDER = 'b2';
      env.B2_BUCKET = undefined; // missing companion vars
      invalidateSystemProviderCache();

      const provider = await getSystemStorageProvider();
      expect(provider.name).toBe('local');
    } finally {
      env.STORAGE_SYSTEM_PROVIDER = original.provider;
      env.B2_BUCKET = original.bucket;
      invalidateSystemProviderCache();
    }
  });
});
