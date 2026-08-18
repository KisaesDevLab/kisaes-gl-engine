// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import fs from 'fs';
import path from 'path';
import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage-provider.interface.js';

export class LocalProvider implements StorageProvider {
  readonly name = 'local';
  readonly requiresOAuth = false;
  private basePath: string;

  constructor(basePath: string = '/data/uploads') {
    this.basePath = process.env['UPLOAD_DIR'] || basePath;
  }

  private resolvePath(key: string): string {
    // Universal traversal guard: every read/write/delete on the local
    // provider goes through here, so a key from ANY caller (attachments,
    // DR restore bundles, exports) is confined to basePath. Absolute keys,
    // NUL bytes, backslashes and any `.` / `..` segment are refused, and
    // the resolved path must stay inside the root.
    if (typeof key !== 'string' || key.length === 0 || key.includes('\0') || key.includes('\\')) {
      throw new Error('Invalid storage key');
    }
    for (const seg of key.split('/')) {
      if (seg === '.' || seg === '..') throw new Error('Invalid storage key');
    }
    const root = path.resolve(this.basePath);
    const full = path.resolve(root, key.replace(/^\/+/, ''));
    if (full !== root && !full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  private ensureDir(filePath: string): void {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  async upload(key: string, data: Buffer, metadata: FileMetadata): Promise<StorageResult> {
    const filePath = this.resolvePath(key);
    this.ensureDir(filePath);
    fs.writeFileSync(filePath, data);
    return { key, sizeBytes: data.length };
  }

  async download(key: string): Promise<Buffer> {
    const filePath = this.resolvePath(key);
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${key}`);
    return fs.readFileSync(filePath);
  }

  async delete(key: string): Promise<void> {
    const filePath = this.resolvePath(key);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  async exists(key: string): Promise<boolean> {
    return fs.existsSync(this.resolvePath(key));
  }

  async getTemporaryUrl(_key: string, _expiresInSeconds: number): Promise<string | null> {
    return null; // Local files are served through the API, not via direct URLs
  }

  async checkHealth(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const testFile = path.join(this.basePath, '.health', 'test');
      // ensureDir creates dirname(arg) — pass the file path so the
      // .health directory itself gets created (previously the arg was
      // the .health dir, so only basePath was created and the write
      // below failed with ENOENT on any fresh basePath).
      this.ensureDir(testFile);
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);
      return { status: 'healthy', latencyMs: Date.now() - start };
    } catch (err: any) {
      return { status: 'error', latencyMs: Date.now() - start, error: err.message };
    }
  }

  async getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }> {
    // Simple recursive size calculation
    let total = 0;
    const walk = (dir: string) => {
      try {
        for (const entry of fs.readdirSync(dir)) {
          const fullPath = path.join(dir, entry);
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) walk(fullPath);
          else total += stat.size;
        }
      } catch { /* ignore access errors */ }
    };
    walk(this.basePath);
    return { usedBytes: total, totalBytes: null };
  }
}
