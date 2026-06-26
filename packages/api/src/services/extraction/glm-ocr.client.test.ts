// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  parseOpenAiChatResponse,
  buildOcrRequestBody,
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

  it('throws on the truncation guard (finish_reason=length)', () => {
    expect(() => parseOpenAiChatResponse(chatBody('partial', 'length'), 2, 0.9)).toThrow(GlmOcrError);
  });

  it('throws when choices is missing', () => {
    expect(() => parseOpenAiChatResponse({}, 0, 0.9)).toThrow(GlmOcrError);
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
});
