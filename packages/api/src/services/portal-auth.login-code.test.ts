// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Portal sign-in by email OR mobile number (0227). The message goes by the
// channel typed — email for an address, SMS for a number (email fallback
// when SMS can't be sent) — and carries a 6-digit code beside the link. A
// person on several tenants gets one message per tenant; the code entered
// picks the tenant. An SMS sign-in does not prove the email address.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

const sent = vi.hoisted(() => ({
  emails: [] as Array<{ to: string; subject: string; text: string }>,
  texts: [] as Array<{ to: string; body: string }>,
  smsConfigured: true,
  smsOk: true,
  suppressed: false,
}));

vi.mock('./admin.service.js', async (orig) => ({
  ...(await orig<typeof import('./admin.service.js')>()),
  getSmtpSettings: async () => ({ smtpHost: 'smtp.test', smtpPort: 587, smtpUser: '', smtpPass: '', smtpFrom: 'portal@test', smtpFromName: 'Portal' }),
}));
vi.mock('../utils/mail-transport.js', () => ({
  createMailTransport: () => ({
    sendMail: async (m: { to: string; subject: string; text: string }) => { sent.emails.push({ to: m.to, subject: m.subject, text: m.text }); },
  }),
}));
vi.mock('./tfa-config.service.js', async (orig) => ({
  ...(await orig<typeof import('./tfa-config.service.js')>()),
  getRawConfig: async () => (sent.smsConfigured ? { smsProvider: 'twilio' } : { smsProvider: null }),
}));
vi.mock('./sms-providers/index.js', () => ({
  getSmsProvider: () => ({
    sendText: async (to: string, body: string) => { sent.texts.push({ to, body }); return { success: sent.smsOk }; },
  }),
}));
vi.mock('./sms-suppression.service.js', async (orig) => ({
  ...(await orig<typeof import('./sms-suppression.service.js')>()),
  isPhoneSuppressed: async () => sent.suppressed,
}));

const { db } = await import('../db/index.js');
const { tenants, portalContacts, portalMagicLinks, portalContactSessions, auditLog } = await import('../db/schema/index.js');
const auth = await import('./portal-auth.service.js');

const uniq = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const EMAIL = `code-${uniq}@example.com`;
// A unique 10-digit number per run so other suites' contacts never match.
const PHONE_DIGITS = `555${String(Date.now()).slice(-7)}`;
const PHONE_TYPED = `(${PHONE_DIGITS.slice(0, 3)}) ${PHONE_DIGITS.slice(3, 6)}-${PHONE_DIGITS.slice(6)}`;
const tenantIds: string[] = [];
const BASE = 'https://books.example.com';

const codeIn = (s: string) => s.match(/\b(\d{6})\b/)![1]!;
const phone = () => auth.parseLoginIdentifier(PHONE_TYPED)!;
const email = () => auth.parseLoginIdentifier(EMAIL)!;

async function requestEverywhere(identifier: ReturnType<typeof phone>) {
  const ids = identifier.kind === 'email'
    ? await auth.resolveActiveContactTenants(identifier.value)
    : await auth.resolveActiveContactTenantsByPhone(identifier.value);
  for (const t of ids) await auth.requestPortalSignIn({ tenantId: t, identifier, baseUrl: BASE });
}

beforeEach(async () => {
  Object.assign(sent, { emails: [], texts: [], smsConfigured: true, smsOk: true, suppressed: false });
  for (const n of ['Acme LLC', 'Birch Co']) {
    const [t] = await db.insert(tenants).values({ name: n, slug: `code-${n.split(' ')[0]!.toLowerCase()}-${uniq}` }).returning();
    tenantIds.push(t!.id);
  }
  // Same person on both tenants, phone stored in two different formats.
  await db.insert(portalContacts).values({ tenantId: tenantIds[0]!, email: EMAIL, phone: PHONE_TYPED, firstName: 'Pat', status: 'active' });
  await db.insert(portalContacts).values({ tenantId: tenantIds[1]!, email: EMAIL, phone: `+1${PHONE_DIGITS}`, firstName: 'Pat', status: 'active' });
});

afterEach(async () => {
  await db.delete(portalContactSessions).where(inArray(portalContactSessions.tenantId, tenantIds));
  await db.delete(portalMagicLinks).where(inArray(portalMagicLinks.tenantId, tenantIds));
  await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
  await db.delete(portalContacts).where(inArray(portalContacts.tenantId, tenantIds));
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  tenantIds.length = 0;
});

describe('parseLoginIdentifier', () => {
  it('reads an email or a mobile number and rejects anything else', () => {
    expect(auth.parseLoginIdentifier(' Pat@Example.COM ')).toEqual({ kind: 'email', value: 'pat@example.com' });
    expect(auth.parseLoginIdentifier('(555) 123-4567')).toEqual({ kind: 'phone', value: '5551234567' });
    expect(auth.parseLoginIdentifier('+1 555.123.4567')).toEqual({ kind: 'phone', value: '5551234567' });
    expect(auth.parseLoginIdentifier('12345')).toBeNull();
    expect(auth.parseLoginIdentifier('pat@')).toBeNull();
    expect(auth.parseLoginIdentifier('call me')).toBeNull();
  });
});

describe('sign-in by mobile number', () => {
  it('texts one code per tenant, names the client, and the code picks the tenant', async () => {
    await requestEverywhere(phone());
    expect(sent.emails).toHaveLength(0);
    expect(sent.texts).toHaveLength(2);
    const acme = sent.texts.find((t) => t.body.startsWith('Acme LLC portal'))!;
    const birch = sent.texts.find((t) => t.body.startsWith('Birch Co portal'))!;
    expect(acme.body).toContain('/portal/auth/verify?token=');
    expect(codeIn(acme.body)).not.toBe(codeIn(birch.body));

    const session = await auth.verifyLoginCode({ identifier: phone(), code: codeIn(birch.body) });
    expect(session.tenantId).toBe(tenantIds[1]);
    const [row] = await db.select().from(portalContactSessions).where(eq(portalContactSessions.contactId, session.contactId));
    // Proved the phone, not the email: no verified address on the session.
    expect(row!.verifiedEmail).toBeNull();

    // Used once; the other tenant's code still works.
    await expect(auth.verifyLoginCode({ identifier: phone(), code: codeIn(birch.body) })).rejects.toMatchObject({ code: 'BAD_CODE' });
    expect((await auth.verifyLoginCode({ identifier: phone(), code: codeIn(acme.body) })).tenantId).toBe(tenantIds[0]);
  });

  it('falls back to email when SMS is not configured, and the code works with the number typed', async () => {
    sent.smsConfigured = false;
    await auth.requestPortalSignIn({ tenantId: tenantIds[0]!, identifier: phone(), baseUrl: BASE });
    expect(sent.texts).toHaveLength(0);
    expect(sent.emails).toHaveLength(1);
    expect(sent.emails[0]!.to).toBe(EMAIL);
    expect(sent.emails[0]!.subject).toContain('Acme LLC');
    const session = await auth.verifyLoginCode({ identifier: phone(), code: codeIn(sent.emails[0]!.text) });
    const [row] = await db.select().from(portalContactSessions).where(eq(portalContactSessions.contactId, session.contactId));
    expect(row!.verifiedEmail).toBe(EMAIL); // delivered by email, so the email is proved
  });

  it('falls back to email for a number that opted out (STOP) or when the text fails', async () => {
    sent.suppressed = true;
    await auth.requestPortalSignIn({ tenantId: tenantIds[0]!, identifier: phone(), baseUrl: BASE });
    sent.suppressed = false;
    sent.smsOk = false;
    await auth.requestPortalSignIn({ tenantId: tenantIds[1]!, identifier: phone(), baseUrl: BASE });
    expect(sent.emails).toHaveLength(2);
    const links = await db.select().from(portalMagicLinks).where(inArray(portalMagicLinks.tenantId, tenantIds));
    expect(links.map((l) => l.sentVia)).toEqual(['email', 'email']);
  });
});

describe('sign-in by email', () => {
  it('emails a code and link per tenant; the code signs in once', async () => {
    await requestEverywhere(email());
    expect(sent.texts).toHaveLength(0);
    expect(sent.emails).toHaveLength(2);
    const code = codeIn(sent.emails[0]!.text);
    const session = await auth.verifyLoginCode({ identifier: email(), code });
    const [row] = await db.select().from(portalContactSessions).where(eq(portalContactSessions.contactId, session.contactId));
    expect(row!.verifiedEmail).toBe(EMAIL);
    await expect(auth.verifyLoginCode({ identifier: email(), code })).rejects.toMatchObject({ code: 'BAD_CODE' });
  });

  it('a code is only good for the identifier it was sent to', async () => {
    await auth.requestPortalSignIn({ tenantId: tenantIds[0]!, identifier: email(), baseUrl: BASE });
    await expect(auth.verifyLoginCode({ identifier: phone(), code: codeIn(sent.emails[0]!.text) })).rejects.toMatchObject({ code: 'BAD_CODE' });
  });

  it('stops accepting codes after 5 wrong attempts', async () => {
    await auth.requestPortalSignIn({ tenantId: tenantIds[0]!, identifier: email(), baseUrl: BASE });
    const right = codeIn(sent.emails[0]!.text);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      await expect(auth.verifyLoginCode({ identifier: email(), code: wrong })).rejects.toMatchObject({ code: 'BAD_CODE' });
    }
    await expect(auth.verifyLoginCode({ identifier: email(), code: right })).rejects.toMatchObject({ code: 'BAD_CODE' });
  });

  it('sends nothing for an unknown address or number', async () => {
    await requestEverywhere(auth.parseLoginIdentifier(`nobody-${uniq}@example.com`)!);
    await requestEverywhere(auth.parseLoginIdentifier('(999) 000-0001')!);
    expect(sent.emails).toHaveLength(0);
    expect(sent.texts).toHaveLength(0);
  });
});
