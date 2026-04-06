import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { StorageProvider, FileMetadata, StorageResult, HealthResult } from './storage-provider.interface.js';

export class S3Provider implements StorageProvider {
  readonly name = 's3';
  readonly requiresOAuth = false;
  private client: S3Client;
  private bucket: string;
  private prefix: string;

  constructor(config: { bucket: string; region?: string; endpoint?: string; accessKeyId: string; secretAccessKey: string; prefix?: string }) {
    this.bucket = config.bucket;
    this.prefix = config.prefix || '';
    this.client = new S3Client({
      region: config.region || 'us-east-1',
      endpoint: config.endpoint || undefined,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      forcePathStyle: !!config.endpoint, // needed for MinIO/non-AWS
    });
  }

  private fullKey(key: string): string {
    return this.prefix ? `${this.prefix}/${key}` : key;
  }

  async upload(key: string, data: Buffer, metadata: FileMetadata): Promise<StorageResult> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: this.fullKey(key),
      Body: data,
      ContentType: metadata.mimeType,
    }));
    return { key, sizeBytes: data.length };
  }

  async download(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
    const body = res.Body;
    if (!body) throw new Error('Empty response from S3');
    return Buffer.from(await body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }));
      return true;
    } catch { return false; }
  }

  async getTemporaryUrl(key: string, expiresInSeconds: number): Promise<string | null> {
    try {
      return await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.fullKey(key) }), { expiresIn: expiresInSeconds });
    } catch { return null; }
  }

  async checkHealth(): Promise<HealthResult> {
    const start = Date.now();
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      return { status: 'healthy', latencyMs: Date.now() - start };
    } catch (err: any) {
      return { status: 'error', latencyMs: Date.now() - start, error: err.message };
    }
  }

  async getUsage(): Promise<{ usedBytes: number; totalBytes: number | null }> {
    // S3 doesn't have a native usage API — return 0 (could use ListObjects to calculate but expensive)
    return { usedBytes: 0, totalBytes: null };
  }
}
