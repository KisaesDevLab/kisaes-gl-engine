// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// QA follow-ups to the 2026-08-18 security review (post-release sweep):
//
//   1. Team edit: a ROLE-ONLY change on a non-home user (the SPA always
//      echoes the unchanged email + displayName) must succeed — the
//      home-tenant identity gate applies only to values that change.
//   2. requireSessionAuth covers passkey registration/management and TFA
//      self-service (an API key must not plant a passkey or strip 2FA).
//   3. switch-tenant never resets auth_time: both /auth/switch-tenant
//      (no cookie) and /api/v2/tenants/switch carry the caller JWT's
//      auth_time forward, so JWT_ADMIN_ABSOLUTE_MAX_AGE can't be dodged.
//   4. enableTfa seeds the email method (when allowed) so an abandoned
//      enrolment isn't a recovery-codes-only lockout; checkTfaRequired
//      heals pre-existing enabled-but-empty rows the same way.
//   5. Portal receipt upload against a document request issued for a
//      DIFFERENT linked company files under the request's company; a
//      request for an unlinked company is still refused.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { inArray, eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, apiKeys, userTenantAccess,
  portalContacts, portalContactCompanies, documentRequests,
} from '../db/schema/index.js';
import { companyRouter } from './company.routes.js';
import { apiKeysRouter } from './api-keys.routes.js';
import { authRouter } from './auth.routes.js';
import { apiV2Router } from './api-v2.routes.js';
import { passkeyRouter } from './passkey.routes.js';
import { tfaRouter } from './tfa.routes.js';
import * as authService from '../services/auth.service.js';
import * as tfaConfigService from '../services/tfa-config.service.js';
import * as tfaEnrollment from '../services/tfa-enrollment.service.js';
import * as tfaService from '../services/tfa.service.js';
import * as portalReceipts from '../services/portal-receipts.service.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;

const PFX = 'sec-hardening-20260818-qa';
const OWNER_A = `${PFX}-owner-a@example.com`;
const OWNER_B = `${PFX}-owner-b@example.com`;
const PORTAL = `${PFX}-client@example.com`;
const ALL_EMAILS = [OWNER_A, OWNER_B];

async function cleanDb() {
  const rows = await db.select({ id: users.id, tenantId: users.tenantId }).from(users).where(inArray(users.email, ALL_EMAILS));
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const userIds = rows.map((r) => r.id);
  if (userIds.length) {
    await db.delete(apiKeys).where(inArray(apiKeys.userId, userIds));
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, userIds));
  }
  if (tenantIds.length) {
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.tenantId, tenantIds));
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
    const contacts = await db.select({ id: portalContacts.id }).from(portalContacts).where(inArray(portalContacts.tenantId, tenantIds));
    if (contacts.length) {
      const cids = contacts.map((c) => c.id);
      await db.delete(documentRequests).where(inArray(documentRequests.contactId, cids));
      await db.delete(portalContactCompanies).where(inArray(portalContactCompanies.contactId, cids));
      await db.delete(portalContacts).where(inArray(portalContacts.id, cids));
    }
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
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/auth/passkeys', passkeyRouter);
  app.use('/api/v1/users/me/tfa', tfaRouter);
  app.use('/api/v1/company', companyRouter);
  app.use('/api/v1/api-keys', apiKeysRouter);
  app.use('/api/v2', apiV2Router);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
          ...(data ? { 'Content-Length': String(data.length) } : {}),
        },
      },
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

beforeEach(async () => {
  await cleanDb();
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
  await tfaConfigService.updateConfig({ isEnabled: false });
});

async function twoTenants() {
  const a = await authService.register({ email: OWNER_A, password: 'password123', displayName: 'Owner A', companyName: 'Tenant A' });
  const b = await authService.register({ email: OWNER_B, password: 'password123', displayName: 'Owner B', companyName: 'Tenant B' });
  return { a, b };
}

describe('1 — role-only edit of a non-home user still works', () => {
  it('owner B changes only the role of invited user A while echoing unchanged identity fields', async () => {
    const { a, b } = await twoTenants();
    await authService.inviteUser(b.user.tenantId, { email: OWNER_A, displayName: 'Owner A', role: 'accountant' }, b.user.id);

    // Exactly what TeamPage sends: unchanged email + displayName + new role.
    const res = await request('PATCH', `/api/v1/company/users/${a.user.id}`, {
      email: OWNER_A, displayName: 'Owner A', role: 'readonly',
    }, bearer(b.tokens.accessToken));
    expect(res.status).toBe(200);
    const uta = await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, a.user.id), eq(userTenantAccess.tenantId, b.user.tenantId)),
    });
    expect(uta?.role).toBe('readonly');
    // Home-tenant identity untouched.
    const still = await db.query.users.findFirst({ where: eq(users.id, a.user.id) });
    expect(still!.email).toBe(OWNER_A);
    expect(still!.role).toBe('owner');

    // Email case-normalisation is not a "change" either.
    const res2 = await request('PATCH', `/api/v1/company/users/${a.user.id}`, {
      email: OWNER_A.toUpperCase(), displayName: 'Owner A', role: 'accountant',
    }, bearer(b.tokens.accessToken));
    expect(res2.status).toBe(200);

    // But an ACTUAL identity change from the non-home tenant is still refused.
    const res3 = await request('PATCH', `/api/v1/company/users/${a.user.id}`, {
      email: OWNER_A, displayName: 'Renamed by B', role: 'accountant',
    }, bearer(b.tokens.accessToken));
    expect(res3.status).toBe(403);
    expect(res3.json['error']?.code).toBe('USER_MANAGED_ELSEWHERE');
  });
});

describe('2 — passkey + TFA self-service are session-only', () => {
  it('an API key is refused on passkey registration/list and TFA enable/methods', async () => {
    const { b } = await twoTenants();
    const created = await request('POST', '/api/v1/api-keys', { name: 'k', role: 'owner' }, bearer(b.tokens.accessToken));
    expect(created.status).toBe(201);
    const key = created.json['apiKey'] as string;

    for (const [method, path] of [
      ['POST', '/api/v1/auth/passkeys/register/options'],
      ['GET', '/api/v1/auth/passkeys/me'],
      ['POST', '/api/v1/users/me/tfa/enable'],
      ['DELETE', '/api/v1/users/me/tfa/methods/totp'],
      ['GET', '/api/v1/users/me/tfa/status'],
    ] as const) {
      const r = await request(method, path, method === 'GET' ? undefined : {}, { 'x-api-key': key });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json['error']?.code, `${method} ${path}`).toBe('SESSION_AUTH_REQUIRED');
    }
    // A real session still reaches them (status is the cheapest probe).
    const ok = await request('GET', '/api/v1/users/me/tfa/status', undefined, bearer(b.tokens.accessToken));
    expect(ok.status).toBe(200);
  });
});

describe('3 — switch-tenant carries auth_time forward', () => {
  it('v1 without a refresh cookie and v2 both keep the caller JWT auth_time', async () => {
    const { a, b } = await twoTenants();
    await authService.inviteUser(b.user.tenantId, { email: OWNER_A, displayName: 'Owner A', role: 'accountant' }, b.user.id);
    const jwt = await import('jsonwebtoken');
    const first = jwt.default.decode(a.tokens.accessToken) as { auth_time?: number };
    expect(typeof first.auth_time).toBe('number');
    await new Promise((r) => setTimeout(r, 1100));

    const v1 = await request('POST', '/api/v1/auth/switch-tenant', { tenantId: b.user.tenantId }, bearer(a.tokens.accessToken));
    expect(v1.status).toBe(200);
    const v1Claims = jwt.default.decode(v1.json['tokens']['accessToken']) as { auth_time?: number; tenantId?: string };
    expect(v1Claims.tenantId).toBe(b.user.tenantId);
    expect(v1Claims.auth_time).toBe(first.auth_time);

    const v2 = await request('POST', '/api/v2/tenants/switch', { tenantId: a.user.tenantId }, bearer(v1.json['tokens']['accessToken']));
    expect(v2.status).toBe(200);
    const v2Claims = jwt.default.decode(v2.json['tokens']['accessToken']) as { auth_time?: number };
    expect(v2Claims.auth_time).toBe(first.auth_time);

    // The persisted session row for the switched chain carries it too, so a
    // later refresh can't launder a fresh auth_time.
    const rows = await db.select({ authTime: sessions.authTime }).from(sessions).where(eq(sessions.userId, a.user.id));
    for (const r of rows) {
      expect(Math.floor(r.authTime!.getTime() / 1000)).toBe(first.auth_time);
    }
  });
});

describe('4 — enabling TFA never strands the user without a login method', () => {
  it('enableTfa seeds email; checkTfaRequired heals an enabled-but-empty row', async () => {
    const { a } = await twoTenants();
    await tfaConfigService.updateConfig({ isEnabled: true, allowedMethods: ['email', 'totp'] });

    await tfaEnrollment.enableTfa(a.user.id);
    const u1 = await db.query.users.findFirst({ where: eq(users.id, a.user.id) });
    expect(u1!.tfaEnabled).toBe(true);
    expect((u1!.tfaMethods || '').split(',').filter(Boolean)).toContain('email');
    // The login gate accepts it.
    await expect(tfaService.assertLoginTfaMethodAllowed(a.user.id, 'email', 'password')).resolves.toBeUndefined();

    // Simulate a row enabled by an older build with no method enrolled.
    await db.update(users).set({ tfaMethods: '' }).where(eq(users.id, a.user.id));
    const req = await tfaService.checkTfaRequired(a.user.id);
    expect(req.required).toBe(true);
    expect(req.methods).toEqual(['email']);
    const u2 = await db.query.users.findFirst({ where: eq(users.id, a.user.id) });
    expect(u2!.tfaMethods).toBe('email');
  });
});

describe('5 — portal receipt upload against a document request for another linked company', () => {
  it('files under the request company when linked; refuses when not linked', async () => {
    const { a } = await twoTenants();
    const tenantId = a.user.tenantId;
    const [coA] = await db.select({ id: companies.id }).from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
    const [coB] = await db.insert(companies).values({ tenantId, businessName: 'Second Co' } as any).returning({ id: companies.id });
    const [coC] = await db.insert(companies).values({ tenantId, businessName: 'Third Co' } as any).returning({ id: companies.id });
    const [contact] = await db.insert(portalContacts).values({ tenantId, email: PORTAL, status: 'active' } as any).returning({ id: portalContacts.id });
    await db.insert(portalContactCompanies).values([
      { contactId: contact!.id, companyId: coA!.id },
      { contactId: contact!.id, companyId: coB!.id },
    ] as any);
    const [drB] = await db.insert(documentRequests).values({
      tenantId, contactId: contact!.id, companyId: coB!.id, documentType: 'bank_statement', description: 'Bank statement', periodLabel: '2026-07', status: 'pending',
    } as any).returning({ id: documentRequests.id });
    const [drC] = await db.insert(documentRequests).values({
      tenantId, contactId: contact!.id, companyId: coC!.id, documentType: 'bank_statement', description: 'Unlinked co request', periodLabel: '2026-07', status: 'pending',
    } as any).returning({ id: documentRequests.id });

    // Active company A, request for linked company B → filed under B.
    const target = await portalReceipts.assertContactMayUploadFor(tenantId, contact!.id, coA!.id, drB!.id);
    expect(target.companyId).toBe(coB!.id);
    // Same-company request → unchanged.
    const same = await portalReceipts.assertContactMayUploadFor(tenantId, contact!.id, coB!.id, drB!.id);
    expect(same.companyId).toBe(coB!.id);
    // Request for a company the contact is NOT linked to → 404.
    await expect(portalReceipts.assertContactMayUploadFor(tenantId, contact!.id, coA!.id, drC!.id)).rejects.toMatchObject({ statusCode: 404 });
    // Unlinked active company → 404 regardless.
    await expect(portalReceipts.assertContactMayUploadFor(tenantId, contact!.id, coC!.id)).rejects.toMatchObject({ statusCode: 404 });
  });
});
