// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Switching between firms in the portal.
//
// The switcher was keyed on a linked identity, and an identity only exists
// once a client has set a password — which almost none do, because the
// portal signs people in with emailed links. So the one person the feature
// exists for, someone who books with two of the firm's clients, never saw
// it. A session is only minted after its holder proved control of the email
// address, so the same address in another tenancy is the same human.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, portalContacts, portalContactSessions } from '../db/schema/index.js';
import { switchToContact } from './portal-auth.service.js';
import { updateContact } from './portal-contact.service.js';
import { listSiblingContactsByEmail } from './portal-identity.service.js';

const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const email = `both-${stamp}@example.com`;
const tenantIds: string[] = [];
let contactA = '';
let contactB = '';
let strangerContact = '';
let sessionToken = '';

const hash = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

async function mkTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenants).values({ name, slug: `${name.toLowerCase()}-${stamp}` }).returning();
  tenantIds.push(t!.id);
  await db.insert(companies).values({ tenantId: t!.id, businessName: `${name} Co` });
  return t!.id;
}

beforeAll(async () => {
  const a = await mkTenant(`Alpha${stamp}`);
  const b = await mkTenant(`Bravo${stamp}`);
  const [ca] = await db.insert(portalContacts).values({
    tenantId: a, email, firstName: 'Sam', lastName: 'Client', status: 'active',
  }).returning();
  contactA = ca!.id;
  const [cb] = await db.insert(portalContacts).values({
    tenantId: b, email, firstName: 'Sam', lastName: 'Client', status: 'active',
  }).returning();
  contactB = cb!.id;
  // Same tenancy as B, different person — must never be reachable.
  const [cs] = await db.insert(portalContacts).values({
    tenantId: b, email: `stranger-${stamp}@example.com`, status: 'active',
  }).returning();
  strangerContact = cs!.id;

  sessionToken = crypto.randomBytes(16).toString('hex');
  await db.insert(portalContactSessions).values({
    tenantId: a,
    contactId: contactA,
    identityId: null,                       // magic-link session: no identity
    verifiedEmail: email,                   // the address it was minted against
    tokenHash: hash(sessionToken),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
});

afterAll(async () => {
  if (tenantIds.length === 0) return;
  await db.delete(portalContactSessions).where(inArray(portalContactSessions.tenantId, tenantIds));
  await db.delete(portalContacts).where(inArray(portalContacts.tenantId, tenantIds));
  await db.delete(companies).where(inArray(companies.tenantId, tenantIds));
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
});

describe('portal firm switching', () => {
  it('lists both tenancies for one email, without an identity', async () => {
    const siblings = await listSiblingContactsByEmail(email);
    expect(siblings.map((s) => s.contactId).sort()).toEqual([contactA, contactB].sort());
    expect(siblings.every((s) => s.tenantName.includes(stamp))).toBe(true);
  });

  it('switches a magic-link session to the same person at the other firm', async () => {
    const next = await switchToContact({ currentSessionToken: sessionToken, targetContactId: contactB });
    expect(next.contactId).toBe(contactB);
    expect(next.tenantId).toBe(tenantIds[1]);
    // The old cookie is dead, the new one works.
    const old = await db.select().from(portalContactSessions).where(eq(portalContactSessions.tokenHash, hash(sessionToken)));
    expect(old).toHaveLength(0);
    const fresh = await db.select().from(portalContactSessions)
      .where(eq(portalContactSessions.tokenHash, hash(next.sessionToken)));
    expect(fresh[0]!.contactId).toBe(contactB);
    expect(fresh[0]!.identityId).toBeNull();
    sessionToken = next.sessionToken;   // keep switching from here
  });

  it('switches back', async () => {
    const back = await switchToContact({ currentSessionToken: sessionToken, targetContactId: contactA });
    expect(back.contactId).toBe(contactA);
    sessionToken = back.sessionToken;
  });

  it('refuses a contact belonging to a different email', async () => {
    await expect(
      switchToContact({ currentSessionToken: sessionToken, targetContactId: strangerContact }),
    ).rejects.toThrow(/not available/i);
  });

  it('refuses a paused target', async () => {
    await db.update(portalContacts).set({ status: 'paused' }).where(eq(portalContacts.id, contactB));
    await expect(
      switchToContact({ currentSessionToken: sessionToken, targetContactId: contactB }),
    ).rejects.toThrow(/not available/i);
    // …and a paused tenancy drops off the switcher entirely.
    expect((await listSiblingContactsByEmail(email)).map((s) => s.contactId)).toEqual([contactA]);
    await db.update(portalContacts).set({ status: 'active' }).where(eq(portalContacts.id, contactB));
  });

  it('refuses a session that predates the pinned address', async () => {
    // Sessions issued before migration 0182 carry no proof of an address.
    // They fail closed rather than falling back to the mutable column.
    const token = crypto.randomBytes(16).toString('hex');
    await db.insert(portalContactSessions).values({
      tenantId: tenantIds[0]!, contactId: contactA, identityId: null,
      verifiedEmail: null, tokenHash: hash(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await expect(
      switchToContact({ currentSessionToken: token, targetContactId: contactB }),
    ).rejects.toThrow(/not available/i);
  });

  it('cannot be aimed at someone else by editing the contact email', async () => {
    // The escalation this rule exists to stop: staff sign in as a contact of
    // their own tenant, repoint it at a victim's address in another tenant,
    // and inherit the victim's portal. Editing the address now kills the
    // session outright, and even a surviving one compares the address the
    // session was MINTED against, not the column staff can edit.
    const token = crypto.randomBytes(16).toString('hex');
    const [attacker] = await db.insert(portalContacts).values({
      tenantId: tenantIds[0]!, email: `attacker-${stamp}@example.com`, status: 'active',
    }).returning();
    await db.insert(portalContactSessions).values({
      tenantId: tenantIds[0]!, contactId: attacker!.id, identityId: null,
      verifiedEmail: `attacker-${stamp}@example.com`, tokenHash: hash(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    // A victim address that does NOT exist in the attacker's own tenant, so
    // the per-tenant duplicate check cannot be what stops this.
    const victimEmail = `victim-${stamp}@example.com`;
    const [victim] = await db.insert(portalContacts).values({
      tenantId: tenantIds[1]!, email: victimEmail, status: 'active',
    }).returning();
    await updateContact(tenantIds[0]!, attacker!.id, { email: victimEmail });

    // The session is gone the moment the address changed.
    const left = await db.select().from(portalContactSessions)
      .where(eq(portalContactSessions.tokenHash, hash(token)));
    expect(left).toHaveLength(0);
    await expect(
      switchToContact({ currentSessionToken: token, targetContactId: victim!.id }),
    ).rejects.toThrow();
  });
});
