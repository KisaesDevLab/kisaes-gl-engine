// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Opt-in "your report is ready" notice on Report Builder publish. Goes to
// every ACTIVE portal contact with Financials access to the report's
// company; honours STOP opt-outs; never sent for an unpublished report;
// setStatus flags only a real transition into published (so a PDF retry
// or a repeated publish can't re-email the client).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, companies, auditLog, reportInstances, reportTemplates,
  portalContacts, portalContactCompanies, reminderSends, reminderSuppressions,
} from '../db/schema/index.js';
import * as svc from './portal-reports.service.js';
import * as notice from './portal-report-notice.service.js';

const sendMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./portal-reminders.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portal-reminders.service.js')>();
  return { ...actual, getMailer: async () => ({ isStub: false, send: sendMock }) };
});
vi.mock('./portal-pdf.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./portal-pdf.service.js')>();
  return { ...actual, htmlToPdf: vi.fn(async () => Buffer.from('%PDF-fake')) };
});
vi.mock('./storage/storage-provider.factory.js', () => ({
  getProviderForTenant: async () => ({
    upload: vi.fn(async () => undefined),
    download: vi.fn(async () => Buffer.from('%PDF-fake')),
    delete: vi.fn(async () => undefined),
  }),
  invalidateProviderCache: () => undefined,
}));

let tenantId = '';
let userId = '';
let companyId = '';
let otherCompanyId = '';

async function cleanDb() {
  if (!tenantId) return;
  const contactIds = db.select({ id: portalContacts.id }).from(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(reminderSuppressions).where(inArray(reminderSuppressions.contactId, contactIds));
  await db.delete(reminderSends).where(eq(reminderSends.tenantId, tenantId));
  await db.delete(portalContactCompanies).where(inArray(portalContactCompanies.contactId, contactIds));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(reportInstances).where(eq(reportInstances.tenantId, tenantId));
  await db.delete(reportTemplates).where(eq(reportTemplates.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function contact(email: string, opts: { company?: string; financials?: boolean; status?: string } = {}) {
  const [c] = await db.insert(portalContacts).values({
    tenantId, email, firstName: email.split('@')[0], status: opts.status ?? 'active',
  }).returning();
  await db.insert(portalContactCompanies).values({
    contactId: c!.id, companyId: opts.company ?? companyId, financialsAccess: opts.financials ?? true,
  });
  return c!.id;
}

async function makeInstance(): Promise<string> {
  const { id } = await svc.createInstance(tenantId, userId, {
    templateId: null, companyId, periodStart: '2026-04-01', periodEnd: '2026-06-30',
  });
  return id;
}

beforeEach(async () => {
  await cleanDb();
  const stamp = Date.now();
  const [t] = await db.insert(tenants).values({ name: 'Notice T', slug: `notice-${stamp}` }).returning();
  tenantId = t!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `notice-${stamp}@example.com`, passwordHash: 'x', displayName: 'Notice', role: 'owner',
  }).returning();
  userId = u!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Notice Co' }).returning();
  companyId = co!.id;
  const [co2] = await db.insert(companies).values({ tenantId, businessName: 'Other Co' }).returning();
  otherCompanyId = co2!.id;
  sendMock.mockClear();
});

afterEach(async () => {
  await cleanDb();
});

describe('report published notice', () => {
  it('lists only active contacts with Financials access to the report company', async () => {
    await contact('yes@example.com');
    await contact('nofin@example.com', { financials: false });
    await contact('paused@example.com', { status: 'paused' });
    await contact('other@example.com', { company: otherCompanyId });
    const id = await makeInstance();
    const r = await notice.listReportNoticeRecipients(tenantId, id);
    expect(r.map((x) => x.email)).toEqual(['yes@example.com']);
  });

  it('emails eligible contacts, skips opted-out ones, and records each send', async () => {
    const a = await contact('a@example.com');
    const b = await contact('b@example.com');
    await db.insert(reminderSuppressions).values({ contactId: b, reason: 'STOP_KEYWORD', channel: 'email' });
    const id = await makeInstance();
    const status = await svc.setStatus(tenantId, id, userId, 'published');
    expect(status.newlyPublished).toBe(true);

    const res = await notice.sendReportPublishedNotice(tenantId, id, userId);
    expect(res.results.map((r) => [r.contactId, r.outcome])).toEqual([[a, 'sent'], [b, 'suppressed']]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const [to, subject, , text] = sendMock.mock.calls[0] as unknown as [string, string, string, string];
    expect(to).toBe('a@example.com');
    expect(subject).toContain('Notice Co');
    expect(text).toContain('Apr 1, 2026 – Jun 30, 2026');
    expect(text).toContain('/portal/login?firm=');

    const sends = await db.select().from(reminderSends).where(eq(reminderSends.tenantId, tenantId));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.questionId).toBe(id);
  });

  it('refuses to announce an unpublished report', async () => {
    await contact('a@example.com');
    const id = await makeInstance();
    await expect(notice.sendReportPublishedNotice(tenantId, id, userId)).rejects.toThrow(/published/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('flags newlyPublished only on the real transition', async () => {
    const id = await makeInstance();
    expect((await svc.setStatus(tenantId, id, userId, 'review')).newlyPublished).toBe(false);
    expect((await svc.setStatus(tenantId, id, userId, 'published')).newlyPublished).toBe(true);
    const again = await svc.setStatus(tenantId, id, userId, 'published');
    expect(again.newlyPublished).toBeFalsy();
    await svc.setStatus(tenantId, id, userId, 'archived');
    expect((await svc.setStatus(tenantId, id, userId, 'published')).newlyPublished).toBe(true);
  });
});
