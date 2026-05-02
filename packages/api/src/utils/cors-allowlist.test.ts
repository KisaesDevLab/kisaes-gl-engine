// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { buildOriginAllowlist } from './cors-allowlist.js';

describe('buildOriginAllowlist', () => {
  it('matches literal origins (case-sensitive, exact)', () => {
    const m = buildOriginAllowlist(
      'http://localhost:5173, http://192.168.68.100:3081, https://mb.kisaes.local',
    );
    expect(m.matches('http://localhost:5173')).toBe(true);
    expect(m.matches('http://192.168.68.100:3081')).toBe(true);
    expect(m.matches('https://mb.kisaes.local')).toBe(true);
    expect(m.matches('http://evil.example.com')).toBe(false);
  });

  it('normalizes trailing slashes on literal entries and origins', () => {
    const m = buildOriginAllowlist('http://localhost:5173/');
    expect(m.matches('http://localhost:5173')).toBe(true);
    expect(m.matches('http://localhost:5173/')).toBe(true);
  });

  it('ignores empty entries and trims whitespace', () => {
    const m = buildOriginAllowlist('  ,http://a.test , ,http://b.test ,');
    expect(m.matches('http://a.test')).toBe(true);
    expect(m.matches('http://b.test')).toBe(true);
    expect(m.literals.size).toBe(2);
  });

  it('compiles /pattern/ entries as regex', () => {
    const m = buildOriginAllowlist('/^https:\\/\\/.*\\.firm\\.com$/');
    expect(m.matches('https://acme.firm.com')).toBe(true);
    expect(m.matches('https://sub.acme.firm.com')).toBe(true);
    expect(m.matches('http://acme.firm.com')).toBe(false);
    expect(m.matches('https://firm.com.evil.example')).toBe(false);
  });

  it('honors regex flags (e.g. /.../ i for case-insensitive)', () => {
    const m = buildOriginAllowlist('/^https:\\/\\/MB\\.kisaes\\.local$/i');
    expect(m.matches('https://mb.kisaes.local')).toBe(true);
    expect(m.matches('https://MB.KISAES.LOCAL')).toBe(true);
  });

  it('mixes literal and regex entries', () => {
    const m = buildOriginAllowlist(
      'http://localhost:5173, /^https:\\/\\/.*\\.firm\\.com$/',
    );
    expect(m.matches('http://localhost:5173')).toBe(true);
    expect(m.matches('https://acme.firm.com')).toBe(true);
    expect(m.matches('http://acme.firm.com')).toBe(false);
    expect(m.matches('http://other.test')).toBe(false);
  });

  it('rejects unmatched origins', () => {
    const m = buildOriginAllowlist('http://localhost:5173');
    expect(m.matches('http://localhost:5174')).toBe(false);
    expect(m.matches('http://attacker.example')).toBe(false);
  });

  it('throws on a malformed regex pattern', () => {
    expect(() => buildOriginAllowlist('/[unterminated/')).toThrow(/regex entry/);
  });

  it('treats /path-without-trailing-slash as a literal (not a regex)', () => {
    // A bare '/foo' or '/foo/bar' isn't a regex literal — it's an
    // unparseable origin. Don't silently swallow as a regex; treat as a
    // literal so the operator sees it stays unmatched.
    const m = buildOriginAllowlist('/foo');
    expect(m.regexes).toHaveLength(0);
    expect(m.literals.has('/foo')).toBe(true);
  });
});
