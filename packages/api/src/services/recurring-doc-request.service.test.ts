// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, portalContacts, recurringDocumentRequests, documentRequests, reminderSends, auditLog } from '../db/schema/index.js';
import {
  CRON_LAST_BUSINESS_DAY,
  computeFirstIssueAt,
  computeNextIssueAt,
  cronNext,
  deleteRule,
  isValidCronExpression,
  issueNow,
  issueOne,
  listOpenRequests,
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

// DB-backed tests for the rule row-lifecycle actions. Tenant-scoped
// setup/teardown so concurrent suites are unaffected.
describe('recurring-doc-request — deleteRule / issueNow (db)', () => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  let tenantId: string;
  let contactId: string;

  beforeAll(async () => {
    const [tenant] = await db.insert(tenants).values({
      name: 'RDR Test Tenant',
      slug: 'test-rdr-' + Date.now(),
    }).returning();
    tenantId = tenant!.id;
    const [contact] = await db.insert(portalContacts).values({
      tenantId,
      email: `rdr-${Date.now()}@example.com`,
    }).returning();
    contactId = contact!.id;
  });

  afterAll(async () => {
    if (!tenantId) return;
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
    await db.delete(documentRequests).where(eq(documentRequests.tenantId, tenantId));
    await db.delete(recurringDocumentRequests).where(eq(recurringDocumentRequests.tenantId, tenantId));
    await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  });

  async function mkRule(overrides: Partial<typeof recurringDocumentRequests.$inferInsert> = {}) {
    const [rule] = await db.insert(recurringDocumentRequests).values({
      tenantId,
      contactId,
      documentType: 'bank_statement',
      description: 'test rule',
      nextIssueAt: new Date('2099-01-03T09:00:00Z'),
      ...overrides,
    }).returning();
    return rule!;
  }

  it('deleteRule removes the row and preserves issued requests with recurring_id nulled', async () => {
    const rule = await mkRule();
    const [issued] = await db.insert(documentRequests).values({
      tenantId,
      recurringId: rule.id,
      contactId,
      documentType: 'bank_statement',
      description: 'test rule',
      periodLabel: '2026-06',
    }).returning();

    await deleteRule(tenantId, actorId, rule.id);

    const gone = await db.query.recurringDocumentRequests.findFirst({
      where: eq(recurringDocumentRequests.id, rule.id),
    });
    expect(gone).toBeUndefined();
    const kept = await db.query.documentRequests.findFirst({
      where: eq(documentRequests.id, issued!.id),
    });
    expect(kept).toBeDefined();
    expect(kept!.recurringId).toBeNull();
    expect(kept!.status).toBe('pending');
  });

  it('listOpenRequests returns ISO reminder timestamps when a reminder was sent (regression: MAX() is a string, not a Date)', async () => {
    const [req] = await db.insert(documentRequests).values({
      tenantId,
      contactId,
      documentType: 'bank_statement',
      description: 'reminded request',
      periodLabel: '2026-07',
      status: 'pending',
    }).returning();
    // A reminder send makes MAX(sent_at) non-null — the exact condition that
    // 500'd the Open Requests tab (agg.lastSentAt.toISOString is not a function).
    await db.insert(reminderSends).values({
      tenantId,
      contactId,
      questionId: req!.id,
      channel: 'email',
      sentAt: new Date(),
    });

    const { items } = await listOpenRequests(tenantId, { status: 'pending', limit: 100, offset: 0 });
    const found = items.find((i) => i.id === req!.id);
    expect(found).toBeDefined();
    expect(typeof found!.lastRemindedAt).toBe('string');
    expect(() => new Date(found!.lastRemindedAt!).toISOString()).not.toThrow();
    expect(found!.reminderSendCount).toBeGreaterThanOrEqual(1);
  });

  it('deleteRule 404s for another tenant', async () => {
    const rule = await mkRule();
    const [otherTenant] = await db.insert(tenants).values({
      name: 'Other', slug: 'test-rdr-other-' + Date.now(),
    }).returning();
    try {
      await expect(deleteRule(otherTenant!.id, actorId, rule.id)).rejects.toThrow(/not found/i);
    } finally {
      await db.delete(tenants).where(eq(tenants.id, otherTenant!.id));
    }
  });

  it('issueNow creates a current-period request without touching the schedule', async () => {
    const rule = await mkRule();
    const now = new Date('2026-06-15T12:00:00Z');
    const result = await issueNow(tenantId, actorId, rule.id, now);
    expect(result.outcome).toBe('issued');
    expect(result.periodLabel).toBe(periodLabelFor(now, 'monthly'));

    const req = await db.query.documentRequests.findFirst({
      where: eq(documentRequests.id, result.requestId),
    });
    expect(req!.status).toBe('pending');
    expect(req!.requestedAt.toISOString()).toBe(now.toISOString());
    // dueDate = now + default 7 due days
    expect(req!.dueDate!.toISOString()).toBe(new Date('2026-06-22T12:00:00Z').toISOString());

    const after = await db.query.recurringDocumentRequests.findFirst({
      where: eq(recurringDocumentRequests.id, rule.id),
    });
    expect(after!.nextIssueAt.toISOString()).toBe(rule.nextIssueAt.toISOString());
    expect(after!.lastIssuedAt!.toISOString()).toBe(now.toISOString());
  });

  it('issueNow reports already_pending on a second call in the same period', async () => {
    const rule = await mkRule();
    const now = new Date('2026-07-10T12:00:00Z');
    const first = await issueNow(tenantId, actorId, rule.id, now);
    expect(first.outcome).toBe('issued');
    const second = await issueNow(tenantId, actorId, rule.id, new Date('2026-07-11T12:00:00Z'));
    expect(second.outcome).toBe('already_pending');
    expect(second.requestId).toBe(first.requestId);
  });

  // Regression: uq_doc_req_recurring_period is a partial unique index —
  // the scheduler's INSERT ... ON CONFLICT previously failed to infer it
  // (42P10) and every issuance crashed before the first row was written.
  it('issueOne issues a due rule and advances the schedule', async () => {
    const due = new Date('2026-09-03T09:00:00Z');
    const rule = await mkRule({ nextIssueAt: due, dayOfMonth: 3 });
    const result = await issueOne(rule.id, new Date('2026-09-03T09:05:00Z'));
    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.periodLabel).toBe(periodLabelFor(due, 'monthly'));

    const after = await db.query.recurringDocumentRequests.findFirst({
      where: eq(recurringDocumentRequests.id, rule.id),
    });
    expect(after!.lastIssuedAt!.toISOString()).toBe(due.toISOString());
    expect(after!.nextIssueAt.getTime()).toBeGreaterThan(due.getTime());

    // Racing second worker: it read the rule before the first advanced
    // next_issue_at, so it attempts the same period — the unique index
    // makes that a clean no-op (created=false), not a crash.
    await db.update(recurringDocumentRequests)
      .set({ nextIssueAt: due })
      .where(eq(recurringDocumentRequests.id, rule.id));
    const again = await issueOne(rule.id, new Date('2026-09-03T09:10:00Z'));
    expect(again!.created).toBe(false);
    expect(again!.rowId).toBe(result!.rowId);
  });

  it('issueNow reports already_closed when the period request is submitted', async () => {
    const rule = await mkRule();
    const now = new Date('2026-08-10T12:00:00Z');
    const first = await issueNow(tenantId, actorId, rule.id, now);
    await db.update(documentRequests)
      .set({ status: 'submitted', submittedAt: new Date() })
      .where(eq(documentRequests.id, first.requestId));
    const second = await issueNow(tenantId, actorId, rule.id, new Date('2026-08-12T12:00:00Z'));
    expect(second.outcome).toBe('already_closed');
    expect(second.outcome === 'already_closed' && second.status).toBe('submitted');
  });
});
