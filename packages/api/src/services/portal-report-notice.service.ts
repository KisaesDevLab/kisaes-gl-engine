// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// "Your report is ready" notice — opt-in from the Report Builder's Publish
// button. Goes to every portal contact who can SEE the report: active,
// linked to the report's company, with Financials access (the same gate
// listPublishedForContact / the PDF download enforce). Email only.
//
// Shares the send primitives with every other portal message (mailer,
// STOP opt-outs, reminder_sends open/click tracking, firm-name resolution)
// — see categorize-help-request.service for the pattern. The polymorphic
// reminder_sends.question_id carries the REPORT INSTANCE id here.

import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  companies,
  portalContactCompanies,
  portalContacts,
  reminderSends,
  reminderTemplates,
  reportInstances,
  reportTemplates,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { escapeHtml } from './report-export.service.js';
import {
  getMailer,
  isSuppressed,
  portalLinkBase,
  portalLoginLink,
  renderTemplate,
  resolveFirmName,
} from './portal-reminders.service.js';

export const REPORT_PUBLISHED_TRIGGER = 'report_published';

export interface ReportNoticeRecipient {
  contactId: string;
  name: string;
  email: string;
}

export type ReportNoticeOutcome = 'sent' | 'suppressed' | 'error';

export interface ReportNoticeResult {
  results: Array<{ contactId: string; name: string; outcome: ReportNoticeOutcome; error?: string }>;
}

function displayName(c: { firstName: string | null; lastName: string | null; email: string }): string {
  const n = [c.firstName, c.lastName].filter(Boolean).join(' ').trim();
  return n || c.email;
}

async function loadInstance(tenantId: string, instanceId: string) {
  const [row] = await db
    .select({
      id: reportInstances.id,
      companyId: reportInstances.companyId,
      status: reportInstances.status,
      periodStart: reportInstances.periodStart,
      periodEnd: reportInstances.periodEnd,
      version: reportInstances.version,
      templateName: reportTemplates.name,
      companyName: companies.businessName,
    })
    .from(reportInstances)
    .innerJoin(companies, eq(companies.id, reportInstances.companyId))
    .leftJoin(reportTemplates, eq(reportTemplates.id, reportInstances.templateId))
    .where(and(
      eq(reportInstances.tenantId, tenantId),
      eq(reportInstances.id, instanceId),
      // Cross-tenant guard on the joined company too.
      eq(companies.tenantId, tenantId),
    ))
    .limit(1);
  if (!row) throw AppError.notFound('Report not found');
  return row;
}

async function eligibleContacts(tenantId: string, companyId: string) {
  return db
    .select({
      id: portalContacts.id,
      email: portalContacts.email,
      firstName: portalContacts.firstName,
      lastName: portalContacts.lastName,
    })
    .from(portalContactCompanies)
    .innerJoin(portalContacts, eq(portalContacts.id, portalContactCompanies.contactId))
    .where(and(
      eq(portalContactCompanies.companyId, companyId),
      eq(portalContactCompanies.financialsAccess, true),
      eq(portalContacts.tenantId, tenantId),
      eq(portalContacts.status, 'active'),
    ))
    .orderBy(portalContacts.lastName, portalContacts.firstName, portalContacts.email);
}

/** Who would get the notice — shown next to the checkbox before publishing. */
export async function listReportNoticeRecipients(tenantId: string, instanceId: string): Promise<ReportNoticeRecipient[]> {
  const inst = await loadInstance(tenantId, instanceId);
  const rows = await eligibleContacts(tenantId, inst.companyId);
  return rows.map((c) => ({ contactId: c.id, name: displayName(c), email: c.email }));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}, ${y}`;
}
export function formatReportPeriod(start: string, end: string): string {
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

const DEFAULT_EMAIL_SUBJECT = 'New report for {company_name}: {report_name}';
const DEFAULT_EMAIL_BODY =
  `Hi {first_name},\n\n` +
  `{firm_name} has published {report_name} for {company_name} ({period}).\n\n` +
  `Log into your portal and open Financials to view it: {portal_link}\n\n` +
  `Thank you,\n{firm_name}`;

/**
 * Email the notice for a PUBLISHED instance. One reminder_sends row per
 * contact (failures included). Opt-outs (STOP / suppression rows) are
 * honoured; the engagement throttle is skipped — this is a person pressing
 * Publish, announcing something new.
 */
export async function sendReportPublishedNotice(
  tenantId: string,
  instanceId: string,
  userId: string,
): Promise<ReportNoticeResult> {
  const inst = await loadInstance(tenantId, instanceId);
  if (inst.status !== 'published') {
    throw AppError.conflict('Only a published report can be announced to the client.', 'REPORT_NOT_PUBLISHED');
  }

  const [firmName, contacts, tplRows] = await Promise.all([
    resolveFirmName(tenantId),
    eligibleContacts(tenantId, inst.companyId),
    db
      .select({ subject: reminderTemplates.subject, body: reminderTemplates.body })
      .from(reminderTemplates)
      .where(and(
        eq(reminderTemplates.tenantId, tenantId),
        eq(reminderTemplates.triggerType, REPORT_PUBLISHED_TRIGGER),
        eq(reminderTemplates.channel, 'email'),
      ))
      .limit(1),
  ]);
  const tpl = tplRows[0] ?? null;
  const linkBase = portalLinkBase();
  const portalLink = await portalLoginLink(linkBase, tenantId);
  const mailer = contacts.length > 0 ? await getMailer() : null;

  const results: ReportNoticeResult['results'] = [];
  for (const c of contacts) {
    const name = displayName(c);
    if (await isSuppressed(c.id, 'email', { skipEngagementWindow: true })) {
      results.push({ contactId: c.id, name, outcome: 'suppressed' });
      continue;
    }
    const [sendRow] = await db
      .insert(reminderSends)
      .values({ scheduleId: null, tenantId, contactId: c.id, questionId: inst.id, channel: 'email' })
      .returning({ id: reminderSends.id });
    const sendId = sendRow?.id;
    if (!sendId) { results.push({ contactId: c.id, name, outcome: 'error', error: 'could not record the send' }); continue; }

    const vars = {
      first_name: c.firstName ?? '',
      firm_name: firmName,
      company_name: inst.companyName,
      report_name: inst.templateName ?? 'a financial report',
      period: formatReportPeriod(inst.periodStart, inst.periodEnd),
      portal_link: portalLink,
    };
    const subject = renderTemplate(tpl?.subject || DEFAULT_EMAIL_SUBJECT, vars);
    const text = renderTemplate(tpl?.body || DEFAULT_EMAIL_BODY, vars);
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
      results.push({ contactId: c.id, name, outcome: 'sent' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.update(reminderSends).set({ error: message }).where(eq(reminderSends.id, sendId));
      results.push({ contactId: c.id, name, outcome: 'error', error: message });
    }
  }

  await auditLog(
    tenantId, 'create', 'report_published_notice', inst.id, null,
    {
      companyId: inst.companyId,
      version: inst.version,
      contacts: results.map((r) => ({ contactId: r.contactId, outcome: r.outcome })),
    },
    userId,
  );

  return { results };
}
