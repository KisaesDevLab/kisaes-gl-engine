// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { DigitalOceanProvider, doPriceFor } from './digitalocean.provider.js';

function fakeFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fn };
}

describe('DigitalOceanProvider', () => {
  it('asks for JSON through one required function call and sets reasoning effort', () => {
    const p = new DigitalOceanProvider('key', 'openai-gpt-oss-120b');
    const body = p.buildBody({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json', thinking: 'on', maxTokens: 500 });
    expect(body['tool_choice']).toBe('required');
    expect((body['tools'] as Array<{ function: { name: string } }>)[0]!.function.name).toBe('respond');
    expect(body['reasoning_effort']).toBe('medium');
    expect(body['response_format']).toBeUndefined();
    expect(body['chat_template_kwargs']).toBeUndefined();
    expect(p.buildBody({ systemPrompt: 's', userPrompt: 'u' })['reasoning_effort']).toBe('low');
    expect(p.buildBody({ systemPrompt: 's', userPrompt: 'u' })['tools']).toBeUndefined();
  });

  it('reads the answer from the function-call arguments', async () => {
    const { calls, fn } = fakeFetch({
      choices: [{ message: { content: null, tool_calls: [{ function: { name: 'respond', arguments: '{"explanation":"ok"}' } }] }, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 },
    });
    const p = new DigitalOceanProvider('key', 'openai-gpt-oss-120b', undefined, fn);
    const r = await p.complete({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' });
    expect(r.parsed).toEqual({ explanation: 'ok' });
    expect(r.provider).toBe('digitalocean');
    expect(calls[0]!.url).toBe('https://inference.do-ai.run/v1/chat/completions');
    expect((calls[0]!.init.headers as Record<string, string>)['Authorization']).toBe('Bearer key');
    // 1000 × $0.10/M + 500 × $0.70/M
    expect(p.estimateCost(r.inputTokens, r.outputTokens)).toBeCloseTo(0.00045, 8);
  });

  it('falls back to plain content when the model answers in text', async () => {
    const { fn } = fakeFetch({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] });
    const r = await new DigitalOceanProvider('key', undefined, undefined, fn).complete({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' });
    expect(r.parsed).toEqual({ a: 1 });
  });

  it('surfaces HTTP errors and refuses images', async () => {
    const { fn } = fakeFetch({ error: 'nope' }, 401);
    const p = new DigitalOceanProvider('bad', undefined, 'https://example.test/v1', fn);
    await expect(p.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/401/);
    await expect(p.completeWithImage({ systemPrompt: 's', userPrompt: 'u', images: [] })).rejects.toThrow(/do not read images/);
  });

  it('reports a missing model on test', async () => {
    const { fn } = fakeFetch({ data: [{ id: 'openai-gpt-oss-20b' }] });
    const r = await new DigitalOceanProvider('key', 'openai-gpt-oss-120b', undefined, fn).testConnection();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not offered/);
  });

  it('prices by model family', () => {
    expect(doPriceFor('openai-gpt-oss-20b')).toEqual([0.05, 0.45]);
    expect(doPriceFor('something-new')).toEqual([0.10, 0.70]);
  });
});
