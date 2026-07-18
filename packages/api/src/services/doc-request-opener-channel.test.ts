// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// DOC_REQUEST_SMS_V1 — the standing-request opener honors the per-rule
// reminder_channel, and (regression) always sends on issuance even to a
// recently-active contact (the 7-day engagement throttle must not
// suppress a brand-new obligation).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, portalContacts, documentRequests, reminderSends,
  portalSettingsPerPractice, tenantFeatureFlags, reminderSuppressions,
} from '../db/schema/index.js';

// Capture the transport without hitting SMTP or an SMS provider.
const emailSend = vi.fn().mockResolvedValue(undefined);
vi.mock('./admin.service.js', async (orig) => {
  const actual = await orig<typeof import('./admin.service.js')>();
  return { ...actual, getSmtpSettings: async () => ({ smtpHost: 'smtp.test', smtpPort: 587, smtpUser: '', smtpPass: '', smtpFrom: 'f@test', smtpFromName: '', source: 'db' }) };
});
vi.mock('nodemailer', () => ({
  default: { createTransport: () => ({ sendMail: (...a: unknown[]) => emailSend(...a) }) },
}));

import { sendOpenerForDocRequest } from './portal-reminders.service.js';

let tenantId = '';
let companyId = '';
let contactId = '';
const uniq = Date.now() + '-' + Math.random().toString(36).slice(2, 6);

async function makeRequest(reminderChannel: string, over: Partial<typeof documentRequests.$inferInsert> = {}) {
  const [req] = await db.insert(documentRequests).values({
    tenantId, companyId, contactId, documentType: 'bank_statement',
    description: 'Checking xxxx-1234', periodLabel: '2026-07-' + Math.random().toString(36).slice(2, 6),
    status: 'pending', reminderChannel, ...over,
  }).returning();
  return req!;
}

beforeEach(async () => {
  emailSend.mockClear();
  const [t] = await db.insert(tenants).values({ name: 'Opener', slug: 'opener-' + uniq + Math.random().toString(36).slice(2, 5) }).returning();
  tenantId = t!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Opener Co' }).returning();
  companyId = co!.id;
  const [pc] = await db.insert(portalContacts).values({
    tenantId, email: `opener-${uniq}@example.com`, phone: '+15555550123', status: 'active',
  }).returning();
  contactId = pc!.id;
});

afterEach(async () => {
  await db.delete(reminderSends).where(eq(reminderSends.tenantId, tenantId));
  if (contactId) await db.delete(reminderSuppressions).where(eq(reminderSuppressions.contactId, contactId));
  await db.delete(documentRequests).where(eq(documentRequests.tenantId, tenantId));
  await db.delete(portalSettingsPerPractice).where(eq(portalSettingsPerPractice.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.id, companyId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

async function setSmsEnabled(flagOn: boolean, tenantOutbound: boolean) {
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'DOC_REQUEST_SMS_V1', enabled: flagOn })
    .onConflictDoNothing();
  await db.insert(portalSettingsPerPractice).values({ tenantId, smsOutboundEnabled: tenantOutbound })
    .onConflictDoUpdate({ target: portalSettingsPerPractice.tenantId, set: { smsOutboundEnabled: tenantOutbound } });
}

function channelsSent() {
  return db.select({ channel: reminderSends.channel }).from(reminderSends).where(eq(reminderSends.tenantId, tenantId));
}

describe('doc-request opener — channel selection', () => {
  it("channel 'email' sends only email", async () => {
    const req = await makeRequest('email');
    const r = await sendOpenerForDocRequest(tenantId, req.id);
    expect(r).toBe('sent');
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect((await channelsSent()).map((x) => x.channel)).toEqual(['email']);
  });

  it("channel 'both' with SMS enabled records an email AND an sms send", async () => {
    await setSmsEnabled(true, true);
    const req = await makeRequest('both');
    // SMS leg needs a system provider; getRawConfig has none in test, so
    // the sms send records an error row but the row + channel still exist.
    const r = await sendOpenerForDocRequest(tenantId, req.id);
    expect(r).toBe('sent'); // email leg delivered
    const chans = (await channelsSent()).map((x) => x.channel).sort();
    expect(chans).toEqual(['email', 'sms']);
  });

  it("channel 'sms' falls back to email when the DOC_REQUEST_SMS_V1 flag is off", async () => {
    await setSmsEnabled(false, true); // tenant outbound on, but flag off
    const req = await makeRequest('sms');
    const r = await sendOpenerForDocRequest(tenantId, req.id);
    expect(r).toBe('sent');
    expect((await channelsSent()).map((x) => x.channel)).toEqual(['email']); // fallback, not dropped
  });

  it("channel 'sms' falls back to email when the contact has no phone", async () => {
    await setSmsEnabled(true, true);
    await db.update(portalContacts).set({ phone: '' }).where(eq(portalContacts.id, contactId));
    const req = await makeRequest('sms');
    const r = await sendOpenerForDocRequest(tenantId, req.id);
    expect(r).toBe('sent');
    expect((await channelsSent()).map((x) => x.channel)).toEqual(['email']);
  });

  it('opener still sends to a recently-active contact (engagement throttle skipped)', async () => {
    // The 7-day engagement window suppresses repeat nudges, but a
    // brand-new request must always announce itself.
    await db.update(portalContacts).set({ lastSeenAt: new Date() }).where(eq(portalContacts.id, contactId));
    const req = await makeRequest('email');
    const r = await sendOpenerForDocRequest(tenantId, req.id);
    expect(r).toBe('sent');
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it('opener STILL respects an explicit STOP/opt-out suppression', async () => {
    await db.insert(reminderSuppressions).values({ contactId, reason: 'STOP_KEYWORD', channel: null });
    const req = await makeRequest('email');
    const r = await sendOpenerForDocRequest(tenantId, req.id);
    expect(r).toBe('suppressed');
    expect(emailSend).not.toHaveBeenCalled();
  });
});
