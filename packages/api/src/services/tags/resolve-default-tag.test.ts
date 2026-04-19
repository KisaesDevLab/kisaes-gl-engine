// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { resolveDefaultTag } from './resolve-default-tag.js';

// ADR 0XY §7 truth table — each row is one test case. The table labels
// "vendor" map to contactDefaultTagId in this implementation per addendum
// §C.1 (the repo has no separate vendors table; the default comes from
// the header contact when it is of type 'vendor' or 'both').
describe('resolveDefaultTag — precedence truth table', () => {
  it('row 1 — every source empty → null', () => {
    expect(resolveDefaultTag({})).toBeNull();
  });

  it('row 2 — bank rule beats AI, item, and contact', () => {
    expect(resolveDefaultTag({
      bankRuleTagId: 'B',
      aiSuggestedTagId: 'A',
      itemDefaultTagId: 'I',
      contactDefaultTagId: 'V',
    })).toBe('B');
  });

  it('row 3 — AI wins when no bank rule', () => {
    expect(resolveDefaultTag({
      aiSuggestedTagId: 'A',
      itemDefaultTagId: 'I',
      contactDefaultTagId: 'V',
    })).toBe('A');
  });

  it('row 4 — item wins when no bank rule or AI', () => {
    expect(resolveDefaultTag({
      itemDefaultTagId: 'I',
      contactDefaultTagId: 'V',
    })).toBe('I');
  });

  it('row 5 — contact is last-resort default', () => {
    expect(resolveDefaultTag({
      contactDefaultTagId: 'V',
    })).toBe('V');
  });

  it('row 6 — explicit user entry wins over every source', () => {
    expect(resolveDefaultTag({
      explicitUserTagId: 'U',
      bankRuleTagId: 'B',
      aiSuggestedTagId: 'A',
      itemDefaultTagId: 'I',
      contactDefaultTagId: 'V',
    })).toBe('U');
  });

  it('row 7 — explicit null from user is honored, not upgraded to a fallback', () => {
    expect(resolveDefaultTag({
      explicitUserTagId: null,
      bankRuleTagId: 'B',
      aiSuggestedTagId: 'A',
      itemDefaultTagId: 'I',
      contactDefaultTagId: 'V',
    })).toBeNull();
  });

  it('row 8 — bank rule alone', () => {
    expect(resolveDefaultTag({ bankRuleTagId: 'B' })).toBe('B');
  });

  it('row 9 — AI alone', () => {
    expect(resolveDefaultTag({ aiSuggestedTagId: 'A' })).toBe('A');
  });

  it('skips null source values and falls through to the next', () => {
    expect(resolveDefaultTag({
      bankRuleTagId: null,
      aiSuggestedTagId: null,
      itemDefaultTagId: 'I',
    })).toBe('I');
  });

  it('skips undefined source values and falls through', () => {
    expect(resolveDefaultTag({
      bankRuleTagId: undefined,
      itemDefaultTagId: undefined,
      contactDefaultTagId: 'V',
    })).toBe('V');
  });

  it('treats undefined on explicit as "not touched" and consults sources', () => {
    expect(resolveDefaultTag({
      explicitUserTagId: undefined,
      itemDefaultTagId: 'I',
    })).toBe('I');
  });
});
