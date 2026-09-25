// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';
import { extractJsonForResult } from './json-utils.js';

// DigitalOcean serverless inference (open-weight models such as
// gpt-oss-120b) behind an OpenAI-compatible endpoint.
//
// Differences from the generic openai_compat provider:
//  - Structured output goes through ONE required function call. DO documents
//    `tools` / `tool_choice` but not `response_format`, so JSON mode would
//    be silently ignored.
//  - Reasoning depth is `reasoning_effort` (low / medium / high), not the
//    `chat_template_kwargs` toggle local servers use.
//  - Real per-token pricing, so AI usage and budgets are tracked.
//  - Text only: the offered open-weight models have no vision.
//
// DO states it does not store or train on serverless inputs/outputs; it is
// still a cloud provider for consent and PII scrubbing purposes.

export const DIGITALOCEAN_DEFAULT_BASE_URL = 'https://inference.do-ai.run';
export const DIGITALOCEAN_DEFAULT_MODEL = 'openai-gpt-oss-120b';

// USD per 1M tokens [input, output], DO pricing page as of 2026-09. Matched
// by a distinctive fragment of the model id, since DO's exact ids carry
// vendor prefixes (the admin picks the id from DO's own /v1/models list).
const PRICES: Array<[string, [number, number]]> = [
  ['gpt-oss-120b', [0.10, 0.70]],
  ['gpt-oss-20b', [0.05, 0.45]],
  ['maverick', [0.25, 0.87]],
  ['ministral', [0.20, 0.20]],
];
export function doPriceFor(model: string): [number, number] {
  const m = model.toLowerCase();
  return PRICES.find(([frag]) => m.includes(frag))?.[1] ?? [0.10, 0.70];
}

interface DoChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

const RESPOND_TOOL = {
  type: 'function',
  function: {
    name: 'respond',
    description: 'Return the answer as the JSON object the instructions describe.',
    parameters: { type: 'object', additionalProperties: true },
  },
};

export class DigitalOceanProvider implements AiProvider {
  name = 'digitalocean';
  supportsVision = false;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(private readonly apiKey: string, model?: string, baseUrl?: string, private readonly fetchImpl: typeof fetch = fetch) {
    this.model = model || DIGITALOCEAN_DEFAULT_MODEL;
    this.baseUrl = (baseUrl || DIGITALOCEAN_DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/i, '');
  }

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` };
  }

  /** Request body for a completion (exported shape is tested). */
  buildBody(params: CompletionParams): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: params.systemPrompt },
        { role: 'user', content: params.userPrompt },
      ],
      temperature: params.temperature ?? 0.1,
      // Thinking on = deliberate; off or unset = quick. gpt-oss always
      // reasons a little, so "low" is the floor.
      reasoning_effort: params.thinking === 'on' ? 'medium' : 'low',
      stream: false,
    };
    if (params.maxTokens) body['max_tokens'] = params.maxTokens;
    if (params.responseFormat === 'json') {
      body['tools'] = [RESPOND_TOOL];
      body['tool_choice'] = 'required';
    }
    return body;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const start = Date.now();
    const res = await this.fetchImpl(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildBody(params)),
      signal: params.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err: Error & { status?: number } = new Error(`DigitalOcean inference error: ${res.status} ${res.statusText} ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }
    const data = (await res.json()) as DoChatResponse;
    const choice = data.choices?.[0];
    const truncated = choice?.finish_reason === 'length';
    // Prefer the function-call arguments (the structured answer); fall back
    // to plain content if the model answered in text anyway.
    const toolArgs = choice?.message?.tool_calls?.find((t) => t.function?.name === 'respond')?.function?.arguments;
    const text = toolArgs ?? choice?.message?.content ?? '';
    const { parsed, parseError } = extractJsonForResult(text || choice?.message?.reasoning_content || '', params.responseFormat, { truncated });
    const inputTokens = data.usage?.prompt_tokens || 0;
    const outputTokens = data.usage?.completion_tokens || 0;
    return {
      text,
      parsed,
      parseError,
      truncated,
      inputTokens,
      outputTokens,
      model: this.model,
      provider: this.name,
      durationMs: Date.now() - start,
    };
  }

  async completeWithImage(_params: VisionParams): Promise<CompletionResult> {
    throw new Error('DigitalOcean serverless open-weight models do not read images. Use a vision-capable provider for OCR.');
  }

  async testConnection(signal?: AbortSignal): Promise<{ success: boolean; error?: string; modelInfo?: string }> {
    try {
      const models = await this.listModels(signal ?? AbortSignal.timeout(10_000));
      const found = models.includes(this.model);
      return found
        ? { success: true, modelInfo: this.model }
        : { success: false, error: `Connected, but model "${this.model}" is not offered. Available: ${models.slice(0, 8).join(', ')}` };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, { headers: this.headers(), signal });
    if (!res.ok) throw new Error(`/v1/models returned ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id ?? '').filter(Boolean).sort();
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    const [inP, outP] = doPriceFor(this.model);
    return (inputTokens * inP + outputTokens * outP) / 1_000_000;
  }
}
