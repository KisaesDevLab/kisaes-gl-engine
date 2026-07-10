// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Deterministic, cross-platform unit tests for the render dispatch + storage
// key logic. The actual `pdftoppm` rasterization is exercised as an
// integration test in Phase 8 (it needs the poppler binary, present in the
// container image but not necessarily on a dev box).

import { describe, it, expect } from 'vitest';
import { AppError } from '../../utils/errors.js';
import {
  isRenderablePdf,
  isPassthroughImage,
  renderToPages,
  checkPdftoppmAvailable,
} from './pdf-render.service.js';
import { originalKey, pageKey, extForMime } from './storage.service.js';

describe('pdf-render MIME classification', () => {
  it('recognizes PDFs and supported images', () => {
    expect(isRenderablePdf('application/pdf')).toBe(true);
    expect(isRenderablePdf('APPLICATION/PDF')).toBe(true);
    expect(isRenderablePdf('image/png')).toBe(false);
    expect(isPassthroughImage('image/png')).toBe(true);
    expect(isPassthroughImage('image/jpeg')).toBe(true);
    expect(isPassthroughImage('application/pdf')).toBe(false);
  });
});

describe('renderToPages dispatch', () => {
  it('passes a supported image through as a single page, bytes untouched', async () => {
    const bytes = Buffer.from('fake-png-bytes');
    const pages = await renderToPages(bytes, 'image/png');
    expect(pages).toHaveLength(1);
    expect(pages[0]!.pageNo).toBe(1);
    expect(pages[0]!.mimeType).toBe('image/png');
    expect(pages[0]!.data.equals(bytes)).toBe(true);
  });

  it('rejects an unsupported document type', async () => {
    await expect(renderToPages(Buffer.from('x'), 'application/zip')).rejects.toBeInstanceOf(AppError);
  });
});

describe('extraction storage keys', () => {
  it('builds tenant-rooted original and page keys', () => {
    // Tenant-rooted layout: {tenantId}/documents/{jobId}/... — the
    // builder validates the tenant id, so use a real UUID.
    const t = '5b0c2f9e-1d3a-4b6c-8e7f-9a0b1c2d3e4f';
    expect(originalKey(t, 'j1', '.pdf')).toBe(`${t}/documents/j1/original.pdf`);
    expect(pageKey(t, 'j1', 3)).toBe(`${t}/documents/j1/page-3.png`);
    expect(pageKey(t, 'j1', 1, '.jpg')).toBe(`${t}/documents/j1/page-1.jpg`);
  });

  it('maps MIME types to extensions', () => {
    expect(extForMime('application/pdf')).toBe('.pdf');
    expect(extForMime('image/png')).toBe('.png');
    expect(extForMime('image/jpeg')).toBe('.jpg');
    expect(extForMime('something/unknown')).toBe('.bin');
  });
});

describe('checkPdftoppmAvailable', () => {
  it('returns a structured status without throwing', async () => {
    const status = await checkPdftoppmAvailable();
    expect(typeof status.available).toBe('boolean');
    // When available, a version line is captured; when not, an error string.
    if (status.available) {
      expect(status.error).toBeUndefined();
    } else {
      expect(typeof status.error).toBe('string');
    }
  });
});
