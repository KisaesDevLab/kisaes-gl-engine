// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  resultSchemaFor,
  bankStatementResultSchema,
  invoiceResultSchema,
  DOC_TYPES,
  DOC_TYPE_RESULT_SCHEMAS,
} from './extraction.js';

describe('extraction result schemas', () => {
  it('exposes a schema for every docType', () => {
    for (const dt of DOC_TYPES) {
      expect(DOC_TYPE_RESULT_SCHEMAS[dt]).toBeDefined();
      expect(resultSchemaFor(dt)).toBe(DOC_TYPE_RESULT_SCHEMAS[dt]);
    }
  });

  it('coerces messy model numbers and clamps confidence', () => {
    const parsed = bankStatementResultSchema.parse({
      page_confidence: 1.7, // out of range → clamped to 1
      transactions: [
        { date: '2026-01-02', description: 'ACME', amount: '$1,234.56', type: 'debit', balance: '2,000' },
        { date: null, description: null, amount: '', type: null }, // unreadable row
      ],
    });
    expect(parsed.page_confidence).toBe(1);
    expect(parsed.transactions[0]!.amount).toBe(1234.56);
    expect(parsed.transactions[0]!.balance).toBe(2000);
    expect(parsed.transactions[1]!.amount).toBeNull();
  });

  it('defaults missing/garbled confidence to 0 (fail-safe → review)', () => {
    const parsed = invoiceResultSchema.parse({
      page_confidence: 'not-a-number',
      vendor: 'ACME',
      invoice_no: null,
      date: null,
      due_date: null,
      subtotal: 100,
      tax: 7,
      total: 107,
    });
    expect(parsed.page_confidence).toBe(0);
    expect(parsed.line_items).toEqual([]);
  });

  it('rejects a non-object payload', () => {
    expect(() => bankStatementResultSchema.parse('not json')).toThrow();
  });
});
