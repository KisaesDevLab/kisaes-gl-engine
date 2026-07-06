// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OllamaProvider } from './ollama.provider.js';

describe('OllamaProvider.complete — request tuning (keep_alive / num_predict)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('sends keep_alive and threads maxTokens to options.num_predict', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: { content: '{"ok":true}' }, prompt_eval_count: 1, eval_count: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await new OllamaProvider('http://localhost:11434', 'qwen').complete({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxTokens: 512,
      temperature: 0.1,
      responseFormat: 'json',
    });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.keep_alive).toBeTruthy();
    expect(body.options.num_predict).toBe(512);
    expect(body.options.temperature).toBe(0.1);
  });
});

describe('OllamaProvider.complete — truncation + thinking salvage', () => {
  afterEach(() => vi.restoreAllMocks());

  function mockChat(body: Record<string, unknown>) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }

  it('flags done_reason length as truncated and says "raise max tokens", not "non-JSON"', async () => {
    mockChat({ message: { content: '{"transactions":[{"date":' }, done_reason: 'length', prompt_eval_count: 1, eval_count: 320 });
    const result = await new OllamaProvider('http://localhost:11434', 'qwen3').complete({
      systemPrompt: 's', userPrompt: 'u', responseFormat: 'json',
    });
    expect(result.truncated).toBe(true);
    expect(result.parseError).toMatch(/truncated at the max-token limit/);
    expect(result.parseError).not.toMatch(/^Model returned non-JSON/);
  });

  it('a normal stop is not truncated', async () => {
    mockChat({ message: { content: '{"ok":true}' }, done_reason: 'stop', prompt_eval_count: 1, eval_count: 5 });
    const result = await new OllamaProvider().complete({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' });
    expect(result.truncated).toBe(false);
    expect(result.parsed).toEqual({ ok: true });
  });

  it('salvages JSON from message.thinking when content is empty (leaky reasoning template)', async () => {
    mockChat({
      message: { content: '', thinking: 'Let me work this out… the answer is {"account_name":"Meals"}' },
      done_reason: 'stop', prompt_eval_count: 1, eval_count: 50,
    });
    const result = await new OllamaProvider('http://localhost:11434', 'qwen3').complete({
      systemPrompt: 's', userPrompt: 'u', responseFormat: 'json',
    });
    expect(result.parsed).toEqual({ account_name: 'Meals' });
    expect(result.parseError).toBeUndefined();
  });

  it('strips inline <think> blocks from content', async () => {
    mockChat({
      message: { content: '<think>coffee → meals {maybe: this}</think>{"account_name":"Meals"}' },
      done_reason: 'stop', prompt_eval_count: 1, eval_count: 50,
    });
    const result = await new OllamaProvider().complete({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' });
    expect(result.parsed).toEqual({ account_name: 'Meals' });
  });
});

describe('OllamaProvider.testConnection — fail-closed on non-ok', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reports success when /api/tags returns 200 with a models list', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'llama3.2' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const result = await new OllamaProvider('http://localhost:11434').testConnection();
    expect(result.success).toBe(true);
    expect(result.modelInfo).toContain('llama3.2');
  });

  // Regression: testConnection previously skipped the response.ok check that
  // complete() has, so a reachable-but-wrong endpoint returning 404/500 with a
  // JSON body (e.g. a proxy error page) was reported as a healthy connection.
  it('does NOT report success when the endpoint returns a non-ok status', async () => {
    for (const status of [404, 500, 502]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: 'nope' }), {
          status,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      const result = await new OllamaProvider('http://localhost:11434').testConnection();
      expect(result.success).toBe(false);
      expect(result.error).toMatch(String(status));
      vi.restoreAllMocks();
    }
  });

  it('reports failure when fetch rejects (connection refused)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await new OllamaProvider('http://localhost:11434').testConnection();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED|Cannot connect/);
  });
});
