// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Integration-style unit tests for the resolver pipeline the ledger
// runs on every write: pre-load contact default + (future) item/rule/AI
// sources, then map each line through resolveDefaultTag. These tests
// don't touch the DB; they use plain arrays to simulate the per-line
// inputs and the pre-loaded context, which is exactly what the
// ledger.service's postTransaction loop does.

import { describe, it, expect } from 'vitest';
import { resolveDefaultTag, type DefaultTagContext } from './resolve-default-tag.js';
import { deriveHeaderTags, uniformHeaderTag } from './derive-header-tags.js';

interface LineIn {
  explicitUserTagId?: string | null;
  itemDefaultTagId?: string | null;
  aiSuggestedTagId?: string | null;
}

function resolveLines(lines: LineIn[], shared: Omit<DefaultTagContext, 'explicitUserTagId' | 'itemDefaultTagId' | 'aiSuggestedTagId'>) {
  return lines.map((l) => resolveDefaultTag({
    explicitUserTagId: l.explicitUserTagId,
    itemDefaultTagId: l.itemDefaultTagId,
    aiSuggestedTagId: l.aiSuggestedTagId,
    ...shared,
  }));
}

describe('batch resolver behavior mirroring ledger.postTransaction', () => {
  it('fills contact-default on untouched lines, preserves touched', () => {
    const resolved = resolveLines([
      { /* user hasn't set */ },
      { explicitUserTagId: 'userpick' },
      { /* user hasn't set */ },
    ], { contactDefaultTagId: 'vendor-default' });
    expect(resolved).toEqual(['vendor-default', 'userpick', 'vendor-default']);
  });

  it('respects explicit null clears per line', () => {
    const resolved = resolveLines([
      { explicitUserTagId: null },
      { /* untouched */ },
    ], { contactDefaultTagId: 'vendor-default' });
    expect(resolved).toEqual([null, 'vendor-default']);
  });

  it('item default wins over contact default on a per-line basis', () => {
    const resolved = resolveLines([
      { itemDefaultTagId: 'item-A' },
      { itemDefaultTagId: null },
      { itemDefaultTagId: 'item-B' },
    ], { contactDefaultTagId: 'vendor-default' });
    expect(resolved).toEqual(['item-A', 'vendor-default', 'item-B']);
  });

  it('bank rule stamps uniformly when present regardless of per-line item', () => {
    const resolved = resolveLines([
      { itemDefaultTagId: 'item-A' },
      { itemDefaultTagId: 'item-B' },
    ], { bankRuleTagId: 'rule-X' });
    expect(resolved).toEqual(['rule-X', 'rule-X']);
  });

  it('AI suggestion sits between bank rule and item', () => {
    const resolved = resolveLines([
      { aiSuggestedTagId: 'ai-1', itemDefaultTagId: 'item-A' },
      { aiSuggestedTagId: null, itemDefaultTagId: 'item-A' },
    ], {});
    expect(resolved).toEqual(['ai-1', 'item-A']);
  });

  it('derives uniform header tag when every resolved line ends up the same', () => {
    const resolved = resolveLines([
      { },
      { },
      { },
    ], { contactDefaultTagId: 'vendor-default' });
    const lines = resolved.map((tagId) => ({ tagId }));
    expect(uniformHeaderTag(lines)).toBe('vendor-default');
    expect(deriveHeaderTags(lines)).toEqual(['vendor-default']);
  });

  it('derives distinct set when lines resolve to different tags', () => {
    const resolved = resolveLines([
      { explicitUserTagId: 'A' },
      { explicitUserTagId: 'B' },
      { explicitUserTagId: null },
    ], {});
    const lines = resolved.map((tagId) => ({ tagId }));
    expect(deriveHeaderTags(lines).sort()).toEqual(['A', 'B']);
    expect(uniformHeaderTag(lines)).toBeNull();
  });

  it('every source present — precedence chain holds per line', () => {
    const shared = {
      bankRuleTagId: 'rule',
      contactDefaultTagId: 'vendor',
    };
    const resolved = resolveLines([
      // No explicit → bank rule wins over item and contact.
      { itemDefaultTagId: 'item' },
      // Explicit user beats everything.
      { explicitUserTagId: 'user', itemDefaultTagId: 'item' },
      // Explicit null beats everything downstream too.
      { explicitUserTagId: null, itemDefaultTagId: 'item' },
    ], shared);
    expect(resolved).toEqual(['rule', 'user', null]);
  });
});
