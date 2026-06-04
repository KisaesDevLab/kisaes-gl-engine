// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';
import { extractJsonForResult } from './json-utils.js';

export class OllamaProvider implements AiProvider {
  name = 'ollama';
  supportsVision = true; // depends on model, but we attempt it
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string = 'http://localhost:11434', model: string = 'llama3.2') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
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
        options: { temperature: params.temperature ?? 0.1 },
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
