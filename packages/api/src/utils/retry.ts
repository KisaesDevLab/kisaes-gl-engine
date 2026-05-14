// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

/**
 * Thrown by `withTimeout` (and indirectly by every AI provider) when an
 * operation exceeds its wall-clock budget. Carries a stable `code` so
 * higher layers can recognise timeouts without string-matching the
 * message.
 */
export class TimeoutError extends Error {
  code = 'timeout' as const;
  constructor(public label: string, public timeoutMs: number) {
    super(`Timeout after ${timeoutMs}ms: ${label}`);
    this.name = 'TimeoutError';
  }
}

/**
 * Race a promise against a wall-clock timeout. If the timer fires first,
 * rejects with `TimeoutError`. The underlying promise is NOT cancelled —
 * callers that need socket teardown (fetch) should additionally use
 * `abortableTimeout` to feed an `AbortSignal` into the inner call.
 *
 * `clearTimeout` is in a finally so a fast resolution doesn't leak a
 * timer handle that keeps Node alive.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Create an `AbortSignal` that fires after `ms` and a `cancel` callback
 * to dispose the timer if the operation finishes first. Use this in
 * fetch-based providers so the socket actually tears down on timeout —
 * Promise.race alone leaves the request hanging in the background.
 *
 * Usage:
 *   const { signal, cancel } = abortableTimeout(60_000);
 *   try { return await fetch(url, { signal }); } finally { cancel(); }
 */
export function abortableTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
}

/**
 * Retry a function with exponential backoff.
 * Handles rate limit (429) errors by respecting Retry-After headers.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelay = options.baseDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 30000;

  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;

      if (attempt >= maxRetries) break;

      // Don't retry wall-clock timeouts — the outer budget has expired,
      // so spinning inside it just delays the error reaching the caller.
      if (err instanceof TimeoutError) throw err;

      // Check for rate limit (429)
      const retryAfter = extractRetryAfter(err);
      if (retryAfter !== null) {
        await sleep(Math.min(retryAfter * 1000, maxDelay));
        continue;
      }

      // Don't retry on client errors (4xx except 429)
      const status = err.status || err.statusCode || err.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw err;
      }

      // Exponential backoff with jitter
      const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 500, maxDelay);
      await sleep(delay);
    }
  }
  throw lastError;
}

function extractRetryAfter(err: any): number | null {
  // Check common locations for retry-after
  const headers = err.headers || err.response?.headers;
  if (headers) {
    const ra = headers['retry-after'] || headers.get?.('retry-after');
    if (ra) {
      const seconds = parseInt(ra);
      if (!isNaN(seconds)) return seconds;
    }
  }
  // Anthropic SDK puts it in err.headers
  if (err.status === 429 || err.statusCode === 429) {
    return 5; // Default 5s if no header
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Simple in-memory semaphore for concurrency limiting.
 */
export class Semaphore {
  private current = 0;
  private queue: Array<() => void> = [];

  constructor(private maxConcurrent: number) {}

  async acquire(): Promise<void> {
    if (this.current < this.maxConcurrent) {
      this.current++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => { this.current++; resolve(); });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
