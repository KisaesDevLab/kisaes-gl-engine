// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  CRON_LAST_BUSINESS_DAY,
  computeFirstIssueAt,
  computeNextIssueAt,
  cronNext,
  isValidCronExpression,
  periodLabelFor,
} from './recurring-doc-request.service.js';

// RECURRING_DOC_REQUESTS_V1 — pure-function unit tests. The DB-touching
// branches (issueOne, listRules, etc.) are covered by integration tests
// against a real Postgres in the CI test runner.

describe('recurring-doc-request — calendar arithmetic', () => {
  describe('computeNextIssueAt', () => {
    it('advances monthly with day-of-month preserved', () => {
      const prev = new Date(Date.UTC(2026, 3, 3, 9, 0, 0)); // April 3
      const next = computeNextIssueAt(prev, 'monthly', 1, 3);
      expect(next.getUTCFullYear()).toBe(2026);
      expect(next.getUTCMonth()).toBe(4); // May
      expect(next.getUTCDate()).toBe(3);
    });

    it('clamps day=31 to February (28 or 29)', () => {
      // January 31 → February 28 (2026 is not a leap year).
      const jan = new Date(Date.UTC(2026, 0, 31, 9, 0, 0));
      const feb = computeNextIssueAt(jan, 'monthly', 1, 31);
      expect(feb.getUTCMonth()).toBe(1); // February
      expect(feb.getUTCDate()).toBeLessThanOrEqual(29);
    });

    it('clamps day=29 in February of a non-leap year', () => {
      const jan = new Date(Date.UTC(2027, 0, 29, 9, 0, 0));
      const feb = computeNextIssueAt(jan, 'monthly', 1, 29);
      expect(feb.getUTCMonth()).toBe(1);
      expect(feb.getUTCDate()).toBe(28); // 2027 is not leap
    });

    it('crosses year boundary cleanly', () => {
      const dec = new Date(Date.UTC(2026, 11, 15, 9, 0, 0));
      const jan = computeNextIssueAt(dec, 'monthly', 1, 15);
      expect(jan.getUTCFullYear()).toBe(2027);
      expect(jan.getUTCMonth()).toBe(0);
      expect(jan.getUTCDate()).toBe(15);
    });

    it('quarterly adds 3 × interval months', () => {
      const apr = new Date(Date.UTC(2026, 3, 1, 9, 0, 0));
      const next = computeNextIssueAt(apr, 'quarterly', 1, 1);
      expect(next.getUTCMonth()).toBe(6); // July
    });

    it('annually adds intervalValue years', () => {
      const apr = new Date(Date.UTC(2026, 3, 1, 9, 0, 0));
      const next = computeNextIssueAt(apr, 'annually', 1, null);
      expect(next.getUTCFullYear()).toBe(2027);
      expect(next.getUTCMonth()).toBe(3);
      expect(next.getUTCDate()).toBe(1);
    });

    it('keeps a fixed UTC hour across DST boundaries', () => {
      // Spring-forward weekend in the US: late March 2026.
      // The math is in UTC, so the hour stays 09:00 either side.
      const mar = new Date(Date.UTC(2026, 2, 8, 9, 0, 0));
      const apr = computeNextIssueAt(mar, 'monthly', 1, 8);
      expect(apr.getUTCHours()).toBe(9);
    });
  });

  describe('computeFirstIssueAt', () => {
    it('returns explicit startAt when in the future', () => {
      const now = new Date(Date.UTC(2026, 3, 26, 12, 0, 0));
      const start = new Date(Date.UTC(2026, 4, 3, 9, 0, 0));
      const out = computeFirstIssueAt(now, 'monthly', 1, 3, start);
      expect(out.getTime()).toBe(start.getTime());
    });

    it('jumps to the next month when day-of-month has already passed', () => {
      // Today is April 26; rule asks for day 3 monthly. First fire = May 3.
      const now = new Date(Date.UTC(2026, 3, 26, 12, 0, 0));
      const out = computeFirstIssueAt(now, 'monthly', 1, 3, undefined);
      expect(out.getUTCMonth()).toBe(4); // May
      expect(out.getUTCDate()).toBe(3);
    });

    it('uses the current month when day-of-month is still in the future', () => {
      const now = new Date(Date.UTC(2026, 3, 1, 12, 0, 0));
      const out = computeFirstIssueAt(now, 'monthly', 1, 15, undefined);
      expect(out.getUTCMonth()).toBe(3); // April
      expect(out.getUTCDate()).toBe(15);
    });
  });

  describe('periodLabelFor', () => {
    it('formats monthly as YYYY-MM', () => {
      expect(periodLabelFor(new Date(Date.UTC(2026, 3, 3, 9, 0, 0)), 'monthly')).toBe('2026-04');
      expect(periodLabelFor(new Date(Date.UTC(2026, 11, 31, 9, 0, 0)), 'monthly')).toBe('2026-12');
    });

    it('formats quarterly as YYYY-Qn', () => {
      expect(periodLabelFor(new Date(Date.UTC(2026, 0, 1, 9, 0, 0)), 'quarterly')).toBe('2026-Q1');
      expect(periodLabelFor(new Date(Date.UTC(2026, 3, 1, 9, 0, 0)), 'quarterly')).toBe('2026-Q2');
      expect(periodLabelFor(new Date(Date.UTC(2026, 8, 1, 9, 0, 0)), 'quarterly')).toBe('2026-Q3');
      expect(periodLabelFor(new Date(Date.UTC(2026, 11, 31, 9, 0, 0)), 'quarterly')).toBe('2026-Q4');
    });

    it('formats annually as YYYY', () => {
      expect(periodLabelFor(new Date(Date.UTC(2026, 5, 15, 9, 0, 0)), 'annually')).toBe('2026');
    });
  });

  // RECURRING_CRON_V1 — cron parsing + named-preset arithmetic.

  describe('isValidCronExpression', () => {
    it('accepts standard 5-field expressions', () => {
      expect(isValidCronExpression('0 9 * * 5').ok).toBe(true);
      expect(isValidCronExpression('0 9 * * 1-5').ok).toBe(true);
    });

    it('accepts the named last-business-day preset sentinel', () => {
      expect(isValidCronExpression(CRON_LAST_BUSINESS_DAY).ok).toBe(true);
    });

    it('rejects empty input', () => {
      const r = isValidCronExpression('');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/empty/i);
    });

    it('rejects malformed expressions', () => {
      expect(isValidCronExpression('not a cron').ok).toBe(false);
    });

    it('rejects expressions with multi-year gaps as a foot-gun', () => {
      // "every Feb 29" — fires once every 4 years, blocked by the gap guard.
      const r = isValidCronExpression('0 0 29 2 *');
      expect(r.ok).toBe(false);
    });
  });

  describe('cronNext', () => {
    it('returns the next firing for "every Friday at 9 a.m."', () => {
      const monday = new Date(Date.UTC(2026, 3, 27, 12, 0, 0)); // 2026-04-27 Mon
      const next = cronNext('0 9 * * 5', 'UTC', monday);
      // Next Friday = 2026-05-01.
      expect(next.getUTCDay()).toBe(5);
      expect(next.getUTCDate()).toBe(1);
      expect(next.getUTCMonth()).toBe(4); // May
      expect(next.getUTCHours()).toBe(9);
    });

    it('alternates correctly across multiple firings (weekly Friday)', () => {
      let cursor = new Date(Date.UTC(2026, 3, 27, 12, 0, 0));
      const seen: number[] = [];
      for (let i = 0; i < 4; i++) {
        cursor = cronNext('0 9 * * 5', 'UTC', cursor);
        seen.push(cursor.getUTCDay());
      }
      expect(seen).toEqual([5, 5, 5, 5]);
    });

    it('honors the named "last business day of month" preset', () => {
      // April 2026 — last day is the 30th (Thu); should fire then.
      const start = new Date(Date.UTC(2026, 3, 1, 12, 0, 0));
      const next = cronNext(CRON_LAST_BUSINESS_DAY, 'UTC', start);
      expect(next.getUTCFullYear()).toBe(2026);
      expect(next.getUTCMonth()).toBe(3);
      expect(next.getUTCDate()).toBe(30);
      // 30 April 2026 is a Thursday.
      expect(next.getUTCDay()).toBe(4);
    });

    it('skips weekends when the calendar last day is Sat or Sun', () => {
      // May 2026 — last day is Sunday the 31st; expect Friday the 29th.
      const start = new Date(Date.UTC(2026, 4, 1, 12, 0, 0));
      const next = cronNext(CRON_LAST_BUSINESS_DAY, 'UTC', start);
      expect(next.getUTCMonth()).toBe(4); // May
      expect(next.getUTCDate()).toBe(29);
      expect(next.getUTCDay()).toBe(5); // Friday
    });
  });
});
