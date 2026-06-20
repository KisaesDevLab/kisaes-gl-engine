// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';
import { extractJsonForResult } from './json-utils.js';
import { env } from '../../config/env.js';

export class OllamaProvider implements AiProvider {
  name = 'ollama';
  supportsVision = true; // depends on model, but we attempt it
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:11434', model: string = 'llama3.2') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  // Shared request tuning for both text and vision calls:
  //  - keep_alive keeps the model resident between requests (no cold
  //    reload on the next call); OLLAMA_KEEP_ALIVE tunes it.
  //  - num_predict caps output tokens — this is how the per-function
  //    maxTokens setting reaches Ollama (the /api/chat body ignores a
  //    top-level max_tokens).
  //  - num_ctx (optional, OLLAMA_NUM_CTX) widens the context window so a
  //    long COA/vendor/tag prompt isn't silently truncated.
  private requestExtras(params: CompletionParams): { keep_alive: string; options: Record<string, unknown> } {
    const options: Record<string, unknown> = { temperature: params.temperature ?? 0.1 };
    if (params.maxTokens) options['num_predict'] = params.maxTokens;
    if (env.OLLAMA_NUM_CTX) options['num_ctx'] = env.OLLAMA_NUM_CTX;
    return { keep_alive: env.OLLAMA_KEEP_ALIVE, options };
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt },
        ],
        format: params.responseFormat === 'json' ? 'json' : undefined,
        stream: false,
        // Thinking toggle. Ollama's native /api/chat accepts `think`
        // (boolean) for reasoning-capable models — `false` suppresses the
        // chain-of-thought entirely, which is faster and avoids the empty
        // `content` failure mode seen on the OpenAI-compat /v1 path. Omit
        // when unset so non-thinking models keep their default behaviour.
        ...(params.thinking ? { think: params.thinking === 'on' } : {}),
        ...this.requestExtras(params),
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      const err: any = new Error(`Ollama error: ${response.status} ${response.statusText}`);
      err.status = response.status;
      err.headers = Object.fromEntries(response.headers.entries());
      throw err;
    }

    const data = await response.json() as any;
    const text = data.message?.content || '';
    const { parsed, parseError } = extractJsonForResult(text, params.responseFormat);

    return {
      text, parsed, parseError,
      inputTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0,
      model: this.model, provider: this.name, durationMs: Date.now() - start,
    };
  }

  async completeWithImage(params: VisionParams): Promise<CompletionResult> {
    const start = Date.now();
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt, images: params.images.map((i) => i.base64) },
        ],
        format: params.responseFormat === 'json' ? 'json' : undefined,
        stream: false,
        ...(params.thinking ? { think: params.thinking === 'on' } : {}),
        ...this.requestExtras(params),
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      const err: any = new Error(`Ollama vision error: ${response.status} ${response.statusText}`);
      err.status = response.status;
      err.headers = Object.fromEntries(response.headers.entries());
      throw err;
    }

    const data = await response.json() as any;
    const text = data.message?.content || '';
    const { parsed, parseError } = extractJsonForResult(text, params.responseFormat);

    return {
      text, parsed, parseError,
      inputTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0,
      model: this.model, provider: this.name, durationMs: Date.now() - start,
    };
  }

  async testConnection(signal?: AbortSignal) {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal });
      // Mirror complete(): a reachable-but-wrong endpoint (404/500) must not
      // report "connected". Without this guard a misconfigured base URL whose
      // body happens to parse as JSON returns success.
      if (!response.ok) {
        return { success: false, error: `Ollama returned ${response.status}` };
      }
      const data = await response.json() as any;
      const models = (data.models || []).map((m: any) => m.name).join(', ');
      return { success: true, modelInfo: `Available models: ${models || 'none'}` };
    } catch (err: any) {
      return { success: false, error: err.message || 'Cannot connect to Ollama' };
    }
  }

  estimateCost(): number { return 0; } // self-hosted, free
}
