// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';
import { extractJsonForResult } from './json-utils.js';
import { env } from '../../config/env.js';

// Minimal structural type for a non-streaming /api/chat response.
// `thinking` is populated for reasoning models when think is enabled;
// broken templates sometimes leak the entire answer there.
interface OllamaChatResponse {
  message?: { content?: string; thinking?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

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
    const numCtx = params.numCtx ?? env.OLLAMA_NUM_CTX;
    if (numCtx) options['num_ctx'] = numCtx;
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
      // A 404 from /api/chat almost always means the model isn't pulled on this
      // server — name it so the fix is obvious (and it's the #1 fallback-chain
      // footgun: a model id valid for a cloud provider isn't on Ollama).
      const detail = response.status === 404
        ? `model '${this.model}' not found on the Ollama server — run \`ollama pull ${this.model}\` or choose an installed model`
        : `${response.status} ${response.statusText}`;
      const err: any = new Error(`Ollama error: ${detail}`);
      err.status = response.status;
      err.headers = Object.fromEntries(response.headers.entries());
      throw err;
    }

    const data = await response.json() as OllamaChatResponse;
    return this.buildResult(data, params, start);
  }

  // Shared response mapping for text + vision:
  //  - done_reason 'length' = the reply hit num_predict; a JSON body cut
  //    mid-object must surface as "truncated (raise max tokens)", not
  //    "non-JSON".
  //  - When `content` is empty but the model emitted a separate
  //    `thinking` field (reasoning models with think enabled), salvage
  //    the JSON from the thinking text rather than failing on an empty
  //    response — some templates leak the entire answer there.
  private buildResult(data: OllamaChatResponse, params: CompletionParams, start: number): CompletionResult {
    const text = data.message?.content || '';
    const truncated = data.done_reason === 'length';
    const extractionSource = text || data.message?.thinking || '';
    const { parsed, parseError } = extractJsonForResult(extractionSource, params.responseFormat, { truncated });

    return {
      text, parsed, parseError, truncated,
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

    const data = await response.json() as OllamaChatResponse;
    return this.buildResult(data, params, start);
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
      const names: string[] = (data.models || []).map((m: any) => String(m.name ?? '')).filter(Boolean);
      const models = names.join(', ');
      // Honest-test contract: reachability alone isn't success — the model
      // this provider is configured to run must actually be installed, or
      // every real call will 404. Ollama tags carry a ":latest"/variant
      // suffix, so accept an exact match, the ":latest" form, or a bare-name
      // prefix match.
      const installed = names.some(
        (n) => n === this.model || n === `${this.model}:latest` || n.split(':')[0] === this.model,
      );
      if (!installed) {
        return {
          success: false,
          error: `Ollama reachable, but model '${this.model}' is not installed — run \`ollama pull ${this.model}\` or pick an installed model. Installed: ${models || 'none'}`,
        };
      }
      return { success: true, modelInfo: `Model '${this.model}' is installed. Available models: ${models || 'none'}` };
    } catch (err: any) {
      return { success: false, error: err.message || 'Cannot connect to Ollama' };
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, { signal });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const data = (await response.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name ?? '').filter(Boolean).sort();
  }

  estimateCost(): number { return 0; } // self-hosted, free
}
