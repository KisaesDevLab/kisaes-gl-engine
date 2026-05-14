// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AiProvider, CompletionParams, CompletionResult } from './ai-provider.interface.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { OpenAiProvider } from './openai.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { OllamaProvider } from './ollama.provider.js';
import { GlmOcrProvider } from './glm-ocr.provider.js';
import { OpenAiCompatProvider } from './openai-compat.provider.js';
import { decrypt } from '../../utils/encryption.js';
import { retryWithBackoff, abortableTimeout, withTimeout, TimeoutError } from '../../utils/retry.js';

export type { AiProvider, CompletionParams, CompletionResult } from './ai-provider.interface.js';
export type { VisionParams } from './ai-provider.interface.js';

interface AiConfigRow {
  anthropicApiKeyEncrypted?: string | null;
  openaiApiKeyEncrypted?: string | null;
  geminiApiKeyEncrypted?: string | null;
  ollamaBaseUrl?: string | null;
  glmOcrApiKeyEncrypted?: string | null;
  glmOcrBaseUrl?: string | null;
  openaiCompatBaseUrl?: string | null;
  openaiCompatApiKeyEncrypted?: string | null;
  openaiCompatModel?: string | null;
}

export function getProvider(providerName: string, config: AiConfigRow, model?: string): AiProvider {
  switch (providerName) {
    case 'anthropic':
      if (!config.anthropicApiKeyEncrypted) throw new Error('Anthropic API key not configured');
      return new AnthropicProvider(decrypt(config.anthropicApiKeyEncrypted), model);
    case 'openai':
      if (!config.openaiApiKeyEncrypted) throw new Error('OpenAI API key not configured');
      return new OpenAiProvider(decrypt(config.openaiApiKeyEncrypted), model);
    case 'gemini':
      if (!config.geminiApiKeyEncrypted) throw new Error('Gemini API key not configured');
      return new GeminiProvider(decrypt(config.geminiApiKeyEncrypted), model);
    case 'ollama':
      return new OllamaProvider(config.ollamaBaseUrl || undefined, model);
    case 'glm_ocr_cloud':
      if (!config.glmOcrApiKeyEncrypted) throw new Error('GLM-OCR API key not configured');
      return new GlmOcrProvider('cloud', decrypt(config.glmOcrApiKeyEncrypted));
    case 'glm_ocr_local': {
      // Default URL matches the Vibe-GLM-OCR appliance's OCR_PORT
      // default (8090). The old default was :11434 (Ollama), which
      // guaranteed a 404 against the appliance's llama.cpp server.
      // If the admin set an OCR_API_KEY on the appliance and entered
      // it in the GLM-OCR key field, reuse it as the bearer token for
      // the local endpoint — cloud and local modes are mutually
      // exclusive so the single key field is unambiguous.
      const url = config.glmOcrBaseUrl || 'http://localhost:8090';
      const localApiKey = config.glmOcrApiKeyEncrypted ? decrypt(config.glmOcrApiKeyEncrypted) : undefined;
      return new GlmOcrProvider('local', url, localApiKey);
    }
    case 'openai_compat': {
      // Generic OpenAI-compatible local/remote server. Points at
      // Ollama's `/v1`, llama.cpp's server, LM Studio, vLLM, etc.
      // Admin supplies: base URL (required), model name (defaults to
      // llama3.2 — a common Ollama model; callers can override via
      // the optional `model` argument), optional bearer API key.
      if (!config.openaiCompatBaseUrl) throw new Error('OpenAI-compat base URL not configured');
      const apiKey = config.openaiCompatApiKeyEncrypted ? decrypt(config.openaiCompatApiKeyEncrypted) : undefined;
      const effectiveModel = model || config.openaiCompatModel || 'llama3.2';
      return new OpenAiCompatProvider(config.openaiCompatBaseUrl, effectiveModel, apiKey);
    }
    default:
      throw new Error(`Unknown AI provider: ${providerName}`);
  }
}

export function hasCredentials(providerName: string, config: AiConfigRow): boolean {
  switch (providerName) {
    case 'anthropic': return !!config.anthropicApiKeyEncrypted;
    case 'openai': return !!config.openaiApiKeyEncrypted;
    case 'gemini': return !!config.geminiApiKeyEncrypted;
    case 'ollama': return true; // always available if Ollama is running
    case 'glm_ocr_cloud': return !!config.glmOcrApiKeyEncrypted;
    case 'glm_ocr_local': return true;
    case 'openai_compat': return !!config.openaiCompatBaseUrl;
    default: return false;
  }
}

// Providers that only do vision-to-text (no JSON structuring) — used to
// exclude them when picking a secondary text model for chained OCR. If
// you add another OCR-only provider, list it here.
const VISION_ONLY_PROVIDERS = new Set(['glm_ocr_local', 'glm_ocr_cloud']);

// Pick the first text-capable provider in preference order for
// structuring raw OCR text into JSON. Used by the GLM-OCR chain path in
// ai-receipt-ocr / ai-bill-ocr / ai-statement-parser.
//
// Order:
//   1. `preferred` (typically categorizationProvider or chatProvider)
//   2. Everything in fallbackChain
// Entries are skipped if they're vision-only or lack credentials.
// Returns null if nothing is configured — the caller should surface a
// `glm_ocr_no_structurer` warning so the admin knows to add a text LLM.
export function pickTextStructurer(
  config: AiConfigRow,
  fallbackChain: string[],
  preferred?: string | null,
): { name: string; provider: AiProvider } | null {
  const tryOne = (name: string): { name: string; provider: AiProvider } | null => {
    if (!name || VISION_ONLY_PROVIDERS.has(name)) return null;
    if (!hasCredentials(name, config)) return null;
    try {
      return { name, provider: getProvider(name, config) };
    } catch {
      return null;
    }
  };
  if (preferred) {
    const r = tryOne(preferred);
    if (r) return r;
  }
  for (const name of fallbackChain) {
    if (name === preferred) continue;
    const r = tryOne(name);
    if (r) return r;
  }
  return null;
}

/**
 * Wall-clock budget for a single provider attempt (one `complete()` plus
 * its internal retries). Each fallback attempt restarts the budget. The
 * default is intentionally generous — receipt OCR with cold-start
 * cloud providers can legitimately take 30+ seconds — but bounded so a
 * stuck upstream can't lock up the API process indefinitely.
 *
 * Callers can override via `params.timeoutMs` on the orchestrator path
 * (e.g. tighter timeout for chat, looser for bulk OCR).
 */
const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;

// Per-provider attempt with shared timeout/abort plumbing. Pulled out so
// the preferred-provider branch and the fallback-chain branch can't
// silently drift on retry behaviour or signal threading.
//
// Two layers of timeout enforcement:
//   1. `abortableTimeout(signal)` — threaded into the provider so SDKs
//      that respect AbortSignal (Anthropic / OpenAI / fetch-based) can
//      cancel the underlying request and tear down the socket.
//   2. `withTimeout` race around the whole call — guarantees the caller
//      is unblocked even when a provider IGNORES the abort signal
//      (Gemini's @google/genai doesn't expose one). The provider's
//      promise keeps running in the background; we attach a no-op catch
//      so a post-timeout rejection from it isn't logged as an unhandled
//      rejection.
async function attempt(
  provider: AiProvider,
  params: CompletionParams,
  timeoutMs: number,
): Promise<CompletionResult> {
  // One AbortController per attempt so a timeout in attempt N+1 doesn't
  // cascade-cancel attempt N's still-running fetch (which never happens
  // — attempts are serial — but the contract is clearer this way).
  const { signal, cancel } = abortableTimeout(timeoutMs);
  try {
    const inner = retryWithBackoff(
      () => provider.complete({ ...params, signal }),
      { maxRetries: 2, baseDelayMs: 1000 },
    );
    // Defensive catch attached BEFORE the race so a late rejection from
    // a non-abortable provider has at least one handler. Without this,
    // a Gemini call that wins the cancellation race against our timeout
    // would still eventually reject (network drop, billing limit, etc.)
    // and produce an `UnhandledPromiseRejection` warning long after the
    // caller has moved on. The catch is a sibling chain — it does NOT
    // affect the race's resolution.
    inner.catch(() => {
      // intentionally swallowed — see comment above
    });
    return await withTimeout(inner, timeoutMs, `provider.complete(${provider.name})`);
  } finally {
    cancel();
  }
}

export async function executeWithFallback(
  params: CompletionParams,
  config: AiConfigRow,
  fallbackChain: string[],
  preferredProvider?: string,
  preferredModel?: string,
  options?: { timeoutMs?: number },
): Promise<CompletionResult> {
  const errors: string[] = [];
  const timeoutMs = options?.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;

  // Tag timeout errors with the provider name so the combined error
  // message at the bottom shows operators which upstream stalled.
  const recordError = (providerName: string, err: any) => {
    if (err instanceof TimeoutError) {
      errors.push(`${providerName}: timeout after ${timeoutMs}ms`);
    } else {
      errors.push(`${providerName}: ${err?.message ?? String(err)}`);
    }
  };

  // Try preferred provider first (with retry + backoff + wall-clock timeout)
  if (preferredProvider) {
    if (!hasCredentials(preferredProvider, config)) {
      // Surface the actual cause instead of silently skipping. Without
      // this, an admin who's selected a provider but forgotten its key
      // sees the misleading "All AI providers failed. " (empty list)
      // aggregate. With it: "anthropic: no credentials configured".
      errors.push(`${preferredProvider}: no credentials configured`);
    } else {
      try {
        const provider = getProvider(preferredProvider, config, preferredModel);
        return await attempt(provider, params, timeoutMs);
      } catch (err: any) {
        recordError(preferredProvider, err);
      }
    }
  }

  // Try fallback chain (each provider gets retry + backoff + timeout)
  for (const providerName of fallbackChain) {
    if (providerName === preferredProvider) continue; // already tried / recorded above
    if (!hasCredentials(providerName, config)) {
      errors.push(`${providerName}: no credentials configured`);
      continue;
    }
    try {
      const provider = getProvider(providerName, config);
      return await attempt(provider, params, timeoutMs);
    } catch (err: any) {
      recordError(providerName, err);
      continue;
    }
  }

  // Typed error so callers can route on `code` rather than regex-match
  // the message. Carries the per-provider error list as a property for
  // detailed diagnostics without bloating the human-readable message.
  const aggErr: Error & { code?: string; providerErrors?: string[] } =
    new Error(`All AI providers failed. ${errors.join('; ')}`);
  aggErr.code = 'ai_all_providers_failed';
  aggErr.providerErrors = errors;
  throw aggErr;
}
