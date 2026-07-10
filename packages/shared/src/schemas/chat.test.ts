// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// M13(b): form_fields values are interpolated into the LLM prompt, so each
// value's serialized size is capped and the number of keys is bounded.

import { describe, it, expect } from 'vitest';
import { chatContextSchema } from './chat.js';

describe('chatContextSchema — form_fields size caps (M13)', () => {
  it('accepts normal-sized form fields', () => {
    const r = chatContextSchema.safeParse({
      form_fields: { amount: '100.00', memo: 'coffee', qty: 3, flag: true, nothing: null },
    });
    expect(r.success).toBe(true);
  });

  it('rejects a single oversized form-field value (> 2KB serialized)', () => {
    const r = chatContextSchema.safeParse({
      form_fields: { blob: 'x'.repeat(4000) },
    });
    expect(r.success).toBe(false);
  });

  it('rejects more than 50 form-field keys', () => {
    const many: Record<string, unknown> = {};
    for (let i = 0; i < 51; i++) many[`k${i}`] = i;
    const r = chatContextSchema.safeParse({ form_fields: many });
    expect(r.success).toBe(false);
  });

  it('accepts exactly 50 keys with small values', () => {
    const fifty: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) fifty[`k${i}`] = `v${i}`;
    const r = chatContextSchema.safeParse({ form_fields: fifty });
    expect(r.success).toBe(true);
  });
});
