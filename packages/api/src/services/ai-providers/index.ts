// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AiProvider, CompletionParams, CompletionResult } from './ai-provider.interface.js';
import { AnthropicProvider } from './anthropic.provider.js';
import { OpenAiProvider } from './openai.provider.js';
import { GeminiProvider } from './gemini.provider.js';
import { OllamaProvider } from './ollama.provider.js';
import { GlmOcrProvider } from './glm-ocr.provider.js';
import { decrypt } from '../../utils/encryption.js';
import { retryWithBackoff } from '../../utils/retry.js';

export type { AiProvider, CompletionParams, CompletionResult } from './ai-provider.interface.js';
export type { VisionParams } from './ai-provider.interface.js';

interface AiConfigRow {
  anthropicApiKeyEncrypted?: string | null;
  openaiApiKeyEncrypted?: string | null;
  geminiApiKeyEncrypted?: string | null;
  ollamaBaseUrl?: string | null;
  glmOcrApiKeyEncrypted?: string | null;
  glmOcrBaseUrl?: string | null;
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

export async function executeWithFallback(
  params: CompletionParams,
  config: AiConfigRow,
  fallbackChain: string[],
  preferredProvider?: string,
  preferredModel?: string,
): Promise<CompletionResult> {
  const errors: string[] = [];

  // Try preferred provider first (with retry + backoff)
  if (preferredProvider && hasCredentials(preferredProvider, config)) {
    try {
      const provider = getProvider(preferredProvider, config, preferredModel);
      return await retryWithBackoff(() => provider.complete(params), { maxRetries: 2, baseDelayMs: 1000 });
    } catch (err: any) {
      errors.push(`${preferredProvider}: ${err.message}`);
    }
  }

  // Try fallback chain (each provider gets retry + backoff)
  for (const providerName of fallbackChain) {
    if (providerName === preferredProvider) continue; // already tried
    if (!hasCredentials(providerName, config)) continue;
    try {
      const provider = getProvider(providerName, config);
      return await retryWithBackoff(() => provider.complete(params), { maxRetries: 2, baseDelayMs: 1000 });
    } catch (err: any) {
      errors.push(`${providerName}: ${err.message}`);
      continue;
    }
  }

  throw new Error(`All AI providers failed. ${errors.join('; ')}`);
}
