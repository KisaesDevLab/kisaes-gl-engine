// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  RECOVERY_KEY_PREFIX,
  RECOVERY_KEY_ALPHABET,
  generateRecoveryKey,
  formatRecoveryKey,
  parseRecoveryKey,
  recoveryKeyToPassphrase,
} from './recovery-key.service.js';

describe('recovery-key.service', () => {
  describe('alphabet', () => {
    it('has 31 characters', () => {
      expect(RECOVERY_KEY_ALPHABET.length).toBe(31);
    });

    it('excludes ambiguous characters 0 O 1 I L', () => {
      expect(RECOVERY_KEY_ALPHABET).not.toContain('0');
      expect(RECOVERY_KEY_ALPHABET).not.toContain('O');
      expect(RECOVERY_KEY_ALPHABET).not.toContain('1');
      expect(RECOVERY_KEY_ALPHABET).not.toContain('I');
      expect(RECOVERY_KEY_ALPHABET).not.toContain('L');
    });
  });

  describe('generateRecoveryKey', () => {
    it('returns a key in the canonical format', () => {
      const key = generateRecoveryKey();
      expect(key).toMatch(/^RKVMB-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    });

    it('uses only the allowed alphabet', () => {
      const key = generateRecoveryKey();
      const payload = key.slice(RECOVERY_KEY_PREFIX.length + 1).replace(/-/g, '');
      for (const ch of payload) {
        expect(RECOVERY_KEY_ALPHABET).toContain(ch);
      }
    });

    it('produces distinct values on repeated calls', () => {
      const a = generateRecoveryKey();
      const b = generateRecoveryKey();
      const c = generateRecoveryKey();
      expect(new Set([a, b, c]).size).toBe(3);
    });
  });

  describe('formatRecoveryKey', () => {
    it('inserts dashes every 5 characters', () => {
      const formatted = formatRecoveryKey('ABCDEFGHJKMNPQRSTUVWXYZ23');
      expect(formatted).toBe('RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23');
    });

    it('throws on wrong length', () => {
      expect(() => formatRecoveryKey('TOO_SHORT')).toThrow();
      expect(() => formatRecoveryKey('A'.repeat(30))).toThrow();
    });
  });

  describe('parseRecoveryKey', () => {
    it('accepts the canonical form', () => {
      const key = 'RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23';
      expect(parseRecoveryKey(key)).toBe(key);
    });

    it('is case-insensitive', () => {
      expect(parseRecoveryKey('rkvmb-abcde-fghjk-mnpqr-stuvw-xyz23')).toBe('RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23');
    });

    it('ignores extra whitespace', () => {
      expect(parseRecoveryKey('  RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23  ')).toBe('RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23');
    });

    it('accepts keys without dashes', () => {
      expect(parseRecoveryKey('RKVMBABCDEFGHJKMNPQRSTUVWXYZ23')).toBe('RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23');
    });

    it('accepts keys without the RKVMB prefix when payload is already 25 chars', () => {
      expect(parseRecoveryKey('ABCDE-FGHJK-MNPQR-STUVW-XYZ23')).toBe('RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23');
    });

    it('rejects invalid characters', () => {
      // `0` and `1` are not in the alphabet
      expect(() => parseRecoveryKey('RKVMB-ABCDE-FGHJK-MNPQR-STUV0-XYZ23')).toThrow();
      expect(() => parseRecoveryKey('RKVMB-ABCDE-FGHJK-MNPQR-STUV1-XYZ23')).toThrow();
    });

    it('rejects empty input', () => {
      expect(() => parseRecoveryKey('')).toThrow();
    });

    it('rejects wrong length', () => {
      expect(() => parseRecoveryKey('RKVMB-ABCDE')).toThrow();
    });

    it('round-trips with generateRecoveryKey', () => {
      const generated = generateRecoveryKey();
      expect(parseRecoveryKey(generated)).toBe(generated);
    });
  });

  describe('recoveryKeyToPassphrase', () => {
    it('strips dashes and uppercases', () => {
      expect(recoveryKeyToPassphrase('RKVMB-ABCDE-FGHJK-MNPQR-STUVW-XYZ23')).toBe('RKVMBABCDEFGHJKMNPQRSTUVWXYZ23');
    });

    it('is deterministic', () => {
      const key = generateRecoveryKey();
      expect(recoveryKeyToPassphrase(key)).toBe(recoveryKeyToPassphrase(key));
    });
  });
});
