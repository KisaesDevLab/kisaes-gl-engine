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
} from './portal-reminders.service.js';

export type HelpChannel = 'email' | 'sms';

export const CATEGORIZE_REQUEST_TRIGGER = 'categorize_request';

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
}

async function loadTemplate(tenantId: string, channel: HelpChannel): Promise<{ subject: string | null; body: string } | null> {
  const rows = await db
    .select({ subject: reminderTemplates.subject, body: reminderTemplates.body })
    .from(reminderTemplates)
    .where(and(
      eq(reminderTemplates.tenantId, tenantId),
      eq(reminderTemplates.triggerType, CATEGORIZE_REQUEST_TRIGGER),
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
  userId: string,
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
  const [tenant] = await db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const firmName = tenant?.name ?? '';

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
  const [emailTpl, smsTpl] = await Promise.all([loadTemplate(tenantId, 'email'), loadTemplate(tenantId, 'sms')]);
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
        .values({ scheduleId: null, tenantId, contactId: c.id, questionId: companyId, channel })
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
        const subject = renderTemplate(emailTpl?.subject || DEFAULT_EMAIL_SUBJECT, vars);
        const text = renderTemplate(emailTpl?.body || DEFAULT_EMAIL_BODY, vars);
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
          smsTpl?.body || DEFAULT_SMS_BODY,
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
      channels,
      contacts: results.map((r) => ({ contactId: r.contactId, outcomes: r.outcomes.map((o) => `${o.channel}:${o.outcome}`) })),
      notEligible,
      noteLength: note.length,
    },
    userId,
  );

  return { queueCount: count, results, notEligible };
}
