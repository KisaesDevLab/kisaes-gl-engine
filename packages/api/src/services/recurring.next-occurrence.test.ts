// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// calculateNextOccurrence advances a schedule's next date by its cadence.
// Covers the added bi-weekly (every 14 days) and semi-monthly (1st & 15th)
// frequencies alongside the existing ones, and the UTC/month-length edges.

import { describe, it, expect } from 'vitest';
import { calculateNextOccurrence } from './recurring.service.js';

describe('calculateNextOccurrence', () => {
  it('daily / weekly / monthly / quarterly / annually honor the interval', () => {
    expect(calculateNextOccurrence('2026-06-15', 'daily', 1)).toBe('2026-06-16');
    expect(calculateNextOccurrence('2026-06-15', 'daily', 3)).toBe('2026-06-18');
    expect(calculateNextOccurrence('2026-06-15', 'weekly', 1)).toBe('2026-06-22');
    expect(calculateNextOccurrence('2026-06-15', 'weekly', 2)).toBe('2026-06-29');
    expect(calculateNextOccurrence('2026-06-15', 'monthly', 1)).toBe('2026-07-15');
    expect(calculateNextOccurrence('2026-06-15', 'quarterly', 1)).toBe('2026-09-15');
    expect(calculateNextOccurrence('2026-06-15', 'annually', 1)).toBe('2027-06-15');
  });

  describe('bi-weekly', () => {
    it('advances 14 days', () => {
      expect(calculateNextOccurrence('2026-06-15', 'biweekly', 1)).toBe('2026-06-29');
    });
    it('crosses a month boundary', () => {
      expect(calculateNextOccurrence('2026-06-25', 'biweekly', 1)).toBe('2026-07-09');
    });
    it('interval multiplies the two-week step (every 4 weeks)', () => {
      expect(calculateNextOccurrence('2026-06-15', 'biweekly', 2)).toBe('2026-07-13');
    });
  });

  describe('semi-monthly (1st & 15th)', () => {
    it('before the 15th → the 15th of the same month', () => {
      expect(calculateNextOccurrence('2026-06-01', 'semimonthly', 1)).toBe('2026-06-15');
      expect(calculateNextOccurrence('2026-06-10', 'semimonthly', 1)).toBe('2026-06-15');
    });
    it('on/after the 15th → the 1st of the next month', () => {
      expect(calculateNextOccurrence('2026-06-15', 'semimonthly', 1)).toBe('2026-07-01');
      expect(calculateNextOccurrence('2026-06-28', 'semimonthly', 1)).toBe('2026-07-01');
    });
    it('rolls the year at December', () => {
      expect(calculateNextOccurrence('2026-12-20', 'semimonthly', 1)).toBe('2027-01-01');
    });
    it('cycles 1st ↔ 15th and ignores the interval', () => {
      const a = calculateNextOccurrence('2026-02-15', 'semimonthly', 9); // interval ignored
      expect(a).toBe('2026-03-01');
      const b = calculateNextOccurrence(a, 'semimonthly', 1);
      expect(b).toBe('2026-03-15');
      const c = calculateNextOccurrence(b, 'semimonthly', 1);
      expect(c).toBe('2026-04-01');
    });
  });

  it('an unknown frequency falls back to monthly', () => {
    expect(calculateNextOccurrence('2026-06-15', 'nonsense', 1)).toBe('2026-07-15');
  });
});
