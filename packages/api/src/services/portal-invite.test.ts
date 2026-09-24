// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Portal invitations. Creating a portal contact used to send nothing at
// all, so clients waited for an email that was never written. These cases
// pin the invitation itself: it goes out, it is signed by the PRACTICE
// rather than the client's own company, its link outlives an afternoon,
// and it can be sent again.
//
// SMTP is unset in tests, so the mailer is the stub that logs the subject
// and a token-redacted preview; that log is the message here.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, portalContacts, portalContactCompanies, portalMagicLinks,
  firms, tenantFirmAssignments, auditLog,
} from '../db/schema/index.js';
import { sendPortalInvite } from './portal-auth.service.js';
import { resolveFirmName } from './portal-reminders.service.js';

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let tenantId = '';
let companyId = '';
let contactId = '';
let firmId = '';
let sentMail: Array<{ to: string; subject: string; preview: string }> = [];

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: `TimberStone ${stamp}`, slug: `timber-${stamp}` }).returning();
  tenantId = t!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'TimberStone LLC' }).returning();
  companyId = co!.id;
  const [f] = await db.insert(firms).values({ name: `Krueger CPA ${stamp}`, slug: `krueger-${stamp}` }).returning();
  firmId = f!.id;
  await db.insert(tenantFirmAssignments).values({ tenantId, firmId, isActive: true });
  const [c] = await db.insert(portalContacts).values({
    tenantId, email: `client-${stamp}@example.com`, firstName: 'Kurt', lastName: 'Krueger', status: 'active',
  }).returning();
  contactId = c!.id;
  await db.insert(portalContactCompanies).values({ contactId, companyId });
});

afterAll(async () => {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(portalMagicLinks).where(eq(portalMagicLinks.tenantId, tenantId));
  await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, contactId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, tenantId));
  await db.delete(firms).where(eq(firms.id, firmId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

beforeEach(() => {
  sentMail = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    try {
      const e = JSON.parse(String(line));
      if (e.component === 'portal-mail-stub') sentMail.unshift({ to: e.to, subject: e.subject, preview: e.preview });
    } catch { /* not our line */ }
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(portalMagicLinks).where(eq(portalMagicLinks.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
});

const invite = () =>
  sendPortalInvite({ tenantId, contactId, baseUrl: 'https://books.example.com' });

describe('sendPortalInvite', () => {
  it('emails the contact a link that lasts a week', async () => {
    const before = Date.now();
    const result = await invite();
    expect(result.rateLimited).toBe(false);
    expect(result.viaStub).toBe(true);                    // no SMTP in tests
    const days = (result.expiresAt!.getTime() - before) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const links = await db.select().from(portalMagicLinks).where(eq(portalMagicLinks.tenantId, tenantId));
    expect(links).toHaveLength(1);
    expect(links[0]!.consumedAt).toBeNull();
    expect(sentMail[0]!.to).toBe(`client-${stamp}@example.com`);
  });

  it('comes from the practice and names the client it is for', async () => {
    await invite();
    // Two bugs pinned at once. Every client is a tenant, so tenants.name is
    // the CLIENT: an invitation FROM "TimberStone LLC" to TimberStone's own
    // contact says nothing about who is asking. And a person invited to two
    // of the firm's clients gets two of these, so the one thing that tells
    // them apart — whose books — has to be in the subject.
    expect(sentMail[0]!.subject.startsWith(`Krueger CPA ${stamp}`)).toBe(true);
    expect(sentMail[0]!.subject).toContain(`TimberStone ${stamp}`);
    expect(await resolveFirmName(tenantId)).toBe(`Krueger CPA ${stamp}`);
  });

  it('does not say the same name twice when the firm is the client', async () => {
    // Appliance install: a business running its own books, no separate
    // practice, so resolveFirmName falls back to the tenant name.
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, tenantId));
    try {
      await invite();
      expect(sentMail[0]!.subject).toBe(`TimberStone ${stamp} has invited you to your client portal`);
    } finally {
      await db.insert(tenantFirmAssignments).values({ tenantId, firmId, isActive: true });
    }
  });

  it('says which client a sign-in link opens', async () => {
    const { requestMagicLink } = await import('./portal-auth.service.js');
    const r = await requestMagicLink({
      tenantId, email: `client-${stamp}@example.com`, baseUrl: 'https://books.example.com',
    });
    expect(r.sent).toBe(true);
    // Asking from the portal's front page sends one of these PER tenancy;
    // without the client name they arrive identical and unusable.
    expect(sentMail[0]!.subject).toBe(`Your portal sign-in link for TimberStone ${stamp}`);
  });

  it('never puts the token in the log preview', async () => {
    await invite();
    expect(sentMail[0]!.preview).not.toMatch(/token=[A-Za-z0-9]{8}/);
  });

  it('invalidates the previous link when it is sent again', async () => {
    await invite();
    await invite();
    const links = await db.select().from(portalMagicLinks).where(eq(portalMagicLinks.tenantId, tenantId));
    expect(links).toHaveLength(2);
    expect(links.filter((l) => l.invalidatedAt === null)).toHaveLength(1);
  });

  it('records the send for audit', async () => {
    await invite();
    const rows = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const entry = rows.find((r) => r.entityType === 'portal_invite');
    expect(entry).toBeTruthy();
    expect((entry!.afterData as { viaStub?: boolean }).viaStub).toBe(true);
  });

  it('stops at the shared 5-per-hour link limit instead of silently burning links', async () => {
    for (let i = 0; i < 5; i++) await invite();
    const result = await invite();
    expect(result.rateLimited).toBe(true);
    expect(result.expiresAt).toBeNull();
    const links = await db.select().from(portalMagicLinks).where(eq(portalMagicLinks.tenantId, tenantId));
    expect(links).toHaveLength(5);   // the 6th issued nothing
  });

  it('refuses a paused contact', async () => {
    await db.update(portalContacts).set({ status: 'paused' }).where(eq(portalContacts.id, contactId));
    await expect(invite()).rejects.toThrow(/active/i);
    await db.update(portalContacts).set({ status: 'active' }).where(eq(portalContacts.id, contactId));
  });
});
