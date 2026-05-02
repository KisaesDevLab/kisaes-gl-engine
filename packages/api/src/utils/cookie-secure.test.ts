// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// env.ts freezes process.env into the `env` export at import time, so
// we can't mutate process.env after import and expect the helper to
// re-read. Instead, dynamically import the helper after setting the
// env mock, and reset module cache between tests.
async function importWith(envOverrides: { COOKIE_SECURE?: boolean | undefined; NODE_ENV: 'development' | 'production' | 'test' }): Promise<() => boolean> {
  vi.resetModules();
  vi.doMock('../config/env.js', () => ({
    env: {
      COOKIE_SECURE: envOverrides.COOKIE_SECURE,
      NODE_ENV: envOverrides.NODE_ENV,
    },
  }));
  const mod = await import('./cookie-secure.js');
  return mod.resolvedSecure;
}

describe('resolvedSecure (vibe-mybooks-compatibility-addendum §3.14.4)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('../config/env.js');
    vi.resetModules();
  });

  it('NODE_ENV=production with COOKIE_SECURE unset → true (preserves standalone behavior)', async () => {
    const r = await importWith({ COOKIE_SECURE: undefined, NODE_ENV: 'production' });
    expect(r()).toBe(true);
  });

  it('NODE_ENV=development with COOKIE_SECURE unset → false (preserves dev behavior)', async () => {
    const r = await importWith({ COOKIE_SECURE: undefined, NODE_ENV: 'development' });
    expect(r()).toBe(false);
  });

  it('NODE_ENV=production with COOKIE_SECURE=false → false (emergency HTTP access)', async () => {
    // The critical case: appliance emergency proxy serves plain HTTP at
    // port 5171, but the api container runs NODE_ENV=production. Without
    // COOKIE_SECURE override, the cookie would be set with Secure and
    // dropped by the browser on the next plain-HTTP request.
    const r = await importWith({ COOKIE_SECURE: false, NODE_ENV: 'production' });
    expect(r()).toBe(false);
  });

  it('NODE_ENV=development with COOKIE_SECURE=true → true (forced for staging-over-https)', async () => {
    const r = await importWith({ COOKIE_SECURE: true, NODE_ENV: 'development' });
    expect(r()).toBe(true);
  });

  it('NODE_ENV=test with COOKIE_SECURE unset → false (test never sets Secure)', async () => {
    const r = await importWith({ COOKIE_SECURE: undefined, NODE_ENV: 'test' });
    expect(r()).toBe(false);
  });
});
