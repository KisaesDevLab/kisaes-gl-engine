// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { keyBelongsToTenant } from '../../utils/contained-path.js';
import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage-provider.interface.js';

/**
 * Confines a provider obtained for one tenant to that tenant's keys. Every
 * key a service passes to `getProviderForTenant(tenantId)` is read back
 * from a database row (attachments.storage_key, report pdf_url, ...); a
 * row that names another tenant's folder, or the appliance's `_system`
 * root, must not be able to read, overwrite or delete that file through
 * this tenant's provider. See utils/contained-path.ts keyBelongsToTenant.
 */
export class TenantScopedProvider implements StorageProvider {
  readonly name: string;
  readonly requiresOAuth: boolean;

  constructor(readonly inner: StorageProvider, readonly tenantId: string) {
    this.name = inner.name;
    this.requiresOAuth = inner.requiresOAuth;
  }

  private check(key: string): string {
    if (!keyBelongsToTenant(key, this.tenantId)) throw new Error('Storage key is outside the tenant scope');
    return key;
  }

  upload(key: string, data: Buffer, metadata: FileMetadata): Promise<StorageResult> {
    return this.inner.upload(this.check(key), data, metadata);
  }

  download(key: string): Promise<Buffer> {
    return this.inner.download(this.check(key));
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(this.check(key));
  }

  exists(key: string): Promise<boolean> {
    return this.inner.exists(this.check(key));
  }

  getTemporaryUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    return this.inner.getTemporaryUrl(this.check(key), expiresInSeconds);
  }

  checkHealth(): Promise<HealthResult> {
    return this.inner.checkHealth();
  }

  getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }> {
    return this.inner.getUsage();
  }
}

/** Unwraps the scope (storage migrations address the real provider). */
export function unscopedProvider(provider: StorageProvider): StorageProvider {
  return provider instanceof TenantScopedProvider ? provider.inner : provider;
}
