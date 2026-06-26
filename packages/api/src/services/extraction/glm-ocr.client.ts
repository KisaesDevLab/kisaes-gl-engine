// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
  fetcher?: typeof fetch; // injectable for tests
}

export interface OcrPageResult {
  index: number; // 0-based page index
  markdown: string;
  confidence: number;
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
  fetcher: typeof fetch;
}

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
    fetcher: cfg.fetcher ?? fetch,
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

// Pure parser for the llama-server (OpenAI-compatible) response. The OCR'd
// markdown lives in choices[0].message.content. Exported for unit tests.
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

  // Truncation guard: finish_reason='length' means the model hit max_tokens
  // before completing. Treating that as success silently feeds truncated
  // markdown downstream — fail loud so the audit row names the page.
  if (first['finish_reason'] === 'length') {
    throw new GlmOcrError(
      `GLM-OCR response truncated by output-token cap on page ${pageIndex + 1} ` +
        `(finish_reason='length'). Raise --n-predict on the OCR server or lower DPI.`,
    );
  }
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
  const empty = text.length === 0;
  return { index: pageIndex, markdown: text, confidence: empty ? 0 : defaultConfidence };
};

// Build the OpenAI vision request body for a single page image. Exported so
// tests can assert the exact wire shape.
export const buildOcrRequestBody = (
  image: Buffer,
  mimeType: string,
  cfg: { model: string; prompt: string },
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
  // vibe-glm-ocr entrypoint default.
  temperature: 0.02,
});

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

  const url = `${cfg.baseUrl}/v1/chat/completions`;
  const requestBody = buildOcrRequestBody(image, mimeType, { model: cfg.model, prompt: cfg.prompt });
  let lastErr: unknown;
  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
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
      memCache.set(key, result);
      onSuccess();
      return result;
    } catch (err) {
      lastErr = err;
      // 4xx is a config/contract bug (wrong URL, bad auth, malformed payload);
      // retrying won't help and wastes wall time. Only retry 5xx/timeout/network.
      if (err instanceof GlmOcrError && err.status !== undefined && err.status < 500) {
        clearTimeout(timer);
        onFailure();
        throw err;
      }
      if (attempt < cfg.maxAttempts) await sleep(200 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timer);
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
