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

// Cache provider instances per tenant
const providerCache = new Map<string, { provider: StorageProvider; expiresAt: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getProviderForTenant(tenantId: string): Promise<StorageProvider> {
  // Check cache
  const cached = providerCache.get(tenantId);
  if (cached && Date.now() < cached.expiresAt) return cached.provider;

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
      provider = new DropboxProvider(decrypt(record.accessTokenEncrypted), config);
      break;
    case 'google_drive':
      if (!record.accessTokenEncrypted) throw new Error('Google Drive access token not configured');
      provider = new GoogleDriveProvider(decrypt(record.accessTokenEncrypted), config);
      break;
    case 'onedrive':
      if (!record.accessTokenEncrypted) throw new Error('OneDrive access token not configured');
      provider = new OneDriveProvider(decrypt(record.accessTokenEncrypted), config);
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
