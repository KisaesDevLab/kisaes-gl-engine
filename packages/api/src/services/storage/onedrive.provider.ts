import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage-provider.interface.js';

export class OneDriveProvider implements StorageProvider {
  readonly name = 'onedrive';
  readonly requiresOAuth = true;
  private accessToken: string;
  private folderId: string;

  constructor(accessToken: string, config: { folder_id?: string; drive_id?: string } = {}) {
    this.accessToken = accessToken;
    this.folderId = config.folder_id || 'root';
  }

  private headers(): Record<string, string> {
    return { 'Authorization': `Bearer ${this.accessToken}` };
  }

  async upload(key: string, data: Buffer, metadata: FileMetadata): Promise<StorageResult> {
    const fileName = key.split('/').pop()!;
    // Small files (< 4MB): direct upload
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${this.folderId}:/${fileName}:/content`, {
      method: 'PUT',
      headers: { ...this.headers(), 'Content-Type': metadata.mimeType },
      body: data,
    });
    if (!res.ok) throw new Error(`OneDrive upload failed: ${res.status}`);
    const result = await res.json() as any;
    return { key, providerFileId: result.id, sizeBytes: result.size };
  }

  async download(key: string): Promise<Buffer> {
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${key}/content`, { headers: this.headers() });
    if (!res.ok) throw new Error(`OneDrive download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${key}`, { method: 'DELETE', headers: this.headers() });
  }

  async exists(key: string): Promise<boolean> {
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${key}`, { headers: this.headers() });
    return res.ok;
  }

  async getTemporaryUrl(key: string, _expiresInSeconds: number): Promise<string | null> {
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/items/${key}?select=@microsoft.graph.downloadUrl`, { headers: this.headers() });
    if (!res.ok) return null;
    const data = await res.json() as any;
    return data['@microsoft.graph.downloadUrl'] || null;
  }

  async checkHealth(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me/drive', { headers: this.headers() });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      return { status: 'healthy', latencyMs: Date.now() - start };
    } catch (err: any) {
      return { status: 'error', latencyMs: Date.now() - start, error: err.message };
    }
  }

  async getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }> {
    try {
      const res = await fetch('https://graph.microsoft.com/v1.0/me/drive', { headers: this.headers() });
      const data = await res.json() as any;
      return { usedBytes: data.quota?.used || 0, totalBytes: data.quota?.total || null };
    } catch { return { usedBytes: 0, totalBytes: null }; }
  }
}
