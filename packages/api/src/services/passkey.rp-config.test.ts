// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// vibe-distribution-plan D3: WebAuthn rpId / rpOrigin resolution.
// The env module memoizes once on import, so each scenario gets a
// fresh module via vi.resetModules + dynamic import. Mirrors the
// pattern in refresh-cookie.test.ts.

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env['DATABASE_URL'] = 'postgres://x:y@localhost:5432/test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['JWT_SECRET'] = 'a'.repeat(32);
  process.env['ENCRYPTION_KEY'] = 'b'.repeat(64);
  process.env['PLAID_ENCRYPTION_KEY'] = 'c'.repeat(64);
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('passkey rpId / rpOrigin resolution', () => {
  it('explicit WEBAUTHN_RP_ID wins over derived sources', async () => {
    process.env['WEBAUTHN_RP_ID'] = 'vibe.local';
    process.env['PUBLIC_URL'] = 'https://other.example.com';
    process.env['CORS_ORIGIN'] = 'https://wrong.example.com';
    const { getRpId } = await import('./passkey.service.js');
    expect(getRpId()).toBe('vibe.local');
  });

  it('derives rpId from PUBLIC_URL hostname when WEBAUTHN_RP_ID unset', async () => {
    delete process.env['WEBAUTHN_RP_ID'];
    process.env['PUBLIC_URL'] = 'https://vibe.local/mybooks';
    const { getRpId } = await import('./passkey.service.js');
    expect(getRpId()).toBe('vibe.local');
  });

  it('LAN-IP PUBLIC_URL produces the IP as rpId (no port)', async () => {
    delete process.env['WEBAUTHN_RP_ID'];
    process.env['PUBLIC_URL'] = 'http://192.168.1.50:5173';
    const { getRpId } = await import('./passkey.service.js');
    expect(getRpId()).toBe('192.168.1.50');
  });

  it('falls back to "localhost" via PUBLIC_URL Zod default when env is unset', async () => {
    delete process.env['WEBAUTHN_RP_ID'];
    delete process.env['PUBLIC_URL'];
    const { getRpId } = await import('./passkey.service.js');
    expect(getRpId()).toBe('localhost');
  });

  it('rpOrigin returns PUBLIC_URL verbatim (full origin)', async () => {
    process.env['PUBLIC_URL'] = 'https://vibe.local/mybooks';
    const { getRpOrigin } = await import('./passkey.service.js');
    expect(getRpOrigin()).toBe('https://vibe.local/mybooks');
  });

  it('rpOrigin uses Zod-default PUBLIC_URL when env is unset', async () => {
    delete process.env['PUBLIC_URL'];
    const { getRpOrigin } = await import('./passkey.service.js');
    expect(getRpOrigin()).toBe('http://localhost:5173');
  });

  it('empty-string WEBAUTHN_RP_ID falls through to PUBLIC_URL hostname', async () => {
    process.env['WEBAUTHN_RP_ID'] = '';
    process.env['PUBLIC_URL'] = 'https://vibe.local/mybooks';
    const { getRpId } = await import('./passkey.service.js');
    expect(getRpId()).toBe('vibe.local');
  });
});
