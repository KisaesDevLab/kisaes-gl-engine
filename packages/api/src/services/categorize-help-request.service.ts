// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Practice -> Uncategorized -> In suspense -> "Ask the client for help".
//
// Staff can see a pile of amounts nobody could classify; the person who
// actually knows what they were is the client. This sends that person an
// email and/or a text asking them to log into the portal and answer
// "What was this?" for each row. It sends to the portal contacts who are
// allowed to suggest categories for this company and nobody else, because a
// contact without that tick would log in and find nothing to do.
//
// The same path sends a REMINDER (input.reminder): same recipients, same
// tracking rows, different wording and its own editable template, because a
// second message that reads exactly like the first one reads as a bug.
//
// It is a notice, not a ledger action: nothing here touches a transaction.
// Every send lands in reminder_sends (channel + outcome + provider ids) so it
// shares the open/click tracking, the STOP opt-out table and the reminders
// dashboard with every other portal message. The polymorphic
// reminder_sends.question_id carries the COMPANY id here — "the subject of
// this notice is that company's categorize queue" — which is how
// `lastAskedAt` is found again without a new column.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  clientCategorySuggestions,
  companies,
  portalContactCompanies,
  portalContacts,
  reminderSends,
  reminderTemplates,
  tenants,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { isEnabled } from './feature-flags.service.js';
import { escapeHtml } from './report-export.service.js';
import { listPortalQueue } from './portal-categorization.service.js';
import {
  getMailer,
  getTenantSmsSettings,
  isSuppressed,
  portalLinkBase,
  portalLoginLink,
  renderSmsBody,
  renderTemplate,
  resolveFirmName,
} from './portal-reminders.service.js';

export type HelpChannel = 'email' | 'sms';

export const CATEGORIZE_REQUEST_TRIGGER = 'categorize_request';
// A reminder is the same notice sent again, with its own wording (and its
// own editable template) so the second message does not read like the first.
export const CATEGORIZE_REMINDER_TRIGGER = 'categorize_reminder';

export interface HelpRecipient {
  contactId: string;
  name: string;
  email: string;
  phone: string | null;
  /** The contact has texted STOP / been suppressed on that channel. */
  emailSuppressed: boolean;
  smsSuppressed: boolean;
  lastSeenAt: string | null;
  /** When this contact was last sent this notice for this company. */
  lastAskedAt: string | null;
  /**
   * When this contact last submitted an answer for this company. Read with
   * lastAskedAt it says who a reminder is actually for: asked, and nothing
   * back since. Answers are never deleted on review, so this survives the
   * staff approving them.
   */
  lastAnsweredAt: string | null;
}

export interface HelpRecipientsView {
  /** PORTAL_CATEGORIZE_V1 for the tenant. Off means the client cannot see the page at all. */
  portalEnabled: boolean;
  /** Rows the client would see on the portal's "What was this?" page right now. */
  queueCount: number;
  /** Whether a text can be sent: system provider + the firm's SMS switch. */
  smsAvailable: boolean;
  smsUnavailableReason: string | null;
  companyName: string;
  contacts: HelpRecipient[];
}

async function smsAvailability(tenantId: string): Promise<{ available: boolean; reason: string | null }> {
  const tenantSms = await getTenantSmsSettings(tenantId);
  if (!tenantSms.smsOutboundEnabled) {
    return { available: false, reason: 'Text messages are switched off for this firm (Practice → Client Portal settings).' };
  }
  const tfaConfigService = await import('./tfa-config.service.js');
  const rawTfa = await tfaConfigService.getRawConfig();
  if (!rawTfa.smsProvider) {
    return { available: false, reason: 'No SMS provider is configured on this server (Admin → Two-Factor Auth).' };
  }
  return { available: true, reason: null };
}

/**
 * The contacts who could act on the request: active, linked to this company,
 * with "Can suggest categories" ticked. The tenant join on companies is the
 * cross-tenant guard — companyId comes from the request header.
 */
async function eligibleContacts(tenantId: string, companyId: string) {
  return db
    .select({
      id: portalContacts.id,
      email: portalContacts.email,
      phone: portalContacts.phone,
      firstName: portalContacts.firstName,
      lastName: portalContacts.lastName,
      lastSeenAt: portalContacts.lastSeenAt,
    })
    .from(portalContactCompanies)
    .innerJoin(portalContacts, eq(portalContacts.id, portalContactCompanies.contactId))
    .innerJoin(companies, eq(companies.id, portalContactCompanies.companyId))
    .where(and(
      eq(portalContactCompanies.companyId, companyId),
      eq(portalContactCompanies.categorizeAccess, true),
      eq(companies.tenantId, tenantId),
      eq(portalContacts.tenantId, tenantId),
      eq(portalContacts.status, 'active'),
    ))
    .orderBy(portalContacts.lastName, portalContacts.firstName, portalContacts.email);
}

function displayName(c: { firstName: string | null; lastName: string | null; email: string }): string {
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return n || c.email;
}

export async function listHelpRecipients(tenantId: string, companyId: string): Promise<HelpRecipientsView> {
  const [company] = await db
    .select({ name: companies.businessName })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)))
    .limit(1);
  if (!company) throw AppError.notFound('Company not found');

  const [portalEnabled, sms, contacts, queue] = await Promise.all([
    isEnabled(tenantId, 'PORTAL_CATEGORIZE_V1'),
    smsAvailability(tenantId),
    eligibleContacts(tenantId, companyId),
    listPortalQueue(tenantId, companyId, { limit: 1 }),
  ]);

  const ids = contacts.map((c) => c.id);
  const lastAsked = new Map<string, Date>();
  if (ids.length > 0) {
    const rows = await db
      .select({
        contactId: reminderSends.contactId,
        at: sql<Date>`MAX(${reminderSends.sentAt})`,
      })
      .from(reminderSends)
      .where(and(
        eq(reminderSends.tenantId, tenantId),
        inArray(reminderSends.contactId, ids),
        eq(reminderSends.questionId, companyId),
        isNull(reminderSends.scheduleId),
        isNull(reminderSends.error),
      ))
      .groupBy(reminderSends.contactId);
    for (const r of rows) lastAsked.set(r.contactId, new Date(r.at));
  }

  // Who has come back with something since. Counted across every status so
  // an answer staff have already approved still counts as answered.
  const lastAnswered = new Map<string, Date>();
  if (ids.length > 0) {
    const rows = await db
      .select({
        contactId: clientCategorySuggestions.submittedByContactId,
        at: sql<Date>`MAX(${clientCategorySuggestions.submittedAt})`,
      })
      .from(clientCategorySuggestions)
      .where(and(
        eq(clientCategorySuggestions.tenantId, tenantId),
        eq(clientCategorySuggestions.companyId, companyId),
        inArray(clientCategorySuggestions.submittedByContactId, ids),
      ))
      .groupBy(clientCategorySuggestions.submittedByContactId);
    for (const r of rows) if (r.contactId) lastAnswered.set(r.contactId, new Date(r.at));
  }

  const out: HelpRecipient[] = [];
  for (const c of contacts) {
    const [emailSuppressed, smsSuppressed] = await Promise.all([
      isSuppressed(c.id, 'email', { skipEngagementWindow: true }),
      isSuppressed(c.id, 'sms', { skipEngagementWindow: true }),
    ]);
    out.push({
      contactId: c.id,
      name: displayName(c),
      email: c.email,
      phone: c.phone,
      emailSuppressed,
      smsSuppressed,
      lastSeenAt: c.lastSeenAt ? c.lastSeenAt.toISOString() : null,
      lastAskedAt: lastAsked.get(c.id)?.toISOString() ?? null,
      lastAnsweredAt: lastAnswered.get(c.id)?.toISOString() ?? null,
    });
  }

  return {
    portalEnabled,
    queueCount: queue.total,
    smsAvailable: sms.available,
    smsUnavailableReason: sms.reason,
    companyName: company.name,
    contacts: out,
  };
}

export type SendOutcome = 'sent' | 'suppressed' | 'no_phone' | 'sms_disabled' | 'error';

export interface HelpSendResult {
  queueCount: number;
  results: Array<{
    contactId: string;
    name: string;
    outcomes: Array<{ channel: HelpChannel; outcome: SendOutcome; error?: string }>;
  }>;
  /** Contact ids that are not eligible for this company (not linked, no tick, paused). */
  notEligible: string[];
}

export interface HelpSendInput {
  contactIds: string[];
  channels: HelpChannel[];
  /** A personal line from staff, appended to the message. Plain text. */
  note?: string;
  /**
   * The portal queue for this company is empty right now — the client would
   * log in and find nothing. Refused unless staff confirm they mean it.
   */
  confirmEmpty?: boolean;
  /**
   * Send the REMINDER wording instead of the first-ask wording (its own
   * template trigger, same recipients, same tracking rows). Nothing else
   * changes when a person presses the button.
   */
  reminder?: boolean;
  /**
   * Set when a reminder_schedules row produced this send, so the reminders
   * dashboard can tell an automated nudge from a staff member's click.
   * Null / omitted for anything a human pressed.
   */
  scheduleId?: string | null;
}

async function loadTemplate(
  tenantId: string,
  channel: HelpChannel,
  trigger: string,
): Promise<{ subject: string | null; body: string } | null> {
  const rows = await db
    .select({ subject: reminderTemplates.subject, body: reminderTemplates.body })
    .from(reminderTemplates)
    .where(and(
      eq(reminderTemplates.tenantId, tenantId),
      eq(reminderTemplates.triggerType, trigger),
      eq(reminderTemplates.channel, channel),
    ))
    .limit(1);
  return rows[0] ?? null;
}

const DEFAULT_EMAIL_SUBJECT = '{firm_name} needs your help with {count} transaction(s)';
const DEFAULT_EMAIL_BODY =
  `Hi {first_name},\n\n` +
  `We have {count} transaction(s) for {company_name} that we could not categorize on our own. ` +
  `You are the person who knows what they were.\n\n` +
  `Please log into your portal and open "What was this?" to tell us what each one was for: {portal_link}\n\n` +
  `{note}` +
  `Thank you,\n{firm_name}`;
const DEFAULT_SMS_BODY =
  `{first_name}, {firm_name} needs your help with {count} transaction(s) for {company_name}. ` +
  `Log in and open "What was this?": {portal_link}`;

// Reminder wording. Same variables, so a firm that edits one template can
// edit the other the same way.
const DEFAULT_REMINDER_EMAIL_SUBJECT = 'Reminder: {count} transaction(s) still need your answer';
const DEFAULT_REMINDER_EMAIL_BODY =
  `Hi {first_name},\n\n` +
  `Just a reminder — {count} transaction(s) for {company_name} are still waiting on you. ` +
  `Until we know what they were, we cannot finish your books.\n\n` +
  `Open "What was this?" in your portal and tell us what each one was for: {portal_link}\n\n` +
  `{note}` +
  `Thank you,\n{firm_name}`;
const DEFAULT_REMINDER_SMS_BODY =
  `{first_name}, a reminder from {firm_name}: {count} transaction(s) for {company_name} are still waiting ` +
  `on your answer. Open "What was this?": {portal_link}`;

/**
 * Send the notice. One reminder_sends row per (contact, channel) attempt,
 * including failures, so a misconfigured SMS provider leaves evidence rather
 * than a silent nothing.
 *
 * Deliberately no weekly cap: this is a person pressing a button, not a
 * cadence, and the screen shows when each contact was last asked so the
 * judgement stays with the staff member. STOP opt-outs are always honoured.
 */
export async function sendHelpRequest(
  tenantId: string,
  companyId: string,
  /** The staff member who pressed the button; null when a schedule sent it. */
  userId: string | null,
  input: HelpSendInput,
): Promise<HelpSendResult> {
  if (!(await isEnabled(tenantId, 'PORTAL_CATEGORIZE_V1'))) {
    throw AppError.conflict(
      'Clients cannot see the categorize page until PORTAL_CATEGORIZE_V1 is enabled for this firm.',
      'PORTAL_CATEGORIZE_OFF',
    );
  }
  const channels = [...new Set(input.channels)];
  if (channels.length === 0) throw AppError.badRequest('Pick at least one channel');

  const [company] = await db
    .select({ name: companies.businessName })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.tenantId, tenantId)))
    .limit(1);
  if (!company) throw AppError.notFound('Company not found');
  // The PRACTICE's name, not the client's. Every client is a tenant here,
  // so tenants.name is the client — which made this mail read "TimberStone
  // LLC needs your help" and sign off as TimberStone, sent to TimberStone.
  const firmName = await resolveFirmName(tenantId);

  const eligible = await eligibleContacts(tenantId, companyId);
  const byId = new Map(eligible.map((c) => [c.id, c]));
  const wanted = [...new Set(input.contactIds)];
  const notEligible = wanted.filter((id) => !byId.has(id));
  const targets = wanted.filter((id) => byId.has(id)).map((id) => byId.get(id)!);

  const queue = await listPortalQueue(tenantId, companyId, { limit: 1 });
  const count = queue.total;
  if (count === 0 && !input.confirmEmpty) {
    throw AppError.conflict(
      'The client\'s "What was this?" page is empty right now, so they would log in to nothing.',
      'PORTAL_QUEUE_EMPTY',
    );
  }

  const linkBase = portalLinkBase();
  const portalLink = await portalLoginLink(linkBase, tenantId);
  const note = (input.note ?? '').trim();

  const sms = channels.includes('sms') ? await smsAvailability(tenantId) : { available: false, reason: null };
  const reminder = input.reminder === true;
  const trigger = reminder ? CATEGORIZE_REMINDER_TRIGGER : CATEGORIZE_REQUEST_TRIGGER;
  const [emailTpl, smsTpl] = await Promise.all([
    loadTemplate(tenantId, 'email', trigger),
    loadTemplate(tenantId, 'sms', trigger),
  ]);
  const defaultEmailSubject = reminder ? DEFAULT_REMINDER_EMAIL_SUBJECT : DEFAULT_EMAIL_SUBJECT;
  const defaultEmailBody = reminder ? DEFAULT_REMINDER_EMAIL_BODY : DEFAULT_EMAIL_BODY;
  const defaultSmsBody = reminder ? DEFAULT_REMINDER_SMS_BODY : DEFAULT_SMS_BODY;
  const mailer = channels.includes('email') ? await getMailer() : null;

  const results: HelpSendResult['results'] = [];
  for (const c of targets) {
    const vars = {
      first_name: c.firstName ?? '',
      firm_name: firmName,
      company_name: company.name,
      count,
      portal_link: portalLink,
      // The note is a paragraph of its own when present, nothing when not,
      // so the default template reads cleanly either way.
      note: note ? `${note}\n\n` : '',
    };
    const outcomes: HelpSendResult['results'][number]['outcomes'] = [];

    for (const channel of channels) {
      if (await isSuppressed(c.id, channel, { skipEngagementWindow: true })) {
        outcomes.push({ channel, outcome: 'suppressed' });
        continue;
      }
      if (channel === 'sms') {
        if (!c.phone) { outcomes.push({ channel, outcome: 'no_phone' }); continue; }
        if (!sms.available) { outcomes.push({ channel, outcome: 'sms_disabled', error: sms.reason ?? undefined }); continue; }
      }

      const [sendRow] = await db
        .insert(reminderSends)
        .values({ scheduleId: input.scheduleId ?? null, tenantId, contactId: c.id, questionId: companyId, channel })
        .returning({ id: reminderSends.id });
      const sendId = sendRow?.id;
      if (!sendId) { outcomes.push({ channel, outcome: 'error', error: 'could not record the send' }); continue; }

      const fail = async (err: unknown): Promise<void> => {
        const message = err instanceof Error ? err.message : String(err);
        await db.update(reminderSends).set({ error: message, providerStatus: channel === 'sms' ? 'failed' : null })
          .where(eq(reminderSends.id, sendId));
        outcomes.push({ channel, outcome: 'error', error: message });
      };

      if (channel === 'email') {
        const subject = renderTemplate(emailTpl?.subject || defaultEmailSubject, vars);
        const text = renderTemplate(emailTpl?.body || defaultEmailBody, vars);
        const trackedClick = `${linkBase}/api/portal/track/${sendId}/click?to=${encodeURIComponent(portalLink)}`;
        const trackingPixel = `${linkBase}/api/portal/track/${sendId}/open.gif`;
        const escaped = escapeHtml(text).replace(
          /(https?:\/\/[^\s<]+)/g,
          (m) => `<a href="${m === portalLink ? trackedClick : m}">${m}</a>`,
        );
        const html =
          `<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">${escaped.replace(/\n/g, '<br>')}</div>` +
          `<img src="${trackingPixel}" width="1" height="1" alt="" style="display:none">`;
        try {
          await mailer!.send(c.email, subject, html, text);
          outcomes.push({ channel, outcome: 'sent' });
        } catch (err) {
          await fail(err);
        }
        continue;
      }

      // SMS leg.
      try {
        const tfaConfigService = await import('./tfa-config.service.js');
        const smsProviderModule = await import('./sms-providers/index.js');
        const provider = smsProviderModule.getSmsProvider(await tfaConfigService.getRawConfig());
        const tenantSms = await getTenantSmsSettings(tenantId);
        const body = renderSmsBody(
          smsTpl?.body || defaultSmsBody,
          { ...vars, note: note ? ` ${note}` : '' },
          tenantSms.smsAllowMultiSegment,
        );
        const result = await provider.sendText(c.phone!, body);
        if (result.success) {
          await db.update(reminderSends)
            .set({ providerMessageId: result.providerMessageId ?? null, providerStatus: 'sent' })
            .where(eq(reminderSends.id, sendId));
          outcomes.push({ channel, outcome: 'sent' });
        } else {
          await fail(new Error(result.error ?? 'sms_send_failed'));
        }
      } catch (err) {
        await fail(err);
      }
    }

    results.push({ contactId: c.id, name: displayName(c), outcomes });
  }

  await auditLog(
    tenantId, 'create', 'categorize_help_request', companyId, null,
    {
      companyId,
      queueCount: count,
      reminder,
      channels,
      contacts: results.map((r) => ({ contactId: r.contactId, outcomes: r.outcomes.map((o) => `${o.channel}:${o.outcome}`) })),
      notEligible,
      noteLength: note.length,
    },
    userId ?? undefined,
  );

  return { queueCount: count, results, notEligible };
}

// ── Automated reminders ───────────────────────────────────────────
//
// A reminder_schedules row with trigger_type 'categorize_reminder' turns the
// manual button into a cadence: chase the client until the queue is empty or
// they answer, then stop. It rides the same engine as every other portal
// reminder (quiet hours, channel strategy, the per-contact weekly cap, STOP
// opt-outs) and sends through sendHelpRequest, so an automated nudge and a
// staff-pressed one are the same message with the same tracking.
//
// What a "spell" is: the run of chasing that starts when the client last
// answered (or at the first message, if they never have) and ends when they
// answer again. Anchoring on their last answer is what stops the cadence
// restarting from day one every time a new uncategorized row appears, and
// gives someone who just sent in ten answers a few days' peace before the
// next nudge about the rest.

import {
  chooseChannelsForCandidate,
  exceededWeeklyCap,
  isInQuietHours,
  nextCadenceStep,
} from './portal-reminders.service.js';
import { reminderSchedules } from '../db/schema/index.js';

export interface CategorizeReminderCandidate {
  scheduleId: string;
  tenantId: string;
  companyId: string;
  contactId: string;
  contactPhone: string | null;
  /** 1-based cadence step; 1 is the first message of this spell. */
  step: number;
  channelStrategy: 'email_only' | 'sms_only' | 'both' | 'escalating';
  maxPerWeek: number;
  queueCount: number;
}

/** A send counts once per DAY: 'both' writes one row per channel. */
interface SpellState { days: number; firstSentAt: Date | null; lastSentAt: Date | null }

async function spellState(
  tenantId: string,
  companyId: string,
  contactId: string,
  since: Date | null,
): Promise<SpellState> {
  // Conditions as a list, not an empty sql`` fragment: and() renders a
  // dangling AND for an empty one.
  const conds = [
    eq(reminderSends.tenantId, tenantId),
    eq(reminderSends.contactId, contactId),
    eq(reminderSends.questionId, companyId),
    isNull(reminderSends.error),
  ];
  if (since) conds.push(sql`${reminderSends.sentAt} > ${since}`);
  const rows = await db
    .select({
      days: sql<number>`COUNT(DISTINCT DATE(${reminderSends.sentAt} AT TIME ZONE 'UTC'))::int`,
      first: sql<Date | null>`MIN(${reminderSends.sentAt})`,
      last: sql<Date | null>`MAX(${reminderSends.sentAt})`,
    })
    .from(reminderSends)
    .where(and(...conds));
  const r = rows[0];
  return {
    days: Number(r?.days ?? 0),
    firstSentAt: r?.first ? new Date(r.first) : null,
    lastSentAt: r?.last ? new Date(r.last) : null,
  };
}

/** Latest answer this contact sent for this company, any status. */
async function lastAnswerAt(tenantId: string, companyId: string, contactId: string): Promise<Date | null> {
  const rows = await db
    .select({ at: sql<Date | null>`MAX(${clientCategorySuggestions.submittedAt})` })
    .from(clientCategorySuggestions)
    .where(and(
      eq(clientCategorySuggestions.tenantId, tenantId),
      eq(clientCategorySuggestions.companyId, companyId),
      eq(clientCategorySuggestions.submittedByContactId, contactId),
    ));
  return rows[0]?.at ? new Date(rows[0].at) : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Never twice in a day, whatever the cadence says. Guards a cadence like
// [1,1,1] against the half-hourly tick turning into three sends in an hour.
const MIN_GAP_MS = 20 * 60 * 60 * 1000;

export async function scanCategorizeReminders(tenantId?: string): Promise<CategorizeReminderCandidate[]> {
  const schedules = await db
    .select()
    .from(reminderSchedules)
    .where(and(
      eq(reminderSchedules.triggerType, CATEGORIZE_REMINDER_TRIGGER),
      eq(reminderSchedules.active, true),
      ...(tenantId ? [eq(reminderSchedules.tenantId, tenantId)] : []),
    ));
  if (schedules.length === 0) return [];

  const now = new Date();
  const out: CategorizeReminderCandidate[] = [];
  const flagCache = new Map<string, boolean>();

  for (const sched of schedules) {
    if (isInQuietHours(now, sched.quietHoursStart, sched.quietHoursEnd, sched.timezone)) continue;

    let flagOn = flagCache.get(sched.tenantId);
    if (flagOn === undefined) {
      flagOn = await isEnabled(sched.tenantId, 'PORTAL_CATEGORIZE_V1');
      flagCache.set(sched.tenantId, flagOn);
    }
    // Chasing a client toward a page their firm has not switched on would
    // send them to an empty portal.
    if (!flagOn) continue;

    const cadence = Array.isArray(sched.cadenceDays)
      ? (sched.cadenceDays as unknown[]).filter((d): d is number => typeof d === 'number' && d >= 1)
      : [];
    if (cadence.length === 0) continue;

    const companyRows = sched.companyId
      ? [{ id: sched.companyId }]
      : await db.select({ id: companies.id }).from(companies).where(eq(companies.tenantId, sched.tenantId));

    for (const co of companyRows) {
      const queue = await listPortalQueue(sched.tenantId, co.id, { limit: 1 });
      // Nothing waiting: the spell is over, whatever the cadence says.
      if (queue.total === 0) continue;

      const contacts = await eligibleContacts(sched.tenantId, co.id);
      for (const c of contacts) {
        const answeredAt = await lastAnswerAt(sched.tenantId, co.id, c.id);
        const spell = await spellState(sched.tenantId, co.id, c.id, answeredAt);

        if (spell.lastSentAt && now.getTime() - spell.lastSentAt.getTime() < MIN_GAP_MS) continue;

        // The model, in one line: message 1 opens the spell, and cadenceDays
        // are the day-offsets from it — [3,7,14] chases again 3, 7 and 14
        // days later, then stops until the client answers or the queue
        // empties. `step` is which message this is (1 = the opener), which
        // is what the escalating channel strategy reads.
        let step: number | null;
        if (spell.days === 0) {
          // Nobody has chased them in this spell. Open it now when they have
          // never answered at all; otherwise give them cadence[0] days of
          // quiet after the answer they did send.
          step = answeredAt === null || now.getTime() - answeredAt.getTime() >= cadence[0]! * DAY_MS
            ? 1
            : null;
        } else {
          // days = messages already sent; the next one uses the cadence entry
          // at days-1, measured from the first message of the spell.
          step = nextCadenceStep(cadence, spell.firstSentAt ?? now, spell.days - 1, now) === null
            ? null
            : spell.days + 1;
        }
        if (step === null) continue;

        out.push({
          scheduleId: sched.id,
          tenantId: sched.tenantId,
          companyId: co.id,
          contactId: c.id,
          contactPhone: c.phone,
          step,
          channelStrategy: sched.channelStrategy as CategorizeReminderCandidate['channelStrategy'],
          maxPerWeek: sched.maxPerWeek,
          queueCount: queue.total,
        });
      }
    }
  }
  return out;
}

export interface CategorizeReminderResult {
  attempted: number;
  sent: number;
  capped: number;
  failed: number;
}

export async function dispatchCategorizeReminders(tenantId?: string): Promise<CategorizeReminderResult> {
  const candidates = await scanCategorizeReminders(tenantId);
  const result: CategorizeReminderResult = { attempted: 0, sent: 0, capped: 0, failed: 0 };
  const smsCache = new Map<string, boolean>();

  for (const c of candidates) {
    // The cap is per contact across every portal message, not per schedule:
    // a client already being chased about documents should not also get
    // three of these in the same week.
    if (await exceededWeeklyCap(c.contactId, c.maxPerWeek)) {
      result.capped++;
      continue;
    }

    let smsAvailable = smsCache.get(c.tenantId);
    if (smsAvailable === undefined) {
      smsAvailable = (await smsAvailability(c.tenantId)).available;
      smsCache.set(c.tenantId, smsAvailable);
    }
    const channels = chooseChannelsForCandidate(c.channelStrategy, c.step, !!c.contactPhone, smsAvailable);
    // sms_only with no usable SMS: the firm chose texts, so falling back to
    // email would be answering a question nobody asked.
    if (channels.length === 0) continue;

    result.attempted++;
    try {
      const sendResult = await sendHelpRequest(c.tenantId, c.companyId, null, {
        contactIds: [c.contactId],
        channels,
        reminder: true,
        scheduleId: c.scheduleId,
      });
      const anySent = sendResult.results.some((r) => r.outcomes.some((o) => o.outcome === 'sent'));
      if (anySent) result.sent++;
      else result.failed++;
    } catch {
      // A queue that emptied between scan and send, a flag switched off
      // mid-cycle: skip this one, keep the cycle going.
      result.failed++;
    }
  }
  return result;
}
