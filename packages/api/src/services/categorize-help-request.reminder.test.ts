// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// "Send reminder" on Practice → Uncategorized. Two things have to hold:
// the recipient list says who still owes an answer (so the modal can tick
// the right people), and a reminder goes out with reminder wording rather
// than the first-ask wording — from its own template when the firm wrote
// one. SMTP is unset in tests, so the mailer is the stub that logs the
// subject and a body preview; that log IS the sent message here.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, portalContacts, portalContactCompanies, tenantFeatureFlags,
  clientCategorySuggestions, reminderSends, reminderTemplates, auditLog,
  firms, tenantFirmAssignments,
} from '../db/schema/index.js';
import {
  listHelpRecipients, sendHelpRequest, CATEGORIZE_REMINDER_TRIGGER,
} from './categorize-help-request.service.js';

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let tenantId = '';
let companyId = '';
let contactId = '';
const userId = '00000000-0000-0000-0000-0000000000aa';

/** What the mail stub logged, newest first. */
let sentMail: Array<{ to: string; subject: string; preview: string }> = [];

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: `Remind ${stamp}`, slug: `remind-${stamp}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Darrow Enterprises' }).returning();
  companyId = c!.id;
  const [pc] = await db.insert(portalContacts).values({
    tenantId, email: `dana-${stamp}@example.com`, firstName: 'Dana', lastName: 'Darrow', status: 'active',
  }).returning();
  contactId = pc!.id;
  await db.insert(portalContactCompanies).values({ contactId, companyId, categorizeAccess: true });
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'PORTAL_CATEGORIZE_V1', enabled: true });
});

afterAll(async () => {
  if (!tenantId) return;
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(reminderTemplates).where(eq(reminderTemplates.tenantId, tenantId));
  await db.delete(reminderSends).where(eq(reminderSends.tenantId, tenantId));
  await db.delete(clientCategorySuggestions).where(eq(clientCategorySuggestions.tenantId, tenantId));
  await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, contactId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

beforeEach(() => {
  sentMail = [];
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    try {
      const entry = JSON.parse(String(line));
      if (entry.component === 'reminder-mail-stub') {
        sentMail.unshift({ to: entry.to, subject: entry.subject, preview: entry.preview });
      }
    } catch { /* not our JSON line */ }
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // Audit rows too: each case asserts against the send IT made.
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(reminderTemplates).where(eq(reminderTemplates.tenantId, tenantId));
  await db.delete(reminderSends).where(eq(reminderSends.tenantId, tenantId));
  await db.delete(clientCategorySuggestions).where(eq(clientCategorySuggestions.tenantId, tenantId));
});

const send = (reminder: boolean) =>
  sendHelpRequest(tenantId, companyId, userId, {
    contactIds: [contactId], channels: ['email'], confirmEmpty: true, reminder,
  });

describe('categorize help request — reminder mode', () => {
  it('sends reminder wording instead of the first-ask wording', async () => {
    await send(false);
    expect(sentMail[0]!.subject).toMatch(/needs your help/i);

    sentMail = [];
    await send(true);
    expect(sentMail[0]!.subject).toMatch(/^Reminder:/);
    expect(sentMail[0]!.preview).toMatch(/still waiting on you/i);
  });

  it('prefers the firm\'s own reminder template over the built-in wording', async () => {
    await db.insert(reminderTemplates).values({
      tenantId, triggerType: CATEGORIZE_REMINDER_TRIGGER, channel: 'email',
      subject: 'Still waiting on {company_name}', body: 'Hi {first_name}, {count} left. {portal_link}',
    });
    await send(true);
    expect(sentMail[0]!.subject).toBe('Still waiting on Darrow Enterprises');
    expect(sentMail[0]!.preview).toMatch(/^Hi Dana, 0 left\./);
  });

  it('records the reminder on the same tracking + audit trail as the first ask', async () => {
    const result = await send(true);
    expect(result.results[0]!.outcomes).toEqual([{ channel: 'email', outcome: 'sent' }]);
    const sends = await db.select().from(reminderSends).where(eq(reminderSends.tenantId, tenantId));
    expect(sends).toHaveLength(1);
    expect(sends[0]!.questionId).toBe(companyId);   // subject = this company's queue
    expect(sends[0]!.error).toBeNull();
    const logs = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
    const entry = logs.find((l) => l.entityType === 'categorize_help_request');
    expect((entry?.afterData as { reminder?: boolean })?.reminder).toBe(true);
  });
});

describe('categorize mail — who it is from', () => {
  it('is signed by the practice, not by the client whose books they are', async () => {
    // tenants.name is the CLIENT here, so before this was fixed the mail
    // read "<client> needs your help with 42 transactions" and was signed by
    // the client, to the client's own contact.
    const [f] = await db.insert(firms).values({
      name: `Krueger CPA ${stamp}`, slug: `krueger-cat-${stamp}`,
    }).returning();
    await db.insert(tenantFirmAssignments).values({ tenantId, firmId: f!.id, isActive: true });
    try {
      await send(false);
      expect(sentMail[0]!.subject).toContain(`Krueger CPA ${stamp}`);
      expect(sentMail[0]!.subject).not.toContain('Remind');   // the tenant's own name
      expect(sentMail[0]!.preview).toContain('Darrow Enterprises');  // the company still appears
    } finally {
      await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, tenantId));
      await db.delete(firms).where(eq(firms.id, f!.id));
    }
  });
});

describe('categorize help recipients — who still owes an answer', () => {
  it('reports when the contact was last asked and last answered', async () => {
    const before = await listHelpRecipients(tenantId, companyId);
    expect(before.contacts[0]).toMatchObject({ lastAskedAt: null, lastAnsweredAt: null });

    await send(false);
    const asked = await listHelpRecipients(tenantId, companyId);
    expect(asked.contacts[0]!.lastAskedAt).not.toBeNull();
    // Asked, nothing back — this is the contact a reminder is for.
    expect(asked.contacts[0]!.lastAnsweredAt).toBeNull();

    await db.insert(clientCategorySuggestions).values({
      // ccs_has_answer needs a real answer: a note counts, a bare label does not.
      tenantId, companyId, targetKind: 'transaction',
      // transaction_id is a soft reference; ccs_target_exclusive only needs
      // exactly one of the two target columns set.
      transactionId: '00000000-0000-0000-0000-0000000000bb',
      submittedByContactId: contactId, snapshotAmount: '10.0000', snapshotDate: '2026-06-01',
      suggestedLabel: 'Fuel', clientNote: 'Diesel for the truck',
    });
    const answered = await listHelpRecipients(tenantId, companyId);
    expect(answered.contacts[0]!.lastAnsweredAt).not.toBeNull();
  });
});
