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
    case 'glm_ocr_local':
      return new GlmOcrProvider('local', config.glmOcrBaseUrl || 'http://localhost:11434');
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
