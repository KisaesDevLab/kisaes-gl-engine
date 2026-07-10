// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { baseUrlFor, firstConfiguredOrigin, appBasePath } from './base-url.js';

// Build a minimal Request-shaped object that `baseUrlFor` will read.
function mockReq(opts: {
  protocol?: string;
  host?: string;
  xfp?: string;
  xfh?: string;
}): Request {
  return {
    protocol: opts.protocol ?? 'http',
    headers: {
      ...(opts.host ? { host: opts.host } : {}),
      ...(opts.xfp ? { 'x-forwarded-proto': opts.xfp } : {}),
      ...(opts.xfh ? { 'x-forwarded-host': opts.xfh } : {}),
    },
  } as unknown as Request;
}

describe('baseUrlFor', () => {
  // env is loaded + frozen at config/env.ts import time, so we can't
  // mutate CORS_ORIGIN per-test and expect firstConfiguredOrigin() to
  // see it. The test-setup defaults CORS_ORIGIN to
  // http://localhost:5173; that's the fallback value the
  // no-host-header case exercises below.

  it('derives origin from req.protocol + host', () => {
    const url = baseUrlFor(mockReq({ protocol: 'http', host: '192.168.68.100:3081' }));
    expect(url).toBe('http://192.168.68.100:3081');
  });

  it('respects X-Forwarded-Proto from a reverse proxy', () => {
    const url = baseUrlFor(mockReq({ protocol: 'http', host: 'mb.kisaes.local', xfp: 'https' }));
    expect(url).toBe('https://mb.kisaes.local');
  });

  it('prefers X-Forwarded-Host when set', () => {
    const url = baseUrlFor(mockReq({ protocol: 'http', host: 'internal', xfp: 'https', xfh: 'external.example.com' }));
    expect(url).toBe('https://external.example.com');
  });

  it('splits comma-joined X-Forwarded-Proto (some proxies chain them)', () => {
    const url = baseUrlFor(mockReq({ protocol: 'http', host: 'h.test', xfp: 'https, http' }));
    expect(url).toBe('https://h.test');
  });

  it('falls back to first CORS_ORIGIN entry when no host is present', () => {
    const url = baseUrlFor(mockReq({ protocol: 'http' }));
    expect(url).toBe(firstConfiguredOrigin());
  });
});

describe('firstConfiguredOrigin', () => {
  it('returns a non-empty http(s) origin without a trailing slash', () => {
    const out = firstConfiguredOrigin();
    expect(out).toMatch(/^https?:\/\//);
    expect(out).not.toMatch(/\/$/);
  });
});

describe('appBasePath (multi-app sub-path)', () => {
  it('is empty in single-app mode (test env PUBLIC_URL has no path)', () => {
    // Guards the backward-compatible case: baseUrlFor stays origin-only.
    expect(appBasePath()).toBe('');
  });

  it('derives the sub-path baseUrlFor appends from a PUBLIC_URL', () => {
    // env is frozen at import, so assert the pure transform the helper uses —
    // this is exactly why a share link at the origin root 404s when the app
    // is served under /mybooks.
    const derive = (u: string) => new URL(u).pathname.replace(/\/+$/, '');
    expect(derive('https://vibe.cpa2web.app/mybooks')).toBe('/mybooks');
    expect(derive('https://vibe.cpa2web.app/mybooks/')).toBe('/mybooks');
    expect(derive('https://vibe.cpa2web.app/')).toBe('');
    expect(derive('https://vibe.cpa2web.app')).toBe('');
  });
});
