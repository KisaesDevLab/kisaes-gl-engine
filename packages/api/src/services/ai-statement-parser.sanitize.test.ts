// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// sanitizeExtraction hardens the raw model JSON so one bad row (null amount,
// bad date) or an over-long notes doesn't fail the whole statement parse.

import { describe, it, expect } from 'vitest';
import { StatementExtractionResult } from '@kis-books/shared';
import { sanitizeExtraction } from './ai-statement-parser.service.js';

function tx(over: Record<string, unknown>) {
  return { posted_date: '2026-02-01', description: 'ACME', amount_cents: 1000, ...over };
}

describe('sanitizeExtraction', () => {
  it('drops rows with a null amount and keeps valid ones, then validates', () => {
    const raw = {
      transactions: [
        tx({ amount_cents: 1500 }),
        tx({ amount_cents: null }), // running-balance-only / unreadable
        tx({ amount_cents: -250 }),
        tx({ amount_cents: null }),
      ],
    };
    const cleaned = sanitizeExtraction(raw) as { transactions: unknown[]; notes: string };
    expect(cleaned.transactions.length).toBe(2);
    expect(cleaned.notes).toMatch(/2 unreadable row\(s\) were skipped/);
    // The cleaned object now passes the strict schema.
    const parsed = StatementExtractionResult.parse(cleaned);
    expect(parsed.transactions).toHaveLength(2);
  });

  it('coerces a numeric-string amount rather than dropping it', () => {
    const raw = { transactions: [tx({ amount_cents: '12,345' }), tx({ amount_cents: '-6789' })] };
    const cleaned = sanitizeExtraction(raw) as { transactions: Array<{ amount_cents: number }> };
    expect(cleaned.transactions).toHaveLength(2);
    expect(cleaned.transactions[0]!.amount_cents).toBe(12345);
    expect(cleaned.transactions[1]!.amount_cents).toBe(-6789);
  });

  it('truncates over-long notes to 2000 chars', () => {
    const raw = { transactions: [tx({})], notes: 'x'.repeat(5000) };
    const cleaned = sanitizeExtraction(raw) as { notes: string };
    expect(cleaned.notes.length).toBe(2000);
    expect(() => StatementExtractionResult.parse(cleaned)).not.toThrow();
  });

  it('drops a row with a malformed date too (any invalid row)', () => {
    const raw = { transactions: [tx({}), tx({ posted_date: 'Feb 2' })] };
    const cleaned = sanitizeExtraction(raw) as { transactions: unknown[] };
    expect(cleaned.transactions).toHaveLength(1);
  });
});
