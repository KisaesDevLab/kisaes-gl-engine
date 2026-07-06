// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { GoogleGenAI } from '@google/genai';
import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';
import { extractJsonForResult } from './json-utils.js';

// Token-limit stop detection: the SDK surfaces the finish reason on the
// first candidate. Structural typing keeps this resilient across SDK
// versions (the enum name moved between releases).
function isMaxTokensStop(response: { candidates?: Array<{ finishReason?: unknown }> }): boolean {
  return String(response.candidates?.[0]?.finishReason ?? '') === 'MAX_TOKENS';
}

// Note on cancellation: @google/genai (as of the version pinned in
// package.json) does not expose a documented `AbortSignal` option on
// generateContent. We rely on the outer `withTimeout` race in
// executeWithFallback / testProvider to unblock callers; the underlying
// request may continue in the background until it completes or the SDK
// hits its own timeout. If the SDK adds signal support later, thread
// `params.signal` through here.
export class GeminiProvider implements AiProvider {
  name = 'gemini';
  supportsVision = true;
  private client: GoogleGenAI;
  private model: string;
  private apiKey: string;

  constructor(apiKey: string, model: string = 'gemini-2.5-flash') {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
    this.apiKey = apiKey;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    // REST list is more stable across SDK versions than the pager; keep only
    // models that support generateContent and strip the "models/" prefix.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(this.apiKey)}&pageSize=200`,
      { signal },
    );
    if (!res.ok) throw new Error(`Gemini models list returned ${res.status}`);
    const data = (await res.json()) as { models?: Array<{ name?: string; supportedGenerationMethods?: string[] }> };
    return (data.models ?? [])
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const start = Date.now();
    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: `${params.systemPrompt}\n\n${params.userPrompt}` }] }],
      config: {
        maxOutputTokens: params.maxTokens || 1024,
        temperature: params.temperature ?? 0.1,
        responseMimeType: params.responseFormat === 'json' ? 'application/json' : undefined,
      },
    });

    const text = response.text || '';
    const truncated = isMaxTokensStop(response);
    const { parsed, parseError } = extractJsonForResult(text, params.responseFormat, { truncated });

    return {
      text, parsed, parseError, truncated,
      inputTokens: response.usageMetadata?.promptTokenCount || 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
      model: this.model, provider: this.name, durationMs: Date.now() - start,
    };
  }

  async completeWithImage(params: VisionParams): Promise<CompletionResult> {
    const start = Date.now();
    const parts: any[] = params.images.map((img) => ({
      inlineData: { mimeType: img.mimeType, data: img.base64 },
    }));
    parts.push({ text: `${params.systemPrompt}\n\n${params.userPrompt}` });

    const response = await this.client.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts }],
      config: {
        maxOutputTokens: params.maxTokens || 2048,
        temperature: params.temperature ?? 0.1,
        // Native JSON mode was previously only set on the text path;
        // vision OCR calls request responseFormat 'json' too.
        responseMimeType: params.responseFormat === 'json' ? 'application/json' : undefined,
      },
    });

    const text = response.text || '';
    const truncated = isMaxTokensStop(response);
    const { parsed, parseError } = extractJsonForResult(text, params.responseFormat, { truncated });

    return {
      text, parsed, parseError, truncated,
      inputTokens: response.usageMetadata?.promptTokenCount || 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
      model: this.model, provider: this.name, durationMs: Date.now() - start,
    };
  }

  async testConnection(_signal?: AbortSignal) {
    try {
      await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts: [{ text: 'ping' }] }],
        config: { maxOutputTokens: 10 },
      });
      return { success: true, modelInfo: this.model };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    // Per-model pricing keyed off this.model. Defaults to Flash rates if
    // the configured model isn't in the table — Flash is the cheapest of
    // the current Gemini tier, so this errs toward under-counting cost
    // when the table is stale rather than over-blocking on budget. Bump
    // the table when new models ship.
    const k = this.model.toLowerCase();
    let inPerM: number;
    let outPerM: number;
    if (k.includes('2.5-pro') || k.includes('1.5-pro')) {
      inPerM = 1.25; outPerM = 5.0;
    } else if (k.includes('2.0-flash')) {
      inPerM = 0.10; outPerM = 0.40;
    } else {
      // gemini-2.5-flash, gemini-1.5-flash, and unknown → flash pricing
      inPerM = 0.075; outPerM = 0.30;
    }
    return (inputTokens / 1_000_000) * inPerM + (outputTokens / 1_000_000) * outPerM;
  }
}
