// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { S3Provider } from './s3.provider.js';
import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage-provider.interface.js';

/**
 * Backblaze B2 storage provider.
 *
 * B2 exposes an S3-compatible API, so this is a thin wrapper around
 * S3Provider with the B2 field vocabulary mapped onto S3's:
 *   - keyID          → accessKeyId
 *   - applicationKey → secretAccessKey
 *   - endpoint       → https://s3.<region>.backblazeb2.com (path-style,
 *                      which S3Provider already forces whenever an
 *                      endpoint is set)
 *
 * A separate class (rather than reusing S3Provider directly) so that
 * `provider.name` is 'b2' — attachments stamp `storage_provider` from
 * that name, which is what the migration service counts by.
 */

export interface B2ProviderConfig {
  bucket: string;
  /** Full https endpoint, e.g. https://s3.us-west-004.backblazeb2.com */
  endpoint: string;
  /** B2 keyID (maps to S3 accessKeyId) */
  keyId: string;
  /** B2 applicationKey, already decrypted (maps to S3 secretAccessKey) */
  applicationKey: string;
  region?: string;
  prefix?: string;
}

/** Parse the region out of a B2 S3 endpoint (s3.<region>.backblazeb2.com). */
export function deriveB2Region(endpoint: string): string | undefined {
  const match = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint);
  return match?.[1];
}

/**
 * Map a B2 config to the S3Provider constructor shape. Exported as a
 * seam so tests can assert the field mapping without touching the
 * network-backed client.
 */
export function buildB2S3Config(config: B2ProviderConfig): {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix?: string;
} {
  return {
    bucket: config.bucket,
    // B2 requires a region in SigV4 signing; derive from the endpoint
    // when not supplied. 'us-east-1' is a harmless placeholder for
    // non-standard endpoints — B2 only checks the endpoint host.
    region: config.region || deriveB2Region(config.endpoint) || 'us-east-1',
    endpoint: config.endpoint,
    accessKeyId: config.keyId,
    secretAccessKey: config.applicationKey,
    prefix: config.prefix,
  };
}

export class B2Provider implements StorageProvider {
  readonly name = 'b2';
  readonly requiresOAuth = false;
  private inner: S3Provider;

  constructor(config: B2ProviderConfig) {
    this.inner = new S3Provider(buildB2S3Config(config));
  }

  upload(key: string, data: Buffer, metadata: FileMetadata): Promise<StorageResult> {
    return this.inner.upload(key, data, metadata);
  }

  download(key: string): Promise<Buffer> {
    return this.inner.download(key);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  exists(key: string): Promise<boolean> {
    return this.inner.exists(key);
  }

  getTemporaryUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    return this.inner.getTemporaryUrl(key, expiresInSeconds);
  }

  checkHealth(): Promise<HealthResult> {
    return this.inner.checkHealth();
  }

  getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }> {
    return this.inner.getUsage();
  }

  listObjects(subPrefix = '', maxKeys = 1000): Promise<Array<{ key: string; size: number; lastModified: string | null }>> {
    return this.inner.listObjects(subPrefix, maxKeys);
  }

  downloadToFile(key: string, destPath: string, maxBytes: number): Promise<number> {
    return this.inner.downloadToFile(key, destPath, maxBytes);
  }
}
