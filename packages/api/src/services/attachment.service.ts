// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import { eq, and, count, inArray, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { tenantStorageKey } from './storage/storage-keys.js';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Resolves a filePath (stored in the DB as "/uploads/<tenant>/attachments/<uuid>.ext",
// or "/uploads/attachments/<tenant>/<uuid>.ext" for pre-layout-change rows)
// to an absolute path under UPLOAD_DIR and refuses anything that escapes the
// root via "..", symlinks, or absolute overrides. The DB value is considered
// trusted today, but these defenses are cheap and protect against any future
// primitive that lets a user influence filePath.
function resolveUploadPath(filePath: string): string {
  const rel = filePath.replace(/^\/uploads\//, '');
  const root = path.resolve(env.UPLOAD_DIR);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw AppError.notFound('File not found');
  }
  return resolved;
}

export async function upload(
  tenantId: string,
  file: { originalname: string; buffer: Buffer; mimetype: string; size: number },
  attachableType: string,
  attachableId: string,
) {
  if (file.size > env.MAX_FILE_SIZE_MB * 1024 * 1024) {
    throw AppError.badRequest(`File exceeds maximum size of ${env.MAX_FILE_SIZE_MB}MB`);
  }

  const ext = path.extname(file.originalname);
  const uuid = crypto.randomUUID();
  const storageKey = tenantStorageKey(tenantId, 'attachments', `${uuid}${ext}`);

  // Upload via storage provider (local or cloud)
  let providerFileId: string | undefined;
  let storageProviderName = 'local';
  try {
    const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
    const provider = await getProviderForTenant(tenantId);
    storageProviderName = provider.name;
    const result = await provider.upload(storageKey, file.buffer, {
      fileName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size,
    });
    providerFileId = result.providerFileId;
  } catch {
    // Fallback to direct local write if provider resolution fails.
    // Mirror LocalProvider's layout (UPLOAD_DIR/<storageKey>) so the
    // stored key resolves the same file either way.
    const fallbackPath = path.join(env.UPLOAD_DIR, storageKey);
    ensureDir(path.dirname(fallbackPath));
    fs.writeFileSync(fallbackPath, file.buffer);
  }

  const [attachment] = await db.insert(attachments).values({
    tenantId,
    fileName: file.originalname,
    filePath: `/uploads/${storageKey}`,
    fileSize: file.size,
    mimeType: file.mimetype,
    attachableType,
    attachableId,
    storageKey,
    storageProvider: storageProviderName,
    providerFileId: providerFileId || null,
  }).returning();

  // Auto-trigger AI classification + OCR for images
  if (attachment && file.mimetype.startsWith('image/')) {
    triggerAutoClassify(tenantId, attachment.id).catch(() => {});
  }

  return attachment;
}

async function triggerAutoClassify(tenantId: string, attachmentId: string) {
  try {
    const { getConfig } = await import('./ai-config.service.js');
    const config = await getConfig();
    if (!config.isEnabled || !config.autoOcrOnUpload) return;

    const { classifyAndRoute } = await import('./ai-document-classifier.service.js');
    await classifyAndRoute(tenantId, attachmentId);
  } catch {
    // AI processing is best-effort — don't fail the upload
  }
}

export async function list(tenantId: string, filters?: { attachableType?: string; attachableId?: string; limit?: number; offset?: number }) {
  const conditions = [eq(attachments.tenantId, tenantId)];
  if (filters?.attachableType) conditions.push(eq(attachments.attachableType, filters.attachableType));
  if (filters?.attachableId) conditions.push(eq(attachments.attachableId, filters.attachableId));

  const [data, total] = await Promise.all([
    db.select().from(attachments).where(and(...conditions))
      .limit(filters?.limit ?? 50).offset(filters?.offset ?? 0),
    db.select({ count: count() }).from(attachments).where(and(...conditions)),
  ]);

  return { data, total: total[0]?.count ?? 0 };
}

export async function getById(tenantId: string, id: string) {
  const attachment = await db.query.attachments.findFirst({
    where: and(eq(attachments.tenantId, tenantId), eq(attachments.id, id)),
  });
  if (!attachment) throw AppError.notFound('Attachment not found');
  return attachment;
}

export async function download(tenantId: string, id: string) {
  const attachment = await getById(tenantId, id);

  // Use storage provider for download
  try {
    const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
    const provider = await getProviderForTenant(tenantId);
    const key = attachment.providerFileId || attachment.storageKey || attachment.filePath;
    if (!key) throw new Error('No storage key');
    const data = await provider.download(key);
    const { Readable } = await import('stream');
    return { stream: Readable.from(data), attachment };
  } catch {
    // Fallback to direct filesystem for backward compatibility
    const fullPath = resolveUploadPath(attachment.filePath);
    if (!fs.existsSync(fullPath)) throw AppError.notFound('File not found');
    return { stream: fs.createReadStream(fullPath), attachment };
  }
}

// Fetch an attachment's raw bytes — provider-first with the same
// direct-filesystem fallback as download() above. Kept in lockstep with
// download(): storage key preference is providerFileId > storageKey >
// filePath, and any provider failure falls back to UPLOAD_DIR.
async function readAttachmentBytes(
  tenantId: string,
  attachment: { providerFileId: string | null; storageKey: string | null; filePath: string },
): Promise<Buffer> {
  try {
    const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
    const provider = await getProviderForTenant(tenantId);
    const key = attachment.providerFileId || attachment.storageKey || attachment.filePath;
    if (!key) throw new Error('No storage key');
    return await provider.download(key);
  } catch {
    const fullPath = resolveUploadPath(attachment.filePath);
    if (!fs.existsSync(fullPath)) throw AppError.notFound('File not found');
    return fs.readFileSync(fullPath);
  }
}

// Zip entry names must be unique or extractors silently overwrite; collide
// on "receipt.pdf" twice and the second becomes "receipt (1).pdf".
function zipEntryName(used: Set<string>, fileName: string | null): string {
  // Flatten path separators — entries are plain file names, never nested.
  const base = (fileName || 'file').replace(/[\\/]+/g, '_');
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export interface BulkDownloadSkipped {
  id: string;
  fileName: string;
  reason: string;
}

export interface BulkDownloadResult {
  archive: ReturnType<typeof archiver>;
  done: Promise<{ included: number; skipped: BulkDownloadSkipped[] }>;
}

/**
 * Build a ZIP of several attachments. Every id must belong to `tenantId`
 * (404 otherwise, matching the single-download behavior). Returns the
 * archiver stream (pipe it to the response before awaiting `done`) plus a
 * `done` promise that resolves once every entry has been appended and the
 * archive finalized. A file whose bytes can't be fetched never fails the
 * whole zip — it's recorded in `skipped` and listed in a manifest.txt entry.
 */
export async function bulkDownload(tenantId: string, attachmentIds: string[]): Promise<BulkDownloadResult> {
  const uniqueIds = Array.from(new Set(attachmentIds));
  const rows = await db.select().from(attachments)
    .where(and(eq(attachments.tenantId, tenantId), inArray(attachments.id, uniqueIds)));
  if (rows.length !== uniqueIds.length) throw AppError.notFound('Attachment not found');

  const archive = archiver('zip', { zlib: { level: 6 } });
  const skipped: BulkDownloadSkipped[] = [];

  const done = (async () => {
    const usedNames = new Set<string>();
    for (const att of rows) {
      try {
        const bytes = await readAttachmentBytes(tenantId, att);
        archive.append(bytes, { name: zipEntryName(usedNames, att.fileName) });
      } catch (err) {
        skipped.push({
          id: att.id,
          fileName: att.fileName || att.id,
          reason: err instanceof Error ? err.message : 'File could not be read',
        });
      }
    }
    if (skipped.length > 0) {
      const lines = [
        'Some files could not be included in this archive:',
        '',
        ...skipped.map((s) => `- ${s.fileName} (${s.id}): ${s.reason}`),
      ];
      archive.append(Buffer.from(lines.join('\n') + '\n', 'utf8'), { name: 'manifest.txt' });
    }
    await archive.finalize();
    return { included: rows.length - skipped.length, skipped };
  })();

  return { archive, done };
}

export async function remove(tenantId: string, id: string) {
  const attachment = await getById(tenantId, id);

  // Use storage provider for deletion
  try {
    const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
    const provider = await getProviderForTenant(tenantId);
    const key = attachment.providerFileId || attachment.storageKey || attachment.filePath;
    if (key) await provider.delete(key);
  } catch {
    // Fallback to direct filesystem
    try {
      const fullPath = resolveUploadPath(attachment.filePath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } catch {
      // Path didn't resolve under UPLOAD_DIR — leave DB row to be deleted
      // below so a poisoned filePath can't block attachment cleanup.
    }
  }
  await db.delete(attachments).where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, id)));
}

export async function updateOcrResults(tenantId: string, id: string, results: {
  ocrStatus: string; ocrVendor?: string; ocrDate?: string; ocrTotal?: string; ocrTax?: string;
}) {
  await db.update(attachments).set(results)
    .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, id)));
}

export async function reassignDraftAttachments(
  tenantId: string, draftId: string, newType: string, newId: string,
): Promise<number> {
  const result = await db.update(attachments)
    .set({ attachableType: newType, attachableId: newId })
    .where(and(
      eq(attachments.tenantId, tenantId),
      eq(attachments.attachableType, 'draft'),
      eq(attachments.attachableId, draftId),
    ));
  return (result as any).rowCount ?? 0;
}

export async function listUnlinked(tenantId: string) {
  return db.select().from(attachments)
    .where(and(
      eq(attachments.tenantId, tenantId),
      inArray(attachments.attachableType, ['draft', 'receipt']),
    ))
    .orderBy(desc(attachments.createdAt))
    .limit(50);
}

export async function linkAttachment(
  tenantId: string, attachmentId: string, newType: string, newId: string,
) {
  const attachment = await getById(tenantId, attachmentId);
  await db.update(attachments)
    .set({ attachableType: newType, attachableId: newId })
    .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)));
  return attachment;
}
