// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { conditionAstSchema } from './conditional-rules.js';

function leaf(operator: string, value: unknown) {
  return { type: 'leaf', field: 'descriptor', operator, value };
}

describe('conditionAstSchema — empty match values', () => {
  // A blank needle turns `contains` into a catch-all that matches every
  // transaction and short-circuits the rest of the rule list (this bit
  // Shri Krishna LLC in prod, 2026-07-21). Reject on save.
  it.each(['contains', 'not_contains', 'starts_with', 'not_starts_with', 'ends_with', 'not_ends_with', 'matches_regex', 'not_matches_regex'])(
    'rejects %s with an empty value',
    (op) => {
      expect(conditionAstSchema.safeParse(leaf(op, '')).success).toBe(false);
    },
  );
  it('rejects contains with a missing value', () => {
    expect(conditionAstSchema.safeParse(leaf('contains', undefined)).success).toBe(false);
    expect(conditionAstSchema.safeParse(leaf('contains', null)).success).toBe(false);
  });
  it('accepts contains with a real value', () => {
    expect(conditionAstSchema.safeParse(leaf('contains', 'AMAZON')).success).toBe(true);
  });
  it('still allows equals/not_equals against the empty string', () => {
    expect(conditionAstSchema.safeParse(leaf('equals', '')).success).toBe(true);
    expect(conditionAstSchema.safeParse(leaf('not_equals', '')).success).toBe(true);
  });
  it('rejects an empty value inside a nested group', () => {
    const ast = {
      type: 'group',
      op: 'AND',
      children: [
        { type: 'group', op: 'OR', children: [leaf('contains', '')] },
      ],
    };
    expect(conditionAstSchema.safeParse(ast).success).toBe(false);
  });
});
