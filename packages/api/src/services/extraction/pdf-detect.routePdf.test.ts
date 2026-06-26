// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { routePdf, type PdfAnalysis } from './pdf-detect.service.js';

const analysis = (over: Partial<PdfAnalysis>): PdfAnalysis => ({
  pageCount: 1,
  hasTextLayer: false,
  textLayerCoverage: 0,
  avgCharsPerPage: 0,
  suspectedScan: true,
  pages: [{ index: 0, hasText: false, charCount: 0 }],
  ...over,
});

describe('routePdf', () => {
  it('routes a fully text-layer PDF to "text"', () => {
    const a = analysis({
      hasTextLayer: true,
      textLayerCoverage: 1,
      avgCharsPerPage: 800,
      pages: [{ index: 0, hasText: true, charCount: 800 }],
    });
    expect(routePdf(a)).toBe('text');
  });

  it('routes a scanned PDF (no text) to "ocr"', () => {
    expect(routePdf(analysis({}))).toBe('ocr');
  });

  it('routes a mixed PDF to "hybrid"', () => {
    const a = analysis({
      pageCount: 2,
      hasTextLayer: false,
      textLayerCoverage: 0.5,
      avgCharsPerPage: 400,
      pages: [
        { index: 0, hasText: true, charCount: 800 },
        { index: 1, hasText: false, charCount: 0 },
      ],
    });
    expect(routePdf(a)).toBe('hybrid');
  });

  it('forceOcr overrides a text-layer PDF', () => {
    const a = analysis({
      hasTextLayer: true,
      textLayerCoverage: 1,
      avgCharsPerPage: 800,
      pages: [{ index: 0, hasText: true, charCount: 800 }],
    });
    expect(routePdf(a, true)).toBe('ocr');
  });

  it('routes a zero-page document to "ocr"', () => {
    expect(routePdf(analysis({ pageCount: 0, pages: [] }))).toBe('ocr');
  });
});
