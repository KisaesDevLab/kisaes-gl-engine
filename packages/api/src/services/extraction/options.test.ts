// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { resolveExtractionOptions } from './options.js';

describe('resolveExtractionOptions', () => {
  it('falls back to EXTRACTION_* env defaults when no overrides exist', () => {
    const r = resolveExtractionOptions({ extractionOptions: {} });
    // Defaults declared in config/env.ts.
    expect(r.maxTokens).toBe(8192);
    expect(r.numCtx).toBe(8192);
    expect(r.thinking).toBe('on');
    expect(r.ollamaNative).toBe(true);
    expect(r.renderDpi).toBe(200);
    expect(r.grayscale).toBe(false);
    expect(r.confidenceThreshold).toBe(0.85);
    expect(r.modelTag).toBeTruthy();
  });

  it('treats null overrides as "use env default"', () => {
    const r = resolveExtractionOptions({ extractionOptions: { maxTokens: null, numCtx: null, thinking: null } });
    expect(r.maxTokens).toBe(8192);
    expect(r.numCtx).toBe(8192);
    expect(r.thinking).toBe('on');
  });

  it('applies overrides, preserving explicit false for booleans', () => {
    const r = resolveExtractionOptions({
      extractionOptions: { maxTokens: 4096, numCtx: 16384, thinking: 'off', ollamaNative: false, grayscale: true, renderDpi: 300, confidenceThreshold: 0.6, modelTag: 'qwen-custom' },
    });
    expect(r.maxTokens).toBe(4096);
    expect(r.numCtx).toBe(16384);
    expect(r.thinking).toBe('off');
    expect(r.ollamaNative).toBe(false); // explicit false not overridden by env default
    expect(r.grayscale).toBe(true);
    expect(r.renderDpi).toBe(300);
    expect(r.confidenceThreshold).toBe(0.6);
    expect(r.modelTag).toBe('qwen-custom');
  });

  it('handles a missing extractionOptions object', () => {
    const r = resolveExtractionOptions({});
    expect(r.maxTokens).toBe(8192);
  });
});
