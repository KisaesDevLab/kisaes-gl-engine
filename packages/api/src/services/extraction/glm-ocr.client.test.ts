// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseOpenAiChatResponse,
  buildOcrRequestBody,
  collapseRepeatedLines,
  ocrPages,
  clearOcrCache,
  resetOcrCircuit,
  GlmOcrError,
} from './glm-ocr.client.js';

beforeEach(() => {
  clearOcrCache();
  resetOcrCircuit();
});

const chatBody = (content: string, finishReason = 'stop') => ({
  choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }],
});

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const errResponse = (status: number) =>
  ({ ok: false, status, json: async () => ({}), text: async () => '' }) as unknown as Response;

describe('parseOpenAiChatResponse', () => {
  it('extracts markdown from choices[0].message.content', () => {
    const r = parseOpenAiChatResponse(chatBody('# Page\nhello'), 0, 0.9);
    expect(r.markdown).toBe('# Page\nhello');
    expect(r.confidence).toBe(0.9);
  });

  it('rolls confidence to 0 on empty content', () => {
    const r = parseOpenAiChatResponse(chatBody(''), 0, 0.9);
    expect(r.confidence).toBe(0);
  });

  it('flags finish_reason=length as truncated with halved confidence (no throw)', () => {
    const r = parseOpenAiChatResponse(chatBody('partial', 'length'), 2, 0.9);
    expect(r.truncated).toBe(true);
    expect(r.markdown).toBe('partial');
    expect(r.confidence).toBeCloseTo(0.45);
  });

  it('collapses a single-line repetition loop in truncated output', () => {
    const loop = `real row 1\nreal row 2\n${'LOOP LINE\n'.repeat(50)}`;
    const r = parseOpenAiChatResponse(chatBody(loop, 'length'), 0, 0.9);
    expect(r.markdown).toContain('real row 1');
    expect(r.markdown.match(/LOOP LINE/g)!.length).toBe(1);
    expect(r.markdown).toContain('repeated 50×');
  });

  it('throws when choices is missing', () => {
    expect(() => parseOpenAiChatResponse({}, 0, 0.9)).toThrow(GlmOcrError);
  });
});

describe('collapseRepeatedLines', () => {
  it('collapses a repeated multi-line block (the prod check-grid loop shape)', () => {
    const block = 'JACKS DOZING, LLC\nJACK OR CELIA RATHMANN\n\n$1,280.00 6/3/2026\n';
    const text = `head content\n${block.repeat(40)}18151815garbage`;
    const out = collapseRepeatedLines(text);
    expect(out).toContain('head content');
    expect(out.match(/JACKS DOZING, LLC/g)!.length).toBe(1);
    expect(out).toContain('repeated 40×');
    expect(out).toContain('18151815garbage');
  });

  it('keeps a block that repeats only twice (legit check front + back)', () => {
    const block = '1397 $1,280.00 6/3/2026\n';
    const text = `a\n${block}middle\n${block}end`;
    expect(collapseRepeatedLines(text)).toBe(text);
  });

  it('never collapses blank-only runs', () => {
    const text = 'a\n\n\n\n\nb';
    expect(collapseRepeatedLines(text)).toBe(text);
  });
});

describe('buildOcrRequestBody', () => {
  it('builds the OpenAI image_url + text body with temperature 0.02', () => {
    const body = buildOcrRequestBody(Buffer.from('x'), 'image/png', { model: 'glm-ocr', prompt: 'OCR:' });
    expect(body['model']).toBe('glm-ocr');
    expect(body['temperature']).toBe(0.02);
    const content = (body['messages'] as Array<{ content: unknown[] }>)[0]!.content as Array<Record<string, unknown>>;
    expect(content[0]!['type']).toBe('image_url');
    expect(((content[0]!['image_url'] as { url: string }).url)).toContain('data:image/png;base64,');
    expect(content[1]!['text']).toBe('OCR:');
  });

  it('caps output tokens (default 8192) so a looping page cannot generate unbounded', () => {
    const body = buildOcrRequestBody(Buffer.from('x'), 'image/png', { model: 'glm-ocr', prompt: 'OCR:' });
    expect(body['max_tokens']).toBe(8192);
    const custom = buildOcrRequestBody(Buffer.from('x'), 'image/png', { model: 'glm-ocr', prompt: 'OCR:', maxTokens: 4096 });
    expect(custom['max_tokens']).toBe(4096);
  });

  it('anti-loop mode adds repeat_penalty and raises temperature', () => {
    const body = buildOcrRequestBody(Buffer.from('x'), 'image/png', { model: 'glm-ocr', prompt: 'OCR:', antiLoop: true });
    expect(body['repeat_penalty']).toBe(1.3);
    expect(body['temperature']).toBe(0.3);
  });
});

describe('ocrPages', () => {
  it('OCRs pages in order, preserving indices', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(okResponse(chatBody('page A')))
      .mockResolvedValueOnce(okResponse(chatBody('page B')));
    const out = await ocrPages(
      [
        { data: Buffer.from('aaa'), mimeType: 'image/png' },
        { data: Buffer.from('bbb'), mimeType: 'image/png' },
      ],
      { baseUrl: 'http://glm:8090', concurrency: 1, fetcher },
    );
    expect(out.map((p) => p.markdown)).toEqual(['page A', 'page B']);
    expect(out.map((p) => p.index)).toEqual([0, 1]);
  });

  it('retries on a 5xx then succeeds', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(errResponse(503))
      .mockResolvedValueOnce(okResponse(chatBody('recovered')));
    const out = await ocrPages([{ data: Buffer.from('z'), mimeType: 'image/png' }], {
      baseUrl: 'http://glm:8090',
      fetcher,
    });
    expect(out[0]!.markdown).toBe('recovered');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on a 4xx (config/contract error)', async () => {
    const fetcher = vi.fn().mockResolvedValue(errResponse(400));
    await expect(
      ocrPages([{ data: Buffer.from('q'), mimeType: 'image/png' }], { baseUrl: 'http://glm:8090', fetcher }),
    ).rejects.toThrow(GlmOcrError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('throws when the base URL is unset', async () => {
    await expect(
      ocrPages([{ data: Buffer.from('q'), mimeType: 'image/png' }], { baseUrl: '' }),
    ).rejects.toThrow(GlmOcrError);
  });

  it('retries a truncated page with the anti-loop penalty and uses the clean read', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(okResponse(chatBody('looping…', 'length')))
      .mockResolvedValueOnce(okResponse(chatBody('clean read')));
    const out = await ocrPages([{ data: Buffer.from('loopy'), mimeType: 'image/png' }], {
      baseUrl: 'http://glm:8090',
      fetcher,
    });
    expect(out[0]!.markdown).toBe('clean read');
    expect(out[0]!.truncated).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetcher.mock.calls[1] as [string, { body: string }];
    expect(JSON.parse(retryInit.body)['repeat_penalty']).toBe(1.3);
  });

  it('keeps the collapsed truncated read when the anti-loop retry also truncates', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(okResponse(chatBody(`head\n${'LOOP\n'.repeat(20)}`, 'length')));
    const out = await ocrPages([{ data: Buffer.from('loopy2'), mimeType: 'image/png' }], {
      baseUrl: 'http://glm:8090',
      fetcher,
    });
    expect(out[0]!.truncated).toBe(true);
    expect(out[0]!.markdown).toContain('head');
    expect(out[0]!.markdown.match(/LOOP/g)!.length).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight budget across concurrent ocrPages calls (same engine)', async () => {
    // Two simultaneous ocrPages calls with concurrency:1 against the same base
    // URL must never have more than ONE request in flight — the cross-call
    // gate is what keeps a single-slot llama-server from queueing requests
    // into their client timeout.
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return okResponse(chatBody(`ok-${Math.max(1, inFlight)}`));
    }) as unknown as typeof fetch;
    const cfg = { baseUrl: 'http://glm-gate-test:8090', concurrency: 1, fetcher };
    const [a, b] = await Promise.all([
      ocrPages([{ data: Buffer.from('gate-a'), mimeType: 'image/png' }], cfg),
      ocrPages([{ data: Buffer.from('gate-b'), mimeType: 'image/png' }], cfg),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(maxInFlight).toBe(1);
  });
});
