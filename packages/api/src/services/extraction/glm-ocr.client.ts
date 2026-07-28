// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// GLM-OCR HTTP client, trimmed port of Vibe-Transaction-Convertor's
// extractor/glm-ocr-client.ts.
//
// The GLM-OCR appliance runs llama.cpp's llama-server hosting the GLM-OCR
// multimodal model. It exposes an OpenAI-compatible chat-completions API; there
// is no native /ocr endpoint. One POST per page (llama-server isn't batched, so
// we parallelise via `concurrency`):
//
//   POST {baseUrl}/v1/chat/completions
//     { "model": "glm-ocr",
//       "messages": [{ "role": "user", "content": [
//         { "type": "image_url", "image_url": { "url": "data:image/png;base64,…" } },
//         { "type": "text", "text": "OCR:" } ]}],
//       "temperature": 0.02 }
//
// The OCR'd markdown is in choices[0].message.content. llama-server reports no
// per-image confidence, so we stamp `defaultConfidence` (empty content → 0).
//
// Unlike the ai-providers registry (chat/vision-for-extraction), this is a
// dedicated transcription engine pointed at its OWN base URL (ai_config
// glm_ocr_base_url) — it never goes through getProvider().
//
// Inputs are PNG/JPEG page buffers (output of renderPdfToPngPages). Raw PDFs
// are never sent.

import { createHash } from 'node:crypto';
import { log } from '../../utils/logger.js';

export interface GlmOcrConfig {
  baseUrl: string;
  model?: string; // default 'glm-ocr'
  prompt?: string; // default 'OCR:'
  timeoutMs?: number; // default 120000
  concurrency?: number; // default 2
  maxAttempts?: number; // default 3
  apiKey?: string | null; // optional bearer
  defaultConfidence?: number; // default 0.9
  maxTokens?: number; // per-page output cap, default 8192
  fetcher?: typeof fetch; // injectable for tests
}

export interface OcrPageResult {
  index: number; // 0-based page index
  markdown: string;
  confidence: number;
  /** Output hit the max_tokens cap (usually a repetition loop on a noisy
   *  scan). The markdown is the salvaged head with trailing repeats
   *  collapsed — usable, but flag it for review. */
  truncated?: boolean;
}

export class GlmOcrError extends Error {
  readonly status: number | undefined;
  readonly url: string | undefined;
  constructor(message: string, status?: number, url?: string) {
    super(message);
    this.name = 'GlmOcrError';
    this.status = status;
    this.url = url;
  }
}

export class GlmOcrCircuitOpenError extends GlmOcrError {
  constructor(message: string) {
    super(message);
    this.name = 'GlmOcrCircuitOpenError';
  }
}

interface InternalConfig {
  baseUrl: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  concurrency: number;
  maxAttempts: number;
  apiKey: string | null;
  defaultConfidence: number;
  maxTokens: number;
  fetcher: typeof fetch;
}

// A dense statement page transcribes to well under 2k tokens of markdown, so
// 8192 is generous headroom — its real job is stopping a repetition loop (a
// known small-VLM failure mode on noisy scans) from generating unbounded
// output. llama-server defaults to n_predict=-1, and on a single-slot server
// one looping page monopolizes the slot for minutes while every other request
// queues into its client timeout. finish_reason='length' still fails loud
// (see parseOpenAiChatResponse) rather than passing truncated text downstream.
const DEFAULT_MAX_TOKENS = 8192;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hashImage = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');

// Tolerate an operator pasting the base WITH a trailing /v1 (the server's
// published base is often http://host:8082/v1): strip it so {baseUrl}/v1/...
// and the root-level /health probe both resolve.
const normalizeBaseUrl = (raw: string): string =>
  raw.replace(/\/v1\/?$/, '').replace(/\/+$/, '');

const resolveConfig = (cfg: GlmOcrConfig): InternalConfig => {
  const baseUrl = normalizeBaseUrl(cfg.baseUrl ?? '');
  if (!baseUrl) throw new GlmOcrError('GLM-OCR base URL is not set');
  return {
    baseUrl,
    model: cfg.model && cfg.model.length > 0 ? cfg.model : 'glm-ocr',
    prompt: cfg.prompt && cfg.prompt.length > 0 ? cfg.prompt : 'OCR:',
    timeoutMs: cfg.timeoutMs && cfg.timeoutMs > 0 ? cfg.timeoutMs : 120_000,
    concurrency: cfg.concurrency && cfg.concurrency > 0 ? cfg.concurrency : 2,
    maxAttempts: cfg.maxAttempts && cfg.maxAttempts > 0 ? cfg.maxAttempts : 3,
    apiKey: cfg.apiKey && cfg.apiKey.length > 0 ? cfg.apiKey : null,
    defaultConfidence:
      typeof cfg.defaultConfidence === 'number' ? cfg.defaultConfidence : 0.9,
    maxTokens: cfg.maxTokens && cfg.maxTokens > 0 ? cfg.maxTokens : DEFAULT_MAX_TOKENS,
    fetcher: cfg.fetcher ?? fetch,
  };
};

// ── Cross-call in-flight gate ───────────────────────────────────────────────
// `concurrency` used to be a per-ocrPages() budget, so N simultaneous parse
// jobs put N×concurrency requests in flight against one engine. On a
// single-slot llama-server the surplus requests sit in the SERVER's queue with
// their client timeout running — a busy engine then fails with "timed out"
// even though every request would have succeeded in turn. This module-level
// gate makes `concurrency` a per-engine budget across all concurrent callers
// in this process: excess pages wait here (no timer running) and the request
// timeout only measures the engine actually working.
const inflightGates = new Map<string, { active: number; waiters: Array<() => void> }>();

const acquireOcrSlot = async (baseUrl: string, cap: number): Promise<() => void> => {
  let gate = inflightGates.get(baseUrl);
  if (!gate) {
    gate = { active: 0, waiters: [] };
    inflightGates.set(baseUrl, gate);
  }
  // Condition-variable loop: releases wake every waiter and each re-checks,
  // so a cap that changed between calls (admin config edit) is honored.
  while (gate.active >= Math.max(1, cap)) {
    await new Promise<void>((resolve) => gate.waiters.push(resolve));
  }
  gate.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    gate.active -= 1;
    const waiters = gate.waiters.splice(0);
    for (const wake of waiters) wake();
  };
};

// In-memory per-page cache keyed on the image sha256 (v1 — no Redis adapter).
// Bounded by process lifetime; statements re-OCR'd within a process reuse it.
const memCache = new Map<string, OcrPageResult>();
export const clearOcrCache = (): void => memCache.clear();

// Module-scoped circuit breaker shared across calls. Trips after THRESHOLD
// consecutive failures, stays open for OPEN_MS, then half-opens.
const CB_THRESHOLD = 10;
const CB_OPEN_MS = 60_000;
let cbConsecutiveFailures = 0;
let cbOpenedAt = 0;
const circuitState = (): 'closed' | 'open' | 'half-open' => {
  if (cbOpenedAt === 0) return 'closed';
  return Date.now() - cbOpenedAt > CB_OPEN_MS ? 'half-open' : 'open';
};
const onSuccess = (): void => {
  cbConsecutiveFailures = 0;
  cbOpenedAt = 0;
};
const onFailure = (): void => {
  cbConsecutiveFailures += 1;
  if (cbConsecutiveFailures >= CB_THRESHOLD) cbOpenedAt = Date.now();
};
export const resetOcrCircuit = (): void => {
  cbConsecutiveFailures = 0;
  cbOpenedAt = 0;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Collapse a repetition loop in truncated OCR output. A looping decode
// repeats a line — or a multi-line block (observed in prod: a 15-line check
// block repeated 75×) — until the token cap; the head of the output is still
// a faithful read of the page. Any block of up to `maxBlock` lines that
// repeats 3+ times consecutively is kept once with a marker (3+ so a page
// that legitimately shows the same short block twice — e.g. a check front and
// its back — is never collapsed). Exported for unit tests.
export const collapseRepeatedLines = (text: string, maxBlock = 30): string => {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let collapsed = false;
    for (let b = 1; b <= maxBlock && i + 2 * b <= lines.length; b += 1) {
      let eq = true;
      for (let k = 0; k < b; k += 1) {
        if (lines[i + k] !== lines[i + b + k]) { eq = false; break; }
      }
      if (!eq) continue;
      if (!lines.slice(i, i + b).some((l) => l.trim() !== '')) continue;
      let reps = 2;
      for (;;) {
        const start = i + reps * b;
        if (start + b > lines.length) break;
        let same = true;
        for (let k = 0; k < b; k += 1) {
          if (lines[start + k] !== lines[i + k]) { same = false; break; }
        }
        if (!same) break;
        reps += 1;
      }
      if (reps >= 3) {
        out.push(...lines.slice(i, i + b));
        out.push(`[…OCR repetition loop: previous block repeated ${reps}× — collapsed…]`);
        i += reps * b;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) {
      out.push(lines[i]!);
      i += 1;
    }
  }
  return out.join('\n');
};

// Pure parser for the llama-server (OpenAI-compatible) response. The OCR'd
// markdown lives in choices[0].message.content. Exported for unit tests.
//
// finish_reason='length' (output hit the max_tokens cap) is reported via
// `truncated: true` rather than thrown: with the client-side cap in place the
// cap is only ever reached by a repetition loop on a noisy scan, the head of
// the output is still a faithful read, and one unreadable page shouldn't sink
// a whole statement. The caller decides how loud to be (the statement
// pipeline adds a quality warning; ocrOnePage first retries with a repetition
// penalty).
export const parseOpenAiChatResponse = (
  body: unknown,
  pageIndex: number,
  defaultConfidence: number,
): OcrPageResult => {
  if (!isPlainObject(body)) {
    throw new GlmOcrError(`GLM-OCR response: expected JSON object, got ${typeof body}`);
  }
  const choices = body['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new GlmOcrError('GLM-OCR response: missing or empty "choices" array');
  }
  const first = choices[0];
  if (!isPlainObject(first)) throw new GlmOcrError('GLM-OCR response: choices[0] is not an object');

  const truncated = first['finish_reason'] === 'length';
  const message = first['message'];
  if (!isPlainObject(message)) throw new GlmOcrError('GLM-OCR response: choices[0].message missing');

  const rawContent = message['content'];
  let text: string;
  if (typeof rawContent === 'string') {
    text = rawContent;
  } else if (Array.isArray(rawContent)) {
    text = rawContent
      .map((p) =>
        typeof p === 'string' ? p : isPlainObject(p) && typeof p['text'] === 'string' ? p['text'] : '',
      )
      .join('');
  } else {
    text = '';
  }
  if (truncated) text = collapseRepeatedLines(text);
  const empty = text.length === 0;
  return {
    index: pageIndex,
    markdown: text,
    // A truncated page is a degraded read — halve its confidence so the
    // downstream statement confidence reflects it.
    confidence: empty ? 0 : truncated ? defaultConfidence * 0.5 : defaultConfidence,
    ...(truncated ? { truncated: true } : {}),
  };
};

// Build the OpenAI vision request body for a single page image. Exported so
// tests can assert the exact wire shape.
export const buildOcrRequestBody = (
  image: Buffer,
  mimeType: string,
  cfg: { model: string; prompt: string; maxTokens?: number; antiLoop?: boolean },
): Record<string, unknown> => ({
  model: cfg.model,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${image.toString('base64')}` } },
        { type: 'text', text: cfg.prompt },
      ],
    },
  ],
  // Near-greedy decoding — what you want for OCR fidelity. Matches the
  // vibe-glm-ocr entrypoint default. The anti-loop retry (after a truncated
  // first read) trades a little fidelity for escape velocity: a repetition
  // penalty plus mild sampling usually breaks a greedy-decode loop.
  temperature: cfg.antiLoop ? 0.3 : 0.02,
  ...(cfg.antiLoop ? { repeat_penalty: 1.3 } : {}),
  max_tokens: cfg.maxTokens && cfg.maxTokens > 0 ? cfg.maxTokens : DEFAULT_MAX_TOKENS,
});

// One logical OCR request (with network/5xx retries) for a single page.
// antiLoop=true resends with a repetition penalty — used after a truncated
// first read to try to break a decode loop.
const requestOcrPage = async (
  cfg: InternalConfig,
  image: Buffer,
  mimeType: string,
  pageIndex: number,
  antiLoop: boolean,
): Promise<OcrPageResult> => {
  const url = `${cfg.baseUrl}/v1/chat/completions`;
  const requestBody = buildOcrRequestBody(image, mimeType, {
    model: cfg.model,
    prompt: cfg.prompt,
    maxTokens: cfg.maxTokens,
    antiLoop,
  });
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    // Hold an in-flight slot only for the HTTP attempt itself — the timeout
    // timer starts after the slot is acquired, and backoff sleeps between
    // attempts don't hog a slot.
    const releaseSlot = await acquireOcrSlot(cfg.baseUrl, cfg.concurrency);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;
      const res = await cfg.fetcher(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new GlmOcrError(`GLM-OCR POST ${url} → HTTP ${res.status}`, res.status, url);
      }
      const body = (await res.json()) as unknown;
      const result = parseOpenAiChatResponse(body, pageIndex, cfg.defaultConfidence);
      onSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      // 4xx is a config/contract bug (wrong URL, bad auth, malformed payload);
      // retrying won't help and wastes wall time. Only retry 5xx/timeout/network.
      if (err instanceof GlmOcrError && err.status !== undefined && err.status < 500) {
        clearTimeout(timer);
        releaseSlot();
        onFailure();
        throw err;
      }
      if (attempt < cfg.maxAttempts) {
        clearTimeout(timer);
        releaseSlot();
        await sleep(200 * 2 ** (attempt - 1));
      }
    } finally {
      clearTimeout(timer);
      releaseSlot();
    }
  }
  onFailure();
  if (lastErr instanceof Error && (lastErr.name === 'AbortError' || lastErr.name === 'TimeoutError')) {
    const wrapped = new GlmOcrError(
      `GLM-OCR POST ${url} timed out after ${cfg.timeoutMs} ms (page ${pageIndex + 1}, ${cfg.maxAttempts} attempts)`,
      undefined,
      url,
    );
    (wrapped as Error & { cause?: unknown }).cause = lastErr;
    throw wrapped;
  }
  throw lastErr instanceof Error
    ? lastErr
    : new GlmOcrError(`GLM-OCR failed after ${cfg.maxAttempts} attempts (page ${pageIndex + 1})`, undefined, url);
};

const ocrOnePage = async (
  cfg: InternalConfig,
  image: Buffer,
  mimeType: string,
  pageIndex: number,
): Promise<OcrPageResult> => {
  const key = hashImage(image);
  const hit = memCache.get(key);
  if (hit) return { ...hit, index: pageIndex };

  if (circuitState() === 'open') {
    throw new GlmOcrCircuitOpenError(
      `GLM-OCR circuit open (${cbConsecutiveFailures} consecutive failures); retry after cooldown`,
    );
  }

  let result = await requestOcrPage(cfg, image, mimeType, pageIndex, false);
  if (result.truncated) {
    // Near-greedy decoding got stuck in a repetition loop and hit the output
    // cap. One retry with a repetition penalty usually breaks the loop; if it
    // doesn't, keep the (collapsed) truncated read rather than failing.
    log.warn({
      component: 'glm-ocr',
      event: 'ocr_page_truncated_retrying',
      page: pageIndex + 1,
      chars: result.markdown.length,
    });
    try {
      const retry = await requestOcrPage(cfg, image, mimeType, pageIndex, true);
      if (!retry.truncated && retry.markdown.length > 0) {
        // The page is known-loopy — the penalty run terminates but can still
        // repeat itself below the cap, so collapse its repeats as well.
        result = { ...retry, markdown: collapseRepeatedLines(retry.markdown) };
      }
    } catch {
      // Anti-loop retry is best-effort; the collapsed first read stands.
    }
  }
  // Don't cache truncated reads: a later re-process (after a server fix or a
  // DPI change) should get a fresh chance, not the cached bad read.
  if (!result.truncated) memCache.set(key, result);
  return result;
};

const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const cap = Math.max(1, Math.min(limit, items.length || 1));
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < cap; w += 1) {
    workers.push(
      (async () => {
        for (;;) {
          const i = cursor;
          cursor += 1;
          if (i >= items.length) return;
          out[i] = await fn(items[i]!, i);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
};

export interface OcrPageInput {
  data: Buffer;
  mimeType: string;
}

// OCR an ordered set of page images → per-page markdown, preserving order.
export const ocrPages = async (
  pages: OcrPageInput[],
  cfg: GlmOcrConfig,
): Promise<OcrPageResult[]> => {
  const resolved = resolveConfig(cfg);
  return runWithConcurrency(pages, resolved.concurrency, (page, i) =>
    ocrOnePage(resolved, page.data, page.mimeType, i),
  );
};

// ── Health / version probes (admin "Test connection") ──────────────────────

// List the model ids the GLM-OCR llama-server advertises (GET /v1/models).
// llama-server returns both an OpenAI-shaped `data[].id` and a native
// `models[].name`; prefer the former, fall back to the latter.
export const probeGlmOcrModels = async (cfg: GlmOcrConfig): Promise<string[]> => {
  const resolved = resolveConfig(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const headers: Record<string, string> = {};
    if (resolved.apiKey) headers['authorization'] = `Bearer ${resolved.apiKey}`;
    const res = await resolved.fetcher(`${resolved.baseUrl}/v1/models`, { headers, signal: controller.signal });
    if (!res.ok) throw new GlmOcrError(`GLM-OCR /v1/models → HTTP ${res.status}`, res.status);
    const body = (await res.json()) as {
      data?: Array<{ id?: string }>;
      models?: Array<{ name?: string }>;
    };
    const ids = (body.data ?? []).map((m) => m.id ?? '').filter(Boolean);
    if (ids.length) return ids;
    return (body.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
};

export const probeGlmOcrHealth = async (
  cfg: GlmOcrConfig,
): Promise<{ ok: boolean; status?: number; detail?: string }> => {
  try {
    const resolved = resolveConfig(cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const headers: Record<string, string> = {};
      if (resolved.apiKey) headers['authorization'] = `Bearer ${resolved.apiKey}`;
      const res = await resolved.fetcher(`${resolved.baseUrl}/health`, {
        headers,
        signal: controller.signal,
      });
      return res.ok ? { ok: true, status: res.status } : { ok: false, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
};

// Run a single tiny OCR call to confirm the model responds. Used by the admin
// Test-connection route; logs but never throws past the caller's try/catch.
export const sampleOcr = async (
  cfg: GlmOcrConfig,
  page: OcrPageInput,
): Promise<OcrPageResult> => {
  const resolved = resolveConfig(cfg);
  try {
    return await ocrOnePage(resolved, page.data, page.mimeType, 0);
  } catch (err) {
    log.warn({
      component: 'glm-ocr',
      event: 'sample_ocr_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
};
