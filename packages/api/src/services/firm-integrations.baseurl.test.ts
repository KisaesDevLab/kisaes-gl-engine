// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { validateBaseUrlOverride } from './firm-integrations.service.js';

describe('Tax1099 baseUrlOverride validation', () => {
  it('accepts a public https origin and normalises trailing slashes', () => {
    expect(validateBaseUrlOverride('https://sandbox.tax1099.example/api/')).toBe('https://sandbox.tax1099.example/api');
    expect(validateBaseUrlOverride('')).toBeNull();
    expect(validateBaseUrlOverride(null)).toBeNull();
  });
  it('refuses http, loopback, RFC-1918, link-local, metadata and mapped-IPv6 targets', () => {
    for (const bad of [
      'http://api.tax1099.example', 'https://localhost:3001', 'https://127.0.0.1', 'https://192.168.1.110:8082',
      'https://169.254.169.254/latest/', 'https://metadata.google.internal', 'https://[::ffff:7f00:1]/', 'not a url',
    ]) {
      expect(() => validateBaseUrlOverride(bad), bad).toThrow();
    }
  });
});
