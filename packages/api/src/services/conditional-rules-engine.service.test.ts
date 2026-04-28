// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import type { Action, ActionsField, ConditionAST, ConditionalRule, ConditionalRuleContext } from '@kis-books/shared';
import {
  contextFromFeedItem,
  evaluateActions,
  evaluateCondition,
  evaluateRule,
  evaluateRules,
} from './conditional-rules-engine.service.js';

// Default context — overrideable per test.
function ctx(over: Partial<ConditionalRuleContext> = {}): ConditionalRuleContext {
  return {
    descriptor: 'AMAZON MKTPLACE',
    amount: 42.5,
    amount_sign: 1,
    account_source_id: 'acct-source-1',
    date: '2026-04-15',
    day_of_week: 3, // Wednesday
    ...over,
  };
}

function leaf(field: string, operator: string, value: unknown): ConditionAST {
  // The cast is fine for the test surface — production code goes
  // through the Zod schema which narrows field to the catalog
  // enum. The test sometimes supplies deferred fields (class_id,
  // location_id) on purpose to verify the throw path.
  return { type: 'leaf', field, operator, value } as ConditionAST;
}
function group(op: 'AND' | 'OR', ...children: ConditionAST[]): ConditionAST {
  return { type: 'group', op, children };
}

// ─── String operators ─────────────────────────────────────────

describe('evaluateCondition — string operators', () => {
  it('equals matches case-insensitively', () => {
    expect(evaluateCondition(leaf('descriptor', 'equals', 'amazon mktplace'), ctx())).toBe(true);
  });
  it('not_equals returns true when not equal', () => {
    expect(evaluateCondition(leaf('descriptor', 'not_equals', 'walmart'), ctx())).toBe(true);
  });
  it('contains matches substring case-insensitively', () => {
    expect(evaluateCondition(leaf('descriptor', 'contains', 'amazon'), ctx())).toBe(true);
  });
  it('not_contains returns true when substring absent', () => {
    expect(evaluateCondition(leaf('descriptor', 'not_contains', 'walmart'), ctx())).toBe(true);
  });
  it('starts_with matches at start', () => {
    expect(evaluateCondition(leaf('descriptor', 'starts_with', 'amazon'), ctx())).toBe(true);
    expect(evaluateCondition(leaf('descriptor', 'starts_with', 'mktplace'), ctx())).toBe(false);
  });
  it('ends_with matches at end', () => {
    expect(evaluateCondition(leaf('descriptor', 'ends_with', 'mktplace'), ctx())).toBe(true);
    expect(evaluateCondition(leaf('descriptor', 'ends_with', 'amazon'), ctx())).toBe(false);
  });
  it('matches_regex respects case-insensitive flag', () => {
    // descriptor 'AMAZON MKTPLACE' — case-insensitive match on lowercased pattern
    expect(evaluateCondition(leaf('descriptor', 'matches_regex', '^amazon'), ctx())).toBe(true);
    expect(evaluateCondition(leaf('descriptor', 'matches_regex', '^Amazon'), ctx())).toBe(true);
  });
  it('matches_regex returns false on invalid regex', () => {
    expect(evaluateCondition(leaf('descriptor', 'matches_regex', '['), ctx())).toBe(false);
  });
  it('not_matches_regex inverts', () => {
    expect(evaluateCondition(leaf('descriptor', 'not_matches_regex', '^WALMART'), ctx())).toBe(true);
  });
  it('handles empty descriptor', () => {
    const c = ctx({ descriptor: '' });
    expect(evaluateCondition(leaf('descriptor', 'equals', ''), c)).toBe(true);
    expect(evaluateCondition(leaf('descriptor', 'contains', 'foo'), c)).toBe(false);
  });
});

// ─── Numeric operators ────────────────────────────────────────

describe('evaluateCondition — numeric operators', () => {
  it('eq', () => {
    expect(evaluateCondition(leaf('amount', 'eq', 42.5), ctx())).toBe(true);
    expect(evaluateCondition(leaf('amount', 'eq', 42.6), ctx())).toBe(false);
  });
  it('ne', () => {
    expect(evaluateCondition(leaf('amount', 'ne', 50), ctx())).toBe(true);
  });
  it('gt / gte', () => {
    expect(evaluateCondition(leaf('amount', 'gt', 40), ctx())).toBe(true);
    expect(evaluateCondition(leaf('amount', 'gte', 42.5), ctx())).toBe(true);
    expect(evaluateCondition(leaf('amount', 'gt', 42.5), ctx())).toBe(false);
  });
  it('lt / lte', () => {
    expect(evaluateCondition(leaf('amount', 'lt', 50), ctx())).toBe(true);
    expect(evaluateCondition(leaf('amount', 'lte', 42.5), ctx())).toBe(true);
  });
  it('between (inclusive)', () => {
    expect(evaluateCondition(leaf('amount', 'between', [40, 50]), ctx())).toBe(true);
    expect(evaluateCondition(leaf('amount', 'between', [42.5, 42.5]), ctx())).toBe(true);
    expect(evaluateCondition(leaf('amount', 'between', [50, 60]), ctx())).toBe(false);
  });
  it('between rejects malformed value', () => {
    expect(evaluateCondition(leaf('amount', 'between', [40]), ctx())).toBe(false);
  });
});

// ─── Date operators ───────────────────────────────────────────

describe('evaluateCondition — date operators', () => {
  it('before / after', () => {
    expect(evaluateCondition(leaf('date', 'before', '2026-04-20'), ctx())).toBe(true);
    expect(evaluateCondition(leaf('date', 'after', '2026-04-10'), ctx())).toBe(true);
  });
  it('between (inclusive)', () => {
    expect(evaluateCondition(leaf('date', 'between', ['2026-04-10', '2026-04-20']), ctx())).toBe(true);
    expect(evaluateCondition(leaf('date', 'between', ['2026-05-01', '2026-05-10']), ctx())).toBe(false);
  });
  it('on_day_of_week (Wednesday = 3)', () => {
    expect(evaluateCondition(leaf('date', 'on_day_of_week', 3), ctx())).toBe(true);
    expect(evaluateCondition(leaf('date', 'on_day_of_week', 0), ctx())).toBe(false);
  });
});

// ─── amount_sign / day_of_week / account_source_id ───────────

describe('evaluateCondition — eq/ne fields', () => {
  it('amount_sign', () => {
    expect(evaluateCondition(leaf('amount_sign', 'eq', 1), ctx())).toBe(true);
    expect(evaluateCondition(leaf('amount_sign', 'eq', -1), ctx())).toBe(false);
  });
  it('account_source_id', () => {
    expect(evaluateCondition(leaf('account_source_id', 'eq', 'acct-source-1'), ctx())).toBe(true);
    expect(evaluateCondition(leaf('account_source_id', 'ne', 'other'), ctx())).toBe(true);
  });
  it('day_of_week', () => {
    expect(evaluateCondition(leaf('day_of_week', 'eq', 3), ctx())).toBe(true);
  });
});

// ─── Group AND / OR ──────────────────────────────────────────

describe('evaluateCondition — AND/OR groups', () => {
  it('AND requires all children true', () => {
    const cond = group('AND',
      leaf('descriptor', 'contains', 'amazon'),
      leaf('amount', 'gt', 40),
    );
    expect(evaluateCondition(cond, ctx())).toBe(true);
  });
  it('AND fails if any child false', () => {
    const cond = group('AND',
      leaf('descriptor', 'contains', 'amazon'),
      leaf('amount', 'gt', 50),
    );
    expect(evaluateCondition(cond, ctx())).toBe(false);
  });
  it('OR returns true if any child true', () => {
    const cond = group('OR',
      leaf('descriptor', 'contains', 'walmart'),
      leaf('amount', 'gt', 40),
    );
    expect(evaluateCondition(cond, ctx())).toBe(true);
  });
  it('OR with all false returns false', () => {
    const cond = group('OR',
      leaf('descriptor', 'contains', 'walmart'),
      leaf('amount', 'gt', 100),
    );
    expect(evaluateCondition(cond, ctx())).toBe(false);
  });
  it('empty group returns false', () => {
    expect(evaluateCondition({ type: 'group', op: 'AND', children: [] }, ctx())).toBe(false);
  });
  it('nested groups', () => {
    // (descriptor contains "amazon") AND (amount > 40 OR amount_sign == -1)
    const cond = group('AND',
      leaf('descriptor', 'contains', 'amazon'),
      group('OR',
        leaf('amount', 'gt', 40),
        leaf('amount_sign', 'eq', -1),
      ),
    );
    expect(evaluateCondition(cond, ctx())).toBe(true);
  });
});

// ─── evaluateActions — flat list ─────────────────────────────

describe('evaluateActions — flat list', () => {
  it('returns the list as-is for simple Action[] input', () => {
    const actions: ActionsField = [
      { type: 'set_account', accountId: 'a1' },
      { type: 'set_memo', memo: 'foo' },
    ];
    expect(evaluateActions(actions, ctx())).toEqual(actions);
  });

  it('filters out deferred actions (set_class / set_location)', () => {
    const actions: ActionsField = [
      { type: 'set_account', accountId: 'a1' },
      { type: 'set_class', classId: 'c1' },
      { type: 'set_location', locationId: 'l1' },
    ];
    const out = evaluateActions(actions, ctx());
    expect(out.map((a) => a.type)).toEqual(['set_account']);
  });
});

// ─── evaluateActions — branching ─────────────────────────────

describe('evaluateActions — if/then/else', () => {
  it('runs THEN branch when if matches', () => {
    const actions: ActionsField = {
      if: leaf('descriptor', 'contains', 'amazon'),
      then: [{ type: 'set_account', accountId: 'office-supplies' }],
      else: [{ type: 'set_account', accountId: 'misc' }],
    };
    expect(evaluateActions(actions, ctx())).toEqual([{ type: 'set_account', accountId: 'office-supplies' }]);
  });

  it('runs ELSE branch when if fails', () => {
    const actions: ActionsField = {
      if: leaf('descriptor', 'contains', 'walmart'),
      then: [{ type: 'set_account', accountId: 'office-supplies' }],
      else: [{ type: 'set_account', accountId: 'misc' }],
    };
    expect(evaluateActions(actions, ctx())).toEqual([{ type: 'set_account', accountId: 'misc' }]);
  });

  it('runs ELIF branch when if fails but elif matches', () => {
    const actions: ActionsField = {
      if: leaf('descriptor', 'contains', 'walmart'),
      then: [{ type: 'set_account', accountId: 'walmart' }],
      elif: [
        { if: leaf('descriptor', 'contains', 'amazon'), then: [{ type: 'set_account', accountId: 'amazon-acct' }] },
      ],
      else: [{ type: 'set_account', accountId: 'misc' }],
    };
    expect(evaluateActions(actions, ctx())).toEqual([{ type: 'set_account', accountId: 'amazon-acct' }]);
  });

  it('returns empty when no branch matches and no else', () => {
    const actions: ActionsField = {
      if: leaf('descriptor', 'contains', 'walmart'),
      then: [{ type: 'set_account', accountId: 'a' }],
    };
    expect(evaluateActions(actions, ctx())).toEqual([]);
  });

  it('throws when nesting depth exceeds MAX_BRANCH_DEPTH', () => {
    // Build a branch nested 10 deep — exceeds MAX_BRANCH_DEPTH=5.
    let nested: ActionsField = [{ type: 'set_account', accountId: 'leaf' }];
    for (let i = 0; i < 10; i++) {
      nested = {
        if: leaf('amount', 'gt', 0),
        then: nested,
      };
    }
    expect(() => evaluateActions(nested, ctx())).toThrow(/depth/i);
  });
});

// ─── evaluateRule + evaluateRules ────────────────────────────

function rule(over: Partial<ConditionalRule> & { conditions: ConditionAST; actions: ActionsField; priority: number }): ConditionalRule {
  return {
    id: over.id ?? `rule-${over.priority}`,
    tenantId: 't1',
    companyId: null,
    name: over.name ?? `rule-${over.priority}`,
    priority: over.priority,
    conditions: over.conditions,
    actions: over.actions,
    continueAfterMatch: over.continueAfterMatch ?? false,
    active: over.active ?? true,
    createdBy: null,
    // 3-tier rules plan, Phase 2 — engine tests default every
    // synthetic rule to tenant_user scope to match the pre-tier
    // semantics. Tier-aware evaluator tests live in their own
    // file once Phase 4 lands.
    scope: over.scope ?? 'tenant_user',
    ownerUserId: over.ownerUserId ?? 'u1',
    ownerFirmId: over.ownerFirmId ?? null,
    forkedFromGlobalId: over.forkedFromGlobalId ?? null,
    createdAt: '2026-04-15T00:00:00.000Z',
    updatedAt: '2026-04-15T00:00:00.000Z',
  };
}

describe('evaluateRule', () => {
  it('returns matched=false when conditions fail', () => {
    const r = rule({
      priority: 100,
      conditions: leaf('descriptor', 'contains', 'walmart'),
      actions: [{ type: 'set_account', accountId: 'a' }],
    });
    const result = evaluateRule(r, ctx());
    expect(result.matched).toBe(false);
    expect(result.appliedActions).toEqual([]);
  });

  it('returns matched=true with applied actions when conditions pass', () => {
    const r = rule({
      priority: 100,
      conditions: leaf('descriptor', 'contains', 'amazon'),
      actions: [{ type: 'set_account', accountId: 'office' }],
    });
    const result = evaluateRule(r, ctx());
    expect(result.matched).toBe(true);
    expect(result.appliedActions).toEqual([{ type: 'set_account', accountId: 'office' }]);
  });
});

describe('evaluateRules — priority + continue_after_match', () => {
  it('returns first match only when continue_after_match=false', () => {
    const r1 = rule({ priority: 1, conditions: leaf('descriptor', 'contains', 'amazon'), actions: [{ type: 'set_account', accountId: 'a' }] });
    const r2 = rule({ priority: 2, conditions: leaf('amount', 'gt', 40), actions: [{ type: 'set_account', accountId: 'b' }] });
    const out = evaluateRules([r1, r2], ctx());
    expect(out).toHaveLength(1);
    expect(out[0]?.ruleId).toBe(r1.id);
  });

  it('continues to subsequent matches when continue_after_match=true', () => {
    const r1 = rule({ priority: 1, continueAfterMatch: true, conditions: leaf('descriptor', 'contains', 'amazon'), actions: [{ type: 'set_account', accountId: 'a' }] });
    const r2 = rule({ priority: 2, conditions: leaf('amount', 'gt', 40), actions: [{ type: 'set_tag', tagId: 't' }] });
    const out = evaluateRules([r1, r2], ctx());
    expect(out).toHaveLength(2);
  });

  it('skips non-matching rules when continuing', () => {
    const r1 = rule({ priority: 1, continueAfterMatch: true, conditions: leaf('descriptor', 'contains', 'amazon'), actions: [{ type: 'set_account', accountId: 'a' }] });
    const r2 = rule({ priority: 2, conditions: leaf('descriptor', 'contains', 'walmart'), actions: [{ type: 'set_tag', tagId: 't' }] });
    const r3 = rule({ priority: 3, conditions: leaf('amount', 'gt', 40), actions: [{ type: 'set_memo', memo: 'memo' }] });
    const out = evaluateRules([r1, r2, r3], ctx());
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.ruleId)).toEqual([r1.id, r3.id]);
  });

  it('returns empty when no rule matches', () => {
    const r = rule({ priority: 1, conditions: leaf('descriptor', 'contains', 'walmart'), actions: [{ type: 'set_account', accountId: 'a' }] });
    expect(evaluateRules([r], ctx())).toEqual([]);
  });
});

// ─── contextFromFeedItem ─────────────────────────────────────

describe('contextFromFeedItem', () => {
  it('builds a context from a feed item', () => {
    const c = contextFromFeedItem({
      description: 'Cleaned',
      originalDescription: 'AMZN MKTPLACE',
      amount: '-100.50',
      feedDate: '2026-04-15',
      bankConnectionAccountId: 'acct-1',
    });
    expect(c.descriptor).toBe('AMZN MKTPLACE');
    expect(c.amount).toBe(-100.5);
    expect(c.amount_sign).toBe(-1);
    expect(c.day_of_week).toBe(3);
  });

  it('falls back to description when originalDescription is missing', () => {
    const c = contextFromFeedItem({
      description: 'Fallback',
      originalDescription: null,
      amount: '0',
      feedDate: '2026-04-15',
      bankConnectionAccountId: 'acct-1',
    });
    expect(c.descriptor).toBe('Fallback');
    expect(c.amount_sign).toBe(0);
  });
});

// ─── Deferred fields/actions throw ───────────────────────────

describe('deferred features', () => {
  it('throws on class_id condition reference', () => {
    expect(() => evaluateCondition(leaf('class_id', 'eq', 'c1'), ctx())).toThrow(/not yet implemented/);
  });

  it('throws on location_id condition reference', () => {
    expect(() => evaluateCondition(leaf('location_id', 'eq', 'l1'), ctx())).toThrow(/not yet implemented/);
  });

  it('filters out set_class action without throwing', () => {
    const out = evaluateActions(
      [{ type: 'set_class', classId: 'c1' } as Action],
      ctx(),
    );
    expect(out).toEqual([]);
  });
});
