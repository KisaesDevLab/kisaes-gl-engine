import Anthropic from '@anthropic-ai/sdk';
import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';

export class AnthropicProvider implements AiProvider {
  name = 'anthropic';
  supportsVision = true;
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-20250514') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const start = Date.now();
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens || 1024,
      system: params.systemPrompt,
      messages: [{ role: 'user', content: params.userPrompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    let parsed: any;
    if (params.responseFormat === 'json') {
      try { parsed = JSON.parse(text); } catch { /* ignore parse errors */ }
    }

    return {
      text,
      parsed,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: this.model,
      provider: this.name,
      durationMs: Date.now() - start,
    };
  }

  async completeWithImage(params: VisionParams): Promise<CompletionResult> {
    const start = Date.now();
    const content: any[] = params.images.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
    }));
    content.push({ type: 'text', text: params.userPrompt });

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: params.maxTokens || 2048,
      system: params.systemPrompt,
      messages: [{ role: 'user', content }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    let parsed: any;
    if (params.responseFormat === 'json') {
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
    }

    return {
      text, parsed,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: this.model, provider: this.name, durationMs: Date.now() - start,
    };
  }

  async testConnection() {
    try {
      await this.client.messages.create({
        model: this.model, max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { success: true, modelInfo: this.model };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    // Claude Sonnet pricing (approximate)
    return (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
  }
}
