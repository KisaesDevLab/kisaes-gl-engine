// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { baseUrlFor, firstConfiguredOrigin } from './base-url.js';

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
