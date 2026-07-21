// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Magic-link / portal-link hardening:
//   - staff /send is no longer an enumeration oracle: ineligible REAL
//     accounts get the same silent success as unknown emails (no 400)
//   - the system-wide tfa_config.magicLinkEnabled toggle is enforced
//     at send (silently) and verify (with a reason)
//   - portal email base URL prefers the operator-configured PUBLIC_URL
//     over attacker-controllable request headers
//   - reminder links fall back to PUBLIC_URL (not localhost) and carry
//     the ?firm= slug the portal login page needs to resolve the tenant

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, magicLinks, tfaConfig, sessions } from '../db/schema/index.js';
import { sendMagicLink, verifyMagicLink } from './magic-link.service.js';
import { __portalLinkBaseForTests, __portalLoginLinkForTests } from './portal-reminders.service.js';
import { resolveEmailBaseUrl } from '../routes/portal-auth.routes.js';

const uniq = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const EMAIL = `ml-hardening-${uniq}@example.com`;
let tenantId = '';
let userId = '';

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(async () => {
  await db.delete(tfaConfig); // global singleton — suites share it by design
  const [t] = await db.insert(tenants).values({ name: 'ML Hardening', slug: 'ml-hardening-' + uniq }).returning();
  tenantId = t!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: EMAIL, passwordHash: 'not-used', displayName: 'ML', role: 'owner',
    magicLinkEnabled: true, tfaMethods: 'totp', tfaTotpVerified: true,
  }).returning();
  userId = u!.id;
});

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
  await db.delete(magicLinks).where(eq(magicLinks.userId, userId));
  // The direct-login verify test issues a real session; clear it before the
  // user delete or the FK blocks cleanup and leaks the tenant (slug collision
  // on the next beforeEach).
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.delete(tfaConfig);
});

async function enableSystemMagicLink(enabled: boolean) {
  await db.insert(tfaConfig).values({ magicLinkEnabled: enabled });
}

describe('staff magic-link send — enumeration safety', () => {
  it('eligible user with system toggle on: link row is created', async () => {
    await enableSystemMagicLink(true);
    const res = await sendMagicLink(EMAIL, '127.0.0.1', 'vitest');
    expect(res.sent).toBe(true);
    const rows = await db.select().from(magicLinks).where(eq(magicLinks.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('per-user opt-in is no longer required: a link row is still created', async () => {
    // Magic-link is now available to any active user (system toggle is the
    // only gate); the per-user magicLinkEnabled flag no longer blocks a send.
    await enableSystemMagicLink(true);
    await db.update(users).set({ magicLinkEnabled: false }).where(eq(users.id, userId));
    const res = await sendMagicLink(EMAIL, '127.0.0.1', 'vitest');
    expect(res.sent).toBe(true);
    expect(await db.select().from(magicLinks).where(eq(magicLinks.userId, userId))).toHaveLength(1);
  });

  it('no non-email second factor: a link is still created (single-factor login)', async () => {
    await enableSystemMagicLink(true);
    await db.update(users).set({ tfaMethods: 'email' }).where(eq(users.id, userId));
    const res = await sendMagicLink(EMAIL, '127.0.0.1', 'vitest');
    expect(res.sent).toBe(true);
    expect(await db.select().from(magicLinks).where(eq(magicLinks.userId, userId))).toHaveLength(1);
  });

  it('system toggle off: silent success, no row (still the master switch)', async () => {
    await enableSystemMagicLink(false);
    const res = await sendMagicLink(EMAIL, '127.0.0.1', 'vitest');
    expect(res.sent).toBe(true);
    expect(await db.select().from(magicLinks).where(eq(magicLinks.userId, userId))).toHaveLength(0);
  });
});

describe('staff magic-link verify — second factor vs direct login', () => {
  async function insertLink(): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await db.insert(magicLinks).values({
      userId, tokenHash, expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    });
    return token;
  }

  it('user WITH a TOTP factor: returns a 2FA challenge, not a session', async () => {
    await enableSystemMagicLink(true);
    // beforeEach already gave this user tfaMethods='totp'.
    const token = await insertLink();
    const res = await verifyMagicLink(token) as Record<string, unknown>;
    expect(res['loggedIn']).toBe(false);
    expect(res['tfaToken']).toBeTruthy();
    expect(res['accessToken']).toBeUndefined();
    expect(res['availableMethods']).toContain('totp');
  });

  it('user WITHOUT a non-email factor: logs in directly (session, no challenge)', async () => {
    await enableSystemMagicLink(true);
    await db.update(users).set({ tfaMethods: 'email' }).where(eq(users.id, userId));
    const token = await insertLink();
    const res = await verifyMagicLink(token) as Record<string, unknown>;
    expect(res['loggedIn']).toBe(true);
    expect(res['accessToken']).toBeTruthy();
    expect(res['refreshToken']).toBeTruthy();
    expect(res['tfaToken']).toBeUndefined();
  });
});

describe('staff magic-link send — expiry parity (no oracle via expiresInMinutes)', () => {
  it('unknown emails answer with the CONFIGURED expiry, same as real accounts', async () => {
    await db.insert(tfaConfig).values({ magicLinkEnabled: true, magicLinkExpiryMinutes: 30 });
    const unknown = await sendMagicLink(`nobody-${uniq}@example.com`, '127.0.0.1', 'vitest');
    const known = await sendMagicLink(EMAIL, '127.0.0.1', 'vitest');
    expect(unknown.expiresInMinutes).toBe(30); // was hard-coded 15 → enumeration oracle
    expect(known.expiresInMinutes).toBe(30);
  });
});

describe('staff magic-link verify — system toggle', () => {
  it('refuses verification while the system toggle is off', async () => {
    await enableSystemMagicLink(false);
    await expect(verifyMagicLink('any-token-value-here')).rejects.toThrow(/disabled by your administrator/);
  });
});

describe('portal email base URL', () => {
  it('prefers PUBLIC_URL over request headers (link-poisoning guard)', () => {
    setEnv('PUBLIC_URL', 'https://mybooks.example.com/');
    const base = resolveEmailBaseUrl(
      { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.attacker.tld', host: 'evil.attacker.tld' },
      'http',
    );
    expect(base).toBe('https://mybooks.example.com'); // trailing slash stripped, headers ignored
  });

  it('falls back to headers only when PUBLIC_URL is unset (dev)', () => {
    setEnv('PUBLIC_URL', undefined);
    const base = resolveEmailBaseUrl({ host: 'localhost:5173' }, 'http');
    expect(base).toBe('http://localhost:5173');
  });
});

describe('reminder portal links', () => {
  it('base falls back PORTAL_BASE_URL → PUBLIC_URL → localhost', () => {
    setEnv('PORTAL_BASE_URL', undefined);
    setEnv('PUBLIC_URL', 'https://mybooks.example.com');
    expect(__portalLinkBaseForTests()).toBe('https://mybooks.example.com');
    setEnv('PORTAL_BASE_URL', 'https://portal.example.com/');
    expect(__portalLinkBaseForTests()).toBe('https://portal.example.com');
    setEnv('PORTAL_BASE_URL', undefined);
    setEnv('PUBLIC_URL', undefined);
    expect(__portalLinkBaseForTests()).toBe('http://localhost:5173');
  });

  it('login link carries the ?firm= slug the login page needs', async () => {
    const link = await __portalLoginLinkForTests('https://mybooks.example.com', tenantId);
    expect(link).toBe(`https://mybooks.example.com/portal/login?firm=${encodeURIComponent('ml-hardening-' + uniq)}`);
  });
});
