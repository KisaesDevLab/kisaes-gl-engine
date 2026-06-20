// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAiCompatProvider } from './openai-compat.provider.js';

function mockChatOnce() {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// Structural param type avoids the incompatible MockInstance<fetch> generic
// that `ReturnType<typeof vi.spyOn>` infers for the global fetch overloads.
function calledUrl(spy: { mock: { calls: unknown[][] } }): string {
  return String(spy.mock.calls[0]![0]);
}

function callInit(spy: { mock: { calls: unknown[][] } }): RequestInit {
  return spy.mock.calls[0]![1] as RequestInit;
}

describe('OpenAiCompatProvider — base URL normalisation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('appends /v1/chat/completions to a bare root URL', async () => {
    const fetchSpy = mockChatOnce();
    await new OpenAiCompatProvider('http://192.168.68.105:11434').complete({
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(calledUrl(fetchSpy)).toBe('http://192.168.68.105:11434/v1/chat/completions');
  });

  it('does NOT double the /v1 when the admin pasted Ollama\'s documented /v1 URL', async () => {
    const fetchSpy = mockChatOnce();
    await new OpenAiCompatProvider('http://192.168.68.105:11434/v1/').complete({
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(calledUrl(fetchSpy)).toBe('http://192.168.68.105:11434/v1/chat/completions');
    expect(calledUrl(fetchSpy)).not.toContain('/v1/v1/');
  });

  it('strips a trailing /v1 without a trailing slash too', async () => {
    const fetchSpy = mockChatOnce();
    await new OpenAiCompatProvider('http://ollama:11434/v1').complete({
      systemPrompt: 's',
      userPrompt: 'u',
    });
    expect(calledUrl(fetchSpy)).toBe('http://ollama:11434/v1/chat/completions');
  });

  it('normalises the /v1/models probe path the same way', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'qwen3.5:35b-a3b' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await new OpenAiCompatProvider('http://192.168.68.105:11434/v1', 'qwen3.5:35b-a3b').testConnection();
    expect(calledUrl(fetchSpy)).toBe('http://192.168.68.105:11434/v1/models');
  });

  it('sends no Authorization header when no API key is configured', async () => {
    const fetchSpy = mockChatOnce();
    await new OpenAiCompatProvider('http://192.168.68.105:11434').complete({
      systemPrompt: 's',
      userPrompt: 'u',
    });
    const headers = callInit(fetchSpy).headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('sends a Bearer token when an API key is configured', async () => {
    const fetchSpy = mockChatOnce();
    await new OpenAiCompatProvider('http://192.168.68.105:11434', 'm', 'secret-token').complete({
      systemPrompt: 's',
      userPrompt: 'u',
    });
    const headers = callInit(fetchSpy).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
  });
});
