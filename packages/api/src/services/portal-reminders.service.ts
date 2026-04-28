// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import nodemailer from 'nodemailer';
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  documentRequests,
  portalContacts,
  portalQuestions,
  portalSettingsPerPractice,
  reminderSchedules,
  reminderSends,
  reminderSuppressions,
  reminderTemplates,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { getSmtpSettings } from './admin.service.js';
import { auditLog } from '../middleware/audit.js';
import { escapeHtml } from './report-export.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 13 — automated reminders.
// Scan job + dispatch + suppression. Email-first; SMS deferred until
// a Twilio/TextLinkSMS provider is wired (the channel column already
// supports it).

const DEFAULT_DIGEST_SUBJECT = 'You have new questions waiting';

interface MailerHandle {
  send: (to: string, subject: string, html: string, text: string) => Promise<void>;
  isStub: boolean;
}

async function getMailer(): Promise<MailerHandle> {
  const smtp = await getSmtpSettings();
  const from = smtp.smtpFrom || 'noreply@example.com';
  if (!smtp.smtpHost) {
    return {
      isStub: true,
      send: async (to, subject, _html, text) => {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            component: 'reminder-mail-stub',
            event: 'send',
            to,
            subject,
            preview: text.slice(0, 400),
          }),
        );
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: smtp.smtpHost,
    port: smtp.smtpPort,
    secure: smtp.smtpPort === 465,
    auth: smtp.smtpUser ? { user: smtp.smtpUser, pass: smtp.smtpPass } : undefined,
  });
  return {
    isStub: false,
    send: async (to, subject, html, text) => {
      await transport.sendMail({ from, to, subject, html, text });
    },
  };
}

// 13.6 — engagement-based suppression check. Treats any portal
// activity by the contact in the last 7 days, or an active explicit
// suppression row, as "do not send".
async function isSuppressed(contactId: string, channel: 'email' | 'sms'): Promise<boolean> {
  const now = new Date();

  const suppression = await db
    .select()
    .from(reminderSuppressions)
    .where(
      and(
        eq(reminderSuppressions.contactId, contactId),
        sql`(${reminderSuppressions.channel} IS NULL OR ${reminderSuppressions.channel} = ${channel})`,
        sql`(${reminderSuppressions.expiresAt} IS NULL OR ${reminderSuppressions.expiresAt} > ${now})`,
      ),
    )
    .limit(1);
  if (suppression.length > 0) return true;

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const contact = await db.query.portalContacts.findFirst({
    where: eq(portalContacts.id, contactId),
  });
  if (contact?.lastSeenAt && contact.lastSeenAt > sevenDaysAgo) return true;

  return false;
}

// 13.6 — max-per-week cap. Counts sends across all schedules so a
// contact can never exceed N total reminders/week.
async function exceededWeeklyCap(contactId: string, max: number): Promise<boolean> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(reminderSends)
    .where(
      and(
        eq(reminderSends.contactId, contactId),
        gte(reminderSends.sentAt, sevenDaysAgo),
      ),
    );
  return Number(rows[0]?.n ?? 0) >= max;
}

// Scan: produce the digest payload for every active schedule. One
// email per (contact, schedule) — the digest format includes every
// outstanding question.
export interface ReminderCandidate {
  scheduleId: string;
  tenantId: string;
  contactId: string;
  contactEmail: string;
  contactFirstName: string | null;
  triggerType: string;
  channel: 'email' | 'sms';
  questionIds: string[];
  maxPerWeek: number;
}

// Returns true when the contact is currently inside the schedule's
// quiet hours window. Quiet hours are stored as integer hours (0-23)
// in the schedule's timezone. Window may wrap across midnight
// (start=20, end=8 means "quiet from 20:00 to 08:00"). Exported for
// test coverage; the dispatch loop is the only production caller.
export function isInQuietHours(
  now: Date,
  startHour: number,
  endHour: number,
  timezone: string,
): boolean {
  if (startHour === endHour) return false;
  const fmt = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    hour12: false,
    timeZone: timezone || 'UTC',
  });
  const parts = fmt.formatToParts(now);
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
  let h = parseInt(hourPart, 10);
  if (h === 24) h = 0; // some locales report "24" for midnight
  if (startHour < endHour) {
    return h >= startHour && h < endHour;
  }
  return h >= startHour || h < endHour;
}

// Pick the cadence step to fire for a question. Given cadenceDays
// e.g. [3,7,14] and a question that was first notified at notifiedAt,
// returns the step number (1-based) that should be sent now, or null
// if no step is due. The number of prior reminder sends to the same
// contact for the same question determines which step is next.
// Exported for unit-test coverage.
export function nextCadenceStep(
  cadence: number[],
  notifiedAt: Date,
  priorSendCount: number,
  now: Date,
): number | null {
  const ageDays = (now.getTime() - notifiedAt.getTime()) / (24 * 60 * 60 * 1000);
  // Steps are indexed 0..cadence.length-1; priorSendCount = N means
  // we've already sent N reminders, so step N (the (N+1)-th) is next.
  const stepIdx = priorSendCount;
  if (stepIdx >= cadence.length) return null;
  const stepDay = cadence[stepIdx];
  if (typeof stepDay !== 'number' || !Number.isFinite(stepDay) || stepDay < 1) return null;
  if (ageDays < stepDay) return null;
  return stepIdx + 1;
}

export async function scanForReminders(tenantId?: string): Promise<ReminderCandidate[]> {
  // Currently implements only `unanswered_question`. The other trigger
  // types (w9_pending, doc_request, recurring_non_transaction,
  // magic_link_expiring) plug into the same scan loop — additional
  // queries can be added behind the same digest-grouping primitive.
  const schedules = await db
    .select()
    .from(reminderSchedules)
    .where(
      and(
        eq(reminderSchedules.active, true),
        eq(reminderSchedules.triggerType, 'unanswered_question'),
        tenantId ? eq(reminderSchedules.tenantId, tenantId) : sql`TRUE`,
      ),
    );

  const candidates: ReminderCandidate[] = [];
  const now = new Date();

  for (const sched of schedules) {
    const cadence = Array.isArray(sched.cadenceDays) ? (sched.cadenceDays as number[]) : [3, 7, 14];
    const minDays = Math.min(...cadence);
    if (!Number.isFinite(minDays) || minDays < 1) continue;

    // Quiet hours — skip the entire schedule for this tick if we're
    // currently inside the window.
    if (isInQuietHours(now, sched.quietHoursStart, sched.quietHoursEnd, sched.timezone)) {
      continue;
    }

    const cutoff = new Date(now.getTime() - minDays * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        questionId: portalQuestions.id,
        notifiedAt: portalQuestions.notifiedAt,
        contactId: portalQuestions.assignedContactId,
        contactEmail: portalContacts.email,
        contactFirstName: portalContacts.firstName,
      })
      .from(portalQuestions)
      .innerJoin(portalContacts, eq(portalQuestions.assignedContactId, portalContacts.id))
      .where(
        and(
          eq(portalQuestions.tenantId, sched.tenantId),
          sched.companyId ? eq(portalQuestions.companyId, sched.companyId) : sql`TRUE`,
          inArray(portalQuestions.status, ['open', 'viewed']),
          sql`${portalQuestions.notifiedAt} IS NOT NULL`,
          lt(portalQuestions.notifiedAt, cutoff),
          eq(portalContacts.status, 'active'),
        ),
      );

    // For each question, compute whether the next cadence step is
    // due. Group by contact so we send one digest per contact per
    // schedule rather than N emails per question.
    const byContact = new Map<string, ReminderCandidate>();
    for (const row of rows) {
      if (!row.contactId || !row.notifiedAt) continue;

      const priorSends = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(reminderSends)
        .where(
          and(
            eq(reminderSends.scheduleId, sched.id),
            eq(reminderSends.contactId, row.contactId),
            eq(reminderSends.questionId, row.questionId),
          ),
        );
      const priorCount = Number(priorSends[0]?.n ?? 0);
      const step = nextCadenceStep(cadence, row.notifiedAt, priorCount, now);
      if (step === null) continue;

      const existing = byContact.get(row.contactId);
      if (existing) {
        existing.questionIds.push(row.questionId);
      } else {
        byContact.set(row.contactId, {
          scheduleId: sched.id,
          tenantId: sched.tenantId,
          contactId: row.contactId,
          contactEmail: row.contactEmail,
          contactFirstName: row.contactFirstName,
          triggerType: sched.triggerType,
          channel: 'email',
          questionIds: [row.questionId],
          maxPerWeek: sched.maxPerWeek,
        });
      }
    }
    candidates.push(...byContact.values());
  }
  return candidates;
}

export interface DispatchResult {
  attempted: number;
  sent: number;
  suppressed: number;
  capped: number;
}

// Returns a map of (tenantId|triggerType|channel) -> template body,
// pre-fetched so the dispatch loop avoids per-candidate queries.
async function loadTemplatesByTrigger(
  tenantIds: string[],
): Promise<Map<string, { subject: string | null; body: string }>> {
  const out = new Map<string, { subject: string | null; body: string }>();
  if (tenantIds.length === 0) return out;
  const rows = await db
    .select()
    .from(reminderTemplates)
    .where(inArray(reminderTemplates.tenantId, tenantIds));
  for (const r of rows) {
    out.set(`${r.tenantId}|${r.triggerType}|${r.channel}`, {
      subject: r.subject,
      body: r.body,
    });
  }
  return out;
}

function renderTemplate(
  body: string,
  vars: Record<string, string | number>,
): string {
  return body.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined ? '' : String(v);
  });
}

export async function dispatch(tenantId?: string): Promise<DispatchResult> {
  const candidates = await scanForReminders(tenantId);
  const mailer = await getMailer();
  const tenantIds = Array.from(new Set(candidates.map((c) => c.tenantId)));
  const templates = await loadTemplatesByTrigger(tenantIds);
  const linkBase = (process.env['PORTAL_BASE_URL'] || 'http://localhost:5173').replace(/\/$/, '');

  let sent = 0;
  let suppressed = 0;
  let capped = 0;

  for (const c of candidates) {
    if (await isSuppressed(c.contactId, c.channel)) {
      suppressed++;
      continue;
    }
    if (await exceededWeeklyCap(c.contactId, c.maxPerWeek)) {
      capped++;
      continue;
    }

    const sendRow = await db
      .insert(reminderSends)
      .values({
        scheduleId: c.scheduleId,
        tenantId: c.tenantId,
        contactId: c.contactId,
        questionId: c.questionIds[0] ?? null,
        channel: c.channel,
      })
      .returning({ id: reminderSends.id });
    const sendId = sendRow[0]?.id;
    if (!sendId) continue;

    const portalLink = `${linkBase}/portal/login`;
    const trackingPixel = `${linkBase}/api/portal/track/${sendId}/open.gif`;
    const trackedClick = `${linkBase}/api/portal/track/${sendId}/click?to=${encodeURIComponent(portalLink)}`;
    const firstName = c.contactFirstName ?? '';
    const openCount = c.questionIds.length;
    const tplKey = `${c.tenantId}|${c.triggerType}|${c.channel}`;
    const tpl = templates.get(tplKey);

    const subject = tpl?.subject || DEFAULT_DIGEST_SUBJECT;

    let text: string;
    let htmlBody: string;
    if (tpl) {
      const rendered = renderTemplate(tpl.body, {
        first_name: firstName,
        open_count: openCount,
        portal_link: portalLink,
        firm_name: '',
      });
      text = rendered;
      // Auto-link the portal URL inside the rendered body for HTML.
      const escaped = escapeHtml(rendered).replace(
        /(https?:\/\/[^\s<]+)/g,
        (m) => `<a href="${m === portalLink ? trackedClick : m}">${m}</a>`,
      );
      htmlBody = `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">${escaped.replace(/\n/g, '<br>')}</div>`;
    } else {
      const greeting = firstName ? `Hi ${firstName},` : 'Hello,';
      text = `${greeting}\n\nYour bookkeeper is waiting on ${openCount} question${openCount === 1 ? '' : 's'}. Sign in to your portal to respond:\n\n${portalLink}\n\nReply STOP at any time to stop these reminders.`;
      const safeGreeting = escapeHtml(greeting);
      htmlBody = `<p>${safeGreeting}</p><p>Your bookkeeper is waiting on <strong>${openCount}</strong> question${openCount === 1 ? '' : 's'}.</p><p><a href="${trackedClick}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Open my portal</a></p><p style="color:#888;font-size:12px">Reply STOP at any time to stop these reminders.</p>`;
    }
    const html = `${htmlBody}<img src="${trackingPixel}" width="1" height="1" alt="" style="display:none">`;

    try {
      await mailer.send(c.contactEmail, subject, html, text);
      sent++;
    } catch (err) {
      await db
        .update(reminderSends)
        .set({ error: err instanceof Error ? err.message : String(err) })
        .where(eq(reminderSends.id, sendId));
    }
  }

  // Fold doc_request escalations into the same dispatch tick so a
  // single advisory-locked cycle covers both unanswered_question and
  // doc_request triggers. RECURRING_DOC_REQUESTS_V1.
  const docs = await dispatchDocRequests(tenantId);
  return {
    attempted: candidates.length + docs.attempted,
    sent: sent + docs.sent,
    suppressed: suppressed + docs.suppressed,
    capped: capped + docs.capped,
  };
}

// 13.5 — pixel hit. Side effect: marks opened_at and contact last_seen.
export async function recordOpen(sendId: string): Promise<void> {
  const send = await db.query.reminderSends.findFirst({ where: eq(reminderSends.id, sendId) });
  if (!send) return;
  if (send.openedAt) return;
  await db.transaction(async (tx) => {
    await tx
      .update(reminderSends)
      .set({ openedAt: new Date() })
      .where(eq(reminderSends.id, sendId));
    await tx
      .update(portalContacts)
      .set({ lastSeenAt: new Date() })
      .where(eq(portalContacts.id, send.contactId));
  });
}

export async function recordClick(sendId: string): Promise<{ to: string | null }> {
  const send = await db.query.reminderSends.findFirst({ where: eq(reminderSends.id, sendId) });
  if (!send) return { to: null };
  await db
    .update(reminderSends)
    .set({ clickedAt: send.clickedAt ?? new Date() })
    .where(eq(reminderSends.id, sendId));
  return { to: null };
}

// 13.6 / 13.9 — STOP keyword (TCPA hard requirement). Adds a
// permanent suppression row for the channel. Internal helper — does
// not check tenant; only call from a trusted path that has already
// verified the contact (e.g. an inbound SMS webhook authenticated by
// signature, or the tenant-scoped wrapper below).
export async function suppress(contactId: string, reason: string, channel?: 'email' | 'sms'): Promise<void> {
  await db.insert(reminderSuppressions).values({
    contactId,
    reason,
    channel: channel ?? null,
  });
}

// Tenant-scoped wrapper for the bookkeeper UI. Verifies the contact
// belongs to the requesting tenant before writing the suppression so
// a stolen UUID can't be used to mute another firm's contact.
export async function suppressForTenant(
  tenantId: string,
  bookkeeperUserId: string,
  contactId: string,
  reason: string,
  channel?: 'email' | 'sms',
): Promise<void> {
  const c = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.id, contactId)),
  });
  if (!c) throw AppError.notFound('Contact not found');
  await suppress(contactId, reason, channel);
  await auditLog(
    tenantId,
    'create',
    'reminder_suppression',
    contactId,
    null,
    { reason, channel: channel ?? null },
    bookkeeperUserId,
  );
}

export async function unsuppress(
  tenantId: string,
  contactId: string,
  bookkeeperUserId?: string,
): Promise<number> {
  // Tenant scope check — the contact must belong to this tenant before
  // we delete suppressions on their behalf.
  const c = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.id, contactId)),
  });
  if (!c) throw AppError.notFound('Contact not found');
  const res = await db.delete(reminderSuppressions).where(eq(reminderSuppressions.contactId, contactId));
  const removed = (res as { rowCount?: number }).rowCount ?? 0;
  if (removed > 0) {
    await auditLog(
      tenantId,
      'delete',
      'reminder_suppression',
      contactId,
      { removed },
      null,
      bookkeeperUserId,
    );
  }
  return removed;
}

// 13.8 — preview queue: same scan logic, scoped to the requesting
// tenant, capped to the next N candidates and grouped for the admin
// UI.
export async function previewQueue(tenantId: string): Promise<ReminderCandidate[]> {
  const all = await scanForReminders(tenantId);
  return all.slice(0, 200);
}

// ── Schedule + template CRUD ─────────────────────────────────────

export interface ScheduleInput {
  triggerType: string;
  cadenceDays: number[];
  channelStrategy: 'email_only' | 'sms_only' | 'both' | 'escalating';
  quietHoursStart?: number;
  quietHoursEnd?: number;
  maxPerWeek?: number;
  companyId?: string | null;
  active?: boolean;
}

export async function listSchedules(tenantId: string) {
  return db
    .select()
    .from(reminderSchedules)
    .where(eq(reminderSchedules.tenantId, tenantId))
    .orderBy(desc(reminderSchedules.createdAt));
}

export async function createSchedule(
  tenantId: string,
  bookkeeperUserId: string,
  input: ScheduleInput,
): Promise<{ id: string }> {
  const inserted = await db
    .insert(reminderSchedules)
    .values({
      tenantId,
      companyId: input.companyId ?? null,
      triggerType: input.triggerType,
      cadenceDays: input.cadenceDays,
      channelStrategy: input.channelStrategy,
      quietHoursStart: input.quietHoursStart ?? 20,
      quietHoursEnd: input.quietHoursEnd ?? 8,
      maxPerWeek: input.maxPerWeek ?? 3,
      active: input.active ?? true,
    })
    .returning({ id: reminderSchedules.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  await auditLog(tenantId, 'create', 'reminder_schedule', row.id, null, input, bookkeeperUserId);
  return { id: row.id };
}

export async function deleteSchedule(tenantId: string, id: string, bookkeeperUserId: string) {
  const before = await db.query.reminderSchedules.findFirst({
    where: and(eq(reminderSchedules.tenantId, tenantId), eq(reminderSchedules.id, id)),
  });
  if (!before) throw AppError.notFound('Schedule not found');
  await db.delete(reminderSchedules).where(eq(reminderSchedules.id, id));
  await auditLog(tenantId, 'delete', 'reminder_schedule', id, before, null, bookkeeperUserId);
}

export async function setScheduleActive(
  tenantId: string,
  id: string,
  active: boolean,
  bookkeeperUserId: string,
): Promise<void> {
  const before = await db.query.reminderSchedules.findFirst({
    where: and(eq(reminderSchedules.tenantId, tenantId), eq(reminderSchedules.id, id)),
  });
  if (!before) throw AppError.notFound('Schedule not found');
  await db
    .update(reminderSchedules)
    .set({ active, updatedAt: new Date() })
    .where(eq(reminderSchedules.id, id));
  await auditLog(
    tenantId,
    'update',
    'reminder_schedule',
    id,
    { active: before.active },
    { active },
    bookkeeperUserId,
  );
}

export interface TemplateInput {
  triggerType: string;
  channel: 'email' | 'sms';
  subject?: string | null;
  body: string;
}

export async function listTemplates(tenantId: string) {
  return db
    .select()
    .from(reminderTemplates)
    .where(eq(reminderTemplates.tenantId, tenantId))
    .orderBy(reminderTemplates.triggerType);
}

export async function upsertTemplate(
  tenantId: string,
  bookkeeperUserId: string,
  input: TemplateInput,
): Promise<{ id: string }> {
  // One row per (tenant, trigger, channel). We treat that as the
  // logical key — delete any existing and insert fresh.
  const existing = await db
    .select()
    .from(reminderTemplates)
    .where(
      and(
        eq(reminderTemplates.tenantId, tenantId),
        eq(reminderTemplates.triggerType, input.triggerType),
        eq(reminderTemplates.channel, input.channel),
      ),
    );
  const before = existing[0] ?? null;
  for (const e of existing) {
    await db.delete(reminderTemplates).where(eq(reminderTemplates.id, e.id));
  }
  const inserted = await db
    .insert(reminderTemplates)
    .values({
      tenantId,
      triggerType: input.triggerType,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
    })
    .returning({ id: reminderTemplates.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  await auditLog(
    tenantId,
    before ? 'update' : 'create',
    'reminder_template',
    row.id,
    before,
    input,
    bookkeeperUserId,
  );
  return { id: row.id };
}

// 13.5 — reporting helper used by the admin dashboard widget.
// DOC_REQUEST_SMS_V1 — also returns the SMS-channel-only sent count so
// the UI can surface a separate "SMS sent" tile.
export async function openRateLast30Days(tenantId: string): Promise<{
  sent: number;
  opened: number;
  rate: number;
  smtpConfigured: boolean;
  smsSent: number;
  smsDelivered: number;
}> {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      sent: sql<number>`COUNT(*)::int`,
      opened: sql<number>`COUNT(*) FILTER (WHERE ${reminderSends.openedAt} IS NOT NULL)::int`,
      smsSent: sql<number>`COUNT(*) FILTER (WHERE ${reminderSends.channel} = 'sms')::int`,
      smsDelivered: sql<number>`COUNT(*) FILTER (WHERE ${reminderSends.channel} = 'sms' AND ${reminderSends.deliveredAt} IS NOT NULL)::int`,
    })
    .from(reminderSends)
    .where(and(eq(reminderSends.tenantId, tenantId), gte(reminderSends.sentAt, cutoff)));
  const sent = Number(rows[0]?.sent ?? 0);
  const opened = Number(rows[0]?.opened ?? 0);
  const smsSent = Number(rows[0]?.smsSent ?? 0);
  const smsDelivered = Number(rows[0]?.smsDelivered ?? 0);
  const smtp = await getSmtpSettings();
  return {
    smsSent,
    smsDelivered,
    sent,
    opened,
    rate: sent === 0 ? 0 : opened / sent,
    smtpConfigured: Boolean(smtp.smtpHost),
  };
}

// Cleanup: remove old suppressions whose expiry has passed.
export async function purgeExpiredSuppressions(): Promise<number> {
  const now = new Date();
  const res = await db
    .delete(reminderSuppressions)
    .where(
      and(
        sql`${reminderSuppressions.expiresAt} IS NOT NULL`,
        lt(reminderSuppressions.expiresAt, now),
      ),
    );
  return (res as { rowCount?: number }).rowCount ?? 0;
}

// ── doc_request trigger ────────────────────────────────────────
// RECURRING_DOC_REQUESTS_V1. The opener email is sent by the
// recurring-doc-request scheduler with scheduleId=null at issuance
// time; the cadenceDays escalation runs through the same scan +
// dispatch loop as unanswered_question, just with a different
// triggerType and a different source table (document_requests).
//
// Prior-send count for cadence-step selection only counts sends
// tied to the firm-configured doc_request schedule (scheduleId =
// sched.id); openers with scheduleId=null are intentionally excluded
// so the first cadence step still fires after `cadenceDays[0]` days.

export interface DocRequestCandidate {
  scheduleId: string;
  tenantId: string;
  contactId: string;
  contactEmail: string;
  contactPhone: string | null;
  contactFirstName: string | null;
  documentRequestId: string;
  description: string;
  periodLabel: string;
  dueDate: Date | null;
  // The schedule-level strategy. dispatchDocRequests resolves it
  // into the actual channel(s) at send time via chooseChannelsForCandidate.
  channelStrategy: 'email_only' | 'sms_only' | 'both' | 'escalating';
  // Cadence step number this candidate represents (1-based). Used by
  // the `escalating` strategy to decide email-vs-SMS.
  step: number;
  maxPerWeek: number;
}

// DOC_REQUEST_SMS_V1 — pure helper. Given the schedule's channel
// strategy, the cadence step number, and whether the contact has a
// phone + the firm has SMS turned on, returns the channels to attempt.
// Exported for unit-test coverage.
export function chooseChannelsForCandidate(
  strategy: 'email_only' | 'sms_only' | 'both' | 'escalating',
  step: number,
  hasPhone: boolean,
  smsAvailable: boolean,
): ('email' | 'sms')[] {
  const sms = hasPhone && smsAvailable;
  switch (strategy) {
    case 'email_only':
      return ['email'];
    case 'sms_only':
      return sms ? ['sms'] : [];
    case 'both':
      return sms ? ['email', 'sms'] : ['email'];
    case 'escalating':
      // First two steps email; from step 3 onward, SMS — falling back
      // to email when SMS is unavailable so the contact still hears
      // from us. Once you hit step 3 you've been chasing the contact
      // for ~2 weeks; falling back to email beats silence.
      if (step <= 2) return ['email'];
      return sms ? ['sms'] : ['email'];
    default:
      return ['email'];
  }
}

// DOC_REQUEST_SMS_V1 — render an SMS body with single-segment-by-default
// truncation. Reserves a 23-char STOP footer (`Reply STOP to opt out.`)
// out of the budget so even a fully-truncated body still carries the
// TCPA-required opt-out instruction. Exported for unit-test coverage.
export function renderSmsBody(
  template: string,
  vars: Record<string, string | number>,
  allowMultiSegment: boolean,
): string {
  const STOP_FOOTER = ' Reply STOP to opt out.';
  const SINGLE_SEGMENT_BUDGET = 160;
  const rendered = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const v = vars[key];
    return v === undefined ? '' : String(v);
  }).trim();
  if (allowMultiSegment) {
    return `${rendered}${STOP_FOOTER}`;
  }
  const bodyBudget = SINGLE_SEGMENT_BUDGET - STOP_FOOTER.length;
  let body = rendered;
  if (body.length > bodyBudget) {
    body = body.slice(0, bodyBudget - 1).replace(/\s+\S*$/, '') + '…';
  }
  return `${body}${STOP_FOOTER}`;
}

export async function scanDocRequestReminders(tenantId?: string): Promise<DocRequestCandidate[]> {
  const schedules = await db
    .select()
    .from(reminderSchedules)
    .where(
      and(
        eq(reminderSchedules.active, true),
        eq(reminderSchedules.triggerType, 'doc_request'),
        tenantId ? eq(reminderSchedules.tenantId, tenantId) : sql`TRUE`,
      ),
    );

  const now = new Date();
  const out: DocRequestCandidate[] = [];

  for (const sched of schedules) {
    const cadence = Array.isArray(sched.cadenceDays) ? (sched.cadenceDays as number[]) : [3, 7, 14];
    if (cadence.length === 0) continue;
    const minDays = Math.min(...cadence);
    if (!Number.isFinite(minDays) || minDays < 1) continue;
    if (isInQuietHours(now, sched.quietHoursStart, sched.quietHoursEnd, sched.timezone)) continue;

    const cutoff = new Date(now.getTime() - minDays * 24 * 60 * 60 * 1000);

    const rows = await db
      .select({
        documentRequestId: documentRequests.id,
        requestedAt: documentRequests.requestedAt,
        description: documentRequests.description,
        periodLabel: documentRequests.periodLabel,
        dueDate: documentRequests.dueDate,
        contactId: documentRequests.contactId,
        contactEmail: portalContacts.email,
        contactPhone: portalContacts.phone,
        contactFirstName: portalContacts.firstName,
      })
      .from(documentRequests)
      .innerJoin(portalContacts, eq(documentRequests.contactId, portalContacts.id))
      .where(
        and(
          eq(documentRequests.tenantId, sched.tenantId),
          sched.companyId ? eq(documentRequests.companyId, sched.companyId) : sql`TRUE`,
          eq(documentRequests.status, 'pending'),
          lt(documentRequests.requestedAt, cutoff),
          eq(portalContacts.status, 'active'),
        ),
      );

    for (const row of rows) {
      const priorSends = await db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(reminderSends)
        .where(
          and(
            eq(reminderSends.scheduleId, sched.id),
            eq(reminderSends.contactId, row.contactId),
            eq(reminderSends.questionId, row.documentRequestId),
          ),
        );
      const priorCount = Number(priorSends[0]?.n ?? 0);
      const step = nextCadenceStep(cadence, row.requestedAt, priorCount, now);
      if (step === null) continue;

      out.push({
        scheduleId: sched.id,
        tenantId: sched.tenantId,
        contactId: row.contactId,
        contactEmail: row.contactEmail,
        contactPhone: row.contactPhone,
        contactFirstName: row.contactFirstName,
        documentRequestId: row.documentRequestId,
        description: row.description,
        periodLabel: row.periodLabel,
        dueDate: row.dueDate,
        channelStrategy: (sched.channelStrategy ?? 'email_only') as DocRequestCandidate['channelStrategy'],
        step,
        maxPerWeek: sched.maxPerWeek,
      });
    }
  }

  return out;
}

// DOC_REQUEST_SMS_V1 — single-channel send helper. Email and SMS
// branch off the same (suppression, cap, reminder_sends row) shell;
// the channel-specific bits are the body rendering and the transport
// call. `forceCanSend` skips the cap (used by openers and force-nudge).
async function sendDocRequestNotice(
  tenantId: string,
  scheduleId: string | null,
  contactId: string,
  contactEmail: string,
  contactPhone: string | null,
  contactFirstName: string | null,
  documentRequestId: string,
  description: string,
  periodLabel: string,
  dueDate: Date | null,
  isOpener: boolean,
  maxPerWeek: number,
  channel: 'email' | 'sms',
): Promise<'sent' | 'suppressed' | 'capped' | 'error' | 'no_phone' | 'sms_disabled'> {
  if (await isSuppressed(contactId, channel)) return 'suppressed';
  if (!isOpener && (await exceededWeeklyCap(contactId, maxPerWeek))) return 'capped';

  if (channel === 'sms') {
    if (!contactPhone) return 'no_phone';
    const tenantSms = await getTenantSmsSettings(tenantId);
    if (!tenantSms.smsOutboundEnabled) return 'sms_disabled';
  }

  const sendRow = await db
    .insert(reminderSends)
    .values({
      scheduleId: scheduleId,
      tenantId,
      contactId,
      questionId: documentRequestId,
      channel,
    })
    .returning({ id: reminderSends.id });
  const sendId = sendRow[0]?.id;
  if (!sendId) return 'error';

  const linkBase = (process.env['PORTAL_BASE_URL'] || 'http://localhost:5173').replace(/\/$/, '');
  const portalLink = `${linkBase}/portal/login`;
  const firstName = contactFirstName ?? '';
  const dueDateStr = dueDate ? dueDate.toISOString().slice(0, 10) : '';

  if (channel === 'email') {
    return sendEmailLeg(
      sendId, tenantId, contactEmail, isOpener,
      firstName, description, periodLabel, dueDateStr,
      portalLink, linkBase,
    );
  }

  // SMS leg.
  return sendSmsLeg(
    sendId, tenantId, contactPhone!, isOpener,
    firstName, description, periodLabel, dueDateStr, portalLink,
  );
}

async function sendEmailLeg(
  sendId: string,
  tenantId: string,
  contactEmail: string,
  isOpener: boolean,
  firstName: string,
  description: string,
  periodLabel: string,
  dueDateStr: string,
  portalLink: string,
  linkBase: string,
): Promise<'sent' | 'error'> {
  const trackingPixel = `${linkBase}/api/portal/track/${sendId}/open.gif`;
  const trackedClick = `${linkBase}/api/portal/track/${sendId}/click?to=${encodeURIComponent(portalLink)}`;

  const tpl = await loadDocRequestTemplate(tenantId, 'email');
  const subject = tpl?.subject || `Document needed — ${description} (${periodLabel})`;
  const body = tpl?.body || (
    isOpener
      ? `Hi {first_name},\n\nWe need {description} for {period_label} by {due_date}. Upload it via your portal: {portal_link}\n\nReply STOP to opt out of these reminders.`
      : `Hi {first_name},\n\nReminder: {description} for {period_label} is still outstanding (due {due_date}). Please upload via {portal_link}.\n\nReply STOP to opt out.`
  );
  const rendered = renderTemplate(body, {
    first_name: firstName,
    description,
    document_type: '',
    period_label: periodLabel,
    due_date: dueDateStr,
    portal_link: portalLink,
    firm_name: '',
  });
  const text = rendered;
  const escaped = escapeHtml(rendered).replace(
    /(https?:\/\/[^\s<]+)/g,
    (m) => `<a href="${m === portalLink ? trackedClick : m}">${m}</a>`,
  );
  const htmlBody = `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">${escaped.replace(/\n/g, '<br>')}</div>`;
  const html = `${htmlBody}<img src="${trackingPixel}" width="1" height="1" alt="" style="display:none">`;

  const mailer = await getMailer();
  try {
    await mailer.send(contactEmail, subject, html, text);
    return 'sent';
  } catch (err) {
    await db
      .update(reminderSends)
      .set({ error: err instanceof Error ? err.message : String(err) })
      .where(eq(reminderSends.id, sendId));
    return 'error';
  }
}

async function sendSmsLeg(
  sendId: string,
  tenantId: string,
  contactPhone: string,
  isOpener: boolean,
  firstName: string,
  description: string,
  periodLabel: string,
  dueDateStr: string,
  portalLink: string,
): Promise<'sent' | 'error' | 'sms_disabled'> {
  // System-level SMS provider config (Twilio / TextLinkSMS).
  const tfaConfigService = await import('./tfa-config.service.js');
  const smsProviderModule = await import('./sms-providers/index.js');
  const rawTfa = await tfaConfigService.getRawConfig();
  if (!rawTfa.smsProvider) {
    await db
      .update(reminderSends)
      .set({ error: 'No SMS provider configured at the system level' })
      .where(eq(reminderSends.id, sendId));
    return 'sms_disabled';
  }
  const tenantSettings = await getTenantSmsSettings(tenantId);

  const tpl = await loadDocRequestTemplate(tenantId, 'sms');
  const body = tpl?.body || (
    isOpener
      ? `Hi {first_name}, please upload {description} for {period_label} by {due_date}: {portal_link}`
      : `{first_name}, {description} for {period_label} still outstanding (due {due_date}). Upload: {portal_link}`
  );
  const rendered = renderSmsBody(
    body,
    {
      first_name: firstName,
      description,
      period_label: periodLabel,
      due_date: dueDateStr,
      portal_link: portalLink,
    },
    tenantSettings.smsAllowMultiSegment,
  );

  let provider;
  try {
    provider = smsProviderModule.getSmsProvider(rawTfa);
  } catch (err) {
    await db
      .update(reminderSends)
      .set({ error: err instanceof Error ? err.message : String(err) })
      .where(eq(reminderSends.id, sendId));
    return 'error';
  }

  const result = await provider.sendText(contactPhone, rendered);
  if (result.success) {
    await db
      .update(reminderSends)
      .set({
        providerMessageId: result.providerMessageId ?? null,
        providerStatus: 'sent',
      })
      .where(eq(reminderSends.id, sendId));
    return 'sent';
  }
  await db
    .update(reminderSends)
    .set({ error: result.error ?? 'sms_send_failed', providerStatus: 'failed' })
    .where(eq(reminderSends.id, sendId));
  return 'error';
}

async function getTenantSmsSettings(tenantId: string): Promise<{ smsOutboundEnabled: boolean; smsAllowMultiSegment: boolean }> {
  const row = await db.query.portalSettingsPerPractice.findFirst({
    where: eq(portalSettingsPerPractice.tenantId, tenantId),
  });
  return {
    smsOutboundEnabled: row?.smsOutboundEnabled ?? false,
    smsAllowMultiSegment: row?.smsAllowMultiSegment ?? false,
  };
}

async function loadDocRequestTemplate(tenantId: string, channel: 'email' | 'sms'): Promise<{ subject: string | null; body: string } | null> {
  const rows = await db
    .select()
    .from(reminderTemplates)
    .where(
      and(
        eq(reminderTemplates.tenantId, tenantId),
        eq(reminderTemplates.triggerType, 'doc_request'),
        eq(reminderTemplates.channel, channel),
      ),
    )
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { subject: r.subject, body: r.body };
}

export async function dispatchDocRequests(tenantId?: string): Promise<DispatchResult> {
  const candidates = await scanDocRequestReminders(tenantId);
  let attempted = 0;
  let sent = 0;
  let suppressed = 0;
  let capped = 0;

  // Pre-resolve per-tenant SMS availability so each candidate doesn't
  // re-fetch tfa_config + portal_settings_per_practice. tfa_config is
  // a singleton at the system level so one fetch covers everyone;
  // tenant settings are batched.
  const tfaConfigService = await import('./tfa-config.service.js');
  const rawTfa = await tfaConfigService.getRawConfig();
  const systemSmsConfigured = !!rawTfa.smsProvider;

  const tenantIds = Array.from(new Set(candidates.map((c) => c.tenantId)));
  const tenantSmsMap = new Map<string, boolean>();
  if (tenantIds.length > 0) {
    const rows = await db
      .select()
      .from(portalSettingsPerPractice)
      .where(inArray(portalSettingsPerPractice.tenantId, tenantIds));
    for (const r of rows) tenantSmsMap.set(r.tenantId, r.smsOutboundEnabled);
  }

  for (const c of candidates) {
    const tenantSmsOn = tenantSmsMap.get(c.tenantId) ?? false;
    const smsAvailable = systemSmsConfigured && tenantSmsOn;
    const channels = chooseChannelsForCandidate(
      c.channelStrategy,
      c.step,
      !!c.contactPhone,
      smsAvailable,
    );
    if (channels.length === 0) {
      // Strategy was sms_only but SMS isn't available; record it but
      // don't fall back to email — the firm explicitly chose SMS-only.
      continue;
    }
    for (const ch of channels) {
      attempted++;
      const r = await sendDocRequestNotice(
        c.tenantId,
        c.scheduleId,
        c.contactId,
        c.contactEmail,
        c.contactPhone,
        c.contactFirstName,
        c.documentRequestId,
        c.description,
        c.periodLabel,
        c.dueDate,
        false,
        c.maxPerWeek,
        ch,
      );
      if (r === 'sent') sent++;
      else if (r === 'suppressed') suppressed++;
      else if (r === 'capped') capped++;
    }
  }
  return { attempted, sent, suppressed, capped };
}

// Called by the recurring-doc-request scheduler at issuance time.
// Bypasses cadence + weekly cap so the monthly drumbeat lands. Opener
// stays email-only — the initial outreach to the contact carries more
// detail than fits comfortably in 160 chars and email is more durable
// for "kicks off the conversation". SMS escalation comes via the
// firm's reminder_schedules row through dispatchDocRequests.
export async function sendOpenerForDocRequest(
  tenantId: string,
  documentRequestId: string,
): Promise<'sent' | 'suppressed' | 'capped' | 'error' | 'not_found'> {
  const row = await db
    .select({
      d: documentRequests,
      contactEmail: portalContacts.email,
      contactPhone: portalContacts.phone,
      contactFirstName: portalContacts.firstName,
      contactStatus: portalContacts.status,
    })
    .from(documentRequests)
    .innerJoin(portalContacts, eq(documentRequests.contactId, portalContacts.id))
    .where(
      and(
        eq(documentRequests.tenantId, tenantId),
        eq(documentRequests.id, documentRequestId),
      ),
    )
    .limit(1);
  const r = row[0];
  if (!r) return 'not_found';
  if (r.contactStatus !== 'active') return 'suppressed';
  const result = await sendDocRequestNotice(
    tenantId,
    null,
    r.d.contactId,
    r.contactEmail,
    r.contactPhone,
    r.contactFirstName,
    r.d.id,
    r.d.description,
    r.d.periodLabel,
    r.d.dueDate,
    true,
    9999,
    'email',
  );
  // Collapse channel-specific outcomes (no_phone / sms_disabled) to
  // 'error' — the opener should never hit those because channel='email'.
  if (result === 'no_phone' || result === 'sms_disabled') return 'error';
  return result;
}

// Force a single nudge regardless of cadence. Used by the practice
// dashboard's "Remind now" row action so a CPA can break out of the
// cadence on-demand. Counts toward weekly cap.
export async function forceNudgeForDocRequest(
  tenantId: string,
  documentRequestId: string,
  bookkeeperUserId: string,
): Promise<'sent' | 'suppressed' | 'capped' | 'error' | 'not_found'> {
  const row = await db
    .select({
      d: documentRequests,
      contactEmail: portalContacts.email,
      contactPhone: portalContacts.phone,
      contactFirstName: portalContacts.firstName,
      contactStatus: portalContacts.status,
    })
    .from(documentRequests)
    .innerJoin(portalContacts, eq(documentRequests.contactId, portalContacts.id))
    .where(
      and(
        eq(documentRequests.tenantId, tenantId),
        eq(documentRequests.id, documentRequestId),
      ),
    )
    .limit(1);
  const r = row[0];
  if (!r) return 'not_found';
  if (r.contactStatus !== 'active') return 'suppressed';

  // Find the firm's doc_request schedule so the send is attributed
  // and counts toward subsequent cadence-step selection.
  const sched = await db
    .select()
    .from(reminderSchedules)
    .where(
      and(
        eq(reminderSchedules.tenantId, tenantId),
        eq(reminderSchedules.triggerType, 'doc_request'),
        eq(reminderSchedules.active, true),
      ),
    )
    .limit(1);
  const schedRow = sched[0];
  // Allow forcing without a schedule — the send is logged with
  // scheduleId=null, the cadence loop simply won't pick this row up
  // until the firm enables a doc_request schedule.
  // Force-nudge always goes via email — the explicit "Remind now"
  // action wants the highest-fidelity channel the firm has wired up;
  // SMS gets used through the cadence path where the firm has
  // explicitly chosen sms_only / both / escalating.

  const result = await sendDocRequestNotice(
    tenantId,
    schedRow?.id ?? null,
    r.d.contactId,
    r.contactEmail,
    r.contactPhone,
    r.contactFirstName,
    r.d.id,
    r.d.description,
    r.d.periodLabel,
    r.d.dueDate,
    false,
    schedRow?.maxPerWeek ?? 9999,
    'email',
  );

  if (result === 'sent') {
    await auditLog(
      tenantId,
      'create',
      'doc_request_force_nudge',
      documentRequestId,
      null,
      { triggeredBy: bookkeeperUserId },
      bookkeeperUserId,
    );
  }
  if (result === 'no_phone' || result === 'sms_disabled') return 'error';
  return result;
}
