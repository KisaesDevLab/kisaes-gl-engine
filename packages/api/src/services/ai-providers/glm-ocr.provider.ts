// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';

export class GlmOcrProvider implements AiProvider {
  name: string;
  supportsVision = true;
  private mode: 'cloud' | 'local';
  private apiKeyOrUrl: string;

  constructor(mode: 'cloud' | 'local', apiKeyOrUrl: string) {
    this.mode = mode;
    this.name = mode === 'cloud' ? 'glm_ocr_cloud' : 'glm_ocr_local';
    this.apiKeyOrUrl = apiKeyOrUrl;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    // GLM-OCR is vision-only — for text completion, delegate to a generic response
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
    });

    if (!response.ok) {
      const err: any = new Error(`GLM-OCR cloud error: ${response.status}`);
      err.status = response.status;
      err.headers = Object.fromEntries(response.headers.entries());
      throw err;
    }

    const data = await response.json() as any;
    const text = data.result || data.choices?.[0]?.message?.content || JSON.stringify(data);

    return {
      text,
      parsed: typeof data.result === 'object' ? data.result : undefined,
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      model: 'glm-ocr', provider: this.name, durationMs: Date.now() - start,
    };
  }

  private async localOcr(params: VisionParams, start: number): Promise<CompletionResult> {
    const image = params.images[0];
    if (!image) throw new Error('No image provided');

    const baseUrl = this.apiKeyOrUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-ocr',
        messages: [
          { role: 'system', content: params.systemPrompt },
          { role: 'user', content: params.userPrompt, images: [image.base64] },
        ],
        stream: false,
      }),
    });

    const data = await response.json() as any;
    const text = data.message?.content || '';

    return {
      text,
      inputTokens: data.prompt_eval_count || 0,
      outputTokens: data.eval_count || 0,
      model: 'glm-ocr', provider: this.name, durationMs: Date.now() - start,
    };
  }

  async testConnection() {
    try {
      if (this.mode === 'cloud') {
        const response = await fetch('https://api.z.ai/api/paas/v4/layout_parsing', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.apiKeyOrUrl}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'glm-ocr', content: [] }),
        });
        return { success: response.status !== 401 && response.status !== 403, modelInfo: 'GLM-OCR Cloud' };
      } else {
        const baseUrl = this.apiKeyOrUrl.replace(/\/$/, '');
        const response = await fetch(`${baseUrl}/api/tags`);
        const data = await response.json() as any;
        const models = (data.models || []).map((m: any) => m.name || '');
        const hasGlm = models.some((n: string) => n.toLowerCase().includes('glm-ocr') || n.toLowerCase().includes('glm_ocr'));
        const modelList = models.join(', ');
        return { success: true, modelInfo: hasGlm ? `GLM-OCR available (${modelList})` : `GLM-OCR model not found. Available: ${modelList || 'none'}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    return this.mode === 'cloud' ? (inputTokens + outputTokens) / 1_000_000 * 0.1 : 0;
  }
}
