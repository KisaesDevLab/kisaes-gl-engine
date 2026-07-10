// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalFallbackProvider } from './local-fallback.provider.js';
import { LocalProvider } from './local.provider.js';
import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage-provider.interface.js';

let tmpDir: string;
let originalUploadDir: string | undefined;

/** Minimal remote stub: everything misses, calls are recorded. */
function makeRemoteStub(overrides: Partial<StorageProvider> = {}): StorageProvider & { uploads: string[]; deletes: string[] } {
  const uploads: string[] = [];
  const deletes: string[] = [];
  return {
    name: 'b2',
    requiresOAuth: false,
    uploads,
    deletes,
    async upload(key: string, data: Buffer, _metadata: FileMetadata): Promise<StorageResult> {
      uploads.push(key);
      return { key, sizeBytes: data.length };
    },
    async download(_key: string): Promise<Buffer> {
      throw new Error('NoSuchKey: The specified key does not exist.');
    },
    async delete(key: string): Promise<void> {
      deletes.push(key);
    },
    async exists(_key: string): Promise<boolean> {
      return false;
    },
    async getTemporaryUrl(_key: string, _expiresInSeconds: number): Promise<string | null> {
      return 'https://remote.example/presigned';
    },
    async checkHealth(): Promise<HealthResult> {
      return { status: 'healthy', latencyMs: 1 };
    },
    async getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }> {
      return { usedBytes: 0, totalBytes: null };
    },
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-fallback-'));
  originalUploadDir = process.env['UPLOAD_DIR'];
  // LocalProvider reads UPLOAD_DIR at construction time
  process.env['UPLOAD_DIR'] = tmpDir;
});

afterEach(() => {
  if (originalUploadDir === undefined) delete process.env['UPLOAD_DIR'];
  else process.env['UPLOAD_DIR'] = originalUploadDir;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeLocalFile(key: string, content: string) {
  const filePath = path.join(tmpDir, key);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

describe('LocalFallbackProvider', () => {
  it('reports the remote provider name', () => {
    const wrapper = new LocalFallbackProvider(makeRemoteStub(), new LocalProvider());
    expect(wrapper.name).toBe('b2');
  });

  it('serves a pre-migration file from local disk when the remote misses', async () => {
    const key = 'attachments/tenant-1/old-file.txt';
    writeLocalFile(key, 'pre-migration content');
    const wrapper = new LocalFallbackProvider(makeRemoteStub(), new LocalProvider());

    const data = await wrapper.download(key);
    expect(data.toString()).toBe('pre-migration content');
  });

  it('rethrows the remote error when the key exists nowhere', async () => {
    const wrapper = new LocalFallbackProvider(makeRemoteStub(), new LocalProvider());
    await expect(wrapper.download('attachments/tenant-1/missing.txt')).rejects.toThrow('NoSuchKey');
  });

  it('prefers the remote copy when it exists', async () => {
    const key = 'attachments/tenant-1/migrated.txt';
    writeLocalFile(key, 'stale local copy');
    const remote = makeRemoteStub({
      async download(_key: string): Promise<Buffer> {
        return Buffer.from('fresh remote copy');
      },
    });
    const wrapper = new LocalFallbackProvider(remote, new LocalProvider());

    const data = await wrapper.download(key);
    expect(data.toString()).toBe('fresh remote copy');
  });

  it('routes uploads to the remote only', async () => {
    const remote = makeRemoteStub();
    const wrapper = new LocalFallbackProvider(remote, new LocalProvider());
    const key = 'attachments/tenant-1/new-file.txt';

    await wrapper.upload(key, Buffer.from('new'), { fileName: 'new-file.txt', mimeType: 'text/plain', sizeBytes: 3 });

    expect(remote.uploads).toEqual([key]);
    expect(fs.existsSync(path.join(tmpDir, key))).toBe(false);
  });

  it('exists() is true when the file only lives locally', async () => {
    const key = 'attachments/tenant-1/local-only.txt';
    writeLocalFile(key, 'x');
    const wrapper = new LocalFallbackProvider(makeRemoteStub(), new LocalProvider());
    expect(await wrapper.exists(key)).toBe(true);
    expect(await wrapper.exists('attachments/tenant-1/nowhere.txt')).toBe(false);
  });

  it('delete() clears the pre-migration local copy too', async () => {
    const key = 'attachments/tenant-1/deleted.txt';
    writeLocalFile(key, 'x');
    const remote = makeRemoteStub();
    const wrapper = new LocalFallbackProvider(remote, new LocalProvider());

    await wrapper.delete(key);

    expect(remote.deletes).toEqual([key]);
    expect(fs.existsSync(path.join(tmpDir, key))).toBe(false);
  });

  it('returns null for a temporary URL when the key only exists locally', async () => {
    const key = 'attachments/tenant-1/local-only.txt';
    writeLocalFile(key, 'x');
    const wrapper = new LocalFallbackProvider(makeRemoteStub(), new LocalProvider());
    // Presigned URL for a key only on disk would 404 — callers fall
    // back to the API-served download path on null.
    expect(await wrapper.getTemporaryUrl(key, 60)).toBeNull();
  });

  it('returns the remote temporary URL when the key exists remotely', async () => {
    const remote = makeRemoteStub({
      async exists(_key: string): Promise<boolean> { return true; },
    });
    const wrapper = new LocalFallbackProvider(remote, new LocalProvider());
    expect(await wrapper.getTemporaryUrl('any-key', 60)).toBe('https://remote.example/presigned');
  });
});
