// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { aiTaskTogglesSchema, aiBatchCategorizeSchema } from './ai.js';

describe('aiTaskTogglesSchema', () => {
  // Issue A regression: report_summary (and the other sensitive task keys)
  // must survive parsing. z.object() strips unknown keys, so a missing key
  // silently turned its Company Settings checkbox into a no-op.
  it('retains report_summary (previously stripped → checkbox did nothing)', () => {
    const parsed = aiTaskTogglesSchema.parse({ report_summary: true });
    expect(parsed).toEqual({ report_summary: true });
  });

  it('retains every exposed task key', () => {
    const all = {
      categorization: true, receipt_ocr: false, statement_parsing: true,
      document_classification: false, enrich_vendor: true, judgment_review: false,
      report_summary: true,
    };
    expect(aiTaskTogglesSchema.parse(all)).toEqual(all);
  });
});

describe('aiBatchCategorizeSchema', () => {
  const uuid = '11111111-1111-1111-1111-111111111111';

  it('accepts an explicit id list', () => {
    expect(aiBatchCategorizeSchema.parse({ feedItemIds: [uuid] })).toMatchObject({ feedItemIds: [uuid] });
  });

  it('accepts an allPending selector (optionally scoped to a connection)', () => {
    expect(aiBatchCategorizeSchema.parse({ allPending: true })).toMatchObject({ allPending: true });
    expect(aiBatchCategorizeSchema.parse({ allPending: true, bankConnectionId: uuid })).toMatchObject({ allPending: true });
  });

  it('rejects providing both selectors, or neither', () => {
    expect(() => aiBatchCategorizeSchema.parse({ feedItemIds: [uuid], allPending: true })).toThrow();
    expect(() => aiBatchCategorizeSchema.parse({})).toThrow();
  });
});
