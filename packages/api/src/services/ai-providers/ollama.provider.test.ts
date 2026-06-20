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
