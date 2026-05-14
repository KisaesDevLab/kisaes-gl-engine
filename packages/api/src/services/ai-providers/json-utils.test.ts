// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { safeJsonExtract } from './json-utils.js';

describe('safeJsonExtract', () => {
  it('parses bare JSON object', () => {
    expect(safeJsonExtract('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses bare JSON array', () => {
    expect(safeJsonExtract('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fenced block', () => {
    const input = '```json\n{"vendor":"ACME","total":12.50}\n```';
    expect(safeJsonExtract(input)).toEqual({ vendor: 'ACME', total: 12.5 });
  });

  it('strips plain ``` fenced block', () => {
    const input = '```\n{"a":1}\n```';
    expect(safeJsonExtract(input)).toEqual({ a: 1 });
  });

  it('extracts JSON from prose-wrapped response', () => {
    const input = `Here's the extracted receipt:\n\n{"vendor":"ACME","total":"12.50"}\n\nLet me know if you need anything else!`;
    expect(safeJsonExtract(input)).toEqual({ vendor: 'ACME', total: '12.50' });
  });

  it('ignores braces inside string values', () => {
    const input = `{"note":"closing brace: }","ok":true}`;
    expect(safeJsonExtract(input)).toEqual({ note: 'closing brace: }', ok: true });
  });

  it('ignores escaped quotes inside strings', () => {
    const input = `{"q":"she said \\"hi\\" and left","ok":true}`;
    expect(safeJsonExtract(input)).toEqual({ q: 'she said "hi" and left', ok: true });
  });

  it('handles nested objects', () => {
    const input = `Prose. {"a":{"b":{"c":1}},"d":[1,{"e":2}]} trailing`;
    expect(safeJsonExtract(input)).toEqual({ a: { b: { c: 1 } }, d: [1, { e: 2 }] });
  });

  it('returns undefined for empty input', () => {
    expect(safeJsonExtract('')).toBeUndefined();
    expect(safeJsonExtract(null)).toBeUndefined();
    expect(safeJsonExtract(undefined)).toBeUndefined();
  });

  it('returns undefined for genuinely malformed JSON', () => {
    expect(safeJsonExtract('not json at all, just words')).toBeUndefined();
    // Unclosed object — the balanced scanner correctly never closes
    expect(safeJsonExtract('{"a":1')).toBeUndefined();
  });

  it('returns undefined when prose contains a fake } before a real {', () => {
    // The opener scanner finds the first `{` or `[`. With no opener at
    // all, we return undefined — confirming the regex-trap scenario
    // (which would have matched ")}" or stray braces) is avoided.
    expect(safeJsonExtract('this } is not json and neither is this ]')).toBeUndefined();
  });

  it('picks the first balanced object when multiple are present', () => {
    // Real-world: model emits the JSON then explains itself with another
    // example. We should pick the first, not the explanation.
    const input = `{"first":true} ... and here's another: {"second":true}`;
    expect(safeJsonExtract(input)).toEqual({ first: true });
  });

  it('handles a top-level array wrapped in prose', () => {
    expect(safeJsonExtract('Here are the items: [1, 2, 3]. Done.')).toEqual([1, 2, 3]);
  });

  it('preserves whitespace inside strings', () => {
    expect(safeJsonExtract('{"a":"  spaces  "}')).toEqual({ a: '  spaces  ' });
  });

  // Caller-side `unwrapParsedResult` rejects arrays so consumers can
  // safely index by key. The extractor itself still returns them here.
  it('preserves array type when extracting a top-level array', () => {
    const result = safeJsonExtract('[{"a":1},{"b":2}]');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
  });

  // Bound on input length protects against a runaway model output
  // pinning the event loop on the brace tokeniser.
  it('bails on inputs above the size guard without spending tokeniser cycles', () => {
    const huge = '{"a":1}' + '\n'.repeat(2_000_000); // ~2MB
    expect(safeJsonExtract(huge)).toBeUndefined();
  });

  it('still parses a 100KB legitimate response (well under the guard)', () => {
    // Build a wide object inside a single sentence of prose so we exercise
    // the brace scanner path too.
    const pairs = Array.from({ length: 5000 }, (_, i) => `"k${i}":${i}`).join(',');
    const input = `Here is the data: {${pairs}}`;
    const result = safeJsonExtract<Record<string, number>>(input);
    expect(result).toBeDefined();
    expect(result!['k0']).toBe(0);
    expect(result!['k4999']).toBe(4999);
  });
});
