import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage-provider.interface.js';

export class GoogleDriveProvider implements StorageProvider {
  readonly name = 'google_drive';
  readonly requiresOAuth = true;
  private accessToken: string;
  private folderId: string;

  constructor(accessToken: string, config: { folder_id?: string } = {}) {
    this.accessToken = accessToken;
    this.folderId = config.folder_id || 'root';
  }

  private headers(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.accessToken}` };
  }

  async upload(key: string, data: Buffer, metadata: FileMetadata): Promise<StorageResult> {
    const boundary = '---kisbooks-boundary';
    const metadataPart = JSON.stringify({ name: key.split('/').pop(), parents: [this.folderId], mimeType: metadata.mimeType });
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n--${boundary}\r\nContent-Type: ${metadata.mimeType}\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--`),
    ]);

    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { ...this.headers(), 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!res.ok) throw new Error(`Google Drive upload failed: ${res.status}`);
    const result = await res.json() as any;
    return { key, providerFileId: result.id, sizeBytes: data.length };
  }

  async download(key: string): Promise<Buffer> {
    // key is actually the file ID for Google Drive
    const fileId = key; // Use provider_file_id
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Google Drive download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await fetch(`https://www.googleapis.com/drive/v3/files/${key}`, { method: 'DELETE', headers: this.headers() });
  }

  async exists(key: string): Promise<boolean> {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${key}?fields=id`, { headers: this.headers() });
    return res.ok;
  }

  async getTemporaryUrl(key: string, _expiresInSeconds: number): Promise<string | null> {
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${key}?fields=webContentLink`, { headers: this.headers() });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data.webContentLink || null;
  }

  async checkHealth(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: this.headers() });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      return { status: 'healthy', latencyMs: Date.now() - start };
    } catch (err: any) {
      return { status: 'error', latencyMs: Date.now() - start, error: err.message };
    }
  }

  async getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }> {
    try {
      const res = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', { headers: this.headers() });
      const data = await res.json() as any;
      return { usedBytes: parseInt(data.storageQuota?.usage || '0'), totalBytes: parseInt(data.storageQuota?.limit || '0') || null };
    } catch { return { usedBytes: 0, totalBytes: null }; }
  }
}
