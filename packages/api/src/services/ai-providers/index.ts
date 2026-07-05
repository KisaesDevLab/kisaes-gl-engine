// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AiProvider, CompletionParams, CompletionResult } from './ai-provider.interface.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { OpenAiProvider } from './openai.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { OllamaProvider } from './ollama.provider.js';
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
  openaiCompatBaseUrl?: string | null;
  openaiCompatApiKeyEncrypted?: string | null;
  openaiCompatModel?: string | null;
  // 'auto' (default) | 'native' | 'compat'. Controls whether the
  // openai_compat endpoint is driven via Ollama's native /api/chat (the
  // "right method" — correct for thinking models, supports num_ctx /
  // keep_alive / think) or the OpenAI-compatible /v1 path. See
  // resolveOllamaNative.
  openaiCompatMode?: string | null;
}

// Normalise an Ollama base URL to the server root: the OllamaProvider
// appends /api/chat itself, so strip a trailing slash and a trailing /v1
// (admins commonly paste the /v1 form they use for the openai_compat slot).
export function nativeOllamaBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

// Decide whether an openai_compat endpoint should be driven natively.
// 'auto' detects Ollama by its default port (:11434) or an "ollama"
// hostname — so an Ollama box auto-uses /api/chat (fixing empty content on
// thinking models) while vLLM/llama.cpp on other ports stay on /v1.
export function resolveOllamaNative(baseUrl: string, mode?: string | null): boolean {
  if (mode === 'native') return true;
  if (mode === 'compat') return false;
  return /:11434(\b|\/|$)/.test(baseUrl) || /\bollama\b/i.test(baseUrl);
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
    case 'openai_compat': {
      // Generic OpenAI-compatible local/remote server. Points at
      // Ollama's `/v1`, llama.cpp's server, LM Studio, vLLM, etc.
      // Admin supplies: base URL (required), model name (defaults to
      // llama3.2 — a common Ollama model; callers can override via
      // the optional `model` argument), optional bearer API key.
      if (!config.openaiCompatBaseUrl) throw new Error('OpenAI-compat base URL not configured');
      const effectiveModel = model || config.openaiCompatModel || 'llama3.2';
      // When the endpoint is Ollama, drive it natively (/api/chat). This is
      // the correct method for Ollama-served models — especially thinking
      // models like Qwen3.5, which return empty `content` on the /v1 path —
      // and it unlocks num_ctx / keep_alive / think. Non-Ollama backends
      // (vLLM, llama.cpp, LM Studio) keep using /v1.
      if (resolveOllamaNative(config.openaiCompatBaseUrl, config.openaiCompatMode)) {
        return new OllamaProvider(nativeOllamaBaseUrl(config.openaiCompatBaseUrl), effectiveModel);
      }
      const apiKey = config.openaiCompatApiKeyEncrypted ? decrypt(config.openaiCompatApiKeyEncrypted) : undefined;
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
    case 'openai_compat': return !!config.openaiCompatBaseUrl;
    default: return false;
  }
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
        // Name the model in the error so the aggregate distinguishes "the
        // provider is down" from "this specific model id failed".
        recordError(
          preferredModel ? `${preferredProvider} (model ${preferredModel})` : preferredProvider,
          err,
        );
      }
      // A stale per-function model override (e.g. a retired model id left
      // over from a local-Ollama era) must not strand an otherwise-healthy
      // provider: retry the SAME provider once with its default model
      // before walking the fallback chain.
      if (preferredModel) {
        try {
          const provider = getProvider(preferredProvider, config);
          return await attempt(provider, params, timeoutMs);
        } catch (err) {
          recordError(`${preferredProvider} (default model)`, err);
        }
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

  // Server logs must ALWAYS carry the per-provider detail, even when a
  // caller catches this error and re-shapes it into a generic message —
  // otherwise `ai_all_providers_failed` masks the real cause.
  // eslint-disable-next-line no-console
  console.warn('[ai] all providers failed:', errors.join('; '));

  // Typed error so callers can route on `code` rather than regex-match
  // the message. Carries the per-provider error list as a property for
  // detailed diagnostics without bloating the human-readable message.
  const aggErr: Error & { code?: string; providerErrors?: string[] } =
    new Error(`All AI providers failed. ${errors.join('; ')}`);
  aggErr.code = 'ai_all_providers_failed';
  aggErr.providerErrors = errors;
  throw aggErr;
}
