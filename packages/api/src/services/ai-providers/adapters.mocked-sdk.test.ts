// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// U-11: the Anthropic and OpenAI adapters against mocked SDK clients. What
// matters for the desktop app: the key reaches the client constructor only,
// the request shapes, the result mapping (tokens, truncation, JSON), and
// testConnection / listModels. No network.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const anthropic = vi.hoisted(() => ({ create: vi.fn(), stream: vi.fn(), list: vi.fn(), keys: [] as string[] }));
const openai = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), keys: [] as string[] }));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class AnthropicMock {
    messages = { create: anthropic.create, stream: anthropic.stream };
    models = { list: anthropic.list };
    constructor(opts: { apiKey: string }) { anthropic.keys.push(opts.apiKey); }
  },
}));
vi.mock('openai', () => ({
  default: class OpenAiMock {
    chat = { completions: { create: openai.create } };
    models = { list: openai.list };
    constructor(opts: { apiKey: string }) { openai.keys.push(opts.apiKey); }
  },
}));

import { AnthropicProvider } from './anthropic.provider.js';
import { OpenAiProvider } from './openai.provider.js';

beforeEach(() => {
  for (const m of [anthropic.create, anthropic.stream, anthropic.list, openai.create, openai.list]) m.mockReset();
  anthropic.keys.length = 0;
  openai.keys.length = 0;
});

describe('Anthropic adapter', () => {
  const msg = (text: string, stop = 'end_turn') => ({ content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text }], stop_reason: stop, usage: { input_tokens: 10, output_tokens: 2 } });

  it('passes the key to the client only and sends system + user with the JSON suffix', async () => {
    anthropic.create.mockResolvedValue(msg('{"a":1}'));
    const p = new AnthropicProvider('sk-ant-k', 'claude-m');
    const r = await p.complete({ systemPrompt: 'SYS', userPrompt: 'USER', responseFormat: 'json', maxTokens: 50 });
    expect(anthropic.keys).toEqual(['sk-ant-k']);
    const [body, opts] = anthropic.create.mock.calls[0]!;
    expect(body).toMatchObject({ model: 'claude-m', max_tokens: 50, messages: [{ role: 'user', content: 'USER' }] });
    expect(body.system).toMatch(/^SYS\n\nOutput format: respond with ONLY the JSON/);
    expect(JSON.stringify(body)).not.toContain('sk-ant-k');
    expect(opts).toEqual({ signal: undefined });
    expect(r).toMatchObject({ provider: 'anthropic', model: 'claude-m', text: '{"a":1}', parsed: { a: 1 }, inputTokens: 10, outputTokens: 2, truncated: false });
  });

  it('joins text blocks (skipping thinking), maps max_tokens to truncated and streams large requests', async () => {
    anthropic.create.mockResolvedValue(msg('{"a":', 'max_tokens'));
    const r = await new AnthropicProvider('k').complete({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' });
    expect(r.truncated).toBe(true);
    expect(r.parseError).toBeTruthy();
    anthropic.stream.mockReturnValue({ finalMessage: async () => msg('long') });
    const big = await new AnthropicProvider('k').complete({ systemPrompt: 's', userPrompt: 'u', maxTokens: 16_000 });
    expect(anthropic.stream).toHaveBeenCalledTimes(1);
    expect(big.text).toBe('long');
  });

  it('vision: image blocks then the text, same mapping', async () => {
    anthropic.create.mockResolvedValue(msg('{"v":1}'));
    const r = await new AnthropicProvider('k', 'claude-v').completeWithImage({ systemPrompt: 's', userPrompt: 'read', responseFormat: 'json', images: [{ base64: 'QUJD', mimeType: 'image/jpeg' }] });
    const body = anthropic.create.mock.calls[0]![0];
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } },
      { type: 'text', text: 'read' },
    ]);
    expect(r.parsed).toEqual({ v: 1 });
  });

  it('testConnection: ok, bad key, and wrong model (key valid) with the live model list', async () => {
    anthropic.create.mockResolvedValueOnce(msg('pong'));
    expect(await new AnthropicProvider('k', 'claude-m').testConnection()).toEqual({ success: true, modelInfo: 'claude-m' });
    anthropic.create.mockRejectedValueOnce(Object.assign(new Error('401 invalid x-api-key'), { status: 401 }));
    expect(await new AnthropicProvider('k').testConnection()).toEqual({ success: false, error: '401 invalid x-api-key' });
    anthropic.create.mockRejectedValueOnce(Object.assign(new Error('not_found_error: model'), { status: 404 }));
    anthropic.list.mockResolvedValueOnce({ data: [{ id: 'claude-a', display_name: 'A', created_at: '2026-01-01' }, { id: 'claude-b', display_name: 'B', created_at: '2026-02-01' }] });
    const r = await new AnthropicProvider('k', 'claude-old').testConnection();
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/model 'claude-old' was not found. Available: claude-a, claude-b/);
  });

  it('listModels returns ids; listModelDetails keeps names and dates', async () => {
    anthropic.list.mockResolvedValue({ data: [{ id: 'claude-b', display_name: 'B', created_at: '2026-02-01' }, { id: 'claude-a', display_name: 'A', created_at: '2026-01-01' }] });
    const p = new AnthropicProvider('k');
    expect(await p.listModels()).toEqual(['claude-b', 'claude-a']);
    expect(await p.listModelDetails()).toEqual([{ id: 'claude-b', displayName: 'B', createdAt: '2026-02-01' }, { id: 'claude-a', displayName: 'A', createdAt: '2026-01-01' }]);
    expect(anthropic.list.mock.calls[0]![0]).toEqual({ limit: 100 });
  });
});

describe('OpenAI adapter', () => {
  const completion = (content: string, finish = 'stop') => ({ choices: [{ message: { content }, finish_reason: finish }], usage: { prompt_tokens: 7, completion_tokens: 3 } });

  it('passes the key to the client only and requests json_object mode', async () => {
    openai.create.mockResolvedValue(completion('{"b":2}'));
    const p = new OpenAiProvider('sk-openai-k', 'gpt-m');
    const r = await p.complete({ systemPrompt: 'SYS', userPrompt: 'USER', responseFormat: 'json', maxTokens: 20, temperature: 0.3 });
    expect(openai.keys).toEqual(['sk-openai-k']);
    const [body, opts] = openai.create.mock.calls[0]!;
    expect(body).toEqual({
      model: 'gpt-m', max_tokens: 20, temperature: 0.3, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }],
    });
    expect(opts).toEqual({ signal: undefined });
    expect(r).toMatchObject({ provider: 'openai', model: 'gpt-m', parsed: { b: 2 }, inputTokens: 7, outputTokens: 3, truncated: false });
  });

  it('maps finish_reason length to truncated and sends images as data URLs', async () => {
    openai.create.mockResolvedValueOnce(completion('{"b":', 'length'));
    const r = await new OpenAiProvider('k').complete({ systemPrompt: 's', userPrompt: 'u', responseFormat: 'json' });
    expect(r.truncated).toBe(true);
    openai.create.mockResolvedValueOnce(completion('{"v":1}'));
    await new OpenAiProvider('k', 'gpt-v').completeWithImage({ systemPrompt: 's', userPrompt: 'read', responseFormat: 'json', images: [{ base64: 'QUJD', mimeType: 'image/png' }] });
    const body = openai.create.mock.calls[1]![0];
    expect(body.messages[1].content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }, { type: 'text', text: 'read' }]);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('testConnection and listModels', async () => {
    openai.create.mockResolvedValueOnce(completion('pong'));
    expect(await new OpenAiProvider('k', 'gpt-m').testConnection()).toEqual({ success: true, modelInfo: 'gpt-m' });
    openai.create.mockRejectedValueOnce(new Error('Incorrect API key provided'));
    expect(await new OpenAiProvider('k').testConnection()).toEqual({ success: false, error: 'Incorrect API key provided' });
    openai.list.mockResolvedValue({ data: [{ id: 'gpt-z' }, { id: 'gpt-a' }] });
    expect(await new OpenAiProvider('k').listModels()).toEqual(['gpt-a', 'gpt-z']);
  });
});
