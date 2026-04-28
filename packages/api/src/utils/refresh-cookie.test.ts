// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Force env reload per test by importing the module under different
// process.env states. vi.resetModules + a fresh import does the job.
import { vi } from 'vitest';

interface FakeRes {
  headers: Record<string, string | string[]>;
  setHeader(name: string, value: string | string[]): void;
  getHeader(name: string): string | string[] | undefined;
}

function makeRes(): FakeRes {
  const headers: Record<string, string | string[]> = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
    getHeader(name) {
      return headers[name];
    },
  };
}

function getSetCookie(res: FakeRes): string {
  const v = res.getHeader('Set-Cookie');
  if (Array.isArray(v)) return v[0]!;
  return v as string;
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  // Reset env between tests; the env module memoizes once.
  process.env = { ...ORIGINAL_ENV };
  // Make zod env validation pass with the bare minimum.
  process.env['DATABASE_URL'] = 'postgres://x:y@localhost:5432/test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['JWT_SECRET'] = 'a'.repeat(32);
  process.env['ENCRYPTION_KEY'] = 'b'.repeat(64);
  process.env['PLAID_ENCRYPTION_KEY'] = 'c'.repeat(64);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('setRefreshCookie / clearRefreshCookie', () => {
  it('single-app default: Path=/api/v1/auth, no Secure flag in development', async () => {
    process.env['NODE_ENV'] = 'development';
    delete process.env['COOKIE_PATH'];
    delete process.env['COOKIE_SECURE'];
    const { setRefreshCookie } = await import('./refresh-cookie.js');

    const res = makeRes();
    setRefreshCookie(res as never, 'token-abc');
    const header = getSetCookie(res);

    expect(header).toContain('Path=/api/v1/auth');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Max-Age=604800');
    expect(header).not.toContain('Secure');
  });

  it('production NODE_ENV: Secure flag added even without explicit COOKIE_SECURE', async () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['COOKIE_SECURE'];
    const { setRefreshCookie } = await import('./refresh-cookie.js');

    const res = makeRes();
    setRefreshCookie(res as never, 'token-abc');
    expect(getSetCookie(res)).toContain('Secure');
  });

  it('multi-app: COOKIE_PATH=/mybooks scopes the cookie under the app prefix', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['COOKIE_PATH'] = '/mybooks';
    process.env['COOKIE_SECURE'] = '1';
    const { setRefreshCookie } = await import('./refresh-cookie.js');

    const res = makeRes();
    setRefreshCookie(res as never, 'token-abc');
    const header = getSetCookie(res);

    expect(header).toContain('Path=/mybooks/api/v1/auth');
    expect(header).toContain('Secure');
  });

  it('multi-app: COOKIE_PATH with trailing slash is normalized', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['COOKIE_PATH'] = '/mybooks/';
    process.env['COOKIE_SECURE'] = '1';
    const { setRefreshCookie } = await import('./refresh-cookie.js');

    const res = makeRes();
    setRefreshCookie(res as never, 'token-abc');
    expect(getSetCookie(res)).toContain('Path=/mybooks/api/v1/auth');
  });

  it('COOKIE_SECURE=0 forces Secure off even in production', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['COOKIE_SECURE'] = '0';
    const { setRefreshCookie } = await import('./refresh-cookie.js');

    const res = makeRes();
    setRefreshCookie(res as never, 'token-abc');
    expect(getSetCookie(res)).not.toContain('Secure');
  });

  it('clearRefreshCookie matches Path scope and Max-Age=0', async () => {
    process.env['COOKIE_PATH'] = '/mybooks';
    const { clearRefreshCookie } = await import('./refresh-cookie.js');

    const res = makeRes();
    clearRefreshCookie(res as never);
    const header = getSetCookie(res);

    expect(header).toContain('Path=/mybooks/api/v1/auth');
    expect(header).toContain('Max-Age=0');
  });

  it('appendSetCookie preserves prior Set-Cookie headers', async () => {
    const { setRefreshCookie } = await import('./refresh-cookie.js');

    const res = makeRes();
    res.setHeader('Set-Cookie', 'other=existing; Path=/');
    setRefreshCookie(res as never, 'token-abc');

    const v = res.getHeader('Set-Cookie');
    expect(Array.isArray(v)).toBe(true);
    expect(v).toHaveLength(2);
  });

  it('successive setRefreshCookie calls each append a Set-Cookie header', async () => {
    const { setRefreshCookie } = await import('./refresh-cookie.js');

    const res = makeRes();
    setRefreshCookie(res as never, 'token-1');
    setRefreshCookie(res as never, 'token-2');

    const v = res.getHeader('Set-Cookie');
    expect(Array.isArray(v)).toBe(true);
    expect((v as string[]).length).toBe(2);
    expect((v as string[]).every((c) => c.includes('Path='))).toBe(true);
  });
});

describe('env COOKIE_PATH validation', () => {
  it('boot rejects COOKIE_PATH without leading slash', async () => {
    process.env['COOKIE_PATH'] = 'mybooks';
    // env.ts calls process.exit(1) on validation failure; intercept
    // to assert the rejection without killing the test runner.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(import('../config/env.js')).rejects.toThrow(/process\.exit\(1\)/);
    expect(errSpy).toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('boot rejects COOKIE_PATH containing illegal chars', async () => {
    process.env['COOKIE_PATH'] = '/foo;HttpOnly';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(import('../config/env.js')).rejects.toThrow(/process\.exit\(1\)/);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('boot accepts the empty default and "/mybooks"', async () => {
    delete process.env['COOKIE_PATH'];
    await expect(import('../config/env.js')).resolves.toBeDefined();
    vi.resetModules();

    process.env['DATABASE_URL'] = 'postgres://x:y@localhost:5432/test';
    process.env['REDIS_URL'] = 'redis://localhost:6379';
    process.env['JWT_SECRET'] = 'a'.repeat(32);
    process.env['ENCRYPTION_KEY'] = 'b'.repeat(64);
    process.env['PLAID_ENCRYPTION_KEY'] = 'c'.repeat(64);
    process.env['COOKIE_PATH'] = '/mybooks';
    await expect(import('../config/env.js')).resolves.toBeDefined();
  });
});
