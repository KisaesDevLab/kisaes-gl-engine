// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { GlmOcrProvider } from './glm-ocr.provider.js';

// Contract test for the Vibe-GLM-OCR appliance — a llama.cpp server
// (NOT Ollama) hosting the GLM-OCR GGUF over an OpenAI-shape API.
// These assertions trace directly to the appliance README at
// github.com/KisaesDevLab/Vibe-GLM-OCR; a future provider refactor must
// not silently drop one of these without first updating the README.
//
// The test mocks fetch to capture the exact request shape we send, and
// returns a canned response matching the README's "Response" example
// verbatim.

describe('GlmOcrProvider — local appliance contract', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs to /v1/chat/completions with the appliance-documented OpenAI shape', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      captured = { url: String(input), init };
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'OCRed text' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = new GlmOcrProvider('local', 'http://localhost:8090');
    const result = await provider.completeWithImage({
      systemPrompt: 'ignored',
      userPrompt: 'general document', // -> "Text Recognition:" per heuristic
      images: [{ base64: 'AAA', mimeType: 'image/png' }],
      temperature: 0.5, // appliance ignores; provider hardcodes 0.02
      maxTokens: 4096,
    });

    expect(captured).not.toBeNull();
    const c = captured! as { url: string; init?: RequestInit };
    expect(c.url).toBe('http://localhost:8090/v1/chat/completions');
    expect(c.init?.method).toBe('POST');

    const body = JSON.parse(String((c.init as RequestInit | undefined)?.body ?? '{}'));
    // Appliance README literal: model must be "GLM-OCR".
    expect(body.model).toBe('GLM-OCR');
    // Temperature is 0.02 per README — caller-supplied 0.5 above is overridden.
    expect(body.temperature).toBe(0.02);
    // Messages array with one user turn containing image_url + text parts,
    // image first (multimodal models are content-order sensitive).
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA' },
    });
    expect(body.messages[0].content[1]).toEqual({
      type: 'text',
      text: 'Text Recognition:',
    });

    // Response surfaces text + usage.
    expect(result.text).toBe('OCRed text');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
    expect(result.provider).toBe('glm_ocr_local');
  });

  it('switches to "Table Recognition:" prompt for statement / table requests', async () => {
    let bodyText = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      bodyText = String((init as RequestInit | undefined)?.body ?? '');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '| Date |' } }], usage: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = new GlmOcrProvider('local', 'http://localhost:8090');
    await provider.completeWithImage({
      systemPrompt: '',
      userPrompt: 'Extract all transactions from this bank statement',
      images: [{ base64: 'AAA', mimeType: 'image/png' }],
    });

    const body = JSON.parse(bodyText);
    expect(body.messages[0].content[1].text).toBe('Table Recognition:');
  });

  it('sends Bearer token when OCR_API_KEY is configured', async () => {
    let headers: Record<string, string> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const h = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
      headers = h;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '' } }], usage: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = new GlmOcrProvider('local', 'http://localhost:8090', 'secret-key');
    await provider.completeWithImage({
      systemPrompt: '', userPrompt: '',
      images: [{ base64: 'AAA', mimeType: 'image/png' }],
    });
    expect(headers?.['Authorization']).toBe('Bearer secret-key');
  });

  it('omits Authorization when no OCR_API_KEY configured (open appliance)', async () => {
    let headers: Record<string, string> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '' } }], usage: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = new GlmOcrProvider('local', 'http://localhost:8090');
    await provider.completeWithImage({
      systemPrompt: '', userPrompt: '',
      images: [{ base64: 'AAA', mimeType: 'image/png' }],
    });
    expect(headers?.['Authorization']).toBeUndefined();
  });

  it('treats GET /health returning {"status":"ok"} as healthy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      // README contract: /health is the canonical readiness probe.
      expect(url).toBe('http://localhost:8090/health');
      expect((init as RequestInit | undefined)?.method).toBeUndefined(); // GET (default)
      return new Response(
        JSON.stringify({ status: 'ok' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const provider = new GlmOcrProvider('local', 'http://localhost:8090');
    const result = await provider.testConnection();
    expect(result.success).toBe(true);
    expect(result.modelInfo).toContain('GLM-OCR server ready');
  });

  it('reports unhealthy when /health returns a non-ok status (model still loading)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ status: 'loading model' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const provider = new GlmOcrProvider('local', 'http://localhost:8090');
    const result = await provider.testConnection();
    expect(result.success).toBe(false);
    expect(result.modelInfo).toMatch(/not ready/i);
  });

  it('reports failure when /health returns 5xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('boom', { status: 503 }),
    );
    const provider = new GlmOcrProvider('local', 'http://localhost:8090');
    const result = await provider.testConnection();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/503/);
  });

  it('threads AbortSignal into fetch on both completeWithImage and testConnection', async () => {
    const signal = new AbortController().signal;
    let capturedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      capturedSignal = (init as RequestInit | undefined)?.signal as AbortSignal | undefined;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '' } }], usage: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const provider = new GlmOcrProvider('local', 'http://localhost:8090');
    await provider.completeWithImage({
      systemPrompt: '', userPrompt: '',
      images: [{ base64: 'AAA', mimeType: 'image/png' }],
      signal,
    });
    expect(capturedSignal).toBe(signal);

    capturedSignal = undefined;
    await provider.testConnection(signal);
    expect(capturedSignal).toBe(signal);
  });

  it('reports OCR errors with body excerpt for fast triage', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('context overflow', { status: 400 }),
    );
    const provider = new GlmOcrProvider('local', 'http://localhost:8090');
    await expect(
      provider.completeWithImage({
        systemPrompt: '', userPrompt: '',
        images: [{ base64: 'AAA', mimeType: 'image/png' }],
      }),
    ).rejects.toThrow(/GLM-OCR local error: 400 context overflow/);
  });

  it('strips trailing slash on baseUrl so /v1/chat/completions URL stays clean', async () => {
    let capturedUrl = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      capturedUrl = String(input);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '' } }], usage: {} }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const provider = new GlmOcrProvider('local', 'http://localhost:8090/');
    await provider.completeWithImage({
      systemPrompt: '', userPrompt: '',
      images: [{ base64: 'AAA', mimeType: 'image/png' }],
    });
    // Confirms no `//v1/...` double slash from the trailing-slash baseUrl.
    expect(capturedUrl).toBe('http://localhost:8090/v1/chat/completions');
  });
});
