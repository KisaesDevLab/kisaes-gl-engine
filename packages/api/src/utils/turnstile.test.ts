// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verifyTurnstile, invalidateTurnstileSecretCache } from './turnstile.js';

// The secret resolver prefers system_settings over env, then memoizes
// its result. Mock the dynamic import at the top so tests can drive
// the env side without any DB lookup; bust the cache between tests so
// env changes take effect immediately.
vi.mock('../services/admin.service.js', () => ({
  getSetting: vi.fn(async () => null),
}));

describe('verifyTurnstile', () => {
  const originalSecret = process.env['TURNSTILE_SECRET_KEY'];

  beforeEach(() => {
    delete process.env['TURNSTILE_SECRET_KEY'];
    invalidateTurnstileSecretCache();
  });
  afterEach(() => {
    if (originalSecret === undefined) delete process.env['TURNSTILE_SECRET_KEY'];
    else process.env['TURNSTILE_SECRET_KEY'] = originalSecret;
    invalidateTurnstileSecretCache();
    vi.restoreAllMocks();
  });

  it('short-circuits allow=true when secret is unset (dev / LAN-only)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not be called'));
    const result = await verifyTurnstile('any-token');
    expect(result.allow).toBe(true);
    expect(result.skipped).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('short-circuits allow=true when secret is literally "disabled"', async () => {
    process.env['TURNSTILE_SECRET_KEY'] = 'disabled';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not be called'));
    const result = await verifyTurnstile('any-token');
    expect(result.allow).toBe(true);
    expect(result.skipped).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects when no token is supplied and verification is enabled', async () => {
    process.env['TURNSTILE_SECRET_KEY'] = 'real-secret';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await verifyTurnstile(undefined);
    expect(result.allow).toBe(false);
    expect(result.errorCodes).toContain('missing-input-response');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows when CF says success=true', async () => {
    process.env['TURNSTILE_SECRET_KEY'] = 'real-secret';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, challenge_ts: '2026-01-01T00:00:00Z' }), { status: 200 }),
    );
    const result = await verifyTurnstile('valid-token', '203.0.113.5');
    expect(result.allow).toBe(true);
    expect(result.skipped).toBeUndefined();
  });

  it('rejects and surfaces error codes when CF says success=false', async () => {
    process.env['TURNSTILE_SECRET_KEY'] = 'real-secret';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
        { status: 200 },
      ),
    );
    const result = await verifyTurnstile('bad-token');
    expect(result.allow).toBe(false);
    expect(result.errorCodes).toEqual(['invalid-input-response']);
  });

  it('fails OPEN on network error (CF outage)', async () => {
    process.env['TURNSTILE_SECRET_KEY'] = 'real-secret';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    const result = await verifyTurnstile('valid-token');
    expect(result.allow).toBe(true);
    expect(result.skipped).toBe('network_error');
  });

  it('fails OPEN when CF returns non-2xx', async () => {
    process.env['TURNSTILE_SECRET_KEY'] = 'real-secret';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const result = await verifyTurnstile('valid-token');
    expect(result.allow).toBe(true);
    expect(result.skipped).toBe('network_error');
  });
});
