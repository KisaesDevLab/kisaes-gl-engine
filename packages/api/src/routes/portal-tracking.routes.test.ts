// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { resolveRedirectTarget } from './portal-tracking.routes.js';

// Regression: the click-wrapper allowlist checked PORTAL_BASE_URL only,
// while the links it guards are built from PORTAL_BASE_URL || PUBLIC_URL.
// An appliance configured via PUBLIC_URL alone rejected every link in
// its own reminder emails.

const savedPortalBase = process.env['PORTAL_BASE_URL'];
const savedPublicUrl = process.env['PUBLIC_URL'];

afterAll(() => {
  if (savedPortalBase === undefined) delete process.env['PORTAL_BASE_URL'];
  else process.env['PORTAL_BASE_URL'] = savedPortalBase;
  if (savedPublicUrl === undefined) delete process.env['PUBLIC_URL'];
  else process.env['PUBLIC_URL'] = savedPublicUrl;
});

describe('resolveRedirectTarget', () => {
  beforeEach(() => {
    delete process.env['PORTAL_BASE_URL'];
    delete process.env['PUBLIC_URL'];
  });

  it('allows portal links when only PUBLIC_URL is configured', () => {
    process.env['PUBLIC_URL'] = 'https://books.example.com';
    const target = resolveRedirectTarget(
      'https://books.example.com/portal/login?firm=acme-1234',
    );
    expect(target?.toString()).toBe('https://books.example.com/portal/login?firm=acme-1234');
  });

  it('prefers PORTAL_BASE_URL over PUBLIC_URL when both are set', () => {
    process.env['PORTAL_BASE_URL'] = 'https://portal.example.com';
    process.env['PUBLIC_URL'] = 'https://books.example.com';
    expect(resolveRedirectTarget('https://portal.example.com/portal/login')).not.toBeNull();
    expect(resolveRedirectTarget('https://books.example.com/portal/login')).toBeNull();
  });

  it('falls back to the dev default when neither env var is set', () => {
    expect(resolveRedirectTarget('http://localhost:5173/portal/login')).not.toBeNull();
  });

  it('rejects foreign origins, scheme tricks, and malformed targets', () => {
    process.env['PUBLIC_URL'] = 'https://books.example.com';
    expect(resolveRedirectTarget('https://evil.example.com/portal/login')).toBeNull();
    expect(resolveRedirectTarget('http://books.example.com/portal/login')).toBeNull(); // scheme downgrade
    expect(resolveRedirectTarget('javascript:alert(1)')).toBeNull();
    expect(resolveRedirectTarget('data:text/html,hi')).toBeNull();
    expect(resolveRedirectTarget('/portal/login')).toBeNull(); // relative, no origin
    expect(resolveRedirectTarget('')).toBeNull();
    expect(resolveRedirectTarget('https://books.example.com.evil.com/x')).toBeNull();
  });
});
