// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { eq, and, count, inArray, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { attachments } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Resolves a filePath (stored in the DB as "/uploads/attachments/<tenant>/<uuid>.ext")
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
  const storageKey = `attachments/${tenantId}/${uuid}${ext}`;

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
    // Fallback to direct local write if provider resolution fails
    const dir = path.join(env.UPLOAD_DIR, 'attachments', tenantId);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, `${uuid}${ext}`), file.buffer);
  }

  const [attachment] = await db.insert(attachments).values({
    tenantId,
    fileName: file.originalname,
    filePath: `/uploads/attachments/${tenantId}/${uuid}${ext}`,
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
