// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { ZodType } from 'zod';
import { AppError } from '../../utils/errors.js';
import { log } from '../../utils/logger.js';

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
 *   4. Strips `<think>…</think>`-style reasoning blocks (thinking models
 *      like qwen3 emit these inline when the serving layer doesn't split
 *      them out) and retries the fast path.
 *   5. Walks the string with a tiny string-aware tokeniser, finds
 *      balanced top-level `{…}` / `[…]` slices, and parses the first one
 *      that is valid JSON (skipping pseudo-JSON like `{a: 1}` inside
 *      reasoning prose).
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

  // Fast path — untouched content, so a JSON string that legitimately
  // contains "<think>" is never mangled by the reasoning stripper.
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // fall through
  }

  // Thinking models (qwen3 et al.) can emit their chain-of-thought inline
  // as <think>…</think> when the serving layer doesn't split it out.
  // Strip those blocks, then re-strip fences (the answer after the think
  // block is often itself fenced) and retry the fast path.
  const deThought = stripCodeFences(stripReasoningBlocks(trimmed).trim());
  if (!deThought) return undefined;
  if (deThought !== trimmed) {
    try {
      return JSON.parse(deThought) as T;
    } catch {
      // fall through
    }
  }

  // Scan for balanced JSON slices, skipping candidates that don't parse
  // (e.g. `{a: 1}` pseudo-code inside a reasoning preamble).
  return scanForParseableJson<T>(deThought);
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
  opts?: {
    /** Set by the provider when the upstream reported a token-limit stop
     *  (Anthropic `stop_reason: 'max_tokens'`, OpenAI `finish_reason:
     *  'length'`, Ollama `done_reason: 'length'`, Gemini `MAX_TOKENS`).
     *  A truncated response that fails to parse gets an actionable
     *  "raise max tokens" error instead of a misleading "non-JSON" one. */
    truncated?: boolean;
  },
): { parsed?: unknown; parseError?: string } {
  if (responseFormat !== 'json') return {};
  const parsed = safeJsonExtract(text);
  if (parsed !== undefined) return { parsed };
  // Control characters stripped so the excerpt is log/toast-safe.
  const excerpt = text.trim().replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 200);
  if (opts?.truncated) {
    return {
      parseError:
        'Model response was truncated at the max-token limit before the JSON completed — ' +
        'raise this function\'s max tokens (Admin → AI → Tasks) or turn thinking off.' +
        (excerpt ? ` Partial output: ${excerpt}` : ''),
    };
  }
  return { parseError: excerpt ? `Model returned non-JSON: ${excerpt}` : 'Model returned empty response' };
}

/**
 * Pull `parsed` off a `CompletionResult`, or throw a typed
 * `ai_parse_failed` AppError when the provider couldn't extract JSON.
 * Rejects arrays so downstream consumers can safely index by key.
 * `taskLabel` flavors the error message (e.g. "receipt extraction").
 */
export function unwrapParsedResult(
  result: { parsed?: unknown; parseError?: string; provider?: string; model?: string },
  taskLabel: string,
): Record<string, any> {
  if (result.parseError) {
    const who = `${result.provider ?? 'provider'}${result.model ? ` / ${result.model}` : ''}`;
    // Server logs always carry the full detail (provider + model +
    // excerpt), even when a caller catches and re-shapes this error.
    log.warn({
      component: 'ai-json',
      event: 'ai_parse_failed',
      task: taskLabel,
      provider: result.provider ?? null,
      model: result.model ?? null,
      detail: result.parseError,
    });
    throw AppError.badRequest(
      `AI returned non-JSON for ${taskLabel} (${who}). ${result.parseError}`,
      'ai_parse_failed',
    );
  }
  if (result.parsed && typeof result.parsed === 'object' && !Array.isArray(result.parsed)) {
    return result.parsed as Record<string, any>;
  }
  return {};
}

/**
 * Validate a model's parsed output against a Zod schema before it is used to
 * write the database (M5). On failure it throws the same typed
 * `ai_parse_failed` AppError the non-JSON path uses, so a structurally-wrong
 * model reply fails honestly instead of writing a partial/`any` record.
 *
 * `taskLabel` flavors the error (e.g. "receipt extraction"); the full Zod
 * issue list always goes to the server log for diagnosis.
 */
export function validateModelOutput<T>(schema: ZodType<T>, value: unknown, taskLabel: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  log.warn({
    component: 'ai-json',
    event: 'ai_output_schema_invalid',
    task: taskLabel,
    detail: issues,
  });
  throw AppError.badRequest(
    `AI ${taskLabel} output failed validation: ${issues}`,
    'ai_parse_failed',
  );
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
  const deThought = stripCodeFences(stripReasoningBlocks(trimmed).trim());
  return scanForParseableJsonWithSource<T>(deThought) ?? { value: undefined, source: null };
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
 * Remove `<think>…</think>`-style reasoning blocks that thinking models
 * (qwen3, DeepSeek-R1, etc.) emit inline when the serving layer doesn't
 * separate reasoning from the answer. Handles `<think>`, `<thinking>`,
 * `<reasoning>` and `<reflection>` (case-insensitive). A closed block is
 * removed wholesale; an UNCLOSED opening tag (truncated thinking, or a
 * template that forgets the close tag) has just the tag removed so the
 * balanced-slice scanner can still hunt for JSON in what follows.
 */
const REASONING_TAGS = ['think', 'thinking', 'reasoning', 'reflection'] as const;

export function stripReasoningBlocks(s: string): string {
  let out = s;
  for (const tag of REASONING_TAGS) {
    const closed = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, 'gi');
    out = out.replace(closed, ' ');
    // Orphaned tags (unclosed opener from truncation, or a stray closer).
    out = out.replace(new RegExp(`</?${tag}>`, 'gi'), ' ');
  }
  return out;
}

/**
 * Cap on how many balanced-but-unparseable candidates the scanner will
 * try before giving up. Keeps the worst case (a huge reasoning preamble
 * full of pseudo-JSON braces) bounded.
 */
const MAX_SCAN_CANDIDATES = 25;

function scanForParseableJson<T>(s: string): T | undefined {
  return scanForParseableJsonWithSource<T>(s)?.value;
}

/**
 * Walk the input and return the first balanced `{…}` or `[…]` slice that
 * parses as JSON. Candidates that are balanced but NOT valid JSON (e.g.
 * `{a: 1}` pseudo-code in prose) are skipped and the scan continues after
 * them. Respects JSON string semantics:
 *   - `"…"` toggles "inside string" mode; braces inside strings don't
 *     count toward depth.
 *   - `\` escapes the next character inside a string (so `"\}"` doesn't
 *     close the string).
 */
function scanForParseableJsonWithSource<T>(s: string): { value: T | undefined; source: string } | undefined {
  let from = 0;
  for (let attempt = 0; attempt < MAX_SCAN_CANDIDATES; attempt++) {
    const startIdx = findOpener(s, from);
    if (startIdx < 0) return undefined;
    const end = findBalancedEnd(s, startIdx);
    if (end < 0) {
      // This opener never balances (truncated or garbage). An opener
      // nested inside it can't balance either without also closing this
      // one, so only a candidate AFTER the failed opener could work —
      // but without a close for the outer opener the rest of the string
      // is inside it. Give up.
      return undefined;
    }
    const slice = s.slice(startIdx, end + 1);
    try {
      return { value: JSON.parse(slice) as T, source: slice };
    } catch {
      // Balanced but not JSON — continue scanning after this candidate.
      from = end + 1;
    }
  }
  return undefined;
}

/** Index of the matching close bracket for the opener at `startIdx`, or -1. */
function findBalancedEnd(s: string, startIdx: number): number {
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
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findOpener(s: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '{' || c === '[') return i;
  }
  return -1;
}
