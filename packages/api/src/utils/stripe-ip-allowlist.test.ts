// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { stripeIpAllowlist, __internal } from './stripe-ip-allowlist.js';

function invoke(ip: string | undefined): { status?: number; called: boolean; nextCalled: boolean } {
  const status = { status: undefined as number | undefined };
  const res = {
    status: (code: number) => { status.status = code; return res; },
    json: () => res,
  } as unknown as Response;
  let nextCalled = false;
  const next: NextFunction = () => { nextCalled = true; };
  const req = { ip } as Request;
  stripeIpAllowlist()(req, res, next);
  return { status: status.status, called: true, nextCalled };
}

describe('stripeIpAllowlist', () => {
  const original = process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED'];
  beforeEach(() => { delete process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED']; });
  afterEach(() => {
    if (original === undefined) delete process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED'];
    else process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED'] = original;
    vi.restoreAllMocks();
  });

  it('is a pass-through when unset (default)', () => {
    const { nextCalled, status } = invoke('1.2.3.4');
    expect(nextCalled).toBe(true);
    expect(status).toBeUndefined();
  });

  it('is a pass-through when explicitly disabled', () => {
    process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED'] = '0';
    const { nextCalled } = invoke('1.2.3.4');
    expect(nextCalled).toBe(true);
  });

  it('allows a published Stripe IP when enforced', () => {
    process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED'] = '1';
    const allowed = __internal.STRIPE_WEBHOOK_IPS_V4[0]!;
    const { nextCalled, status } = invoke(allowed);
    expect(nextCalled).toBe(true);
    expect(status).toBeUndefined();
  });

  it('denies a non-Stripe IP when enforced', () => {
    process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED'] = '1';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status, nextCalled } = invoke('203.0.113.99');
    expect(status).toBe(403);
    expect(nextCalled).toBe(false);
  });

  it('strips IPv4-mapped IPv6 prefix before the allowlist check', () => {
    process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED'] = '1';
    const allowed = __internal.STRIPE_WEBHOOK_IPS_V4[0]!;
    const { nextCalled } = invoke(`::ffff:${allowed}`);
    expect(nextCalled).toBe(true);
  });

  it('denies when no req.ip was available', () => {
    process.env['STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED'] = '1';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { status } = invoke(undefined);
    expect(status).toBe(403);
  });
});
