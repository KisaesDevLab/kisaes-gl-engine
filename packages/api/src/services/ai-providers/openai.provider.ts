// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import OpenAI from 'openai';
import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';
import { extractJsonForResult } from './json-utils.js';

export class OpenAiProvider implements AiProvider {
  name = 'openai';
  supportsVision = true;
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string = 'gpt-4o-mini') {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const start = Date.now();
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: params.maxTokens || 1024,
      temperature: params.temperature ?? 0.1,
      response_format: params.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
    }, { signal: params.signal });

    const text = response.choices[0]?.message?.content || '';
    const { parsed, parseError } = extractJsonForResult(text, params.responseFormat);

    return {
      text, parsed, parseError,
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
      model: this.model, provider: this.name, durationMs: Date.now() - start,
    };
  }

  async completeWithImage(params: VisionParams): Promise<CompletionResult> {
    const start = Date.now();
    const content: any[] = params.images.map((img) => ({
      type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
    }));
    content.push({ type: 'text', text: params.userPrompt });

    const response = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: params.maxTokens || 2048,
      temperature: params.temperature ?? 0.1,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content },
      ],
    }, { signal: params.signal });

    const text = response.choices[0]?.message?.content || '';
    const { parsed, parseError } = extractJsonForResult(text, params.responseFormat);

    return {
      text, parsed, parseError,
      inputTokens: response.usage?.prompt_tokens || 0,
      outputTokens: response.usage?.completion_tokens || 0,
      model: this.model, provider: this.name, durationMs: Date.now() - start,
    };
  }

  async testConnection(signal?: AbortSignal) {
    try {
      await this.client.chat.completions.create({
        model: this.model, max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }, { signal });
      return { success: true, modelInfo: this.model };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    return (inputTokens / 1_000_000) * 0.15 + (outputTokens / 1_000_000) * 0.6;
  }
}
