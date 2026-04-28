// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import {
  chooseChannelsForCandidate,
  isInQuietHours,
  nextCadenceStep,
  renderSmsBody,
} from './portal-reminders.service.js';

describe('portal-reminders helpers', () => {
  describe('nextCadenceStep', () => {
    const cadence = [3, 7, 14];
    const day = (n: number) => new Date(`2026-04-26T12:00:00Z`).getTime() - n * 86_400_000;
    const at = (n: number) => new Date(day(n));
    const now = new Date('2026-04-26T12:00:00Z');

    it('returns null when no step is due yet (age < cadence[0])', () => {
      expect(nextCadenceStep(cadence, at(2), 0, now)).toBeNull();
    });

    it('fires step 1 once the question crosses cadence[0]', () => {
      expect(nextCadenceStep(cadence, at(3), 0, now)).toBe(1);
      expect(nextCadenceStep(cadence, at(5), 0, now)).toBe(1);
    });

    it('does not re-fire step 1 once it has already been sent', () => {
      expect(nextCadenceStep(cadence, at(5), 1, now)).toBeNull();
    });

    it('fires step 2 when age >= cadence[1] and one prior send', () => {
      expect(nextCadenceStep(cadence, at(7), 1, now)).toBe(2);
    });

    it('fires step 3 when age >= cadence[2] and two prior sends', () => {
      expect(nextCadenceStep(cadence, at(20), 2, now)).toBe(3);
    });

    it('returns null when every step has already been sent', () => {
      expect(nextCadenceStep(cadence, at(60), 3, now)).toBeNull();
    });

    it('rejects malformed cadence entries', () => {
      expect(nextCadenceStep([0, 7] as number[], at(5), 0, now)).toBeNull();
      expect(nextCadenceStep([NaN] as number[], at(5), 0, now)).toBeNull();
    });
  });

  describe('isInQuietHours', () => {
    // Pick a date whose UTC hour is fixed so the test is deterministic.
    const at = (utcHour: number) =>
      new Date(`2026-04-26T${String(utcHour).padStart(2, '0')}:30:00Z`);

    it('is false when start === end (window disabled)', () => {
      expect(isInQuietHours(at(3), 0, 0, 'UTC')).toBe(false);
    });

    it('treats 20:00–08:00 as a wrap-around window', () => {
      expect(isInQuietHours(at(22), 20, 8, 'UTC')).toBe(true);
      expect(isInQuietHours(at(2), 20, 8, 'UTC')).toBe(true);
      expect(isInQuietHours(at(7), 20, 8, 'UTC')).toBe(true);
      expect(isInQuietHours(at(8), 20, 8, 'UTC')).toBe(false);
      expect(isInQuietHours(at(12), 20, 8, 'UTC')).toBe(false);
      expect(isInQuietHours(at(19), 20, 8, 'UTC')).toBe(false);
    });

    it('treats a same-day window correctly', () => {
      expect(isInQuietHours(at(11), 9, 17, 'UTC')).toBe(true);
      expect(isInQuietHours(at(8), 9, 17, 'UTC')).toBe(false);
      expect(isInQuietHours(at(17), 9, 17, 'UTC')).toBe(false);
    });

    it('honors timezone — 20:00 ET window from a UTC clock', () => {
      // 22:30 UTC = 18:30 EDT (-04:00 in late April). Outside 20–08 ET.
      expect(isInQuietHours(at(22), 20, 8, 'America/New_York')).toBe(false);
      // 02:30 UTC = 22:30 EDT prior day — inside the ET window.
      expect(isInQuietHours(at(2), 20, 8, 'America/New_York')).toBe(true);
    });
  });

  // DOC_REQUEST_SMS_V1 — channel-selection + SMS-body rendering helpers.

  describe('chooseChannelsForCandidate', () => {
    it('email_only always returns email regardless of step or sms availability', () => {
      expect(chooseChannelsForCandidate('email_only', 1, true, true)).toEqual(['email']);
      expect(chooseChannelsForCandidate('email_only', 5, false, false)).toEqual(['email']);
    });

    it('sms_only returns sms only when sms is reachable; otherwise empty', () => {
      expect(chooseChannelsForCandidate('sms_only', 1, true, true)).toEqual(['sms']);
      expect(chooseChannelsForCandidate('sms_only', 1, true, false)).toEqual([]);
      expect(chooseChannelsForCandidate('sms_only', 1, false, true)).toEqual([]);
    });

    it('both fans out to email + sms when reachable, falls back to email only when not', () => {
      expect(chooseChannelsForCandidate('both', 1, true, true)).toEqual(['email', 'sms']);
      expect(chooseChannelsForCandidate('both', 1, false, true)).toEqual(['email']);
      expect(chooseChannelsForCandidate('both', 1, true, false)).toEqual(['email']);
    });

    it('escalating uses email for steps 1–2 then SMS from step 3', () => {
      expect(chooseChannelsForCandidate('escalating', 1, true, true)).toEqual(['email']);
      expect(chooseChannelsForCandidate('escalating', 2, true, true)).toEqual(['email']);
      expect(chooseChannelsForCandidate('escalating', 3, true, true)).toEqual(['sms']);
      expect(chooseChannelsForCandidate('escalating', 4, true, true)).toEqual(['sms']);
    });

    it('escalating falls back to email when SMS unreachable from step 3', () => {
      expect(chooseChannelsForCandidate('escalating', 3, false, true)).toEqual(['email']);
      expect(chooseChannelsForCandidate('escalating', 3, true, false)).toEqual(['email']);
    });
  });

  describe('renderSmsBody', () => {
    it('substitutes vars and appends the STOP footer', () => {
      const body = renderSmsBody('Hi {first_name}, send {description}', {
        first_name: 'Sam',
        description: 'April statement',
      }, false);
      expect(body).toBe('Hi Sam, send April statement Reply STOP to opt out.');
    });

    it('truncates the body to fit the 160-char single-segment budget', () => {
      const longDescription = 'X'.repeat(300);
      const body = renderSmsBody('Doc: {description}', { description: longDescription }, false);
      expect(body.length).toBeLessThanOrEqual(160);
      expect(body.endsWith('Reply STOP to opt out.')).toBe(true);
      expect(body).toContain('…');
    });

    it('does not truncate when multi-segment is allowed', () => {
      const longDescription = 'X'.repeat(300);
      const body = renderSmsBody('Doc: {description}', { description: longDescription }, true);
      expect(body.length).toBeGreaterThan(160);
      expect(body.endsWith('Reply STOP to opt out.')).toBe(true);
      expect(body).not.toContain('…');
    });

    it('reserves the STOP footer even when the body is short', () => {
      const body = renderSmsBody('Hi', {}, false);
      expect(body).toBe('Hi Reply STOP to opt out.');
    });
  });
});
