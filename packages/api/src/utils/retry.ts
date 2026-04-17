// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
