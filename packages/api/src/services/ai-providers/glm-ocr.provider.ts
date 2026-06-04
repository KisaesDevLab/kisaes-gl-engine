// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';

// GLM-OCR provider.
//
// Local mode talks to the Vibe-GLM-OCR appliance
// (github.com/KisaesDevLab/Vibe-GLM-OCR) — a llama.cpp server (NOT
// Ollama) running the GLM-OCR GGUF over an OpenAI-shape API. The
// appliance README is the source of truth for the request/response
// contract this provider implements. Specifically:
//
//   - Endpoint:   POST /v1/chat/completions   (standard OAI shape)
//   - Health:     GET  /health                returns {"status":"ok"}
//   - Auth:       optional Bearer via OCR_API_KEY env var on the appliance
//   - Model:      literal string "GLM-OCR" (single-purpose server)
//   - Temp:       0.02 (any higher hallucinates digits — non-negotiable
//                       per appliance README's note on financial OCR)
//   - Default port: 8090
//
// The model is vision-only: it responds to exactly two directive prompts
// ("Text Recognition:" / "Table Recognition:") and returns raw OCR text
// or a Markdown table — never structured JSON. Downstream JSON shaping
// is the service layer's job via `pickTextStructurer` (see ai-receipt-
// ocr.service / ai-bill-ocr.service / ai-statement-parser.service).
//
// Earlier versions of this file targeted Ollama endpoints (/api/chat,
// /api/tags) which 404 against the appliance — kept here as a
// historical note in case anyone hits the same trap.
export class GlmOcrProvider implements AiProvider {
  name: string;
  supportsVision = true;
  private mode: 'cloud' | 'local';
  private apiKeyOrUrl: string;
  private localApiKey: string | undefined;

  constructor(mode: 'cloud' | 'local', apiKeyOrUrl: string, localApiKey?: string) {
    this.mode = mode;
    this.name = mode === 'cloud' ? 'glm_ocr_cloud' : 'glm_ocr_local';
    this.apiKeyOrUrl = apiKeyOrUrl;
    this.localApiKey = localApiKey;
  }

  async complete(_params: CompletionParams): Promise<CompletionResult> {
    // GLM-OCR is vision-only — text-only completion requests return
    // empty so the caller's fallback chain / secondary provider picks
    // up structuring.
    return { text: '', inputTokens: 0, outputTokens: 0, model: 'glm-ocr', provider: this.name, durationMs: 0 };
  }

  async completeWithImage(params: VisionParams): Promise<CompletionResult> {
    const start = Date.now();
    if (this.mode === 'cloud') {
      return this.cloudOcr(params, start);
    } else {
      return this.localOcr(params, start);
    }
  }

  // Heuristic prompt selector. GLM-OCR only understands two directive
  // prompts; any free-text prompt from the caller falls back to the
  // text mode. Bank statements benefit from Table Recognition because
  // the transaction list is tabular and Markdown tables parse cleanly
  // downstream.
  private prompt(userPrompt: string): string {
    const hay = userPrompt.toLowerCase();
    if (hay.includes('statement') || hay.includes('table') || hay.includes('transactions')) {
      return 'Table Recognition:';
    }
    return 'Text Recognition:';
  }

  private async cloudOcr(params: VisionParams, start: number): Promise<CompletionResult> {
    const image = params.images[0];
    if (!image) throw new Error('No image provided');

    const response = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKeyOrUrl}`,
      },
      body: JSON.stringify({
        model: 'glm-ocr',
        content: [{ type: 'image', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } }],
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      const err: Error & { status?: number; headers?: Record<string, string> } = new Error(
        `GLM-OCR cloud error: ${response.status}`,
      );
      err.status = response.status;
      err.headers = Object.fromEntries(response.headers.entries());
      throw err;
    }

    const data = await response.json() as {
      result?: unknown;
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = typeof data.result === 'string'
      ? data.result
      : data.choices?.[0]?.message?.content || JSON.stringify(data);

    return {
      text,
      parsed: typeof data.result === 'object' && data.result !== null ? (data.result as Record<string, unknown>) : undefined,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      model: 'glm-ocr', provider: this.name, durationMs: Date.now() - start,
    };
  }

  private async localOcr(params: VisionParams, start: number): Promise<CompletionResult> {
    const image = params.images[0];
    if (!image) throw new Error('No image provided');

    const baseUrl = this.apiKeyOrUrl.replace(/\/$/, '');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.localApiKey) headers['Authorization'] = `Bearer ${this.localApiKey}`;

    // OpenAI-compatible payload expected by llama.cpp server. Content
    // is an array of parts: the image first, then the directive prompt.
    // Temperature is fixed at 0.02 per the Vibe-GLM-OCR README — higher
    // values hallucinate digits and ruin financial OCR.
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'GLM-OCR',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:${image.mimeType};base64,${image.base64}` } },
              { type: 'text', text: this.prompt(params.userPrompt) },
            ],
          },
        ],
        temperature: 0.02,
        stream: false,
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`GLM-OCR local error: ${response.status} ${body.slice(0, 200)}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content || '';

    return {
      text,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      model: 'glm-ocr', provider: this.name, durationMs: Date.now() - start,
    };
  }

  async testConnection(signal?: AbortSignal) {
    try {
      if (this.mode === 'cloud') {
        const response = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.apiKeyOrUrl}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'glm-ocr', content: [] }),
          signal,
        });
        // 401/403 = key rejected. The probe POSTs an empty `content`, so a
        // valid key may legitimately get a 4xx validation error — that still
        // proves the endpoint+key work. But a 404 (wrong endpoint) or 5xx
        // (service down) must NOT report success, which the old
        // `status !== 401 && status !== 403` check wrongly did.
        if (response.status === 401 || response.status === 403) {
          return { success: false, error: `Authentication failed: ${response.status}` };
        }
        if (response.status === 404 || response.status >= 500) {
          return { success: false, error: `GLM-OCR Cloud returned ${response.status}` };
        }
        return { success: true, modelInfo: 'GLM-OCR Cloud' };
      } else {
        // Vibe-GLM-OCR exposes `/health` when the model is loaded. This is
        // the canonical readiness signal per the appliance README.
        const baseUrl = this.apiKeyOrUrl.replace(/\/$/, '');
        const headers: Record<string, string> = {};
        if (this.localApiKey) headers['Authorization'] = `Bearer ${this.localApiKey}`;
        const response = await fetch(`${baseUrl}/health`, { headers, signal });
        if (!response.ok) {
          return { success: false, error: `Health check failed: ${response.status}` };
        }
        const body = await response.json().catch(() => ({})) as { status?: string };
        const healthy = body.status === 'ok';
        return {
          success: healthy,
          modelInfo: healthy ? `GLM-OCR server ready at ${baseUrl}` : 'Server responded but model not ready',
        };
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    return this.mode === 'cloud' ? (inputTokens + outputTokens) / 1_000_000 * 0.1 : 0;
  }
}
