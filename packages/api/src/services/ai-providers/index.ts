// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { AiProvider, CompletionParams, CompletionResult } from './ai-provider.interface.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { OpenAiProvider } from './openai.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { OllamaProvider } from './ollama.provider.js';
import { OpenAiCompatProvider } from './openai-compat.provider.js';
import { DigitalOceanProvider } from './digitalocean.provider.js';
import { decrypt } from '../../utils/encryption.js';
import { retryWithBackoff, abortableTimeout, withTimeout, TimeoutError } from '../../utils/retry.js';
import { routeFor, routerOn, routerProvider, type RouterSettings } from './vibe-router.provider.js';
import { isDesktop } from '../../desktop/profile.js';
import { getSessionSecret, getSessionOllamaModel } from '../../desktop/session-secrets.js';
import { AppError } from '../../utils/errors.js';
import {
  classifyNetworkError,
  ensureOnline,
  isOfflineUnavailable,
  targetFromUrl,
  type NetTarget,
} from '../../utils/offline.js';

export type { AiProvider, CompletionParams, CompletionResult } from './ai-provider.interface.js';
export type { VisionParams } from './ai-provider.interface.js';
export {
  MYBOOKS_TASK_CLASSES,
  VibeRouterProvider,
  aiMode,
  registerMybooksTaskClasses,
  routerProvider,
  validateAiModeEnv,
  routeFor,
  routerOn,
  routerAvailable,
  ROUTER_FEATURES,
} from './vibe-router.provider.js';

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
  digitaloceanApiKeyEncrypted?: string | null;
  digitaloceanModel?: string | null;
  digitaloceanBaseUrl?: string | null;
  // Per-feature router settings (migration 0185).
  routerEnabled?: boolean | null;
  routerFeatures?: unknown;
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

// --- desktop credential resolution (E6, U-09/U-11) ------------------------
//
// In desktop mode (CL_MODE=desktop) API keys come from the per-session store
// (desktop/session-secrets.ts) and never from the ai_config columns; only
// Anthropic, OpenAI and Ollama are offered (Q-33). On the server nothing
// changes: keys are decrypted from ai_config as before.

/** Providers the desktop edition offers. */
export const DESKTOP_AI_PROVIDERS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'ollama']);

export function isDesktopProvider(providerName: string): boolean {
  return DESKTOP_AI_PROVIDERS.has(providerName);
}

/** The fallback chain restricted to the desktop allowlist; unchanged on the server. */
export function desktopFallbackChain(chain: readonly string[]): string[] {
  return isDesktop() ? chain.filter(isDesktopProvider) : [...chain];
}

/** 400 AI_PROVIDER_NOT_AVAILABLE for a provider the desktop edition does not offer. */
export function assertDesktopProvider(providerName: string): void {
  if (isDesktop() && !isDesktopProvider(providerName)) {
    throw AppError.badRequest(
      `AI provider '${providerName}' is not available in the desktop edition. Choose Anthropic, OpenAI or a local Ollama model.`,
      'AI_PROVIDER_NOT_AVAILABLE',
    );
  }
}

export interface ResolvedCredential {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

/**
 * The credential a provider is built from, or null when it has none.
 * Desktop: the session store only (ai_config key columns are ignored);
 * an unlisted provider resolves to null. Server: the stored, encrypted
 * columns, exactly as before.
 */
export function resolveCredential(providerName: string, config: AiConfigRow): ResolvedCredential | null {
  if (isDesktop()) {
    switch (providerName) {
      case 'anthropic': {
        const apiKey = getSessionSecret('ai.anthropic');
        return apiKey ? { apiKey } : null;
      }
      case 'openai': {
        const apiKey = getSessionSecret('ai.openai');
        return apiKey ? { apiKey } : null;
      }
      case 'ollama':
        return {
          baseUrl: getSessionSecret('ai.ollama.baseUrl') ?? config.ollamaBaseUrl ?? undefined,
          model: getSessionOllamaModel() ?? undefined,
        };
      default:
        return null;
    }
  }
  switch (providerName) {
    case 'anthropic':
      return config.anthropicApiKeyEncrypted ? { apiKey: decrypt(config.anthropicApiKeyEncrypted) } : null;
    case 'openai':
      return config.openaiApiKeyEncrypted ? { apiKey: decrypt(config.openaiApiKeyEncrypted) } : null;
    case 'gemini':
      return config.geminiApiKeyEncrypted ? { apiKey: decrypt(config.geminiApiKeyEncrypted) } : null;
    case 'ollama':
      return { baseUrl: config.ollamaBaseUrl || undefined };
    case 'openai_compat':
      if (!config.openaiCompatBaseUrl) return null;
      return {
        baseUrl: config.openaiCompatBaseUrl,
        model: config.openaiCompatModel || undefined,
        apiKey: config.openaiCompatApiKeyEncrypted ? decrypt(config.openaiCompatApiKeyEncrypted) : undefined,
      };
    case 'digitalocean':
      if (!config.digitaloceanApiKeyEncrypted) return null;
      return {
        apiKey: decrypt(config.digitaloceanApiKeyEncrypted),
        model: config.digitaloceanModel || undefined,
        baseUrl: config.digitaloceanBaseUrl || undefined,
      };
    default:
      return null;
  }
}

export function getProvider(
  providerName: string,
  config: AiConfigRow,
  model?: string,
  opts?: {
    /** MIG-2: bypass the router short-circuit. ONLY for surfaces that are
     *  direct by design in both modes: the pinned-local document-extraction
     *  pipeline (qwen-client), GLM-OCR, and the admin credential test /
     *  model-list endpoints (which diagnose a SPECIFIC stored provider). */
    forceDirect?: boolean;
  },
): AiProvider {
  assertDesktopProvider(providerName);
  // Per-feature routing: when the router is on, hand back a provider that
  // decides at call time from params.taskClass (router for routed features,
  // this direct provider otherwise). The direct provider is still built now
  // so a missing key fails exactly where it did before — but only surfaces
  // for calls that actually go direct.
  if (!opts?.forceDirect && routerOn(config)) {
    let direct: AiProvider | null = null;
    let directError: unknown = null;
    try { direct = buildDirect(providerName, config, model); } catch (err) { directError = err; }
    return new FeatureRoutedProvider(config as RouterSettings, direct, directError);
  }
  return buildDirect(providerName, config, model);
}

// --- offline fast-fail (desktop) -----------------------------------------
//
// Cloud providers the desktop edition offers. Their SDKs read the base URL
// from these env vars, so the connectivity probe targets the same host the
// SDK will use. Ollama (and other self-hosted endpoints) are not wrapped:
// they are local or LAN, and their errors keep their meaning.
const CLOUD_AI_BASE_URLS: Record<string, { env: string; fallback: string }> = {
  anthropic: { env: 'ANTHROPIC_BASE_URL', fallback: 'https://api.anthropic.com' },
  openai: { env: 'OPENAI_BASE_URL', fallback: 'https://api.openai.com' },
};

/** Host:port a cloud provider connects to, or null for local providers. */
export function cloudAiTarget(providerName: string): NetTarget | null {
  const entry = CLOUD_AI_BASE_URLS[providerName];
  if (!entry) return null;
  const raw = process.env[entry.env];
  return targetFromUrl(raw && raw.trim() !== '' ? raw.trim() : entry.fallback);
}

/**
 * Desktop only: before every call, check that the provider's host is
 * reachable (utils/offline.ts: 1.5 s probe, CL_OFFLINE=on fails at once),
 * and map network errors from the SDK to OfflineUnavailableError (HTTP 503
 * OFFLINE_UNAVAILABLE). Covers complete(), completeWithImage() (the OCR
 * and vision callers that bypass executeWithFallback), testConnection()
 * and listModels().
 */
class OfflineAwareProvider implements AiProvider {
  readonly name: string;
  readonly supportsVision: boolean;
  listModels?: (signal?: AbortSignal) => Promise<string[]>;
  private readonly feature: string;
  constructor(private readonly inner: AiProvider, private readonly target: NetTarget) {
    this.name = inner.name;
    this.supportsVision = inner.supportsVision;
    this.feature = `ai:${inner.name}`;
    if (inner.listModels) {
      const list = inner.listModels.bind(inner);
      this.listModels = (signal?: AbortSignal) => this.guard(() => list(signal));
    }
  }
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    await ensureOnline(this.feature, this.target);
    try {
      return await fn();
    } catch (err) {
      throw classifyNetworkError(err, this.feature) ?? err;
    }
  }
  complete(params: CompletionParams): Promise<CompletionResult> {
    return this.guard(() => this.inner.complete(params));
  }
  completeWithImage(params: import('./ai-provider.interface.js').VisionParams): Promise<CompletionResult> {
    return this.guard(() => this.inner.completeWithImage(params));
  }
  testConnection(signal?: AbortSignal) {
    return this.guard(() => this.inner.testConnection(signal));
  }
  estimateCost(inputTokens: number, outputTokens: number): number {
    return this.inner.estimateCost(inputTokens, outputTokens);
  }
}

function buildDirect(providerName: string, config: AiConfigRow, model?: string): AiProvider {
  const provider = buildProvider(providerName, config, model);
  if (!isDesktop()) return provider;
  const target = cloudAiTarget(providerName);
  return target ? new OfflineAwareProvider(provider, target) : provider;
}

function buildProvider(providerName: string, config: AiConfigRow, model?: string): AiProvider {
  assertDesktopProvider(providerName);
  const cred = resolveCredential(providerName, config);
  switch (providerName) {
    case 'anthropic':
      if (!cred?.apiKey) throw new Error('Anthropic API key not configured');
      return new AnthropicProvider(cred.apiKey, model);
    case 'openai':
      if (!cred?.apiKey) throw new Error('OpenAI API key not configured');
      return new OpenAiProvider(cred.apiKey, model);
    case 'gemini':
      if (!cred?.apiKey) throw new Error('Gemini API key not configured');
      return new GeminiProvider(cred.apiKey, model);
    case 'ollama':
      // Desktop: the session endpoint/model (if any) stand in for the stored
      // base URL and the provider default; a caller's model still wins.
      return new OllamaProvider(cred?.baseUrl, model || cred?.model);
    case 'openai_compat': {
      // Generic OpenAI-compatible local/remote server. Points at
      // Ollama's `/v1`, llama.cpp's server, LM Studio, vLLM, etc.
      // Admin supplies: base URL (required), model name (defaults to
      // llama3.2 — a common Ollama model; callers can override via
      // the optional `model` argument), optional bearer API key.
      if (!cred?.baseUrl) throw new Error('OpenAI-compat base URL not configured');
      const effectiveModel = model || cred.model || 'llama3.2';
      // When the endpoint is Ollama, drive it natively (/api/chat). This is
      // the correct method for Ollama-served models — especially thinking
      // models like Qwen3.5, which return empty `content` on the /v1 path —
      // and it unlocks num_ctx / keep_alive / think. Non-Ollama backends
      // (vLLM, llama.cpp, LM Studio) keep using /v1.
      if (resolveOllamaNative(cred.baseUrl, config.openaiCompatMode)) {
        return new OllamaProvider(nativeOllamaBaseUrl(cred.baseUrl), effectiveModel);
      }
      return new OpenAiCompatProvider(cred.baseUrl, effectiveModel, cred.apiKey);
    }
    case 'digitalocean':
      if (!cred?.apiKey) throw new Error('DigitalOcean API key not configured');
      return new DigitalOceanProvider(cred.apiKey, model || cred.model, cred.baseUrl);
    default:
      throw new Error(`Unknown AI provider: ${providerName}`);
  }
}

export function hasCredentials(providerName: string, config: AiConfigRow): boolean {
  // Desktop: a session key (or, for Ollama, nothing) — never a stored column.
  if (isDesktop()) return isDesktopProvider(providerName) && resolveCredential(providerName, config) !== null;
  switch (providerName) {
    case 'anthropic': return !!config.anthropicApiKeyEncrypted;
    case 'openai': return !!config.openaiApiKeyEncrypted;
    case 'gemini': return !!config.geminiApiKeyEncrypted;
    case 'ollama': return true; // always available if Ollama is running
    case 'openai_compat': return !!config.openaiCompatBaseUrl;
    case 'digitalocean': return !!config.digitaloceanApiKeyEncrypted;
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
  // Desktop: only the allowlisted providers are ever tried (Q-33). A
  // preferred provider outside it is recorded, not attempted.
  if (isDesktop() && preferredProvider && !isDesktopProvider(preferredProvider)) {
    errors.push(`${preferredProvider}: not available in the desktop edition (AI_PROVIDER_NOT_AVAILABLE)`);
    preferredProvider = undefined;
  }
  fallbackChain = desktopFallbackChain(fallbackChain);

  // A feature switched to the router short-circuits provider selection and
  // the fallback chain — failover WITHIN router mode is the router's own job,
  // and a router outage must surface as an error, not silently retry a
  // direct provider around the scrubber and ledger.
  if (routeFor(params.taskClass, config)) {
    return attempt(routerProvider(), params, timeoutMs);
  }

  // Desktop offline handling (utils/offline.ts). Once one cloud provider
  // reports OFFLINE_UNAVAILABLE, the other cloud providers in this call are
  // skipped (each would spend its own probe budget to learn the same
  // thing) while local providers (Ollama) are still tried. When every
  // attempt failed only because of that, the caller gets the typed 503
  // instead of the aggregate error. Never set on the server.
  let offlineErr: Error | null = null;
  let otherFailures = 0;
  const skipOffline = (providerName: string): boolean => {
    if (!offlineErr || !isDesktop() || !cloudAiTarget(providerName)) return false;
    errors.push(`${providerName}: offline (skipped)`);
    return true;
  };

  // Tag timeout errors with the provider name so the combined error
  // message at the bottom shows operators which upstream stalled.
  const recordError = (providerName: string, err: any) => {
    if (isOfflineUnavailable(err)) {
      offlineErr ??= err;
      errors.push(`${providerName}: offline`);
      return;
    }
    otherFailures++;
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
      // before walking the fallback chain. (Not when it was unreachable.)
      if (preferredModel && !skipOffline(preferredProvider)) {
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
    if (skipOffline(providerName)) continue;
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

  if (offlineErr && otherFailures === 0) throw offlineErr;

  // Typed error so callers can route on `code` rather than regex-match
  // the message. Carries the per-provider error list as a property for
  // detailed diagnostics without bloating the human-readable message.
  const aggErr: Error & { code?: string; providerErrors?: string[] } =
    new Error(`All AI providers failed. ${errors.join('; ')}`);
  aggErr.code = 'ai_all_providers_failed';
  aggErr.providerErrors = errors;
  throw aggErr;
}

/**
 * Corrective follow-up appended to the user prompt on a parse-failure
 * retry. Exported so tests can assert the retry actually carried it.
 */
export const JSON_CORRECTIVE_SUFFIX =
  '\n\nIMPORTANT: Your previous reply was not valid JSON. Respond again with ONLY the JSON — ' +
  'no markdown code fences, no <think> blocks, no explanations before or after.';

/**
 * `executeWithFallback` + one corrective retry when the reply wasn't
 * parseable JSON. Cheap insurance for small JSON tasks (categorization):
 * a model that rambled once usually complies when told its previous
 * reply was rejected.
 *
 *  - No retry when the response was TRUNCATED — the same maxTokens would
 *    truncate again; the caller should surface "raise max tokens".
 *  - A transport failure during the retry returns the FIRST result (it
 *    at least carries the diagnostic parseError) instead of throwing a
 *    fresh, less-specific error.
 *  - If the retry also fails to parse, the first result is returned so
 *    the surfaced excerpt reflects the model's unprompted behaviour.
 */
export async function executeJsonWithRetry(
  params: CompletionParams,
  config: AiConfigRow,
  fallbackChain: string[],
  preferredProvider?: string,
  preferredModel?: string,
  options?: { timeoutMs?: number },
): Promise<CompletionResult> {
  const first = await executeWithFallback(params, config, fallbackChain, preferredProvider, preferredModel, options);
  if (!first.parseError || first.truncated) return first;

  // eslint-disable-next-line no-console
  console.warn(
    `[ai] non-JSON reply from ${first.provider}/${first.model}; retrying once with a corrective instruction. Detail: ${first.parseError}`,
  );
  try {
    const second = await executeWithFallback(
      { ...params, userPrompt: params.userPrompt + JSON_CORRECTIVE_SUFFIX },
      config, fallbackChain, preferredProvider, preferredModel, options,
    );
    return second.parseError ? first : second;
  } catch {
    return first;
  }
}

/**
 * Routes each call by its task class: router for features switched to the
 * router in Admin -> AI, the configured direct provider for everything else.
 * No silent cross-mode fallback in either direction.
 */
class FeatureRoutedProvider implements AiProvider {
  name: string;
  supportsVision: boolean;
  constructor(
    private readonly cfg: RouterSettings,
    private readonly direct: AiProvider | null,
    private readonly directError: unknown,
  ) {
    this.name = direct?.name ?? 'vibe_router';
    this.supportsVision = direct?.supportsVision ?? true;
  }
  private pick(taskClass: string | undefined): AiProvider {
    if (routeFor(taskClass, this.cfg)) return routerProvider();
    if (!this.direct) throw this.directError instanceof Error ? this.directError : new Error(String(this.directError));
    return this.direct;
  }
  complete(params: CompletionParams): Promise<CompletionResult> {
    return this.pick(params.taskClass).complete(params);
  }
  completeWithImage(params: import('./ai-provider.interface.js').VisionParams): Promise<CompletionResult> {
    return this.pick(params.taskClass).completeWithImage(params);
  }
  testConnection(signal?: AbortSignal) {
    return this.pick(undefined).testConnection(signal);
  }
  estimateCost(inputTokens: number, outputTokens: number): number {
    return this.direct ? this.direct.estimateCost(inputTokens, outputTokens) : 0;
  }
  listModels(signal?: AbortSignal): Promise<string[]> {
    return this.direct?.listModels ? this.direct.listModels(signal) : Promise.resolve([]);
  }
}
