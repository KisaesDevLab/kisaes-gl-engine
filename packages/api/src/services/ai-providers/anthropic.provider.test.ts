// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// testConnection honesty + retry-hygiene coverage for the Anthropic provider:
//   - a model-404 is a FAILURE (red badge) that names the stale model, not a
//     success with a footnote
//   - the re-wrapped 404 from send() keeps err.status so retryWithBackoff's
//     don't-retry-4xx rule still short-circuits

import { describe, it, expect, vi } from 'vitest';
import { AnthropicProvider } from './anthropic.provider.js';

interface StubbedClient {
  messages: { create: ReturnType<typeof vi.fn> };
  models: { list: ReturnType<typeof vi.fn> };
}

function providerWith(model: string, client: StubbedClient): AnthropicProvider {
  const provider = new AnthropicProvider('sk-test', model);
  (provider as unknown as { client: StubbedClient }).client = client;
  return provider;
}

function sdk404(message = 'model: not_found'): Error & { status: number } {
  return Object.assign(new Error(message), { status: 404 });
}

describe('AnthropicProvider.testConnection', () => {
  it('returns success:false when the configured model 404s, naming the model and valid choices', async () => {
    const client: StubbedClient = {
      messages: { create: vi.fn().mockRejectedValue(sdk404()) },
      models: { list: vi.fn().mockResolvedValue({ data: [{ id: 'claude-real-a' }, { id: 'claude-real-b' }] }) },
    };
    const result = await providerWith('claude-stale', client).testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toContain("API key valid, but model 'claude-stale' was not found");
    expect(result.error).toContain('claude-real-a');
  });

  it('still fails (without the Available hint) when the models listing also fails', async () => {
    const client: StubbedClient = {
      messages: { create: vi.fn().mockRejectedValue(sdk404()) },
      models: { list: vi.fn().mockRejectedValue(new Error('listing failed')) },
    };
    const result = await providerWith('claude-stale', client).testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toContain("model 'claude-stale' was not found");
    expect(result.error).not.toContain('Available:');
  });

  it('reports non-404 failures verbatim', async () => {
    const client: StubbedClient = {
      messages: { create: vi.fn().mockRejectedValue(Object.assign(new Error('invalid x-api-key'), { status: 401 })) },
      models: { list: vi.fn() },
    };
    const result = await providerWith('claude-stale', client).testConnection();

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid x-api-key');
    expect(client.models.list).not.toHaveBeenCalled();
  });

  it('reports success with the tested model when the ping works', async () => {
    const client: StubbedClient = {
      messages: { create: vi.fn().mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 1 } }) },
      models: { list: vi.fn() },
    };
    const result = await providerWith('claude-good', client).testConnection();

    expect(result.success).toBe(true);
    expect(result.modelInfo).toBe('claude-good');
  });
});

describe('AnthropicProvider.send — 404 re-wrap keeps err.status (retry hygiene)', () => {
  it('complete() rejects with an actionable message AND status 404', async () => {
    const client: StubbedClient = {
      messages: { create: vi.fn().mockRejectedValue(sdk404()) },
      models: { list: vi.fn() },
    };
    const provider = providerWith('claude-stale', client);

    let caught: (Error & { status?: number }) | undefined;
    try {
      await provider.complete({ systemPrompt: 's', userPrompt: 'u' });
    } catch (err) {
      caught = err as Error & { status?: number };
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toContain("Anthropic model 'claude-stale' was not found (404)");
    // Without status, retryWithBackoff would burn its full backoff budget
    // re-sending a request that can never succeed.
    expect(caught!.status).toBe(404);
  });
});

describe('AnthropicProvider.complete — JSON format pinning + truncation honesty', () => {
  function okResponse(overrides: Record<string, unknown> = {}) {
    return {
      content: [{ type: 'text', text: '{"ok":true}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      ...overrides,
    };
  }

  it('appends the JSON-only instruction to the system prompt when responseFormat is json', async () => {
    const create = vi.fn().mockResolvedValue(okResponse());
    const provider = providerWith('claude-good', { messages: { create }, models: { list: vi.fn() } });

    await provider.complete({ systemPrompt: 'Base prompt.', userPrompt: 'u', responseFormat: 'json' });

    const body = create.mock.calls[0]![0] as { system: string };
    expect(body.system).toMatch(/^Base prompt\./);
    expect(body.system).toContain('ONLY the JSON');
    expect(body.system).toContain('no markdown code fences');
  });

  it('leaves the system prompt untouched for text responses', async () => {
    const create = vi.fn().mockResolvedValue(okResponse());
    const provider = providerWith('claude-good', { messages: { create }, models: { list: vi.fn() } });

    await provider.complete({ systemPrompt: 'Base prompt.', userPrompt: 'u', responseFormat: 'text' });

    const body = create.mock.calls[0]![0] as { system: string };
    expect(body.system).toBe('Base prompt.');
  });

  it('reads the text block even when a thinking block comes first', async () => {
    const create = vi.fn().mockResolvedValue(okResponse({
      content: [
        { type: 'thinking', thinking: 'hmm…' },
        { type: 'text', text: '{"account_name":"Meals"}' },
      ],
    }));
    const provider = providerWith('claude-good', { messages: { create }, models: { list: vi.fn() } });

    const result = await provider.complete({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' });

    expect(result.parsed).toEqual({ account_name: 'Meals' });
    expect(result.parseError).toBeUndefined();
  });

  it('surfaces stop_reason max_tokens as a truncation error, not "non-JSON"', async () => {
    const create = vi.fn().mockResolvedValue(okResponse({
      content: [{ type: 'text', text: '{"transactions":[{"date":' }],
      stop_reason: 'max_tokens',
    }));
    const provider = providerWith('claude-good', { messages: { create }, models: { list: vi.fn() } });

    const result = await provider.complete({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' });

    expect(result.truncated).toBe(true);
    expect(result.parseError).toMatch(/truncated at the max-token limit/);
  });
});
