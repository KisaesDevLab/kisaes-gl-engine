// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Thin wrapper over the existing `openai_compat` AI provider, dedicated to
// the local document-extraction pipeline (Qwen3.5 vision served by Ollama's
// OpenAI-compatible `/v1` endpoint).
//
// We deliberately reuse the shared provider stack rather than hand-rolling
// an OpenAI-SDK client (as the build brief sketched):
//   - `getProvider('openai_compat', config, modelTag)` already builds the
//     exact `image_url` data-URL vision call the brief described.
//   - `assertCloudVisionAllowed` enforces the privacy invariant: it passes
//     only for a self-hosted (local) endpoint and THROWS for any public URL,
//     so "the document never leaves the box" is enforced, not just promised.
//   - Provider credentials live encrypted in `ai_config`, configured via the
//     admin UI — no plaintext base URL / key in env.
//
// The Qwen model tag is the one knob this module overrides (env
// `EXTRACTION_MODEL_TAG`, default `qwen3.5:35b-a3b`) so an operator can swap
// to a larger/newer vision model without touching code.

import { AppError } from '../../utils/errors.js';
import { abortableTimeout, TimeoutError } from '../../utils/retry.js';
import * as aiConfigService from '../ai-config.service.js';
import * as orchestrator from '../ai-orchestrator.service.js';
import { getProvider, hasCredentials, nativeOllamaBaseUrl } from '../ai-providers/index.js';
import { OllamaProvider } from '../ai-providers/ollama.provider.js';
import type { AiProvider } from '../ai-providers/ai-provider.interface.js';
import { resolveExtractionOptions } from './options.js';

const PROVIDER_NAME = 'openai_compat';

// Vision prefill on a 35B model with a 200–300 DPI page image is heavy; a
// single page can legitimately take a minute or more on a CPU/edge box.
// Bounded so a wedged endpoint can't hang a worker indefinitely.
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 15_000;

export interface ExtractImageInput {
  /** Base64-encoded page image (no data: prefix). */
  base64: string;
  /** e.g. `image/png` for rendered pages, `image/jpeg` for photo uploads. */
  mimeType: string;
  systemPrompt: string;
  /** The docType-specific schemaInstruction. */
  userPrompt: string;
  maxTokens?: number;
  /** Override the configured model tag for this single call (escalation). */
  modelTag?: string;
}

export interface ExtractImageResult {
  /** Raw model text — persisted verbatim for audit. */
  text: string;
  /** JSON.parse'd model output, or undefined when it wasn't valid JSON. */
  parsed: unknown;
  /** Set when JSON mode was requested but the response couldn't be parsed. */
  parseError: string | undefined;
  /** Resolved model tag the provider reported. */
  model: string;
  durationMs: number;
}

/**
 * Resolve the configured local provider, enforcing the privacy invariant.
 * Throws an actionable AppError when the endpoint isn't configured, and
 * propagates the cloud-vision guard's error when the endpoint is non-local.
 */
async function resolveProvider(modelTag?: string): Promise<{ provider: AiProvider; opt: ReturnType<typeof resolveExtractionOptions> }> {
  const config = await aiConfigService.getRawConfig();
  if (!hasCredentials(PROVIDER_NAME, config)) {
    throw AppError.badRequest(
      'Local extraction model is not configured. Set the OpenAI-compatible base URL ' +
        '(your Ollama /v1 endpoint) in System Settings → AI before extracting documents.',
    );
  }
  // Privacy invariant — the document image must never leave the box. This
  // returns cleanly for a local Ollama URL (loopback / RFC-1918 private IP /
  // .local / Docker short name) and THROWS for any public URL, turning the
  // no-third-party-disclosure guarantee into an enforced precondition.
  await orchestrator.assertCloudVisionAllowed(PROVIDER_NAME);
  const opt = resolveExtractionOptions(config);
  const tag = modelTag ?? opt.modelTag;
  // Native Ollama path (default): fixes empty-content on thinking models and
  // unlocks num_ctx / keep_alive / think. Falls back to the generic
  // openai_compat /v1 provider for non-Ollama backends.
  const provider = opt.ollamaNative && config.openaiCompatBaseUrl
    ? new OllamaProvider(nativeOllamaBaseUrl(config.openaiCompatBaseUrl), tag)
    : getProvider(PROVIDER_NAME, config, tag);
  return { provider, opt };
}

/**
 * Send one page image to the local vision model and return the raw +
 * parsed JSON. Temperature is pinned to 0 for deterministic extraction.
 * Callers Zod-validate `parsed` downstream — never trust it here.
 */
export async function extractImage(input: ExtractImageInput): Promise<ExtractImageResult> {
  const { provider, opt } = await resolveProvider(input.modelTag);
  const { signal, cancel } = abortableTimeout(DEFAULT_CALL_TIMEOUT_MS);
  try {
    const result = await provider.completeWithImage({
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      images: [{ base64: input.base64, mimeType: input.mimeType }],
      temperature: 0,
      maxTokens: input.maxTokens ?? opt.maxTokens,
      // num_ctx + thinking take effect on the native Ollama provider;
      // the openai_compat fallback ignores num_ctx and best-efforts think.
      numCtx: opt.numCtx,
      thinking: opt.thinking,
      responseFormat: 'json',
      signal,
    });
    return {
      text: result.text,
      parsed: result.parsed,
      parseError: result.parseError,
      model: result.model,
      durationMs: result.durationMs,
    };
  } finally {
    cancel();
  }
}

export interface ExtractionHealth {
  ok: boolean;
  modelTag: string;
  baseUrl: string | null;
  modelInfo?: string;
  error?: string;
}

/**
 * Probe the configured local endpoint (reuses the provider's own
 * `testConnection`, which lists `/v1/models` or falls back to `/health`).
 * Read-only and never throws — returns a structured result the worker logs
 * at boot so an operator sees "model not loaded" immediately rather than on
 * the first extraction.
 */
export async function healthCheck(): Promise<ExtractionHealth> {
  const config = await aiConfigService.getRawConfig();
  const baseUrl = config.openaiCompatBaseUrl ?? null;
  const opt = resolveExtractionOptions(config);
  const modelTag = opt.modelTag || config.openaiCompatModel || 'minicpm-v4.5:latest';
  if (!baseUrl) {
    return { ok: false, modelTag, baseUrl: null, error: 'OpenAI-compatible base URL not configured' };
  }
  const provider = opt.ollamaNative
    ? new OllamaProvider(nativeOllamaBaseUrl(baseUrl), modelTag)
    : getProvider(PROVIDER_NAME, config, modelTag);
  const { signal, cancel } = abortableTimeout(HEALTH_TIMEOUT_MS);
  try {
    const res = await provider.testConnection(signal);
    return {
      ok: res.success,
      modelTag,
      baseUrl,
      ...(res.modelInfo ? { modelInfo: res.modelInfo } : {}),
      ...(res.error ? { error: res.error } : {}),
    };
  } catch (err) {
    const name = (err as { name?: string } | undefined)?.name ?? '';
    const isAbort = err instanceof TimeoutError || name.toLowerCase().includes('abort');
    return {
      ok: false,
      modelTag,
      baseUrl,
      error: isAbort ? `health check timed out after ${HEALTH_TIMEOUT_MS / 1000}s` : err instanceof Error ? err.message : String(err),
    };
  } finally {
    cancel();
  }
}
