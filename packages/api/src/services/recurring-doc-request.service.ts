// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, asc, desc, eq, inArray, lte, sql, type SQL } from 'drizzle-orm';
import type {
  DocRequestStatus,
  DocumentRequestListFilters,
  DocumentRequestSummary,
  RecurringDocRequestCreateInput,
  RecurringDocRequestSummary,
  RecurringDocRequestUpdateInput,
  RecurringFrequency,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  documentRequests,
  portalContacts,
  recurringDocumentRequests,
  reminderSends,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

// RECURRING_DOC_REQUESTS_V1 — service layer for the standing rule
// ("ask client X for their bank statement on the 3rd of every month")
// and the per-cycle issued document_requests rows the scheduler emits.
// The cadence-based escalation lives in portal-reminders.service.ts —
// this file owns the calendar arithmetic and the "create one cycle"
// idempotency.

// ── helpers ──────────────────────────────────────────────────────

// Day-of-month clamp. February doesn't have a 30th; we picked 28 as
// the schema cap to dodge that, but the service still has to handle
// the case where a pre-flag-add row has dayOfMonth=null (annually
// uses the start date directly) or where intervalValue rolls into a
// short month.
function clampDayOfMonth(year: number, month: number, day: number): number {
  // month is 0-indexed for Date; lastDay = day 0 of next month.
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Math.min(day, lastDay);
}

// RECURRING_CRON_V1 — sentinel cron expression for "last business day
// of month". The cron syntax can express "last weekday" but not "last
// non-holiday weekday"; we keep the surface area small and treat this
// as a single named preset that the service computes manually.
export const CRON_LAST_BUSINESS_DAY = '@last-business-day-of-month';

// Maximum gap between two consecutive cron firings before we reject the
// expression as a foot-gun. The classic "0 0 29 2 *" → 4-year sleep
// would otherwise look healthy on the dashboard while silently
// missing every February. Anything 3+ years out is rejected.
const CRON_MAX_GAP_DAYS = 3 * 365;

export function isValidCronExpression(expr: string, timezone?: string): { ok: true } | { ok: false; reason: string } {
  if (!expr) return { ok: false, reason: 'cron expression is empty' };
  if (expr === CRON_LAST_BUSINESS_DAY) return { ok: true };

  try {
    // Lazy import — keeps cron-parser out of the cold path for
    // frequency-mode rules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parser = require('cron-parser') as typeof import('cron-parser');
    const opts = timezone ? { tz: timezone } : undefined;
    const it = parser.parseExpression(expr, opts);
    const a = it.next().toDate();
    const b = it.next().toDate();
    const gapDays = (b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000);
    if (gapDays > CRON_MAX_GAP_DAYS) {
      return { ok: false, reason: `firings are ${gapDays.toFixed(0)} days apart, which is too sparse to be intentional` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'invalid cron expression' };
  }
}

// Compute the cron-mode next issue moment. Handles the named-preset
// sentinel inline; everything else delegates to cron-parser.
export function cronNext(expr: string, timezone: string | null, previous: Date): Date {
  if (expr === CRON_LAST_BUSINESS_DAY) {
    return computeLastBusinessDayNext(previous, timezone ?? 'UTC');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const parser = require('cron-parser') as typeof import('cron-parser');
  const opts: { currentDate: Date; tz?: string } = { currentDate: previous };
  if (timezone) opts.tz = timezone;
  const it = parser.parseExpression(expr, opts);
  return it.next().toDate();
}

// "Last business day of month" — the last Mon–Fri of the month at
// 09:00 in the rule's timezone. Used by the named preset.
function computeLastBusinessDayNext(after: Date, _timezone: string): Date {
  // Start from the month after `after` so we never re-emit the same
  // moment. We then walk back from the last day of that month until
  // we hit a Mon–Fri.
  const cursorYear = after.getUTCFullYear();
  const cursorMonth = after.getUTCMonth();
  // Try the same month first — if the last business day is still in
  // the future relative to `after`, use that. Otherwise advance to
  // the next month.
  for (const offset of [0, 1, 2]) {
    const targetMonth = cursorMonth + offset;
    const lastDay = new Date(Date.UTC(cursorYear, targetMonth + 1, 0));
    const cursor = new Date(lastDay);
    while (true) {
      const dow = cursor.getUTCDay();
      if (dow !== 0 && dow !== 6) break;
      cursor.setUTCDate(cursor.getUTCDate() - 1);
    }
    cursor.setUTCHours(9, 0, 0, 0);
    if (cursor.getTime() > after.getTime()) return cursor;
  }
  // Fallback that should never trigger — return one month out.
  const fb = new Date(after);
  fb.setUTCMonth(fb.getUTCMonth() + 1);
  return fb;
}

// Compute the next issue moment given the previous issue moment, the
// frequency, and (for monthly/quarterly) the day-of-month anchor.
// All arithmetic in UTC — we deliberately do not localize. The
// scheduler runs every five minutes and the rules are coarse-grained
// (a day, not an hour) so DST drift doesn't matter for selection;
// what matters is that the math is reproducible.
export function computeNextIssueAt(
  previous: Date,
  frequency: RecurringFrequency,
  intervalValue: number,
  dayOfMonth: number | null,
): Date {
  const monthsToAdd =
    frequency === 'monthly' ? intervalValue
      : frequency === 'quarterly' ? 3 * intervalValue
        : 12 * intervalValue;
  const y = previous.getUTCFullYear();
  const m = previous.getUTCMonth();
  const targetMonth = m + monthsToAdd;
  const targetYear = y + Math.floor(targetMonth / 12);
  const normMonth = ((targetMonth % 12) + 12) % 12;
  // Frequency=annually keeps the prior day. Monthly/quarterly snap to
  // the rule's anchor day if set; otherwise preserve the prior day.
  const anchorDay = dayOfMonth ?? previous.getUTCDate();
  const day = clampDayOfMonth(targetYear, normMonth, anchorDay);
  // Use 09:00 UTC as the canonical "issue moment" so the row picks
  // are deterministic across retries; the scheduler tick uses
  // next_issue_at <= now() so the choice of hour only matters for
  // when the first email lands.
  return new Date(Date.UTC(targetYear, normMonth, day, 9, 0, 0));
}

// First issuance moment for a brand-new rule. Picks the earliest of:
// (a) explicit startAt, (b) "next dayOfMonth in the future", (c) now
// for annually with no anchor.
export function computeFirstIssueAt(
  now: Date,
  frequency: RecurringFrequency,
  intervalValue: number,
  dayOfMonth: number | null,
  startAt?: Date,
): Date {
  if (startAt && startAt.getTime() > now.getTime()) return startAt;
  if (frequency === 'monthly' || frequency === 'quarterly') {
    const anchor = dayOfMonth ?? now.getUTCDate();
    const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 9, 0, 0));
    candidate.setUTCDate(clampDayOfMonth(candidate.getUTCFullYear(), candidate.getUTCMonth(), anchor));
    if (candidate.getTime() <= now.getTime()) {
      return computeNextIssueAt(candidate, frequency, intervalValue, dayOfMonth);
    }
    return candidate;
  }
  // annually
  const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0));
  return candidate;
}

// Period label that's printed in the email — "2026-04" for April. For
// quarterly we use "2026-Q2"; for annually "2026".
export function periodLabelFor(when: Date, frequency: RecurringFrequency): string {
  const y = when.getUTCFullYear();
  if (frequency === 'annually') return String(y);
  if (frequency === 'quarterly') {
    const q = Math.floor(when.getUTCMonth() / 3) + 1;
    return `${y}-Q${q}`;
  }
  const m = String(when.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ── recurring-rule CRUD ─────────────────────────────────────────

// Verify the contact belongs to this tenant. A leaked UUID can't be
// turned into a rule against another firm's contact.
async function assertContactInTenant(tenantId: string, contactId: string): Promise<void> {
  const contact = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.id, contactId)),
  });
  if (!contact) throw AppError.notFound('Portal contact not found');
  if (contact.status !== 'active') {
    throw AppError.badRequest('Contact is not active; reactivate before creating a rule');
  }
}

export async function createRule(
  tenantId: string,
  bookkeeperUserId: string,
  input: RecurringDocRequestCreateInput,
): Promise<{ id: string; nextIssueAt: string }> {
  await assertContactInTenant(tenantId, input.contactId);

  const cadenceKind = input.cadenceKind ?? 'frequency';

  if (cadenceKind === 'frequency') {
    if ((input.frequency === 'monthly' || input.frequency === 'quarterly') && !input.dayOfMonth) {
      throw AppError.badRequest('dayOfMonth is required for monthly/quarterly frequencies');
    }
  } else {
    if (!input.cronExpression) {
      throw AppError.badRequest('cronExpression is required for cadenceKind=cron');
    }
    const v = isValidCronExpression(input.cronExpression, input.cronTimezone ?? undefined);
    if (!v.ok) throw AppError.badRequest(`Invalid cron expression: ${v.reason}`);
  }

  const now = new Date();
  const startAt = input.startAt ? new Date(input.startAt) : undefined;
  const nextIssueAt = cadenceKind === 'cron' && input.cronExpression
    ? cronNext(input.cronExpression, input.cronTimezone ?? null, startAt ?? now)
    : computeFirstIssueAt(
        now,
        input.frequency,
        input.intervalValue,
        input.dayOfMonth ?? null,
        startAt,
      );

  const inserted = await db
    .insert(recurringDocumentRequests)
    .values({
      tenantId,
      companyId: input.companyId ?? null,
      contactId: input.contactId,
      documentType: input.documentType,
      description: input.description,
      frequency: input.frequency,
      intervalValue: input.intervalValue,
      dayOfMonth: input.dayOfMonth ?? null,
      cadenceKind,
      cronExpression: input.cronExpression ?? null,
      cronTimezone: input.cronTimezone ?? null,
      nextIssueAt,
      dueDaysAfterIssue: input.dueDaysAfterIssue,
      cadenceDays: input.cadenceDays,
      active: input.active,
      endsAt: input.endsAt ? new Date(input.endsAt) : null,
      bankConnectionId: input.bankConnectionId ?? null,
    })
    .returning({ id: recurringDocumentRequests.id });
  const row = inserted[0];
  if (!row) throw AppError.internal('Failed to insert recurring document request');

  await auditLog(tenantId, 'create', 'recurring_document_request', row.id, null, input, bookkeeperUserId);
  return { id: row.id, nextIssueAt: nextIssueAt.toISOString() };
}

export async function updateRule(
  tenantId: string,
  bookkeeperUserId: string,
  id: string,
  input: RecurringDocRequestUpdateInput,
): Promise<void> {
  const before = await db.query.recurringDocumentRequests.findFirst({
    where: and(
      eq(recurringDocumentRequests.tenantId, tenantId),
      eq(recurringDocumentRequests.id, id),
    ),
  });
  if (!before) throw AppError.notFound('Recurring document request not found');

  // Recompute next_issue_at if the cadence math inputs changed.
  let nextIssueAt: Date | undefined;
  const cadenceKind = (input.cadenceKind ?? before.cadenceKind) as 'frequency' | 'cron';
  const cronExpr = input.cronExpression !== undefined ? input.cronExpression : before.cronExpression;
  const cronTz = input.cronTimezone !== undefined ? input.cronTimezone : before.cronTimezone;
  const freq = (input.frequency ?? before.frequency) as RecurringFrequency;
  const interval = input.intervalValue ?? before.intervalValue;
  const dom = input.dayOfMonth !== undefined ? input.dayOfMonth : before.dayOfMonth;
  const cadenceChanged =
    input.cadenceKind !== undefined ||
    input.cronExpression !== undefined ||
    input.cronTimezone !== undefined ||
    input.frequency !== undefined ||
    input.intervalValue !== undefined ||
    input.dayOfMonth !== undefined;
  if (cadenceChanged) {
    if (cadenceKind === 'cron') {
      if (!cronExpr) throw AppError.badRequest('cronExpression is required for cadenceKind=cron');
      const v = isValidCronExpression(cronExpr, cronTz ?? undefined);
      if (!v.ok) throw AppError.badRequest(`Invalid cron expression: ${v.reason}`);
      nextIssueAt = cronNext(cronExpr, cronTz ?? null, new Date());
    } else {
      nextIssueAt = computeFirstIssueAt(new Date(), freq, interval, dom, undefined);
    }
  }

  const patch: Partial<typeof recurringDocumentRequests.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.companyId !== undefined) patch.companyId = input.companyId ?? null;
  if (input.documentType !== undefined) patch.documentType = input.documentType;
  if (input.description !== undefined) patch.description = input.description;
  if (input.cadenceKind !== undefined) patch.cadenceKind = input.cadenceKind;
  if (input.cronExpression !== undefined) patch.cronExpression = input.cronExpression;
  if (input.cronTimezone !== undefined) patch.cronTimezone = input.cronTimezone;
  if (input.bankConnectionId !== undefined) patch.bankConnectionId = input.bankConnectionId ?? null;
  if (input.frequency !== undefined) patch.frequency = input.frequency;
  if (input.intervalValue !== undefined) patch.intervalValue = input.intervalValue;
  if (input.dayOfMonth !== undefined) patch.dayOfMonth = input.dayOfMonth;
  if (input.dueDaysAfterIssue !== undefined) patch.dueDaysAfterIssue = input.dueDaysAfterIssue;
  if (input.cadenceDays !== undefined) patch.cadenceDays = input.cadenceDays;
  if (input.active !== undefined) patch.active = input.active;
  if (input.endsAt !== undefined) patch.endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (nextIssueAt) patch.nextIssueAt = nextIssueAt;

  await db
    .update(recurringDocumentRequests)
    .set(patch)
    .where(eq(recurringDocumentRequests.id, id));

  await auditLog(tenantId, 'update', 'recurring_document_request', id, before, { ...before, ...patch }, bookkeeperUserId);
}

export async function cancelRule(
  tenantId: string,
  bookkeeperUserId: string,
  id: string,
): Promise<void> {
  const before = await db.query.recurringDocumentRequests.findFirst({
    where: and(
      eq(recurringDocumentRequests.tenantId, tenantId),
      eq(recurringDocumentRequests.id, id),
    ),
  });
  if (!before) throw AppError.notFound('Recurring document request not found');
  await db
    .update(recurringDocumentRequests)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(recurringDocumentRequests.id, id));
  await auditLog(tenantId, 'update', 'recurring_document_request', id, before, { ...before, active: false }, bookkeeperUserId);
}

export async function listRules(tenantId: string): Promise<RecurringDocRequestSummary[]> {
  const rows = await db
    .select({
      r: recurringDocumentRequests,
      contactEmail: portalContacts.email,
      contactFirstName: portalContacts.firstName,
      contactLastName: portalContacts.lastName,
    })
    .from(recurringDocumentRequests)
    .innerJoin(portalContacts, eq(recurringDocumentRequests.contactId, portalContacts.id))
    .where(eq(recurringDocumentRequests.tenantId, tenantId))
    .orderBy(asc(recurringDocumentRequests.nextIssueAt));

  if (rows.length === 0) return [];

  // Outstanding-count rollup — one query, grouped by recurring_id.
  const ruleIds = rows.map((r) => r.r.id);
  const outstandingRows = await db
    .select({
      recurringId: documentRequests.recurringId,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(documentRequests)
    .where(
      and(
        inArray(documentRequests.recurringId, ruleIds),
        eq(documentRequests.status, 'pending'),
      ),
    )
    .groupBy(documentRequests.recurringId);
  const outstandingByRule = new Map<string, number>();
  for (const o of outstandingRows) {
    if (o.recurringId) outstandingByRule.set(o.recurringId, Number(o.n));
  }

  return rows.map(({ r, contactEmail, contactFirstName, contactLastName }) => ({
    id: r.id,
    tenantId: r.tenantId,
    companyId: r.companyId,
    contactId: r.contactId,
    contactEmail,
    contactName: [contactFirstName, contactLastName].filter(Boolean).join(' ') || null,
    documentType: r.documentType as RecurringDocRequestSummary['documentType'],
    description: r.description,
    cadenceKind: (r.cadenceKind ?? 'frequency') as RecurringDocRequestSummary['cadenceKind'],
    frequency: r.frequency as RecurringFrequency,
    intervalValue: r.intervalValue,
    dayOfMonth: r.dayOfMonth,
    cronExpression: r.cronExpression ?? null,
    cronTimezone: r.cronTimezone ?? null,
    nextIssueAt: r.nextIssueAt.toISOString(),
    lastIssuedAt: r.lastIssuedAt ? r.lastIssuedAt.toISOString() : null,
    dueDaysAfterIssue: r.dueDaysAfterIssue,
    cadenceDays: Array.isArray(r.cadenceDays) ? (r.cadenceDays as number[]) : [3, 7, 14],
    active: r.active,
    endsAt: r.endsAt ? r.endsAt.toISOString() : null,
    bankConnectionId: r.bankConnectionId ?? null,
    outstandingCount: outstandingByRule.get(r.id) ?? 0,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

// Preview helper for the create-form — given a hypothetical rule
// payload, return the next N issuance dates so the operator can
// sanity-check the schedule before saving. Handles both frequency
// and cron cadence kinds.
export function previewNext(
  cadenceKind: 'frequency' | 'cron',
  frequency: RecurringFrequency,
  intervalValue: number,
  dayOfMonth: number | null,
  cronExpression: string | null,
  cronTimezone: string | null,
  startAt?: Date,
  count = 3,
): string[] {
  const out: string[] = [];
  if (cadenceKind === 'cron') {
    if (!cronExpression) return [];
    const v = isValidCronExpression(cronExpression, cronTimezone ?? undefined);
    if (!v.ok) return [];
    let when = startAt ?? new Date();
    for (let i = 0; i < count; i++) {
      when = cronNext(cronExpression, cronTimezone, when);
      out.push(when.toISOString());
    }
    return out;
  }
  let when = computeFirstIssueAt(new Date(), frequency, intervalValue, dayOfMonth, startAt);
  for (let i = 0; i < count; i++) {
    out.push(when.toISOString());
    when = computeNextIssueAt(when, frequency, intervalValue, dayOfMonth);
  }
  return out;
}

// ── issuance ────────────────────────────────────────────────────

// Insert a single document_requests row for the given rule and
// advance its next_issue_at. Idempotent: the unique index on
// (recurring_id, period_label) means a racing second call returns
// the existing row without double-inserting.
//
// Returns { row, created } so the scheduler can decide whether to
// send the opening email (only on create).
export async function issueOne(
  ruleId: string,
  now: Date = new Date(),
): Promise<{ rowId: string; created: boolean; periodLabel: string } | null> {
  const rule = await db.query.recurringDocumentRequests.findFirst({
    where: eq(recurringDocumentRequests.id, ruleId),
  });
  if (!rule) return null;
  if (!rule.active) return null;
  if (rule.endsAt && rule.endsAt.getTime() <= now.getTime()) return null;

  const issuedAt = rule.nextIssueAt;
  const period = periodLabelFor(issuedAt, rule.frequency as RecurringFrequency);
  const dueDate = new Date(issuedAt.getTime() + rule.dueDaysAfterIssue * 24 * 60 * 60 * 1000);

  // Insert with ON CONFLICT DO NOTHING on the (recurring_id, period_label)
  // unique index. If we return zero rows, another worker beat us to this
  // period — read the existing row and return created=false.
  const inserted = await db
    .insert(documentRequests)
    .values({
      tenantId: rule.tenantId,
      companyId: rule.companyId,
      recurringId: rule.id,
      contactId: rule.contactId,
      documentType: rule.documentType,
      description: rule.description,
      periodLabel: period,
      requestedAt: issuedAt,
      dueDate,
      status: 'pending',
    })
    .onConflictDoNothing({ target: [documentRequests.recurringId, documentRequests.periodLabel] })
    .returning({ id: documentRequests.id });

  let rowId = inserted[0]?.id;
  let created = inserted.length > 0;
  if (!rowId) {
    const existing = await db.query.documentRequests.findFirst({
      where: and(
        eq(documentRequests.recurringId, rule.id),
        eq(documentRequests.periodLabel, period),
      ),
    });
    if (!existing) return null; // shouldn't happen, but be defensive
    rowId = existing.id;
    created = false;
  }

  // Advance the rule. Conditional UPDATE keeps the math idempotent —
  // only advance if next_issue_at is still the value we observed.
  const nextIssueAt = rule.cadenceKind === 'cron' && rule.cronExpression
    ? cronNext(rule.cronExpression, rule.cronTimezone, issuedAt)
    : computeNextIssueAt(
        issuedAt,
        rule.frequency as RecurringFrequency,
        rule.intervalValue,
        rule.dayOfMonth ?? null,
      );
  await db
    .update(recurringDocumentRequests)
    .set({
      nextIssueAt,
      lastIssuedAt: issuedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recurringDocumentRequests.id, rule.id),
        eq(recurringDocumentRequests.nextIssueAt, issuedAt),
      ),
    );

  return { rowId, created, periodLabel: period };
}

// Pick all rules that are ready to fire. Used by the scheduler tick.
export async function findDueRules(now: Date = new Date()): Promise<{ id: string; tenantId: string }[]> {
  const rows = await db
    .select({ id: recurringDocumentRequests.id, tenantId: recurringDocumentRequests.tenantId })
    .from(recurringDocumentRequests)
    .where(
      and(
        eq(recurringDocumentRequests.active, true),
        lte(recurringDocumentRequests.nextIssueAt, now),
        sql`(${recurringDocumentRequests.endsAt} IS NULL OR ${recurringDocumentRequests.endsAt} > ${now})`,
      ),
    );
  return rows;
}

// ── document_requests grid + actions ────────────────────────────

export async function listOpenRequests(
  tenantId: string,
  filters: DocumentRequestListFilters,
): Promise<{ items: DocumentRequestSummary[]; total: number }> {
  const conditions: SQL<unknown>[] = [eq(documentRequests.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(documentRequests.status, filters.status));
  if (filters.contactId) conditions.push(eq(documentRequests.contactId, filters.contactId));
  if (filters.recurringId) conditions.push(eq(documentRequests.recurringId, filters.recurringId));
  if (filters.overdue) {
    conditions.push(eq(documentRequests.status, 'pending'));
    conditions.push(sql`${documentRequests.dueDate} IS NOT NULL AND ${documentRequests.dueDate} < NOW()`);
  }
  const where = conditions.length === 1 ? conditions[0]! : and(...conditions)!;

  const totalRow = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(documentRequests)
    .where(where);
  const total = Number(totalRow[0]?.n ?? 0);

  const rows = await db
    .select({
      d: documentRequests,
      contactEmail: portalContacts.email,
      contactFirstName: portalContacts.firstName,
      contactLastName: portalContacts.lastName,
    })
    .from(documentRequests)
    .innerJoin(portalContacts, eq(documentRequests.contactId, portalContacts.id))
    .where(where)
    .orderBy(desc(documentRequests.requestedAt))
    .limit(filters.limit)
    .offset(filters.offset);

  if (rows.length === 0) return { items: [], total };

  // Pull per-request reminder-send aggregates in one query.
  const reqIds = rows.map((r) => r.d.id);
  const sendsAgg = await db
    .select({
      // We piggyback on reminder_sends.questionId to carry the
      // document_request id for doc_request triggers — defined in
      // the scan branch (portal-reminders.service.ts). The column
      // name stays "questionId" because the table predates this
      // feature; semantically it's "trigger entity id".
      docRequestId: reminderSends.questionId,
      sendCount: sql<number>`COUNT(*)::int`,
      lastSentAt: sql<Date | null>`MAX(${reminderSends.sentAt})`,
      lastOpenedAt: sql<Date | null>`MAX(${reminderSends.openedAt})`,
      lastClickedAt: sql<Date | null>`MAX(${reminderSends.clickedAt})`,
    })
    .from(reminderSends)
    .where(
      and(
        eq(reminderSends.tenantId, tenantId),
        inArray(reminderSends.questionId, reqIds),
      ),
    )
    .groupBy(reminderSends.questionId);

  type SendAgg = { sendCount: number; lastSentAt: Date | null; lastOpenedAt: Date | null; lastClickedAt: Date | null };
  const sendsById = new Map<string, SendAgg>();
  for (const s of sendsAgg) {
    if (s.docRequestId) {
      sendsById.set(s.docRequestId, {
        sendCount: Number(s.sendCount),
        lastSentAt: s.lastSentAt,
        lastOpenedAt: s.lastOpenedAt,
        lastClickedAt: s.lastClickedAt,
      });
    }
  }

  const items: DocumentRequestSummary[] = rows.map(({ d, contactEmail, contactFirstName, contactLastName }) => {
    const agg = sendsById.get(d.id);
    return {
      id: d.id,
      tenantId: d.tenantId,
      companyId: d.companyId,
      recurringId: d.recurringId,
      contactId: d.contactId,
      contactEmail,
      contactName: [contactFirstName, contactLastName].filter(Boolean).join(' ') || null,
      documentType: d.documentType as DocumentRequestSummary['documentType'],
      description: d.description,
      periodLabel: d.periodLabel,
      requestedAt: d.requestedAt.toISOString(),
      dueDate: d.dueDate ? d.dueDate.toISOString() : null,
      status: d.status as DocRequestStatus,
      submittedAt: d.submittedAt ? d.submittedAt.toISOString() : null,
      submittedReceiptId: d.submittedReceiptId,
      lastRemindedAt: agg?.lastSentAt ? agg.lastSentAt.toISOString() : null,
      lastOpenedAt: agg?.lastOpenedAt ? agg.lastOpenedAt.toISOString() : null,
      lastClickedAt: agg?.lastClickedAt ? agg.lastClickedAt.toISOString() : null,
      reminderSendCount: agg?.sendCount ?? 0,
    };
  });

  return { items, total };
}

export async function listSendsForRequest(
  tenantId: string,
  documentRequestId: string,
): Promise<Array<typeof reminderSends.$inferSelect>> {
  // Tenant-scope check before listing the audit trail.
  const req = await db.query.documentRequests.findFirst({
    where: and(
      eq(documentRequests.tenantId, tenantId),
      eq(documentRequests.id, documentRequestId),
    ),
  });
  if (!req) throw AppError.notFound('Document request not found');
  return db
    .select()
    .from(reminderSends)
    .where(
      and(
        eq(reminderSends.tenantId, tenantId),
        eq(reminderSends.questionId, documentRequestId),
      ),
    )
    .orderBy(desc(reminderSends.sentAt));
}

export async function markReceivedManually(
  tenantId: string,
  bookkeeperUserId: string,
  documentRequestId: string,
): Promise<void> {
  const before = await db.query.documentRequests.findFirst({
    where: and(
      eq(documentRequests.tenantId, tenantId),
      eq(documentRequests.id, documentRequestId),
    ),
  });
  if (!before) throw AppError.notFound('Document request not found');
  if (before.status !== 'pending') {
    throw AppError.conflict(`Document request is already ${before.status}`);
  }
  await db
    .update(documentRequests)
    .set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() })
    .where(eq(documentRequests.id, documentRequestId));
  await auditLog(
    tenantId,
    'update',
    'document_request',
    documentRequestId,
    { status: before.status },
    { status: 'submitted', source: 'manual' },
    bookkeeperUserId,
  );
}

export async function cancelRequest(
  tenantId: string,
  bookkeeperUserId: string,
  documentRequestId: string,
): Promise<void> {
  const before = await db.query.documentRequests.findFirst({
    where: and(
      eq(documentRequests.tenantId, tenantId),
      eq(documentRequests.id, documentRequestId),
    ),
  });
  if (!before) throw AppError.notFound('Document request not found');
  if (before.status !== 'pending') {
    throw AppError.conflict(`Document request is already ${before.status}`);
  }
  await db
    .update(documentRequests)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(documentRequests.id, documentRequestId));
  await auditLog(
    tenantId,
    'update',
    'document_request',
    documentRequestId,
    { status: before.status },
    { status: 'cancelled' },
    bookkeeperUserId,
  );
}

// Mark a request fulfilled by an uploaded receipt. Called from
// portal-receipts.service.ts when the upload form passed a
// documentRequestId. Idempotent — already-submitted rows are a no-op.
export async function markFulfilledByReceipt(
  tenantId: string,
  documentRequestId: string,
  receiptId: string,
): Promise<void> {
  const before = await db.query.documentRequests.findFirst({
    where: and(
      eq(documentRequests.tenantId, tenantId),
      eq(documentRequests.id, documentRequestId),
    ),
  });
  if (!before) throw AppError.notFound('Document request not found');
  if (before.status === 'submitted' && before.submittedReceiptId === receiptId) return;
  await db
    .update(documentRequests)
    .set({
      status: 'submitted',
      submittedAt: new Date(),
      submittedReceiptId: receiptId,
      updatedAt: new Date(),
    })
    .where(eq(documentRequests.id, documentRequestId));
  await auditLog(
    tenantId,
    'update',
    'document_request',
    documentRequestId,
    { status: before.status },
    { status: 'submitted', source: 'portal_upload', receiptId },
  );
}

// KPI rollups for the RemindersPage tile row.
export async function dashboardCounts(tenantId: string): Promise<{
  openRequests: number;
  overdue: number;
  avgFulfilDays: number | null;
}> {
  const open = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(documentRequests)
    .where(and(eq(documentRequests.tenantId, tenantId), eq(documentRequests.status, 'pending')));
  const overdue = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(documentRequests)
    .where(
      and(
        eq(documentRequests.tenantId, tenantId),
        eq(documentRequests.status, 'pending'),
        sql`${documentRequests.dueDate} IS NOT NULL AND ${documentRequests.dueDate} < NOW()`,
      ),
    );
  const fulfil = await db
    .select({
      avgDays: sql<number | null>`AVG(EXTRACT(EPOCH FROM (${documentRequests.submittedAt} - ${documentRequests.requestedAt})) / 86400)`,
    })
    .from(documentRequests)
    .where(
      and(
        eq(documentRequests.tenantId, tenantId),
        eq(documentRequests.status, 'submitted'),
        sql`${documentRequests.submittedAt} >= NOW() - INTERVAL '30 days'`,
      ),
    );
  const avg = fulfil[0]?.avgDays;
  return {
    openRequests: Number(open[0]?.n ?? 0),
    overdue: Number(overdue[0]?.n ?? 0),
    avgFulfilDays: avg === null || avg === undefined ? null : Number(avg),
  };
}

// Used by the portal-side dashboard panel — every pending request
// for a contact across companies. Filtered by tenant so a portal
// session can't read another firm's queue.
export async function listForPortalContact(
  tenantId: string,
  contactId: string,
): Promise<DocumentRequestSummary[]> {
  const rows = await db
    .select({
      d: documentRequests,
      contactEmail: portalContacts.email,
      contactFirstName: portalContacts.firstName,
      contactLastName: portalContacts.lastName,
    })
    .from(documentRequests)
    .innerJoin(portalContacts, eq(documentRequests.contactId, portalContacts.id))
    .where(
      and(
        eq(documentRequests.tenantId, tenantId),
        eq(documentRequests.contactId, contactId),
        eq(documentRequests.status, 'pending'),
      ),
    )
    .orderBy(asc(documentRequests.requestedAt));

  return rows.map(({ d, contactEmail, contactFirstName, contactLastName }) => ({
    id: d.id,
    tenantId: d.tenantId,
    companyId: d.companyId,
    recurringId: d.recurringId,
    contactId: d.contactId,
    contactEmail,
    contactName: [contactFirstName, contactLastName].filter(Boolean).join(' ') || null,
    documentType: d.documentType as DocumentRequestSummary['documentType'],
    description: d.description,
    periodLabel: d.periodLabel,
    requestedAt: d.requestedAt.toISOString(),
    dueDate: d.dueDate ? d.dueDate.toISOString() : null,
    status: d.status as DocRequestStatus,
    submittedAt: d.submittedAt ? d.submittedAt.toISOString() : null,
    submittedReceiptId: d.submittedReceiptId,
    lastRemindedAt: null,
    lastOpenedAt: null,
    lastClickedAt: null,
    reminderSendCount: 0,
  }));
}

// Used by ContactDetailPage's Documents panel — open + recently-
// fulfilled (last 90d) document_requests for the contact.
export async function listForContactDetail(
  tenantId: string,
  contactId: string,
): Promise<DocumentRequestSummary[]> {
  const rows = await db
    .select({ d: documentRequests })
    .from(documentRequests)
    .where(
      and(
        eq(documentRequests.tenantId, tenantId),
        eq(documentRequests.contactId, contactId),
        sql`(${documentRequests.status} IN ('pending') OR ${documentRequests.submittedAt} >= NOW() - INTERVAL '90 days')`,
      ),
    )
    .orderBy(desc(documentRequests.requestedAt));
  // Kept light — no aggregates here; the per-contact panel doesn't
  // need them and the document-requests grid carries the fully-
  // joined view.
  return rows.map(({ d }) => ({
    id: d.id,
    tenantId: d.tenantId,
    companyId: d.companyId,
    recurringId: d.recurringId,
    contactId: d.contactId,
    contactEmail: '',
    contactName: null,
    documentType: d.documentType as DocumentRequestSummary['documentType'],
    description: d.description,
    periodLabel: d.periodLabel,
    requestedAt: d.requestedAt.toISOString(),
    dueDate: d.dueDate ? d.dueDate.toISOString() : null,
    status: d.status as DocRequestStatus,
    submittedAt: d.submittedAt ? d.submittedAt.toISOString() : null,
    submittedReceiptId: d.submittedReceiptId,
    lastRemindedAt: null,
    lastOpenedAt: null,
    lastClickedAt: null,
    reminderSendCount: 0,
  }));
}

