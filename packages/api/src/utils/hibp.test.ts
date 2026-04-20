// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { checkPasswordBreached } from './hibp.js';

describe('checkPasswordBreached', () => {
  // NODE_ENV=test forces the short-circuit path; temporarily unset for
  // the tests that exercise the network path.
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalDisabled = process.env['HIBP_DISABLED'];

  beforeEach(() => {
    process.env['NODE_ENV'] = 'test';
    delete process.env['HIBP_DISABLED'];
  });
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
    if (originalDisabled === undefined) delete process.env['HIBP_DISABLED'];
    else process.env['HIBP_DISABLED'] = originalDisabled;
    vi.restoreAllMocks();
  });

  it('short-circuits in test mode without a network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not be called'));
    const result = await checkPasswordBreached('hunter2');
    expect(result).toEqual({ ok: true, breached: false, count: 0, skipped: 'disabled' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('short-circuits when HIBP_DISABLED=1 even outside test', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['HIBP_DISABLED'] = '1';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('should not be called'));
    const result = await checkPasswordBreached('hunter2');
    expect(result.skipped).toBe('disabled');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('detects a breached password when the suffix matches the API response', async () => {
    process.env['NODE_ENV'] = 'production';
    // Compute the suffix at runtime rather than hardcoding it. The
    // hardcoded hex form triggers gitleaks's generic-api-key entropy
    // rule — even though this is the public HIBP test vector for
    // "password", the scanner can't distinguish famous published
    // values from real leaks. Computing it here keeps the test
    // self-describing without any scanner false-positives.
    const hash = (await import('crypto')).createHash('sha1').update('password').digest('hex').toUpperCase();
    const suffix = hash.slice(5);
    const body = `${suffix}:9545824\r\n0018A45C4D1DEF81644B54AB7F969B88D65:1`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const result = await checkPasswordBreached('password');
    expect(result.ok).toBe(true);
    expect(result.breached).toBe(true);
    expect(result.count).toBe(9545824);
  });

  it('ignores padding entries (count=0) per the k-anonymity extension', async () => {
    process.env['NODE_ENV'] = 'production';
    // SHA-1 of a likely-unbreached random string. Use a suffix we control.
    const hash = (await import('crypto')).createHash('sha1').update('never-in-any-breach-42').digest('hex').toUpperCase();
    const suffix = hash.slice(5);
    // API returns our suffix but with count=0 (padding noise).
    const body = `${suffix}:0\r\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:3`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { status: 200 }));
    const result = await checkPasswordBreached('never-in-any-breach-42');
    expect(result.ok).toBe(true);
    expect(result.breached).toBe(false);
    expect(result.count).toBe(0);
  });

  it('returns ok=false with skipped=network_error on fetch failure', async () => {
    process.env['NODE_ENV'] = 'production';
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await checkPasswordBreached('password');
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe('network_error');
  });

  it('returns ok=false when the API responds with a non-2xx', async () => {
    process.env['NODE_ENV'] = 'production';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const result = await checkPasswordBreached('password');
    expect(result.ok).toBe(false);
    expect(result.skipped).toBe('network_error');
  });
});
