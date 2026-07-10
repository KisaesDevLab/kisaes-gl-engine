// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import Anthropic from '@anthropic-ai/sdk';
import type { AiProvider, CompletionParams, VisionParams, CompletionResult } from './ai-provider.interface.js';
import { extractJsonForResult } from './json-utils.js';

// The Messages API has no server-side JSON mode, so `responseFormat:
// 'json'` is enforced by instruction: pin the output format at the END of
// the system prompt (the position models weight most for format
// directives). Task prompts already ask for JSON; this suffix hardens
// custom/admin-authored prompts that forget to.
const JSON_FORMAT_SUFFIX =
  '\n\nOutput format: respond with ONLY the JSON value — no markdown code fences, no preamble, no commentary.';

function systemFor(params: CompletionParams): string {
  return params.responseFormat === 'json'
    ? params.systemPrompt + JSON_FORMAT_SUFFIX
    : params.systemPrompt;
}

// Join all text blocks rather than assuming content[0] is text — an
// extended-thinking model puts a `thinking` block first, which the old
// `content[0]?.type === 'text'` check read as an empty response.
function textOf(response: Anthropic.Messages.Message): string {
  return response.content
    .filter((b): b is Extract<Anthropic.Messages.ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

export class AnthropicProvider implements AiProvider {
  name = 'anthropic';
  supportsVision = true;
  private client: Anthropic;
  private model: string;

  constructor(apiKey: string, model: string = 'claude-sonnet-4-6') {
    this.client = new Anthropic({ apiKey });
    this.model = model;
  }

  // The SDK rejects a NON-streaming request whose max_tokens is large enough
  // that the response could exceed the server's 10-minute limit ("Streaming is
  // required for operations that may take longer than 10 minutes"). Above a
  // safe threshold we stream and accumulate the final message; small requests
  // keep the simpler non-streaming path.
  private async send(
    body: Anthropic.Messages.MessageCreateParamsNonStreaming,
    signal?: AbortSignal,
  ): Promise<Anthropic.Messages.Message> {
    try {
      if ((body.max_tokens ?? 0) > 8192) {
        return await this.client.messages.stream(body, { signal }).finalMessage();
      }
      return await this.client.messages.create(body, { signal });
    } catch (err) {
      // A 404 means the configured model id is wrong/retired — turn the SDK's
      // cryptic error into an actionable one (this otherwise terminal-fails a
      // statement parse with an opaque message).
      const e = err as { status?: number; statusCode?: number; message?: string };
      const status = e?.status ?? e?.statusCode;
      if (status === 404 || /not_found/i.test(e?.message ?? '')) {
        const wrapped: Error & { status?: number } = new Error(
          `Anthropic model '${body.model}' was not found (404). Pick a valid model in Admin → AI.`,
        );
        // Preserve the HTTP status on the re-wrapped error so
        // retryWithBackoff's don't-retry-4xx rule still short-circuits —
        // without it a bad model id burns the full retry/backoff budget.
        wrapped.status = status ?? 404;
        throw wrapped;
      }
      throw err;
    }
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const start = Date.now();
    const response = await this.send({
      model: this.model,
      max_tokens: params.maxTokens || 1024,
      system: systemFor(params),
      messages: [{ role: 'user', content: params.userPrompt }],
    }, params.signal);

    const text = textOf(response);
    const truncated = response.stop_reason === 'max_tokens';
    const { parsed, parseError } = extractJsonForResult(text, params.responseFormat, { truncated });

    return {
      text,
      parsed,
      parseError,
      truncated,
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

    const response = await this.send({
      model: this.model,
      max_tokens: params.maxTokens || 2048,
      system: systemFor(params),
      messages: [{ role: 'user', content }],
    }, params.signal);

    const text = textOf(response);
    const truncated = response.stop_reason === 'max_tokens';
    const { parsed, parseError } = extractJsonForResult(text, params.responseFormat, { truncated });

    return {
      text, parsed, parseError, truncated,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      model: this.model, provider: this.name, durationMs: Date.now() - start,
    };
  }

  async testConnection(signal?: AbortSignal) {
    try {
      await this.client.messages.create({
        model: this.model, max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      }, { signal });
      return { success: true, modelInfo: this.model };
    } catch (err: any) {
      // A 404 "model not found" means the KEY is valid but the configured
      // model id is wrong/stale (a very common footgun). That is still a
      // FAILURE — production calls with this model will 404 — so report
      // success:false, but confirm the key by listing models and name valid
      // choices so the admin can fix the model id rather than the key.
      const status = err?.status ?? err?.statusCode;
      const notFound = status === 404 || /not_found|model:.*not.*found/i.test(err?.message ?? '');
      if (notFound) {
        let available = '';
        try {
          const models = await this.listModels(signal);
          if (models.length > 0) available = ` Available: ${models.slice(0, 6).join(', ')}`;
        } catch { /* key may not even be valid for listing — omit the hint */ }
        return {
          success: false,
          error: `API key valid, but model '${this.model}' was not found.${available}`,
        };
      }
      return { success: false, error: err.message };
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const page = await this.client.models.list({ limit: 100 }, { signal });
    return page.data.map((m) => m.id);
  }

  estimateCost(inputTokens: number, outputTokens: number): number {
    // Claude Sonnet pricing (approximate)
    return (inputTokens / 1_000_000) * 3 + (outputTokens / 1_000_000) * 15;
  }
}

