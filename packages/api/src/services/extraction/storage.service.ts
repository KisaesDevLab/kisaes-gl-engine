// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Storage helper for the document-extraction module. Reuses the existing
// per-tenant StorageProvider abstraction (local disk / S3 / cloud) so
// originals and rendered page images follow the same storage policy as
// every other tenant artefact.
//
// Key layout (tenant-scoped):
//   documents/{tenantId}/{jobId}/original{ext}   — the uploaded file
//   documents/{tenantId}/{jobId}/page-{n}.png    — each rendered page image

import path from 'node:path';
import { getProviderForTenant } from '../storage/storage-provider.factory.js';
import type { RenderedPage } from './pdf-render.service.js';

export function originalKey(tenantId: string, jobId: string, ext: string): string {
  return `documents/${tenantId}/${jobId}/original${ext}`;
}

export function pageKey(tenantId: string, jobId: string, pageNo: number, ext = '.png'): string {
  return `documents/${tenantId}/${jobId}/page-${pageNo}${ext}`;
}

/** Map a MIME type to a file extension for storage keys. */
export function extForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'application/pdf':
      return '.pdf';
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    default:
      return '.bin';
  }
}

/** Reverse of extForMime — infer the MIME from a storage key's extension. */
export function mimeFromStorageKey(key: string): string {
  const dot = key.lastIndexOf('.');
  const ext = dot >= 0 ? key.slice(dot).toLowerCase() : '';
  switch (ext) {
    case '.pdf':
      return 'application/pdf';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

export async function storeBytes(
  tenantId: string,
  key: string,
  data: Buffer,
  mimeType: string,
): Promise<void> {
  const provider = await getProviderForTenant(tenantId);
  await provider.upload(key, data, {
    fileName: path.basename(key),
    mimeType,
    sizeBytes: data.length,
  });
}

export async function loadBytes(tenantId: string, key: string): Promise<Buffer> {
  const provider = await getProviderForTenant(tenantId);
  return provider.download(key);
}

/**
 * Persist one rendered page image and return its storage key (used as
 * `extraction_pages.image_ref`). PDF pages are PNGs; passthrough images
 * keep their original MIME/extension.
 */
export async function storePageImage(
  tenantId: string,
  jobId: string,
  page: RenderedPage,
): Promise<string> {
  const ext = extForMime(page.mimeType);
  const key = pageKey(tenantId, jobId, page.pageNo, ext);
  await storeBytes(tenantId, key, page.data, page.mimeType);
  return key;
}
