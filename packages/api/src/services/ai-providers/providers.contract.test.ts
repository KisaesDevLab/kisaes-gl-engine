// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaProvider } from './ollama.provider.js';
import { withTimeout, abortableTimeout, TimeoutError } from '../../utils/retry.js';

// Cross-cutting provider contract:
//   1. withTimeout rejects when the wall-clock budget expires.
//   2. abortableTimeout's signal threads into fetch so the socket dies.
//   3. extractJsonForResult populates parseError on bad JSON instead of
//      silently coercing to `{}`.

describe('AI provider contract — timeout / abort / JSON extraction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('withTimeout', () => {
    it('rejects with TimeoutError when the promise outlives the budget', async () => {
      const slow = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 10_000));
      const racePromise = withTimeout(slow, 1_000, 'test-op');
      vi.advanceTimersByTime(1_500);
      await expect(racePromise).rejects.toBeInstanceOf(TimeoutError);
    });

    it('resolves normally when the promise finishes inside the budget', async () => {
      const fast = Promise.resolve('done');
      await expect(withTimeout(fast, 1_000, 'test-op')).resolves.toBe('done');
    });

    it('clears the timer on success — no leaked handles', async () => {
      const fast = Promise.resolve('done');
      const spy = vi.spyOn(globalThis, 'clearTimeout');
      await withTimeout(fast, 1_000, 'test-op');
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('abortableTimeout', () => {
    it('returns a signal that aborts after the budget', () => {
      const { signal } = abortableTimeout(500);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(600);
      expect(signal.aborted).toBe(true);
    });

    it('cancel() prevents the signal from aborting', () => {
      const { signal, cancel } = abortableTimeout(500);
      cancel();
      vi.advanceTimersByTime(1_000);
      expect(signal.aborted).toBe(false);
    });
  });

  describe('OllamaProvider fetch-level abort', () => {
    it('threads the caller-supplied signal into fetch', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ message: { content: '{"ok":true}' }, prompt_eval_count: 1, eval_count: 1 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
      );
      const controller = new AbortController();
      const provider = new OllamaProvider('http://localhost:11434', 'llama3.2');

      await provider.complete({
        systemPrompt: 's', userPrompt: 'u', responseFormat: 'json', signal: controller.signal,
      });

      const opts = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(opts?.signal).toBe(controller.signal);
    });
  });

  describe('JSON extraction → parseError on CompletionResult', () => {
    it('populates parsed when JSON is clean', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ message: { content: '{"vendor":"ACME"}' }, prompt_eval_count: 1, eval_count: 1 }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
      );
      const provider = new OllamaProvider();
      const result = await provider.complete({
        systemPrompt: 's', userPrompt: 'u', responseFormat: 'json',
      });
      expect(result.parsed).toEqual({ vendor: 'ACME' });
      expect(result.parseError).toBeUndefined();
    });

    it('extracts JSON wrapped in prose (no parseError)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            message: { content: 'Here is the data: {"vendor":"ACME"} — let me know if you need more.' },
            prompt_eval_count: 1, eval_count: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const provider = new OllamaProvider();
      const result = await provider.complete({
        systemPrompt: 's', userPrompt: 'u', responseFormat: 'json',
      });
      expect(result.parsed).toEqual({ vendor: 'ACME' });
      expect(result.parseError).toBeUndefined();
    });

    it('sets parseError when the model returns non-JSON prose', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            message: { content: 'Sorry, I cannot extract that information.' },
            prompt_eval_count: 1, eval_count: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const provider = new OllamaProvider();
      const result = await provider.complete({
        systemPrompt: 's', userPrompt: 'u', responseFormat: 'json',
      });
      expect(result.parsed).toBeUndefined();
      expect(result.parseError).toMatch(/Model returned non-JSON/);
      expect(result.parseError).toContain('Sorry, I cannot extract');
    });

    it('does NOT extract JSON when responseFormat is text', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            message: { content: '{"vendor":"ACME"}' },
            prompt_eval_count: 1, eval_count: 1,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      const provider = new OllamaProvider();
      const result = await provider.complete({
        systemPrompt: 's', userPrompt: 'u', responseFormat: 'text',
      });
      // Text mode: even if the body happens to look like JSON, we don't
      // parse it. parseError stays undefined.
      expect(result.parsed).toBeUndefined();
      expect(result.parseError).toBeUndefined();
      expect(result.text).toBe('{"vendor":"ACME"}');
    });
  });
});
