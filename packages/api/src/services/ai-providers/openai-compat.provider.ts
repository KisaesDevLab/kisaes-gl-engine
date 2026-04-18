// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';

// Generic OpenAI-compatible provider.
//
// Ollama (via `/v1`), llama.cpp server, LM Studio, vLLM, and the
// Vibe-GLM-OCR appliance all expose the same `/v1/chat/completions`
// endpoint with roughly the same request / response shape. This
// provider is the shared path: give it a base URL + model name (and
// optionally an API key) and it talks to any of them.
//
// The existing dedicated providers (OllamaProvider on `/api/chat`,
// GlmOcrProvider with GLM-OCR's directive prompts) remain because they
// expose protocol quirks this generic path can't abstract over
// (Ollama's `format:'json'` flag, GLM-OCR's fixed Text/Table
// Recognition prompts, etc.).
export class OpenAiCompatProvider implements AiProvider {
  name = 'openai_compat';
  supportsVision = true; // depends on the served model; we try
  private baseUrl: string;
  private model: string;
  private apiKey: string | undefined;

  constructor(baseUrl: string, model: string = 'llama3.2', apiKey?: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    // Servers that don't require auth (e.g. plain llama.cpp, default
    // Ollama) ignore the header. Sending it unconditionally when set
    // keeps the call identical to the OpenAI SDK's behaviour.
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const start = Date.now();
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
      temperature: params.temperature ?? 0.1,
      stream: false,
    };
    if (params.maxTokens) body['max_tokens'] = params.maxTokens;
    // OpenAI-style JSON mode. llama.cpp's server and Ollama's /v1
    // endpoint both accept `response_format: { type: 'json_object' }`
    // as of current versions; servers that don't recognise it ignore
    // it rather than erroring. If the server lacks JSON mode the caller
    // still gets text in `result.text` and can `safeJsonParse` it.
    if (params.responseFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err: Error & { status?: number } = new Error(
        `OpenAI-compat error: ${response.status} ${response.statusText} ${text.slice(0, 200)}`,
      );
      err.status = response.status;
      throw err;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content || '';
    let parsed: Record<string, unknown> | undefined;
    if (params.responseFormat === 'json') {
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* fall through */ }
    }

    return {
      text,
      parsed,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      model: this.model,
      provider: this.name,
      durationMs: Date.now() - start,
    };
  }

  async completeWithImage(params: VisionParams): Promise<CompletionResult> {
    const start = Date.now();
    const userContent: Array<Record<string, unknown>> = [
      { type: 'text', text: params.userPrompt },
    ];
    // Prepend images so the model sees them before the instruction.
    // Some llama.cpp multimodal models are sensitive to content order.
    for (const img of params.images) {
      userContent.unshift({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
      });
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: params.temperature ?? 0.1,
      stream: false,
    };
    if (params.maxTokens) body['max_tokens'] = params.maxTokens;
    if (params.responseFormat === 'json') {
      body['response_format'] = { type: 'json_object' };
    }

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const err: Error & { status?: number } = new Error(
        `OpenAI-compat vision error: ${response.status} ${response.statusText} ${text.slice(0, 200)}`,
      );
      err.status = response.status;
      throw err;
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content || '';
    let parsed: Record<string, unknown> | undefined;
    if (params.responseFormat === 'json') {
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { /* fall through */ }
    }

    return {
      text,
      parsed,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      model: this.model,
      provider: this.name,
      durationMs: Date.now() - start,
    };
  }

  async testConnection() {
    try {
      const response = await fetch(`${this.baseUrl}/v1/models`, { headers: this.headers() });
      if (!response.ok) {
        // Some servers (notably a few llama.cpp builds) don't serve
        // /v1/models but do serve /health — fall back to that signal.
        const healthResp = await fetch(`${this.baseUrl}/health`).catch(() => null);
        if (healthResp && healthResp.ok) {
          return { success: true, modelInfo: `OpenAI-compat server reachable at ${this.baseUrl} (no /v1/models)` };
        }
        return { success: false, error: `/v1/models returned ${response.status}` };
      }
      const data = (await response.json()) as { data?: Array<{ id?: string }> };
      const models = (data.data || []).map((m) => m.id).filter(Boolean) as string[];
      const configured = this.model;
      const hasConfigured = models.includes(configured);
      const list = models.slice(0, 10).join(', ') || 'none';
      return {
        success: true,
        modelInfo: hasConfigured
          ? `Configured model '${configured}' is available. Other models: ${list}`
          : `Configured model '${configured}' NOT in server catalog. Available: ${list}`,
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Self-hosted by convention. If the admin points this provider at a
  // paid hosted endpoint (e.g. a cloud OpenAI-compatible proxy), they
  // can track costs externally; we don't try to model per-provider
  // pricing here.
  estimateCost(): number { return 0; }
}
