// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { deriveHeaderTags, uniformHeaderTag } from './derive-header-tags.js';

describe('deriveHeaderTags', () => {
  it('returns empty array for no lines', () => {
    expect(deriveHeaderTags([])).toEqual([]);
  });

  it('returns empty array when every line is untagged', () => {
    expect(deriveHeaderTags([{ tagId: null }, { tagId: undefined }, {}])).toEqual([]);
  });

  it('returns a single tag when every line shares one tag', () => {
    expect(deriveHeaderTags([{ tagId: 'a' }, { tagId: 'a' }])).toEqual(['a']);
  });

  it('returns distinct tags preserving first-occurrence order', () => {
    expect(deriveHeaderTags([
      { tagId: 'b' },
      { tagId: 'a' },
      { tagId: 'b' },
      { tagId: 'c' },
      { tagId: null },
    ])).toEqual(['b', 'a', 'c']);
  });

  it('ignores nullish and repeated tags', () => {
    expect(deriveHeaderTags([
      { tagId: null },
      { tagId: 'x' },
      { tagId: undefined },
      { tagId: 'x' },
    ])).toEqual(['x']);
  });
});

describe('uniformHeaderTag', () => {
  it('returns null for no lines', () => {
    expect(uniformHeaderTag([])).toBeNull();
  });

  it('returns null when every line is untagged', () => {
    expect(uniformHeaderTag([{ tagId: null }, {}])).toBeNull();
  });

  it('returns the single tag when every line shares one', () => {
    expect(uniformHeaderTag([{ tagId: 'a' }, { tagId: 'a' }])).toBe('a');
  });

  it('returns null when lines disagree, even if only two do', () => {
    expect(uniformHeaderTag([{ tagId: 'a' }, { tagId: 'b' }])).toBeNull();
  });

  it('returns the single tag when one line is tagged and the rest are null', () => {
    expect(uniformHeaderTag([{ tagId: 'a' }, { tagId: null }])).toBe('a');
  });
});
