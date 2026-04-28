// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { buildW9SmsBody } from './portal-1099.service.js';

describe('buildW9SmsBody', () => {
  const link = 'https://example.com/w9/abc123';

  it('includes the link verbatim and a context phrase', () => {
    const body = buildW9SmsBody(link);
    expect(body).toContain(link);
    expect(body).toMatch(/W-9/i);
  });

  it("doesn't include the operator's prose message — that's the email channel's job", () => {
    // The function takes only a link; test surfaces the contract.
    expect(buildW9SmsBody.length).toBe(1);
  });

  it('stays a single SMS segment for production URLs (≤160 chars)', () => {
    // 64-hex-char token + production-style HTTPS hostname. A LAN-IP
    // deployment with a long port (e.g. http://192.168.1.10:3081) can
    // tip into a 2nd segment, which Twilio still concatenates
    // seamlessly — this is per-byte cost, not delivery risk.
    const productionLink = 'https://acme.example.com/w9/' + 'a'.repeat(64);
    expect(buildW9SmsBody(productionLink).length).toBeLessThanOrEqual(160);
  });

  it('shows the expiry to set vendor expectations', () => {
    const body = buildW9SmsBody(link);
    expect(body).toMatch(/expire/i);
  });
});
