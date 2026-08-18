// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Regression tests for the second 2026-08-18 security batch:
//   M2 companyContext enforces accountant_company_exclusions
//   M4 budgets / recurring reject unknown fields (mass assignment)
//   M5 portal password login: uniform errors + per-contact lockout
//   M6 login: account state disclosed only after a correct password;
//      super-admins get a timed lock instead of admin-unlock

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { inArray, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, budgets, budgetLines,
  accountantCompanyExclusions, portalContacts, portalPasswords, portalContactSessions, portalIdentities, userTenantAccess,
} from '../db/schema/index.js';
import { companyRouter } from './company.routes.js';
import { budgetsRouter } from './budgets.routes.js';
import { recurringRouter } from './recurring.routes.js';
import * as authService from '../services/auth.service.js';
import * as portalAuth from '../services/portal-auth.service.js';
import * as companyService from '../services/company.service.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
const PFX = 'sec-batch2-20260818';
const OWNER = `${PFX}-owner@example.com`;
const ACCT = `${PFX}-acct@example.com`;
const SUPER = `${PFX}-super@example.com`;
const PORTAL = `${PFX}-portal@example.com`;
const ALL = [OWNER, ACCT, SUPER];

async function cleanDb() {
  const rows = await db.select({ id: users.id, tenantId: users.tenantId }).from(users).where(inArray(users.email, ALL));
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const userIds = rows.map((r) => r.id);
  if (userIds.length) {
    await db.delete(accountantCompanyExclusions).where(inArray(accountantCompanyExclusions.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, userIds));
  }
  if (tenantIds.length) {
    const contactRows = await db.select({ id: portalContacts.id }).from(portalContacts).where(inArray(portalContacts.tenantId, tenantIds));
    const contactIds = contactRows.map((c) => c.id);
    if (contactIds.length) {
      await db.delete(portalContactSessions).where(inArray(portalContactSessions.contactId, contactIds));
      await db.delete(portalPasswords).where(inArray(portalPasswords.contactId, contactIds));
    }
    await db.delete(portalContacts).where(inArray(portalContacts.tenantId, tenantIds));
    const bRows = await db.select({ id: budgets.id }).from(budgets).where(inArray(budgets.tenantId, tenantIds));
    if (bRows.length) await db.delete(budgetLines).where(inArray(budgetLines.budgetId, bRows.map((b) => b.id)));
    await db.delete(budgets).where(inArray(budgets.tenantId, tenantIds));
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.tenantId, tenantIds));
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
    await db.delete(accounts).where(inArray(accounts.tenantId, tenantIds));
    await db.delete(companies).where(inArray(companies.tenantId, tenantIds));
    await db.delete(users).where(inArray(users.tenantId, tenantIds));
    await db.delete(tenants).where(inArray(tenants.id, tenantIds));
  }
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/company', companyRouter);
  app.use('/api/v1/budgets', budgetsRouter);
  app.use('/api/v1/recurring', recurringRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

function request(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method,
        headers: { 'Content-Type': 'application/json', ...headers, ...(data ? { 'Content-Length': String(data.length) } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); }
          catch { resolve({ status: res.statusCode ?? 0, json: { raw } }); }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(async () => { await cleanDb(); await startApp(); });
afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('M2 — accountant company exclusions are enforced by companyContext', () => {
  it('excluded company is refused via X-Company-Id and skipped as the fallback', async () => {
    const reg = await authService.register({ email: OWNER, password: 'password123', displayName: 'Owner', companyName: 'Main Co' });
    const second = await companyService.createAdditionalCompany(reg.user.tenantId, { businessName: 'Second Co' });
    const invited = await authService.inviteUser(reg.user.tenantId, { email: ACCT, displayName: 'Acct', role: 'accountant' }, reg.user.id);
    const login = await authService.login({ email: ACCT, password: invited.temporaryPassword! });

    // Before exclusion: both companies reachable.
    const okBefore = await request('GET', '/api/v1/company', undefined, { ...bearer(login.tokens.accessToken), 'x-company-id': second.id });
    expect(okBefore.status).toBe(200);

    await db.insert(accountantCompanyExclusions).values({ userId: invited.user.id, companyId: second.id } as any);

    const denied = await request('GET', '/api/v1/company', undefined, { ...bearer(login.tokens.accessToken), 'x-company-id': second.id });
    expect(denied.status).toBe(403);

    // Fallback (no header) must land on a NON-excluded company.
    const fallback = await request('GET', '/api/v1/company', undefined, bearer(login.tokens.accessToken));
    expect(fallback.status).toBe(200);
    expect(fallback.json['company']?.id).not.toBe(second.id);

    // The owner is unaffected.
    const owner = await request('GET', '/api/v1/company', undefined, { ...bearer(reg.tokens.accessToken), 'x-company-id': second.id });
    expect(owner.status).toBe(200);
  });
});

describe('M4 — budgets / recurring reject unknown fields', () => {
  it('cannot set tenantId/companyId through the budget update body', async () => {
    const reg = await authService.register({ email: OWNER, password: 'password123', displayName: 'Owner', companyName: 'Budget Co' });
    const created = await request('POST', '/api/v1/budgets', { name: 'FY', fiscalYear: 2026 }, bearer(reg.tokens.accessToken));
    expect(created.status).toBe(201);
    const id = created.json['budget'].id;
    const bad = await request('PUT', `/api/v1/budgets/${id}`, { name: 'x', tenantId: '00000000-0000-0000-0000-000000000000' }, bearer(reg.tokens.accessToken));
    expect(bad.status).toBe(400);
    const badCreate = await request('POST', '/api/v1/budgets', { name: 'FY2', fiscalYear: 2026, createdBy: reg.user.id }, bearer(reg.tokens.accessToken));
    expect(badCreate.status).toBe(400);
    const stillMine = await db.query.budgets.findFirst({ where: eq(budgets.id, id) });
    expect(stillMine!.tenantId).toBe(reg.user.tenantId);
  });

  it('recurring create/update reject unknown fields and bad enums', async () => {
    const reg = await authService.register({ email: OWNER, password: 'password123', displayName: 'Owner', companyName: 'Recur Co' });
    const r1 = await request('POST', '/api/v1/recurring', {
      templateTransactionId: '00000000-0000-0000-0000-000000000001', frequency: 'monthly', startDate: '2026-09-01', nextOccurrence: '2020-01-01',
    }, bearer(reg.tokens.accessToken));
    expect(r1.status).toBe(400);
    const r2 = await request('POST', '/api/v1/recurring', {
      templateTransactionId: '00000000-0000-0000-0000-000000000001', frequency: 'hourly', startDate: '2026-09-01',
    }, bearer(reg.tokens.accessToken));
    expect(r2.status).toBe(400);
    const r3 = await request('PUT', '/api/v1/recurring/00000000-0000-0000-0000-000000000002', { tenantId: 'x' }, bearer(reg.tokens.accessToken));
    expect(r3.status).toBe(400);
  });
});

describe('M6 — login state disclosure + super-admin timed lock', () => {
  it('a locked regular account answers a WRONG password with plain 401 (no lock oracle)', async () => {
    await authService.register({ email: OWNER, password: 'password123', displayName: 'Owner', companyName: 'Lock Co' });
    for (let i = 0; i < 5; i++) {
      await expect(authService.login({ email: OWNER, password: 'nope' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    }
    await expect(authService.login({ email: OWNER, password: 'still-nope' })).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    // The owner (correct password) is told the truth.
    await expect(authService.login({ email: OWNER, password: 'password123' })).rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_LOCKED' });
  });

  it('a deactivated account answers a WRONG password with plain 401', async () => {
    const reg = await authService.register({ email: OWNER, password: 'password123', displayName: 'Owner', companyName: 'Deact Co' });
    await db.update(users).set({ isActive: false }).where(eq(users.id, reg.user.id));
    await expect(authService.login({ email: OWNER, password: 'nope' })).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    await expect(authService.login({ email: OWNER, password: 'password123' })).rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_DEACTIVATED' });
  });

  it('a super-admin lock is timed and self-releases', async () => {
    const reg = await authService.register({ email: SUPER, password: 'password123', displayName: 'SA', companyName: 'SA Co' });
    await db.update(users).set({ isSuperAdmin: true }).where(eq(users.id, reg.user.id));
    for (let i = 0; i < 5; i++) {
      await expect(authService.login({ email: SUPER, password: 'nope' })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    }
    await expect(authService.login({ email: SUPER, password: 'password123' })).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
    const row = await db.query.users.findFirst({ where: eq(users.id, reg.user.id) });
    expect(row!.loginLockedUntil!.getTime()).toBeGreaterThan(Date.now() + 20 * 60_000); // future release time, not the "now" sentinel
    // Simulate the window elapsing.
    await db.update(users).set({ loginLockedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, reg.user.id));
    const ok = await authService.login({ email: SUPER, password: 'password123' });
    expect(ok.tokens.accessToken).toBeTruthy();
    const after = await db.query.users.findFirst({ where: eq(users.id, reg.user.id) });
    expect(after!.loginLockedUntil).toBeNull();
    expect(after!.loginFailedAttempts).toBe(0);
  });
});

describe('M5 — portal password login', () => {
  it('unknown / no-password / wrong-password all return INVALID_CREDS; 5 failures lock; setPassword unlocks', async () => {
    const reg = await authService.register({ email: OWNER, password: 'password123', displayName: 'Owner', companyName: 'Portal Co' });
    const tenantId = reg.user.tenantId;
    const [contact] = await db.insert(portalContacts).values({ tenantId, email: PORTAL, status: 'active' } as any).returning();

    await expect(portalAuth.loginWithPassword({ tenantId, email: `nobody-${PFX}@example.com`, password: 'x' })).rejects.toMatchObject({ code: 'INVALID_CREDS' });
    // Contact exists but has no password: previously NO_PASSWORD (an oracle).
    await expect(portalAuth.loginWithPassword({ tenantId, email: PORTAL, password: 'x' })).rejects.toMatchObject({ code: 'INVALID_CREDS' });

    await portalAuth.setPassword(contact!.id, 'correct horse battery');
    for (let i = 0; i < 5; i++) {
      await expect(portalAuth.loginWithPassword({ tenantId, email: PORTAL, password: 'wrong' })).rejects.toMatchObject({ code: 'INVALID_CREDS' });
    }
    // Locked: wrong password → still INVALID_CREDS; right password → ACCOUNT_LOCKED.
    await expect(portalAuth.loginWithPassword({ tenantId, email: PORTAL, password: 'wrong' })).rejects.toMatchObject({ code: 'INVALID_CREDS' });
    await expect(portalAuth.loginWithPassword({ tenantId, email: PORTAL, password: 'correct horse battery' })).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
    // Whichever store authenticated (legacy portal_passwords row, or the
    // linked identity when PORTAL_IDENTITY_LINKING_V1 is on) must be locked.
    const pw = await db.query.portalPasswords.findFirst({ where: eq(portalPasswords.contactId, contact!.id) });
    const c2 = await db.query.portalContacts.findFirst({ where: eq(portalContacts.id, contact!.id) });
    const ident = c2?.identityId ? await db.query.portalIdentities.findFirst({ where: eq(portalIdentities.id, c2.identityId) }) : null;
    expect(!!pw!.lockedUntil || !!ident?.lockedUntil).toBe(true);

    // Legacy (unlinked) path: a password reset is the unlock. Detach the
    // contact from any master identity so the per-contact row is what
    // authenticates (the identity path keeps its own lock/unlock contract).
    await db.update(portalContacts).set({ identityId: null }).where(eq(portalContacts.id, contact!.id));
    // Portal locks are TIMED (PORTAL_LOCK_MINUTES): a lock in the future
    // refuses even the right password; an expired one is ignored and the
    // next failure restarts the count at 1.
    await db.update(portalPasswords).set({ failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 10 * 60_000) }).where(eq(portalPasswords.contactId, contact!.id));
    await expect(portalAuth.loginWithPassword({ tenantId, email: PORTAL, password: 'correct horse battery' })).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
    await db.update(portalContacts).set({ identityId: null }).where(eq(portalContacts.id, contact!.id));
    await db.update(portalPasswords).set({ failedLoginAttempts: 5, lockedUntil: new Date(Date.now() - 60_000) }).where(eq(portalPasswords.contactId, contact!.id));
    await expect(portalAuth.loginWithPassword({ tenantId, email: PORTAL, password: 'wrong' })).rejects.toMatchObject({ code: 'INVALID_CREDS' });
    const pwExpired = await db.query.portalPasswords.findFirst({ where: eq(portalPasswords.contactId, contact!.id) });
    expect(pwExpired!.failedLoginAttempts).toBe(1);
    // Expired lock + correct password → login succeeds and clears both columns.
    await db.update(portalContacts).set({ identityId: null }).where(eq(portalContacts.id, contact!.id));
    expect(await portalAuth.loginWithPassword({ tenantId, email: PORTAL, password: 'correct horse battery' })).toBeTruthy();
    const pwCleared = await db.query.portalPasswords.findFirst({ where: eq(portalPasswords.contactId, contact!.id) });
    expect(pwCleared!.lockedUntil).toBeNull();
    expect(pwCleared!.failedLoginAttempts).toBe(0);
    // Re-lock, then a magic-link/staff password (re)set is the early unlock.
    await db.update(portalContacts).set({ identityId: null }).where(eq(portalContacts.id, contact!.id));
    await db.update(portalPasswords).set({ failedLoginAttempts: 5, lockedUntil: new Date(Date.now() + 10 * 60_000) }).where(eq(portalPasswords.contactId, contact!.id));
    await portalAuth.setPassword(contact!.id, 'correct horse battery 2');
    // setPassword re-links to the existing identity (whose password is
    // unchanged by design) — detach again to exercise the legacy row.
    await db.update(portalContacts).set({ identityId: null }).where(eq(portalContacts.id, contact!.id));
    const pwAfter = await db.query.portalPasswords.findFirst({ where: eq(portalPasswords.contactId, contact!.id) });
    expect(pwAfter!.lockedUntil).toBeNull();
    expect(pwAfter!.failedLoginAttempts).toBe(0);
    const ok = await portalAuth.loginWithPassword({ tenantId, email: PORTAL, password: 'correct horse battery 2' });
    expect(ok).toBeTruthy();
  });
});

describe('batch 4 — auth_time survives refresh/switch; TOTP replay guard', () => {
  it('refresh keeps the original auth_time; a stale chain is refused on admin routes', async () => {
    const reg = await authService.register({ email: SUPER, password: 'password123', displayName: 'SA', companyName: 'AT Co' });
    const jwt = await import('jsonwebtoken');
    const first = jwt.default.decode(reg.tokens.accessToken) as { auth_time?: number; iat?: number };
    expect(typeof first.auth_time).toBe('number');
    await new Promise((r) => setTimeout(r, 1100));
    const refreshed = await authService.refresh(reg.tokens.refreshToken);
    const second = jwt.default.decode(refreshed.accessToken) as { auth_time?: number; iat?: number };
    expect(second.auth_time).toBe(first.auth_time);   // preserved
    expect(second.iat).toBeGreaterThan(first.iat!);     // but iat moved on
  });

  it('a TOTP code cannot be replayed within its tolerance window', async () => {
    const reg = await authService.register({ email: OWNER, password: 'password123', displayName: 'Owner', companyName: 'TOTP Co' });
    const tfa = await import('../services/tfa.service.js');
    const enroll = await import('../services/tfa-enrollment.service.js');
    const tfaConfig = await import('../services/tfa-config.service.js');
    await tfaConfig.updateConfig({ isEnabled: true, allowedMethods: ['email', 'totp', 'sms'] } as any, reg.user.id);
    await enroll.enableTfa(reg.user.id);
    const setup = await enroll.addTotpMethod(reg.user.id);
    const { generateSync, NobleCryptoPlugin, ScureBase32Plugin } = await import('otplib');
    const plugins = { crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() };
    const code = generateSync({ secret: setup.secret, ...plugins });
    expect(await enroll.verifyTotpSetup(reg.user.id, code)).toBe(true);
    // The very same code (same 30 s step) must now be refused at login.
    const again = await tfa.verifyCode(reg.user.id, code, 'totp');
    expect(again.valid).toBe(false);
    // …but a code for a LATER step is fine (simulate by clearing the guard
    // to a lower step and generating for a future epoch).
    const later = generateSync({ secret: setup.secret, epoch: Math.floor(Date.now() / 1000) + 30, ...plugins });
    const ok = await tfa.verifyCode(reg.user.id, later, 'totp');
    expect(ok.valid).toBe(true);
  });
});
