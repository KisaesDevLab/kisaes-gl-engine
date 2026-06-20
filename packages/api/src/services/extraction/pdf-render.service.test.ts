// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
  it('builds tenant-scoped original and page keys', () => {
    expect(originalKey('t1', 'j1', '.pdf')).toBe('documents/t1/j1/original.pdf');
    expect(pageKey('t1', 'j1', 3)).toBe('documents/t1/j1/page-3.png');
    expect(pageKey('t1', 'j1', 1, '.jpg')).toBe('documents/t1/j1/page-1.jpg');
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
