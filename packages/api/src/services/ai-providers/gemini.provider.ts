import { GoogleGenAI } from '@google/genai';
import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';

export class GeminiProvider implements AiProvider {
  name = 'gemini';
  supportsVision = true;
  private client: GoogleGenAI;
  private model: string;

  constructor(apiKey: string, model: string = 'gemini-2.5-flash') {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
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
    let parsed: any;
    if (params.responseFormat === 'json') {
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
    }

    return {
      text, parsed,
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
      config: { maxOutputTokens: params.maxTokens || 2048, temperature: params.temperature ?? 0.1 },
    });

    const text = response.text || '';
    let parsed: any;
    if (params.responseFormat === 'json') {
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
    }

    return {
      text, parsed,
      inputTokens: response.usageMetadata?.promptTokenCount || 0,
      outputTokens: response.usageMetadata?.candidatesTokenCount || 0,
      model: this.model, provider: this.name, durationMs: Date.now() - start,
    };
  }

  async testConnection() {
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
    return (inputTokens / 1_000_000) * 0.075 + (outputTokens / 1_000_000) * 0.3;
  }
}
