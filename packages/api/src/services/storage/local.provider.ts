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
    return path.join(this.basePath, key);
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
      this.ensureDir(path.join(this.basePath, '.health'));
      const testFile = path.join(this.basePath, '.health', 'test');
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
