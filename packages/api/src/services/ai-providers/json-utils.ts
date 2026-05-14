// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { AppError } from '../../utils/errors.js';

/**
 * Robust JSON extraction from a model response.
 *
 * Models in `responseFormat: 'json'` mode are *usually* honest about
 * returning bare JSON, but in practice they:
 *   - wrap output in ```json fenced code blocks
 *   - prepend "Here's the receipt:" or similar prose
 *   - append a trailing apology or follow-up question
 *   - emit nested braces inside string values
 *
 * A regex like `/\{[\s\S]*\}/` looks tempting but is wrong on three of
 * those: it doesn't respect string boundaries (so a `}` inside `"a}"`
 * closes the wrong scope), it greedy-matches across stray trailing
 * braces, and it can't handle top-level arrays. Plenty of past silent
 * "AI returned nothing" bugs trace back to that mistake.
 *
 * This function instead:
 *   1. Strips leading/trailing whitespace.
 *   2. Removes ```json … ``` or ``` … ``` fences if they wrap the body.
 *   3. Tries the whole string as JSON (fast path).
 *   4. Walks the string with a tiny string-aware tokeniser, finds the
 *      first balanced top-level `{…}` or `[…]`, and parses that slice.
 *
 * Returns `undefined` when no parseable JSON is present — callers should
 * surface `parseError` to the user rather than silently fall back.
 */
/**
 * Upper bound on input length. Model responses for our OCR / categorize
 * tasks should never exceed a few KB; capping at 1 MB protects against
 * a runaway tool-use loop or a malicious prompt that gets a model to
 * emit a multi-megabyte payload. The character-by-character tokeniser
 * below is O(n) but n=10MB is enough to noticeably pin a worker.
 */
export const MAX_JSON_EXTRACT_INPUT = 1_000_000;

export function safeJsonExtract<T = unknown>(input: string | null | undefined): T | undefined {
  if (!input) return undefined;
  // Bail early on absurd inputs to keep the tokeniser bounded. The
  // caller will then see `parseError` set on the CompletionResult,
  // matching the "model returned non-JSON" path.
  if (input.length > MAX_JSON_EXTRACT_INPUT) return undefined;
  const trimmed = stripCodeFences(input.trim());
  if (!trimmed) return undefined;

  // Fast path
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }

  // Scan for the first balanced JSON value
  const slice = findFirstBalancedJsonSlice(trimmed);
  if (!slice) return undefined;
  try {
    return JSON.parse(slice) as T;
  } catch {
    return undefined;
  }
}

/**
 * Provider helper: turn a raw model response into the `{ parsed,
 * parseError }` shape consumed by `CompletionResult`. When the caller
 * didn't request JSON, returns an empty object (no parsing attempted).
 * When extraction fails, returns a short excerpt of the raw text so the
 * service layer can surface an actionable `ai_parse_failed` error.
 */
export function extractJsonForResult(
  text: string,
  responseFormat?: 'json' | 'text',
): { parsed?: unknown; parseError?: string } {
  if (responseFormat !== 'json') return {};
  const parsed = safeJsonExtract(text);
  if (parsed !== undefined) return { parsed };
  const excerpt = text.trim().slice(0, 200);
  return { parseError: excerpt ? `Model returned non-JSON: ${excerpt}` : 'Model returned empty response' };
}

/**
 * Pull `parsed` off a `CompletionResult`, or throw a typed
 * `ai_parse_failed` AppError when the provider couldn't extract JSON.
 * Rejects arrays so downstream consumers can safely index by key.
 * `taskLabel` flavors the error message (e.g. "receipt extraction").
 */
export function unwrapParsedResult(
  result: { parsed?: unknown; parseError?: string; provider?: string },
  taskLabel: string,
): Record<string, any> {
  if (result.parseError) {
    throw AppError.badRequest(
      `AI returned non-JSON for ${taskLabel} (${result.provider ?? 'provider'}). ${result.parseError}`,
      'ai_parse_failed',
    );
  }
  if (result.parsed && typeof result.parsed === 'object' && !Array.isArray(result.parsed)) {
    return result.parsed as Record<string, any>;
  }
  return {};
}

/**
 * Same as `safeJsonExtract` but returns the slice it parsed (for
 * debugging / error messages). Convenience wrapper.
 */
export function safeJsonExtractWithSource<T = unknown>(input: string | null | undefined): {
  value: T | undefined;
  source: string | null;
} {
  if (!input) return { value: undefined, source: null };
  const trimmed = stripCodeFences(input.trim());
  if (!trimmed) return { value: undefined, source: null };
  try {
    return { value: JSON.parse(trimmed) as T, source: trimmed };
  } catch { /* continue */ }
  const slice = findFirstBalancedJsonSlice(trimmed);
  if (!slice) return { value: undefined, source: null };
  try {
    return { value: JSON.parse(slice) as T, source: slice };
  } catch {
    return { value: undefined, source: slice };
  }
}

/**
 * Strip a single wrapping ```json … ``` or ``` … ``` block. Only strips
 * when the fences enclose the whole string (after trim) — fences in the
 * middle of prose are left alone so the balanced-brace scanner can still
 * find them.
 */
function stripCodeFences(s: string): string {
  // ```json\n...\n```  or  ```\n...\n```
  const fence = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/i;
  const m = s.match(fence);
  if (m && m[1] != null) return m[1].trim();
  return s;
}

/**
 * Walk the input and return the first balanced `{…}` or `[…]` slice.
 * Respects JSON string semantics:
 *   - `"…"` toggles "inside string" mode; braces inside strings don't
 *     count toward depth.
 *   - `\` escapes the next character inside a string (so `"\}"` doesn't
 *     close the string).
 *
 * Returns `null` if no balanced top-level slice is found.
 */
function findFirstBalancedJsonSlice(s: string): string | null {
  const startIdx = findOpener(s, 0);
  if (startIdx < 0) return null;
  const open = s[startIdx];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = startIdx; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inString = false; continue; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(startIdx, i + 1);
    }
  }
  return null;
}

function findOpener(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[') return i;
  }
  return -1;
}
