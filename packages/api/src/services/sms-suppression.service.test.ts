// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import { classifyInboundBody, normalizePhone } from './sms-suppression.service.js';

// DOC_REQUEST_SMS_V1 — pure-helper unit tests. The DB-touching paths
// (applyStopKeyword, applyStartKeyword) are covered by integration
// tests against a real Postgres in CI.

describe('sms-suppression — pure helpers', () => {
  describe('classifyInboundBody', () => {
    it.each([
      ['STOP', 'stop'],
      ['stop', 'stop'],
      ['  Stop ', 'stop'],
      ['UNSUBSCRIBE', 'stop'],
      ['CANCEL', 'stop'],
      ['QUIT', 'stop'],
      ['END', 'stop'],
      ['OPTOUT', 'stop'],
      ['START', 'start'],
      ['unstop', 'start'],
      ['YES', 'start'],
      ['hello', 'none'],
      ['I have the statement ready', 'none'],
      ['', 'none'],
    ])('classifies %s → %s', (input, expected) => {
      expect(classifyInboundBody(input)).toBe(expected);
    });
  });

  describe('normalizePhone', () => {
    it('strips non-digits and a leading 1 for NANP numbers', () => {
      expect(normalizePhone('+1 (312) 555-1234')).toBe('3125551234');
      expect(normalizePhone('+13125551234')).toBe('3125551234');
      expect(normalizePhone('312-555-1234')).toBe('3125551234');
      expect(normalizePhone('312.555.1234')).toBe('3125551234');
    });

    it('preserves a non-NANP number with country code 1 in a different position', () => {
      // 12 digits → not stripped (not NANP-shaped).
      expect(normalizePhone('441234567890')).toBe('441234567890');
    });

    it('returns empty for non-numeric input', () => {
      expect(normalizePhone('abc')).toBe('');
      expect(normalizePhone('')).toBe('');
    });
  });
});
