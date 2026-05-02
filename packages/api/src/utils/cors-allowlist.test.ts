// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { buildOriginAllowlist } from './cors-allowlist.js';

describe('buildOriginAllowlist', () => {
  it('matches literal origins (case-insensitive after normalization)', () => {
    const m = buildOriginAllowlist(
      'http://localhost:5173, http://192.168.68.100:3081, https://mb.kisaes.local',
    );
    expect(m.matches('http://localhost:5173')).toBe(true);
    expect(m.matches('http://192.168.68.100:3081')).toBe(true);
    expect(m.matches('https://mb.kisaes.local')).toBe(true);
    // Case-insensitive — origins from broken middleboxes still match.
    expect(m.matches('HTTPS://MB.KISAES.LOCAL')).toBe(true);
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

  it('compiles /pattern/ entries as regex (anchored)', () => {
    const m = buildOriginAllowlist('/^https:\\/\\/.*\\.firm\\.com$/');
    expect(m.matches('https://acme.firm.com')).toBe(true);
    expect(m.matches('https://sub.acme.firm.com')).toBe(true);
    expect(m.matches('http://acme.firm.com')).toBe(false);
    // The critical bypass case — was previously possible with unanchored regex.
    // With anchor enforcement, this can't even be configured.
    expect(m.matches('https://firm.com.evil.example')).toBe(false);
  });

  it('regex matching uses normalized origin (case-insensitive without `i` flag)', () => {
    // Without the `i` flag, the regex still sees lowercase input because
    // the matcher normalizes before testing. Operators don't have to
    // remember to add `i` for hostnames.
    const m = buildOriginAllowlist('/^https:\\/\\/mb\\.kisaes\\.local$/');
    expect(m.matches('https://MB.KISAES.LOCAL')).toBe(true);
    expect(m.matches('https://mb.kisaes.local')).toBe(true);
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
    // Anchored but the body is invalid — RegExp constructor throws.
    expect(() => buildOriginAllowlist('/^[unterminated$/')).toThrow(/failed to compile/);
  });

  it('throws on an unanchored regex (security guard)', () => {
    // The original PR-1 code accepted this; the fix rejects it because
    // `https://acme.firm.com.attacker.example` would match.
    expect(() => buildOriginAllowlist('/^https:\\/\\/.*\\.firm\\.com/')).toThrow(/must be anchored/);
    expect(() => buildOriginAllowlist('/https:\\/\\/.*\\.firm\\.com$/')).toThrow(/must be anchored/);
    expect(() => buildOriginAllowlist('/foo/')).toThrow(/must be anchored/);
  });

  it('throws on a trivially-permissive regex (security guard)', () => {
    // `^.*$`, `^.+$` and friends would admit any origin — defeating the
    // purpose of the allowlist entirely.
    expect(() => buildOriginAllowlist('/^.*$/')).toThrow(/trivially permissive/);
    expect(() => buildOriginAllowlist('/^.+$/')).toThrow(/trivially permissive/);
    expect(() => buildOriginAllowlist('/^[\\s\\S]*$/')).toThrow(/trivially permissive/);
  });

  it('catches single-scheme wildcards (security guard, QA-R2 C2)', () => {
    // The earlier 2-sample heuristic missed these — only one https
    // probe meant `^https:\/\/.+$` snuck through. Now 5 probes
    // including 3 https and 2 http origins; matchCount=3 trips the
    // guard.
    expect(() => buildOriginAllowlist('/^https:\\/\\/.+$/')).toThrow(/trivially permissive/);
    expect(() => buildOriginAllowlist('/^http:\\/\\/.+$/')).toThrow(/trivially permissive/);
    expect(() => buildOriginAllowlist('/^https?:\\/\\/.+$/')).toThrow(/trivially permissive/);
  });

  it('throws when /pattern/ has no balanced closing slash (QA-R2 H1 — comma-quantifier split)', () => {
    // `/^.{0,99}$/` gets split on the inner comma into '/^.{0' and
    // '99}$/'. Both look like regex starts but neither parses as
    // /pattern/flags. We surface the issue rather than silently
    // falling through to literal mode and rejecting all CORS traffic.
    expect(() => buildOriginAllowlist('/^.{0,99}$/')).toThrow(/not a valid regex literal/);
    // An entry that opens with `/` but never closes — operator typo.
    expect(() => buildOriginAllowlist('/^abc')).toThrow(/not a valid regex literal/);
    // The previous "treats `/foo` as literal" behavior is now an
    // explicit error — silent fallthrough hid configuration mistakes.
    expect(() => buildOriginAllowlist('/foo')).toThrow(/not a valid regex literal/);
  });

  it('accepts the d (hasIndices) regex flag', () => {
    // ES2022 added `d` for indexed captures. Reject it would surprise
    // operators who upgrade Node and find their working regex breaks.
    const m = buildOriginAllowlist('/^https:\\/\\/example\\.com$/d');
    expect(m.matches('https://example.com')).toBe(true);
  });

  it('legitimate firm-pattern regexes pass the trivially-permissive guard', () => {
    // Sanity: real-world patterns operators are likely to write must
    // not trip the guard.
    expect(() => buildOriginAllowlist('/^https:\\/\\/[a-z0-9-]+\\.firm\\.com$/')).not.toThrow();
    expect(() => buildOriginAllowlist('/^https:\\/\\/(?:app|admin)\\.acme\\.test$/')).not.toThrow();
    expect(() => buildOriginAllowlist('/^https:\\/\\/mybooks-[0-9]+\\.example\\.com$/')).not.toThrow();
  });
});
