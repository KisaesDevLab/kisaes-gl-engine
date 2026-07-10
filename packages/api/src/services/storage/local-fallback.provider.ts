// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage-provider.interface.js';
import { LocalProvider } from './local.provider.js';

/**
 * Read-through local fallback for the SYSTEM-default storage provider.
 *
 * When the super-admin flips the system default from local disk to a
 * remote provider (B2/S3), files uploaded before the switch still live
 * under UPLOAD_DIR. Tenants without their own storage_providers row
 * resolve to this wrapper: reads try the remote first, and on a miss
 * fall back to local disk so pre-migration files keep working until
 * the tenant runs a storage migration (Settings > File Storage).
 *
 * Only the system-default resolution path uses this wrapper — a tenant
 * who explicitly configured their own provider gets that provider
 * unwrapped, exactly as before (their downloads already have a
 * filesystem fallback in attachment.service for legacy files).
 *
 * New uploads always go to the remote provider.
 */
export class LocalFallbackProvider implements StorageProvider {
  readonly name: string;
  readonly requiresOAuth = false;
  private remote: StorageProvider;
  private local: LocalProvider;

  constructor(remote: StorageProvider, local: LocalProvider = new LocalProvider()) {
    this.remote = remote;
    this.local = local;
    // Report the remote's name so new attachments are stamped with the
    // real provider (that's what storage migrations count by).
    this.name = remote.name;
  }

  upload(key: string, data: Buffer, metadata: FileMetadata): Promise<StorageResult> {
    return this.remote.upload(key, data, metadata);
  }

  async download(key: string): Promise<Buffer> {
    try {
      return await this.remote.download(key);
    } catch (err) {
      if (await this.local.exists(key)) {
        console.warn(
          `[storage] Key not on system provider '${this.name}', serving from local disk (pre-migration file): ${key}`,
        );
        return this.local.download(key);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.remote.delete(key);
    // Also clear any pre-migration local copy so deletes don't leave
    // orphans behind (S3-style deletes of a missing key are silent
    // no-ops, so without this the local file would linger forever).
    if (await this.local.exists(key)) {
      await this.local.delete(key);
    }
  }

  async exists(key: string): Promise<boolean> {
    if (await this.remote.exists(key)) return true;
    return this.local.exists(key);
  }

  async getTemporaryUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    // A presigned URL for a key that only exists locally would 404 in
    // the user's browser — return null so callers fall back to the
    // API-served download path.
    if (await this.remote.exists(key)) {
      return this.remote.getTemporaryUrl(key, expiresInSeconds);
    }
    if (await this.local.exists(key)) return null;
    return this.remote.getTemporaryUrl(key, expiresInSeconds);
  }

  checkHealth(): Promise<HealthResult> {
    return this.remote.checkHealth();
  }

  getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }> {
    return this.remote.getUsage();
  }
}
