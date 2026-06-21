// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { validateExtractedPage, checkCrossPageConsistency } from './validate.js';

const T = 0.85;

describe('validateExtractedPage — gating', () => {
  it('passes a clean, high-confidence bank statement page', () => {
    const res = validateExtractedPage(
      'bank_statement',
      {
        page_confidence: 0.95,
        transactions: [
          { date: '2026-01-02', description: 'ACME', amount: 12.5, type: 'debit', balance: 100, confidence: 0.95 },
        ],
      },
      { threshold: T },
    );
    expect(res.ok).toBe(true);
    expect(res.reasons).toEqual([]);
    expect(res.minConfidence).toBe(0.95);
  });

  it('flags a page whose page_confidence is below threshold', () => {
    const res = validateExtractedPage(
      'bank_statement',
      { page_confidence: 0.4, transactions: [] },
      { threshold: T },
    );
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain('low_page_confidence');
  });

  it('flags a row whose confidence is below threshold', () => {
    const res = validateExtractedPage(
      'bank_statement',
      {
        page_confidence: 0.95,
        transactions: [{ date: '2026-01-02', description: 'X', amount: 5, type: 'debit', confidence: 0.4 }],
      },
      { threshold: T },
    );
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain('low_row_confidence');
  });

  it('returns schema_parse_failed (not ok) on garbage', () => {
    const res = validateExtractedPage('bank_statement', 'not json', { threshold: T });
    expect(res.ok).toBe(false);
    expect(res.reasons).toEqual(['schema_parse_failed']);
  });
});

describe('validateExtractedPage — arithmetic', () => {
  it('flags an invoice whose subtotal+tax != total', () => {
    const res = validateExtractedPage(
      'invoice',
      { page_confidence: 0.99, vendor: 'A', invoice_no: '1', date: null, due_date: null, subtotal: 100, tax: 7, total: 200, confidence: 0.99 },
      { threshold: T },
    );
    expect(res.ok).toBe(false);
    expect(res.reasons).toContain('invoice_total_mismatch');
  });

  it('flags a receipt where tax exceeds total', () => {
    const res = validateExtractedPage(
      'receipt',
      { page_confidence: 0.99, merchant: 'A', date: null, total: 10, tax: 99, confidence: 0.99 },
      { threshold: T },
    );
    expect(res.reasons).toContain('receipt_tax_exceeds_total');
  });
});

describe('validateExtractedPage — PII masking at rest', () => {
  it('masks a W-2 employee TIN to last 4', () => {
    const res = validateExtractedPage(
      'w2',
      { page_confidence: 0.99, employer: 'A', employee_tin_masked: '123-45-6789', boxes: {}, confidence: 0.99 },
      { threshold: T },
    );
    expect((res.payload as Record<string, unknown>)['employee_tin_masked']).toBe('***-**-6789');
  });

  it('masks long digit runs (account numbers) in bank descriptions', () => {
    const res = validateExtractedPage(
      'bank_statement',
      { page_confidence: 0.95, transactions: [{ date: '2026-01-02', description: 'XFER 12345678901', amount: 5, type: 'debit', confidence: 0.95 }] },
      { threshold: T },
    );
    const txns = (res.payload as { transactions: Array<{ description: string }> }).transactions;
    expect(txns[0]!.description).toBe('XFER ****8901');
  });
});

describe('checkCrossPageConsistency', () => {
  it('detects a duplicate transaction across page boundaries', () => {
    const dup = { date: '2026-01-02', description: 'ACME', amount: 5, type: 'debit' };
    const reasons = checkCrossPageConsistency('bank_statement', [
      { transactions: [dup] },
      { transactions: [dup] },
    ]);
    expect(reasons).toContain('bank_duplicate_txn_across_pages');
  });

  it('detects a running-balance break', () => {
    const reasons = checkCrossPageConsistency('bank_statement', [
      {
        transactions: [
          { date: '2026-01-01', description: 'a', amount: 10, type: 'credit', balance: 110 },
          { date: '2026-01-02', description: 'b', amount: 10, type: 'debit', balance: 999 }, // should be 100
        ],
      },
    ]);
    expect(reasons).toContain('bank_running_balance_break');
  });

  it('is a no-op for non-bank docTypes', () => {
    expect(checkCrossPageConsistency('invoice', [{}])).toEqual([]);
  });

  it('flags opening + net != closing (statement-level reconciliation)', () => {
    // opening 100, +50 credit, -30 debit → should close at 120, not 200.
    const reasons = checkCrossPageConsistency('bank_statement', [
      { opening_balance: 100, transactions: [{ date: '2026-01-01', description: 'a', amount: 50, type: 'credit' }] },
      { closing_balance: 200, transactions: [{ date: '2026-01-02', description: 'b', amount: 30, type: 'debit' }] },
    ]);
    expect(reasons).toContain('bank_opening_closing_mismatch');
  });

  it('passes a reconciled statement (opening + net == closing)', () => {
    const reasons = checkCrossPageConsistency('bank_statement', [
      { opening_balance: 100, transactions: [{ date: '2026-01-01', description: 'a', amount: 50, type: 'credit' }] },
      { closing_balance: 120, transactions: [{ date: '2026-01-02', description: 'b', amount: 30, type: 'debit' }] },
    ]);
    expect(reasons).not.toContain('bank_opening_closing_mismatch');
  });

  it('skips reconciliation when header balances are absent', () => {
    const reasons = checkCrossPageConsistency('bank_statement', [
      { transactions: [{ date: '2026-01-01', description: 'a', amount: 50, type: 'credit' }] },
    ]);
    expect(reasons).not.toContain('bank_opening_closing_mismatch');
  });
});
