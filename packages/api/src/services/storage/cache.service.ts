// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import fs from 'fs';
import path from 'path';
import { eq, and, lt } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { attachments } from '../../db/schema/index.js';
import { getProviderForTenant } from './storage-provider.factory.js';

const CACHE_DIR = process.env['STORAGE_CACHE_DIR'] || '/data/cache';
const CACHE_TTL_HOURS = parseInt(process.env['STORAGE_CACHE_TTL_HOURS'] || '24');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Ensure a cloud-stored file has a local copy for processing (OCR, thumbnails, etc.)
 * Returns the local file path.
 */
export async function ensureLocal(tenantId: string, attachmentId: string): Promise<string> {
  const attachment = await db.query.attachments.findFirst({
    where: and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)),
  });
  if (!attachment) throw new Error('Attachment not found');

  // If local provider or already cached
  if (attachment.storageProvider === 'local' && attachment.filePath) {
    return attachment.filePath;
  }

  if (attachment.localCachePath && attachment.cacheExpiresAt && new Date() < new Date(attachment.cacheExpiresAt)) {
    if (fs.existsSync(attachment.localCachePath)) return attachment.localCachePath;
  }

  // Download from cloud provider
  const provider = await getProviderForTenant(tenantId);
  const key = attachment.storageKey || attachment.filePath;
  if (!key) throw new Error('No storage key for attachment');

  // Use provider_file_id for cloud providers that use their own IDs
  const downloadKey = attachment.providerFileId || key;
  const data = await provider.download(downloadKey);

  // Save to cache
  const ext = path.extname(attachment.fileName || 'file');
  const cachePath = path.join(CACHE_DIR, tenantId, `${attachment.id}${ext}`);
  ensureDir(path.dirname(cachePath));
  fs.writeFileSync(cachePath, data);

  // Update attachment record
  const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000);
  await db.update(attachments).set({ localCachePath: cachePath, cacheExpiresAt: expiresAt }).where(eq(attachments.id, attachmentId));

  return cachePath;
}

/**
 * Evict expired cache files
 */
export async function evictExpired(): Promise<number> {
  const expired = await db.select({ id: attachments.id, localCachePath: attachments.localCachePath })
    .from(attachments)
    .where(and(lt(attachments.cacheExpiresAt, new Date())));

  let evicted = 0;
  for (const item of expired) {
    if (item.localCachePath && fs.existsSync(item.localCachePath)) {
      try { fs.unlinkSync(item.localCachePath); evicted++; } catch { /* ignore */ }
    }
    await db.update(attachments).set({ localCachePath: null, cacheExpiresAt: null }).where(eq(attachments.id, item.id));
  }
  return evicted;
}

/**
 * Clear all cache for a tenant (used during provider migration)
 */
export async function evictForTenant(tenantId: string): Promise<void> {
  const tenantCacheDir = path.join(CACHE_DIR, tenantId);
  if (fs.existsSync(tenantCacheDir)) {
    fs.rmSync(tenantCacheDir, { recursive: true, force: true });
  }
  await db.update(attachments).set({ localCachePath: null, cacheExpiresAt: null }).where(eq(attachments.tenantId, tenantId));
}
