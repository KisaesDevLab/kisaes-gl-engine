// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// M5: model outputs (receipt / bill) are schema-validated before any DB write.
// A structurally-wrong reply must fail honestly as `ai_parse_failed` rather
// than being coerced into a partial/garbage record.
// LOW: confidence coercion keeps an honest 0 as 0 instead of `|| 0.5`.

import { describe, it, expect } from 'vitest';
import { validateModelOutput } from './ai-providers/json-utils.js';
import { receiptOcrOutputSchema, coerceConfidence } from './ai-receipt-ocr.service.js';
import { billOcrOutputSchema } from './ai-bill-ocr.service.js';
import { AppError } from '../utils/errors.js';

describe('M5 — model output schema validation', () => {
  it('accepts a well-formed receipt reply (string OR number money)', () => {
    const out = validateModelOutput(receiptOcrOutputSchema, {
      vendor: 'Blue Bottle',
      date: '2026-06-01',
      total: '12.50',
      tax: 1.02,
      line_items: [{ description: 'Latte', amount: '5.00', quantity: 1 }],
      confidence: 0.9,
    }, 'receipt extraction');
    expect(out.vendor).toBe('Blue Bottle');
    expect(out.line_items?.[0]?.description).toBe('Latte');
  });

  it('rejects a receipt reply whose top level is an array', () => {
    try {
      validateModelOutput(receiptOcrOutputSchema, [{ vendor: 'x' }], 'receipt extraction');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('ai_parse_failed');
    }
  });

  it('rejects a receipt reply where line_items is not an array', () => {
    expect(() =>
      validateModelOutput(receiptOcrOutputSchema, { vendor: 'x', line_items: 'nope' }, 'receipt extraction'),
    ).toThrow(/ai_parse_failed|validation/i);
  });

  it('rejects a bill reply where a line item is a bare string', () => {
    try {
      validateModelOutput(billOcrOutputSchema, { vendor: 'ACME', line_items: ['just a string'] }, 'bill extraction');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('ai_parse_failed');
    }
  });

  it('accepts a well-formed bill reply', () => {
    const out = validateModelOutput(billOcrOutputSchema, {
      vendor: 'ACME',
      total: '100.00',
      confidence: '0.8',
    }, 'bill extraction');
    expect(out.vendor).toBe('ACME');
  });
});

describe('LOW — confidence coercion keeps 0 as 0', () => {
  it('keeps an honest 0', () => {
    expect(coerceConfidence(0, 0.5)).toBe(0);
  });
  it('parses a numeric string', () => {
    expect(coerceConfidence('0.42', 0.5)).toBeCloseTo(0.42);
    expect(coerceConfidence('0', 0.5)).toBe(0);
  });
  it('falls back only when genuinely absent / non-numeric', () => {
    expect(coerceConfidence(undefined, 0.5)).toBe(0.5);
    expect(coerceConfidence(null, 0.5)).toBe(0.5);
    expect(coerceConfidence('not a number', 0.5)).toBe(0.5);
  });
});
