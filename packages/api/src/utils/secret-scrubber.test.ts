// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, afterEach } from 'vitest';
import {
  scrubSecrets,
  registerSecret,
  unregisterSecret,
  registerUrlPassword,
  _resetSecretScrubberForTests,
} from './secret-scrubber.js';

afterEach(() => _resetSecretScrubberForTests());

describe('scrubSecrets', () => {
  it('redacts registered values wherever they appear', () => {
    registerSecret('CANARY-0123456789abcdef');
    expect(scrubSecrets('token=CANARY-0123456789abcdef; again CANARY-0123456789abcdef'))
      .toBe('token=[redacted]; again [redacted]');
  });

  it('ignores values shorter than 8 characters and supports unregister', () => {
    registerSecret('short');
    expect(scrubSecrets('short')).toBe('short');
    registerSecret('longer-secret-value');
    unregisterSecret('longer-secret-value');
    expect(scrubSecrets('longer-secret-value')).toBe('longer-secret-value');
  });

  it('prefers the longest registered value (no partial leftovers)', () => {
    registerSecret('abcdefgh');
    registerSecret('abcdefgh-ijklmnop');
    expect(scrubSecrets('x abcdefgh-ijklmnop y')).toBe('x [redacted] y');
  });

  it('redacts the X-CL-Token header in common dump formats', () => {
    expect(scrubSecrets('x-cl-token: abc123def456')).toBe('x-cl-token: [redacted]');
    expect(scrubSecrets('{"X-CL-Token":"abc123def456"}')).toBe('{"X-CL-Token":"[redacted]"}');
    expect(scrubSecrets("headers: { 'x-cl-token': 'abc123def456' }")).toBe("headers: { 'x-cl-token': '[redacted]' }");
  });

  it('redacts bearer tokens, provider keys and JWTs', () => {
    expect(scrubSecrets('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer [redacted]');
    expect(scrubSecrets('Incorrect API key provided: sk-proj-AbCdEfGh1234')).toBe('Incorrect API key provided: [redacted]');
    expect(scrubSecrets('key sk-ant-api03-XYZxyz_123')).toBe('key [redacted]');
    expect(scrubSecrets('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJl')).toBe('jwt [redacted]');
  });

  it('redacts passwords in connection URLs and registers them', () => {
    expect(scrubSecrets('connect postgresql://cl:p%40ss@127.0.0.1:5432/books failed'))
      .toBe('connect postgresql://cl:[redacted]@127.0.0.1:5432/books failed');
    registerUrlPassword('postgresql://cl:hunter2hunter2@127.0.0.1/books');
    expect(scrubSecrets('password hunter2hunter2 rejected')).toBe('password [redacted] rejected');
  });

  it('replaces email addresses (personal data) but not user@host connection strings', () => {
    expect(scrubSecrets('invite email to Jane.Doe+books@example.co.uk failed: 550 <jane@x.org> rejected'))
      .toBe('invite email to [email] failed: 550 <[email]> rejected');
    expect(scrubSecrets('connecting as kisbooks@127.0.0.1:5434')).toBe('connecting as kisbooks@127.0.0.1:5434');
  });

  it('never touches amounts, dates, uuids or words that merely contain "sk-"', () => {
    const line = 'posted 1234567.8900 and -0.0001 on 2026-10-15 for 3f2b8c1e-1d2a-4c3b-9e8f-0a1b2c3d4e5f task-abcdefghijk';
    expect(scrubSecrets(line)).toBe(line);
  });
});
