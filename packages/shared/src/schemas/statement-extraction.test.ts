// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { StatementExtractionResult, StatementExtractionJsonSchema } from './statement-extraction.js';

describe('StatementExtractionResult', () => {
  it('parses a minimal valid result and applies defaults', () => {
    const r = StatementExtractionResult.parse({ transactions: [] });
    expect(r.transactions).toEqual([]);
    expect(r.account).toEqual({});
    expect(r.balances).toEqual({});
    expect(r.source_date_format.format).toBe('AMBIGUOUS');
  });

  it('keeps signed amount_cents and normalizes null trntype to undefined', () => {
    const r = StatementExtractionResult.parse({
      balances: { opening_cents: 100_00, closing_cents: 70_00 },
      period: { start: '2026-01-01', end: '2026-01-31' },
      transactions: [
        { posted_date: '2026-01-05', description: 'ATM withdrawal', amount_cents: -30_00, trntype: null, source_page: 1 },
        { posted_date: '2026-01-09', description: 'Deposit', amount_cents: 0, source_page: 1 },
      ],
    });
    expect(r.transactions[0]!.amount_cents).toBe(-30_00);
    expect(r.transactions[0]!.trntype).toBeUndefined();
    expect(r.balances.opening_cents).toBe(100_00);
  });

  it('rejects a non-integer amount_cents', () => {
    const parsed = StatementExtractionResult.safeParse({
      transactions: [{ posted_date: '2026-01-05', description: 'x', amount_cents: 12.5 }],
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a malformed posted_date', () => {
    const parsed = StatementExtractionResult.safeParse({
      transactions: [{ posted_date: '01/05/2026', description: 'x', amount_cents: 100 }],
    });
    expect(parsed.success).toBe(false);
  });

  it('exposes a JSON schema requiring transactions', () => {
    expect(StatementExtractionJsonSchema.required).toContain('transactions');
    expect(StatementExtractionJsonSchema.properties.transactions.type).toBe('array');
  });
});
