// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Readable } from 'stream';

export interface FileMetadata {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StorageResult {
  key: string;
  providerFileId?: string;
  sizeBytes: number;
  url?: string;
}

export interface HealthResult {
  status: 'healthy' | 'degraded' | 'error';
  latencyMs: number;
  error?: string;
}

export interface StorageProvider {
  readonly name: string;
  readonly requiresOAuth: boolean;

  upload(key: string, data: Buffer, metadata: FileMetadata): Promise<StorageResult>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  getTemporaryUrl(key: string, expiresInSeconds: number): Promise<string | null>;
  checkHealth(): Promise<HealthResult>;
  getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }>;
}
