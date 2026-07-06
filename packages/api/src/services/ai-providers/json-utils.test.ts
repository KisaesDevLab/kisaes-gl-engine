// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { safeJsonExtract, extractJsonForResult, stripReasoningBlocks } from './json-utils.js';

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

  // ── Thinking-model output (<think> blocks) ─────────────────────────
  // Ollama/openai_compat thinking models (qwen3 et al.) emit their
  // chain-of-thought inline when the serving layer doesn't split it out.

  it('strips a closed <think> block before the JSON', () => {
    const input = `<think>The user paid Starbucks, so coffee → Meals.</think>\n{"account_name":"Meals","confidence":0.9}`;
    expect(safeJsonExtract(input)).toEqual({ account_name: 'Meals', confidence: 0.9 });
  });

  it('strips a <think> block whose reasoning contains pseudo-JSON braces', () => {
    // The braces inside the think block are NOT valid JSON ({a: 1} is
    // JS, not JSON) — the old single-candidate scanner died on them.
    const input = `<think>maybe {a: 1}? or perhaps {b: [2}...</think>{"real":true}`;
    expect(safeJsonExtract(input)).toEqual({ real: true });
  });

  it('handles an UNCLOSED <think> tag followed by JSON (broken template)', () => {
    const input = `<think>draft {a: 1} more thoughts {"real":true}`;
    expect(safeJsonExtract(input)).toEqual({ real: true });
  });

  it('returns undefined for a think-only response (all budget spent reasoning)', () => {
    expect(safeJsonExtract('<think>hmm, let me consider the vendor…')).toBeUndefined();
  });

  it('strips <thinking> and <reasoning> variants too', () => {
    expect(safeJsonExtract('<thinking>…</thinking>{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonExtract('<reasoning>…</reasoning>[1,2]')).toEqual([1, 2]);
  });

  it('handles think block + fenced JSON answer', () => {
    const input = '<think>ok</think>\n```json\n{"a":1}\n```';
    expect(safeJsonExtract(input)).toEqual({ a: 1 });
  });

  it('does NOT mangle a valid JSON string that contains "<think>"', () => {
    // Fast path parses the whole body before the reasoning stripper runs.
    const input = '{"memo":"model said <think>hi</think> to me"}';
    expect(safeJsonExtract(input)).toEqual({ memo: 'model said <think>hi</think> to me' });
  });

  it('skips balanced-but-unparseable candidates and finds the real JSON', () => {
    const input = 'Consider {not: valid} first. The answer: {"valid":true}';
    expect(safeJsonExtract(input)).toEqual({ valid: true });
  });

  it('returns undefined for JSON truncated mid-object even with a think preamble', () => {
    const input = '<think>ok</think>{"transactions":[{"date":"2026-01-01","amount":';
    expect(safeJsonExtract(input)).toBeUndefined();
  });
});

describe('stripReasoningBlocks', () => {
  it('removes closed blocks wholesale and orphan tags individually', () => {
    expect(stripReasoningBlocks('<think>a</think>x').trim()).toBe('x');
    expect(stripReasoningBlocks('<think>a x').replace(/\s+/g, ' ').trim()).toBe('a x');
    expect(stripReasoningBlocks('a</think> x').replace(/\s+/g, ' ').trim()).toBe('a x');
  });
});

describe('extractJsonForResult', () => {
  it('returns parsed for valid JSON and no parseError', () => {
    expect(extractJsonForResult('{"a":1}', 'json')).toEqual({ parsed: { a: 1 } });
  });

  it('is a no-op for responseFormat text', () => {
    expect(extractJsonForResult('prose', 'text')).toEqual({});
  });

  it('reports non-JSON with a short excerpt', () => {
    const { parsed, parseError } = extractJsonForResult('I cannot help with that.', 'json');
    expect(parsed).toBeUndefined();
    expect(parseError).toMatch(/^Model returned non-JSON: I cannot help/);
  });

  it('reports an empty response distinctly', () => {
    expect(extractJsonForResult('', 'json').parseError).toBe('Model returned empty response');
  });

  it('reports TRUNCATION (not "non-JSON") when the provider hit the token limit', () => {
    const cut = '{"transactions":[{"date":"2026-01-01","amount":';
    const { parseError } = extractJsonForResult(cut, 'json', { truncated: true });
    expect(parseError).toMatch(/truncated at the max-token limit/);
    expect(parseError).toMatch(/raise this function's max tokens/);
    expect(parseError).not.toMatch(/^Model returned non-JSON/);
  });

  it('truncated + empty content still explains the token limit', () => {
    const { parseError } = extractJsonForResult('', 'json', { truncated: true });
    expect(parseError).toMatch(/truncated at the max-token limit/);
    expect(parseError).not.toContain('Partial output');
  });

  it('a truncated response that still parsed cleanly is NOT an error', () => {
    // e.g. the model finished the JSON then got cut mid-apology.
    const { parsed, parseError } = extractJsonForResult('{"a":1}\nAlso', 'json', { truncated: true });
    expect(parsed).toEqual({ a: 1 });
    expect(parseError).toBeUndefined();
  });

  it('strips control characters from the excerpt', () => {
    const { parseError } = extractJsonForResult('bad\x00\x01reply', 'json');
    expect(parseError).toBe('Model returned non-JSON: bad reply');
  });
});
