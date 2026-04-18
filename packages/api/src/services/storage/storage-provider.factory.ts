// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { storageProviders } from '../../db/schema/index.js';
import { decrypt } from '../../utils/encryption.js';
import type { StorageProvider } from './storage-provider.interface.js';
import { LocalProvider } from './local.provider.js';
import { DropboxProvider } from './dropbox.provider.js';
import { GoogleDriveProvider } from './google-drive.provider.js';
import { OneDriveProvider } from './onedrive.provider.js';
import { S3Provider } from './s3.provider.js';
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

  // Default to local
  if (!record) {
    const provider = new LocalProvider();
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
    default:
      provider = new LocalProvider();
  }

  providerCache.set(tenantId, { provider, expiresAt: Date.now() + CACHE_TTL });
  return provider;
}

export function invalidateProviderCache(tenantId: string) {
  providerCache.delete(tenantId);
}
