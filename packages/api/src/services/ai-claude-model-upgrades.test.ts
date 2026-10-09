// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { claudeFamily, planClaudeModelUpgrades } from './ai-config.service.js';

const live = [
  { id: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5', createdAt: '2026-08-01T00:00:00Z' },
  { id: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', createdAt: '2026-08-01T00:00:00Z' },
  { id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', createdAt: '2026-08-01T00:00:00Z' },
  { id: 'claude-opus-5', displayName: 'Claude Opus 5', createdAt: '2026-03-01T00:00:00Z' },
  { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', createdAt: '2025-11-01T00:00:00Z' },
  { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5', createdAt: '2025-10-01T00:00:00Z' },
];

describe('Claude model upgrades', () => {
  it('parses the family from an id', () => {
    expect(claudeFamily('claude-sonnet-5-5')).toBe('sonnet');
    expect(claudeFamily('claude-haiku-4-5-20251001')).toBe('haiku');
    expect(claudeFamily('gpt-4o')).toBeNull();
  });

  it('proposes the newest model of the same family and skips up-to-date slots', () => {
    const plan = planClaudeModelUpgrades([
      { slot: 'categorization', label: 'Cat', current: 'claude-sonnet-4-6' },
      { slot: 'ocr', label: 'OCR', current: 'claude-haiku-4-5-20251001' },
      { slot: 'chat', label: 'Chat', current: 'claude-sonnet-5-5' },
      { slot: 'task:close_review', label: 'CR', current: 'claude-opus-5' },
    ], live);
    expect(plan.latestByFamily['opus']!.id).toBe('claude-opus-5-5');
    expect(plan.upgrades.map((u) => [u.slot, u.latest])).toEqual([
      ['categorization', 'claude-sonnet-5-5'],
      ['ocr', 'claude-haiku-5-5'],
      ['task:close_review', 'claude-opus-5-5'],
    ]);
  });

  it('never crosses families and ignores a family Anthropic no longer lists', () => {
    const plan = planClaudeModelUpgrades([
      { slot: 'chat', label: 'Chat', current: 'claude-instant-1-2' },
    ], live);
    expect(plan.upgrades).toEqual([]);
  });
});
