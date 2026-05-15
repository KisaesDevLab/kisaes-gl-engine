// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import bcrypt from 'bcrypt';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants,
  portalContacts,
  portalContactSessions,
  portalIdentities,
  portalPasswords,
  portalMagicLinks,
  auditLog,
} from '../db/schema/index.js';
import {
  findOrCreateIdentity,
  getIdentityByEmail,
  hashPassword,
  linkContactToIdentity,
  listLinkedContacts,
  verifyPassword,
} from './portal-identity.service.js';
import { switchToContact } from './portal-auth.service.js';
import crypto from 'node:crypto';

// PORTAL_IDENTITY_LINKING_V1 — covers the identity service primitives
// and, critically, the cross-identity rejection in switchToContact.
// That last test is the horizontal-escalation guard for the feature.

async function clean() {
  await db.delete(auditLog);
  await db.delete(portalMagicLinks);
  await db.delete(portalContactSessions);
  await db.delete(portalPasswords);
  await db.delete(portalContacts);
  await db.delete(portalIdentities);
  await db.delete(tenants);
}

async function mkTenant(slug: string): Promise<string> {
  const [row] = await db
    .insert(tenants)
    .values({ name: `T-${slug}`, slug: `${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` })
    .returning();
  return row!.id;
}

async function mkContact(tenantId: string, email: string, identityId?: string) {
  const [row] = await db
    .insert(portalContacts)
    .values({ tenantId, email, identityId: identityId ?? null })
    .returning();
  return row!;
}

async function mkSession(args: {
  tenantId: string;
  contactId: string;
  identityId: string | null;
}): Promise<{ token: string; id: string }> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const [row] = await db
    .insert(portalContactSessions)
    .values({
      tenantId: args.tenantId,
      contactId: args.contactId,
      identityId: args.identityId,
      tokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    })
    .returning();
  return { token, id: row!.id };
}

beforeAll(() => {
  // Required so isLinkingEnabled() returns true for tests that
  // exercise behaviors gated by the flag (auto-link, switch endpoint,
  // identity-aware login). Tests that need the flag off override
  // process.env explicitly inside the test body.
  process.env['PORTAL_IDENTITY_LINKING_V1'] = 'true';
});

describe('portal-identity.service', () => {
  beforeEach(async () => {
    await clean();
  });
  afterEach(async () => {
    await clean();
  });

  describe('findOrCreateIdentity', () => {
    it('creates a new identity when none exists', async () => {
      const hash = await hashPassword('correct-horse-battery-staple');
      const identity = await findOrCreateIdentity({
        email: 'New@Example.com',
        bcryptHash: hash,
        emailVerified: true,
      });
      expect(identity.id).toBeTruthy();
      expect(identity.email).toBe('new@example.com');
      expect(identity.emailVerifiedAt).toBeTruthy();
    });

    it('is idempotent on email and DOES NOT overwrite the existing hash', async () => {
      const firstHash = await hashPassword('first-password');
      const original = await findOrCreateIdentity({
        email: 'reuse@example.com',
        bcryptHash: firstHash,
        emailVerified: true,
      });
      const secondHash = await hashPassword('different-password');
      const reused = await findOrCreateIdentity({
        email: 'REUSE@example.com',
        bcryptHash: secondHash,
        emailVerified: false,
      });
      expect(reused.id).toBe(original.id);
      // Critical invariant: the existing identity's password is NOT
      // rotated by a subsequent set-password call from another firm.
      expect(reused.bcryptHash).toBe(firstHash);
    });
  });

  describe('getIdentityByEmail', () => {
    it('matches case-insensitively', async () => {
      const hash = await hashPassword('pw');
      await findOrCreateIdentity({ email: 'Found@Example.com', bcryptHash: hash, emailVerified: false });
      const a = await getIdentityByEmail('found@example.com');
      const b = await getIdentityByEmail('FOUND@EXAMPLE.COM');
      expect(a?.id).toBeTruthy();
      expect(a?.id).toBe(b?.id);
    });

    it('returns null when no identity exists', async () => {
      expect(await getIdentityByEmail('missing@example.com')).toBeNull();
    });
  });

  describe('verifyPassword', () => {
    it('returns the row on a correct password and resets failedLoginAttempts', async () => {
      const hash = await hashPassword('correct');
      const identity = await findOrCreateIdentity({ email: 'v@example.com', bcryptHash: hash, emailVerified: true });
      // Seed a non-zero counter to verify reset.
      await db.update(portalIdentities)
        .set({ failedLoginAttempts: 2 })
        .where(eq(portalIdentities.id, identity.id));
      const ok = await verifyPassword(identity.id, 'correct');
      expect(ok?.id).toBe(identity.id);
      const after = await db.query.portalIdentities.findFirst({ where: eq(portalIdentities.id, identity.id) });
      expect(after?.failedLoginAttempts).toBe(0);
      expect(after?.lastLoginAt).toBeTruthy();
    });

    it('returns null on a bad password and increments failedLoginAttempts', async () => {
      const hash = await hashPassword('correct');
      const identity = await findOrCreateIdentity({ email: 'bad@example.com', bcryptHash: hash, emailVerified: true });
      const result = await verifyPassword(identity.id, 'wrong');
      expect(result).toBeNull();
      const after = await db.query.portalIdentities.findFirst({ where: eq(portalIdentities.id, identity.id) });
      expect(after?.failedLoginAttempts).toBe(1);
      expect(after?.lockedUntil).toBeNull();
    });

    it('locks after 5 consecutive failures', async () => {
      const hash = await hashPassword('correct');
      const identity = await findOrCreateIdentity({ email: 'lock@example.com', bcryptHash: hash, emailVerified: true });
      for (let i = 0; i < 5; i++) {
        await verifyPassword(identity.id, 'wrong');
      }
      const after = await db.query.portalIdentities.findFirst({ where: eq(portalIdentities.id, identity.id) });
      expect(after?.failedLoginAttempts).toBe(5);
      expect(after?.lockedUntil).toBeTruthy();
      // 6th attempt — even with the correct password — must throw
      // ACCOUNT_LOCKED. Matches the staff lockout contract.
      await expect(verifyPassword(identity.id, 'correct')).rejects.toMatchObject({
        code: 'ACCOUNT_LOCKED',
      });
    });
  });

  describe('linkContactToIdentity + listLinkedContacts', () => {
    it('binds a contact and surfaces it in listLinkedContacts', async () => {
      const t1 = await mkTenant('one');
      const t2 = await mkTenant('two');
      const hash = await hashPassword('p');
      const identity = await findOrCreateIdentity({ email: 'link@example.com', bcryptHash: hash, emailVerified: true });
      const c1 = await mkContact(t1, 'link@example.com');
      const c2 = await mkContact(t2, 'link@example.com');

      await linkContactToIdentity(c1.id, identity.id);
      await linkContactToIdentity(c2.id, identity.id);

      const linked = await listLinkedContacts(identity.id);
      expect(linked.map((c) => c.contactId).sort()).toEqual([c1.id, c2.id].sort());
    });

    it('excludes contacts with status != active', async () => {
      const t1 = await mkTenant('active');
      const t2 = await mkTenant('paused');
      const hash = await hashPassword('p');
      const identity = await findOrCreateIdentity({ email: 'filter@example.com', bcryptHash: hash, emailVerified: true });
      const cActive = await mkContact(t1, 'filter@example.com');
      const cPaused = await mkContact(t2, 'filter@example.com');
      await db.update(portalContacts).set({ status: 'paused' }).where(eq(portalContacts.id, cPaused.id));
      await linkContactToIdentity(cActive.id, identity.id);
      await linkContactToIdentity(cPaused.id, identity.id);

      const linked = await listLinkedContacts(identity.id);
      expect(linked.map((c) => c.contactId)).toEqual([cActive.id]);
    });
  });

  describe('switchToContact (cross-firm authz)', () => {
    it('rotates the cookie and mints a new session when target shares identity', async () => {
      const t1 = await mkTenant('a');
      const t2 = await mkTenant('b');
      const hash = await hashPassword('p');
      const identity = await findOrCreateIdentity({ email: 'switch@example.com', bcryptHash: hash, emailVerified: true });
      const c1 = await mkContact(t1, 'switch@example.com', identity.id);
      const c2 = await mkContact(t2, 'switch@example.com', identity.id);
      const session = await mkSession({ tenantId: t1, contactId: c1.id, identityId: identity.id });

      const result = await switchToContact({
        currentSessionToken: session.token,
        targetContactId: c2.id,
      });

      expect(result.contactId).toBe(c2.id);
      expect(result.tenantId).toBe(t2);
      // Old session row deleted.
      const oldRow = await db.query.portalContactSessions.findFirst({
        where: eq(portalContactSessions.id, session.id),
      });
      expect(oldRow).toBeUndefined();
      // New session exists for the target contact AND carries identity.
      const newHash = crypto.createHash('sha256').update(result.sessionToken).digest('hex');
      const newRow = await db.query.portalContactSessions.findFirst({
        where: eq(portalContactSessions.tokenHash, newHash),
      });
      expect(newRow?.contactId).toBe(c2.id);
      expect(newRow?.identityId).toBe(identity.id);
    });

    it('refuses to switch when the target belongs to a different identity', async () => {
      const t1 = await mkTenant('alice');
      const t2 = await mkTenant('bob');
      const aliceHash = await hashPassword('a');
      const bobHash = await hashPassword('b');
      const aliceIdentity = await findOrCreateIdentity({ email: 'alice@example.com', bcryptHash: aliceHash, emailVerified: true });
      const bobIdentity = await findOrCreateIdentity({ email: 'bob@example.com', bcryptHash: bobHash, emailVerified: true });
      const aliceContact = await mkContact(t1, 'alice@example.com', aliceIdentity.id);
      const bobContact = await mkContact(t2, 'bob@example.com', bobIdentity.id);
      const session = await mkSession({ tenantId: t1, contactId: aliceContact.id, identityId: aliceIdentity.id });

      // Alice tries to switch into Bob's contact — must be rejected.
      // This is the horizontal-escalation guard.
      await expect(
        switchToContact({
          currentSessionToken: session.token,
          targetContactId: bobContact.id,
        }),
      ).rejects.toMatchObject({ code: 'TARGET_UNAVAILABLE' });

      // Alice's session still exists; Bob's contact unchanged.
      const stillOurs = await db.query.portalContactSessions.findFirst({
        where: eq(portalContactSessions.id, session.id),
      });
      expect(stillOurs?.contactId).toBe(aliceContact.id);
    });

    it('refuses to switch from a session without identity_id', async () => {
      const t = await mkTenant('legacy');
      const hash = await hashPassword('p');
      const identity = await findOrCreateIdentity({ email: 'target@example.com', bcryptHash: hash, emailVerified: true });
      const legacyContact = await mkContact(t, 'legacy@example.com');
      const linkedTarget = await mkContact(t, 'target@example.com', identity.id);
      // The legacy session has identity_id = null even though the
      // target is identity-bound. Switching must still fail because
      // we don't trust the cookie to pick which identity to scope to.
      const session = await mkSession({ tenantId: t, contactId: legacyContact.id, identityId: null });

      await expect(
        switchToContact({
          currentSessionToken: session.token,
          targetContactId: linkedTarget.id,
        }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_LINKED' });
    });
  });
});
