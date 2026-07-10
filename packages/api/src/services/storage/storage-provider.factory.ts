// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { storageProviders } from '../../db/schema/index.js';
import { decrypt } from '../../utils/encryption.js';
import { env } from '../../config/env.js';
import type { StorageProvider } from './storage-provider.interface.js';
import { LocalProvider } from './local.provider.js';
import { DropboxProvider } from './dropbox.provider.js';
import { GoogleDriveProvider } from './google-drive.provider.js';
import { OneDriveProvider } from './onedrive.provider.js';
import { S3Provider } from './s3.provider.js';
import { B2Provider } from './b2.provider.js';
import { LocalFallbackProvider } from './local-fallback.provider.js';
import { ensureFreshAccessToken } from './oauth-refresh.js';

// Cache provider instances per tenant. Capped + periodic sweep so that an
// installation hosting many tenants doesn't keep every tenant's decrypted
// OAuth token resident in memory forever.
const providerCache = new Map<string, { provider: StorageProvider; expiresAt: number }>();
// 60s cache: short enough that a token refresh pushed through by
// ensureFreshAccessToken takes effect on the next storage op without
// needing an explicit invalidateProviderCache() call from the refresher.
// Previously 5 minutes, which meant a token refreshed on the factory's
// miss path lived in the cached provider for up to 5 minutes after the
// underlying DB row was updated.
const CACHE_TTL = 60 * 1000;
const PROVIDER_CACHE_MAX = 256;

function evictOldestProviderCacheEntry(): void {
  if (providerCache.size < PROVIDER_CACHE_MAX) return;
  const oldest = providerCache.keys().next().value;
  if (oldest !== undefined) providerCache.delete(oldest);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of providerCache) {
    if (entry.expiresAt < now) providerCache.delete(key);
  }
}, CACHE_TTL);

export async function getProviderForTenant(tenantId: string): Promise<StorageProvider> {
  // Check cache
  const cached = providerCache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.provider;
  evictOldestProviderCacheEntry();

  // Query active provider
  const record = await db.query.storageProviders.findFirst({
    where: and(eq(storageProviders.tenantId, tenantId), eq(storageProviders.isActive, true)),
  });

  // No tenant-level provider configured — fall back to the SYSTEM-level
  // default (super-admin setting; 'local' when unset, preserving the
  // original behavior). Tenants with their own active row are never
  // affected by the system setting.
  if (!record) {
    const provider = await getSystemStorageProvider();
    providerCache.set(tenantId, { provider, expiresAt: Date.now() + CACHE_TTL });
    return provider;
  }

  const config = (record.config || {}) as Record<string, any>;
  let provider: StorageProvider;

  switch (record.provider) {
    case 'local':
      provider = new LocalProvider(config['base_path']);
      break;
    case 'dropbox':
      if (!record.accessTokenEncrypted) throw new Error('Dropbox access token not configured');
      // ensureFreshAccessToken refreshes the token if it's within 60s of
      // expiry and persists the new one. Critical because Dropbox's newer
      // short-lived tokens expire in ~4 hours — without refresh, backup
      // uploads silently 401 after that window.
      provider = new DropboxProvider(
        await ensureFreshAccessToken(tenantId, 'dropbox', record),
        config,
      );
      break;
    case 'google_drive':
      if (!record.accessTokenEncrypted) throw new Error('Google Drive access token not configured');
      // Google access tokens expire in 1 hour. Without refresh the backup
      // scheduler fails silently after first run.
      provider = new GoogleDriveProvider(
        await ensureFreshAccessToken(tenantId, 'google_drive', record),
        config,
      );
      break;
    case 'onedrive':
      if (!record.accessTokenEncrypted) throw new Error('OneDrive access token not configured');
      provider = new OneDriveProvider(
        await ensureFreshAccessToken(tenantId, 'onedrive', record),
        config,
      );
      break;
    case 's3':
      if (!config['bucket'] || !config['accessKeyId']) throw new Error('S3 configuration incomplete');
      provider = new S3Provider({
        bucket: config['bucket'],
        region: config['region'],
        endpoint: config['endpoint'],
        accessKeyId: config['accessKeyId'],
        secretAccessKey: config['secretAccessKey'] ? decrypt(config['secretAccessKey']) : '',
        prefix: config['prefix'],
      });
      break;
    case 'b2':
      if (!config['bucket'] || !config['keyId'] || !config['endpoint']) throw new Error('Backblaze B2 configuration incomplete');
      provider = new B2Provider({
        bucket: config['bucket'],
        endpoint: config['endpoint'],
        keyId: config['keyId'],
        applicationKey: config['applicationKey'] ? decrypt(config['applicationKey']) : '',
        region: config['region'],
        prefix: config['prefix'],
      });
      break;
    default:
      provider = new LocalProvider();
  }

  providerCache.set(tenantId, { provider, expiresAt: Date.now() + CACHE_TTL });
  return provider;
}

export function invalidateProviderCache(tenantId: string) {
  providerCache.delete(tenantId);
}

// ─── System-level default provider ───────────────────────────────
//
// Resolution order:
//   1. STORAGE_SYSTEM_PROVIDER env var (deploy-time override for
//      headless installs) with its B2_* companion vars
//   2. DB-backed system_settings (storage_system_provider /
//      storage_system_config, managed from the admin panel)
//   3. LocalProvider (the historical default)
//
// Non-local system providers are wrapped in LocalFallbackProvider so
// files uploaded before the switch keep downloading from local disk
// until the tenant runs a storage migration.

let systemProviderCache: { provider: StorageProvider; expiresAt: number } | null = null;

async function resolveSystemStorageProvider(): Promise<StorageProvider> {
  // 1. Deploy-time env override
  if (env.STORAGE_SYSTEM_PROVIDER === 'local') return new LocalProvider();
  if (env.STORAGE_SYSTEM_PROVIDER === 'b2') {
    if (env.B2_BUCKET && env.B2_ENDPOINT && env.B2_KEY_ID && env.B2_APPLICATION_KEY) {
      return new LocalFallbackProvider(new B2Provider({
        bucket: env.B2_BUCKET,
        endpoint: env.B2_ENDPOINT,
        keyId: env.B2_KEY_ID,
        applicationKey: env.B2_APPLICATION_KEY,
        region: env.B2_REGION,
        prefix: env.B2_PREFIX,
      }));
    }
    console.warn('[storage] STORAGE_SYSTEM_PROVIDER=b2 set but B2_ENDPOINT/B2_BUCKET/B2_KEY_ID/B2_APPLICATION_KEY incomplete — falling back to the DB setting');
  }

  // 2. DB-backed admin setting. Dynamic import to keep the factory free
  // of a static dependency on the (large) admin service module.
  const { getSystemStorageConfig } = await import('../admin.service.js');
  const cfg = await getSystemStorageConfig();
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(cfg.storageSystemConfig) as Record<string, unknown>;
  } catch { /* empty/corrupt config → treated as unset */ }

  switch (cfg.storageSystemProvider) {
    case 'b2':
      if (!config['bucket'] || !config['keyId'] || !config['endpoint']) return new LocalProvider();
      return new LocalFallbackProvider(new B2Provider({
        bucket: config['bucket'] as string,
        endpoint: config['endpoint'] as string,
        keyId: config['keyId'] as string,
        applicationKey: config['application_key_encrypted'] ? decrypt(config['application_key_encrypted'] as string) : '',
        region: (config['region'] as string) || undefined,
        prefix: (config['prefix'] as string) || undefined,
      }));
    case 's3':
      if (!config['bucket'] || !config['accessKeyId']) return new LocalProvider();
      return new LocalFallbackProvider(new S3Provider({
        bucket: config['bucket'] as string,
        region: (config['region'] as string) || undefined,
        endpoint: (config['endpoint'] as string) || undefined,
        accessKeyId: config['accessKeyId'] as string,
        secretAccessKey: config['secret_access_key_encrypted'] ? decrypt(config['secret_access_key_encrypted'] as string) : '',
        prefix: (config['prefix'] as string) || undefined,
      }));
    default:
      return new LocalProvider();
  }
}

/**
 * The system-default storage provider — what a tenant WITHOUT their own
 * configured provider resolves to. Cached for CACHE_TTL like tenant
 * providers.
 */
export async function getSystemStorageProvider(): Promise<StorageProvider> {
  if (systemProviderCache && Date.now() < systemProviderCache.expiresAt) {
    return systemProviderCache.provider;
  }
  const provider = await resolveSystemStorageProvider();
  systemProviderCache = { provider, expiresAt: Date.now() + CACHE_TTL };
  return provider;
}

/**
 * Invalidate the system-default provider. Clears the whole per-tenant
 * cache too: every tenant without their own row cached the old system
 * default under their tenantId.
 */
export function invalidateSystemProviderCache(): void {
  systemProviderCache = null;
  providerCache.clear();
}
