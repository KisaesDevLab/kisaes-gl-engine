// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Learned history is keyed on the cleaned bank description, and a cheque's
// description cleans to "check" — the same key for every cheque a client
// ever wrote. One confirmation therefore taught the system that every future
// cheque went to that payee, and the wrong name then sat on rows the
// statement importer would have filled in correctly. Reported from
// production, where an account's cheques all read "Benton County Sheriff
// Office" and one tenant had 4,964 confirmations against "deposit".

import { describe, it, expect } from 'vitest';
import { isIdentifyingPattern, normalizePayeePattern } from './categorization-ai.service.js';

describe('isIdentifyingPattern', () => {
  it('rejects the words a bank prints that name nobody', () => {
    for (const p of [
      'check', 'checks', 'cheque', 'deposit', 'deposits', 'withdrawal',
      'transfer', 'payment', 'pay', 'debit', 'credit', 'ach', 'eft', 'pos',
      'atm', 'fee', 'interest', 'draft', 'misc', 'other',
    ]) {
      expect(isIdentifyingPattern(p), p).toBe(false);
    }
  });

  it('rejects a key made only of those words, however punctuated', () => {
    expect(isIdentifyingPattern('check #')).toBe(false);
    expect(isIdentifyingPattern('check 3662')).toBe(false);
    expect(isIdentifyingPattern('ach debit')).toBe(false);
    expect(isIdentifyingPattern('pos purchase')).toBe(false);
    expect(isIdentifyingPattern('check card purchase')).toBe(false);
  });

  it('rejects a key with no name in it at all', () => {
    expect(isIdentifyingPattern('')).toBe(false);
    expect(isIdentifyingPattern('   ')).toBe(false);
    expect(isIdentifyingPattern('3662')).toBe(false);
    expect(isIdentifyingPattern('#3662')).toBe(false);
    expect(isIdentifyingPattern(null)).toBe(false);
  });

  it('rejects a card mask', () => {
    expect(isIdentifyingPattern('xx1419')).toBe(false);
    expect(isIdentifyingPattern('****1419')).toBe(false);
    expect(isIdentifyingPattern('x 1419')).toBe(false);
  });

  it('keeps anything that actually names someone', () => {
    for (const p of [
      'walmart', 'amazon', 'benton county sheriff office', 'jim bass electric',
      'city of monett', 'check to rollo insurance', 'ach payment tractor supply',
      'pos purchase casey s general', 'xx1419 shell oil',
    ]) {
      expect(isIdentifyingPattern(p), p).toBe(true);
    }
  });

  it('is what a cheque description actually reduces to', () => {
    // The whole reason this guard exists: every cheque shares one key.
    expect(normalizePayeePattern('CHECK 3662')).toBe(normalizePayeePattern('CHECK 3584'));
    expect(isIdentifyingPattern(normalizePayeePattern('CHECK 3662'))).toBe(false);
  });
});
