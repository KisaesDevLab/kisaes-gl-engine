import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage-provider.interface.js';

export class DropboxProvider implements StorageProvider {
  readonly name = 'dropbox';
  readonly requiresOAuth = true;
  private accessToken: string;
  private rootFolder: string;

  constructor(accessToken: string, config: { root_folder?: string } = {}) {
    this.accessToken = accessToken;
    this.rootFolder = config.root_folder || '/Vibe MyBooks';
  }

  private fullPath(key: string): string {
    return `${this.rootFolder}/${key}`;
  }

  private async apiCall(url: string, body: any, isContent = false): Promise<any> {
    const headers: Record<string, string> = { 'Authorization': `Bearer ${this.accessToken}` };
    if (isContent) {
      headers['Dropbox-API-Arg'] = JSON.stringify(body);
      headers['Content-Type'] = 'application/octet-stream';
    } else {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: isContent ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const err: any = new Error(`Dropbox API error: ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return isContent ? res : res.json();
  }

  async upload(key: string, data: Buffer, metadata: FileMetadata): Promise<StorageResult> {
    const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: this.fullPath(key), mode: 'overwrite', autorename: false }),
        'Content-Type': 'application/octet-stream',
      },
      body: data,
    });
    if (!res.ok) throw new Error(`Dropbox upload failed: ${res.status}`);
    const result = await res.json() as any;
    return { key, providerFileId: result.rev, sizeBytes: result.size };
  }

  async download(key: string): Promise<Buffer> {
    const res = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Dropbox-API-Arg': JSON.stringify({ path: this.fullPath(key) }),
      },
    });
    if (!res.ok) throw new Error(`Dropbox download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.apiCall('https://api.dropboxapi.com/2/files/delete_v2', { path: this.fullPath(key) });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.apiCall('https://api.dropboxapi.com/2/files/get_metadata', { path: this.fullPath(key) });
      return true;
    } catch { return false; }
  }

  async getTemporaryUrl(key: string, _expiresInSeconds: number): Promise<string | null> {
    try {
      const res = await this.apiCall('https://api.dropboxapi.com/2/files/get_temporary_link', { path: this.fullPath(key) });
      return res.link;
    } catch { return null; }
  }

  async checkHealth(): Promise<HealthResult> {
    const start = Date.now();
    try {
      await this.apiCall('https://api.dropboxapi.com/2/users/get_current_account', null);
      return { status: 'healthy', latencyMs: Date.now() - start };
    } catch (err: any) {
      return { status: 'error', latencyMs: Date.now() - start, error: err.message };
    }
  }

  async getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }> {
    try {
      const res = await this.apiCall('https://api.dropboxapi.com/2/users/get_space_usage', null);
      return { usedBytes: res.used || 0, totalBytes: res.allocation?.allocated || null };
    } catch { return { usedBytes: 0, totalBytes: null }; }
  }
}
