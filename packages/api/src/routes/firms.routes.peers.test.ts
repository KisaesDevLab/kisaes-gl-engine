// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm-side Vibe PM management: trust-root settings (admin write /
// staff read / readonly nothing / appliance-firm lockdown), the
// test-token probe, and pm_client_links CRUD with its triple validation
// and per-tenant access rule.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, companies, firms, firmUsers, firmPeers, pmClientLinks,
  tenantFirmAssignments, portalContacts, portalContactCompanies, auditLog as auditLogTable,
} from '../db/schema/index.js';
import { firmsRouter } from './firms.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { PEER_AUDIENCE, PEER_TOKEN_TYP } from '../services/peer-token.service.js';
import { setPeerJtiClientForTests, closePeerJtiStore } from '../utils/peer-jti-store.js';

const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pubPem = kp.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const privPem = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

let server: Server | null = null;
let port = 0;
let tenantA = '';
let tenantB = '';
let firmId = '';
let otherFirmId = '';
const tok: Record<string, string> = {};
const ids: Record<string, string> = {};

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/firms', firmsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}

function request(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedUser(opts: { tenantId: string; role: string; isSuperAdmin?: boolean; tenantAccess?: boolean }) {
  const [u] = await db.insert(users).values({
    tenantId: opts.tenantId,
    email: `u-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: await bcrypt.hash('secret-123-456', 12),
    role: opts.role,
    displayName: opts.role,
    isSuperAdmin: opts.isSuperAdmin ?? false,
  }).returning();
  if (opts.tenantAccess !== false) {
    await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: opts.tenantId, role: opts.role });
  }
  const token = jwt.sign(
    { userId: u!.id, tenantId: opts.tenantId, role: opts.role, isSuperAdmin: opts.isSuperAdmin ?? false },
    process.env['JWT_SECRET']!, { expiresIn: '5m' },
  );
  return { id: u!.id, token };
}

function mint(issuer: string, extra: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign({ iss: issuer, aud: PEER_AUDIENCE, iat: now, exp: now + 120, jti: crypto.randomUUID(), ...extra },
    privPem, { algorithm: 'ES256', header: { typ: PEER_TOKEN_TYP } as jwt.JwtHeader });
}

async function seed() {
  const sfx = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [tA] = await db.insert(tenants).values({ name: 'Peers A', slug: 'peers-a-' + sfx }).returning();
  const [tB] = await db.insert(tenants).values({ name: 'Peers B', slug: 'peers-b-' + sfx }).returning();
  tenantA = tA!.id; tenantB = tB!.id;
  const [f] = await db.insert(firms).values({ name: 'Peers Firm', slug: 'peers-firm-' + sfx }).returning();
  const [of] = await db.insert(firms).values({ name: 'Other Firm', slug: 'peers-other-' + sfx }).returning();
  firmId = f!.id; otherFirmId = of!.id;
  await db.insert(tenantFirmAssignments).values({ tenantId: tenantA, firmId, isActive: true });
  // Tenant B is NOT managed by the firm.

  const sa = await seedUser({ tenantId: tenantA, role: 'owner', isSuperAdmin: true });
  const admin = await seedUser({ tenantId: tenantA, role: 'accountant' });
  const staff = await seedUser({ tenantId: tenantA, role: 'accountant' });
  const staffNoAccess = await seedUser({ tenantId: tenantB, role: 'accountant', tenantAccess: false });
  const ro = await seedUser({ tenantId: tenantA, role: 'accountant' });
  tok['sa'] = sa.token; tok['admin'] = admin.token; tok['staff'] = staff.token; tok['staffNoAccess'] = staffNoAccess.token; tok['ro'] = ro.token;
  await db.insert(firmUsers).values([
    { firmId, userId: admin.id, firmRole: 'firm_admin' },
    { firmId, userId: staff.id, firmRole: 'firm_staff' },
    { firmId, userId: staffNoAccess.id, firmRole: 'firm_staff' },
    { firmId, userId: ro.id, firmRole: 'firm_readonly' },
  ]);

  const [cA1] = await db.insert(companies).values({ tenantId: tenantA, businessName: 'A One' }).returning();
  const [cA2] = await db.insert(companies).values({ tenantId: tenantA, businessName: 'A Two' }).returning();
  const [cB1] = await db.insert(companies).values({ tenantId: tenantB, businessName: 'B One' }).returning();
  ids['cA1'] = cA1!.id; ids['cA2'] = cA2!.id; ids['cB1'] = cB1!.id;
  const [ct] = await db.insert(portalContacts).values({ tenantId: tenantA, email: `ct-${sfx}@example.com`, status: 'active' }).returning();
  const [ctB] = await db.insert(portalContacts).values({ tenantId: tenantB, email: `ctb-${sfx}@example.com`, status: 'active' }).returning();
  ids['ct'] = ct!.id; ids['ctB'] = ctB!.id;
  await db.insert(portalContactCompanies).values({ contactId: ct!.id, companyId: cA1!.id });
}

async function cleanDb() {
  for (const t of [tenantA, tenantB].filter(Boolean)) {
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, t));
    await db.delete(pmClientLinks).where(eq(pmClientLinks.tenantId, t));
    await db.delete(portalContacts).where(eq(portalContacts.tenantId, t));
    await db.delete(companies).where(eq(companies.tenantId, t));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, t));
    await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, t));
    await db.delete(users).where(eq(users.tenantId, t));
  }
  for (const f of [firmId, otherFirmId].filter(Boolean)) {
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, f));
    await db.delete(firmUsers).where(eq(firmUsers.firmId, f));
    await db.delete(firmPeers).where(eq(firmPeers.firmId, f));
    await db.delete(firms).where(eq(firms.id, f));
  }
  for (const t of [tenantA, tenantB].filter(Boolean)) await db.delete(tenants).where(eq(tenants.id, t));
  tenantA = ''; tenantB = ''; firmId = ''; otherFirmId = '';
}

beforeEach(async () => {
  setPeerJtiClientForTests({ async set() { return 'OK'; } });
  await cleanDb();
  await seed();
  await startApp();
});
afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});
afterAll(async () => { await closePeerJtiStore(); });

const S = () => `/api/v1/firms/${firmId}/integrations/vibe-pm`;
const L = () => `/api/v1/firms/${firmId}/pm-links`;

describe('vibe-pm settings', () => {
  it('GET: staff and admin read, readonly is refused', async () => {
    const s = await request('GET', S(), undefined, tok['staff']);
    expect(s.status).toBe(200);
    expect(s.json).toMatchObject({ provider: 'vibe_pm', isEnabled: false, issuer: null, keyMode: null });
    expect((await request('GET', S(), undefined, tok['ro'])).status).toBe(403);
    expect((await request('GET', S(), undefined)).status).toBe(401);
  });

  it('PUT: firm_admin saves a PEM; staff cannot write', async () => {
    const r = await request('PUT', S(), { isEnabled: true, issuer: 'https://pm.example', publicKeyPem: pubPem }, tok['admin']);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ isEnabled: true, issuer: 'https://pm.example', keyMode: 'pem', keyKind: 'ec', keyDetail: 'EC P-256' });
    expect(r.json.keyFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((await request('PUT', S(), { isEnabled: false }, tok['staff'])).status).toBe(403);
    // Audit lands under the firm id with the fingerprint only.
    const rows = await db.select().from(auditLogTable).where(eq(auditLogTable.tenantId, firmId));
    expect(rows.some((a) => a.entityType === 'firm_peer')).toBe(true);
  });

  it('PUT validation: private key, bad url, enabling without key, both modes', async () => {
    const priv = await request('PUT', S(), { issuer: 'https://pm.example', publicKeyPem: privPem }, tok['admin']);
    expect(priv.status).toBe(400);
    expect(priv.json.error.code).toBe('PEER_KEY_PRIVATE');
    const url = await request('PUT', S(), { issuer: 'https://pm.example', jwksUrl: 'http://pm.example/jwks' }, tok['admin']);
    expect(url.status).toBe(400);
    expect(url.json.error.code).toBe('PEER_JWKS_URL_INVALID');
    const nokey = await request('PUT', S(), { issuer: 'https://pm.example', isEnabled: true }, tok['admin']);
    expect(nokey.status).toBe(400);
    expect(nokey.json.error.code).toBe('PEER_KEY_REQUIRED');
    const ws = await request('PUT', S(), { issuer: 'has space' }, tok['admin']);
    expect(ws.status).toBe(400);
  });

  it('switching to a JWKS URL clears the PEM (exactly one mode)', async () => {
    await request('PUT', S(), { issuer: 'https://pm.example', publicKeyPem: pubPem }, tok['admin']);
    const r = await request('PUT', S(), { jwksUrl: 'https://pm.example/.well-known/jwks.json' }, tok['admin']);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ keyMode: 'jwks', publicKeyPem: null, jwksUrl: 'https://pm.example/.well-known/jwks.json' });
  });

  it('issuer must be globally unique → 409 PEER_ISSUER_TAKEN', async () => {
    await db.insert(firmPeers).values({ firmId: otherFirmId, issuer: 'https://taken.example', publicKeyPem: pubPem, isEnabled: true });
    const r = await request('PUT', S(), { issuer: 'https://taken.example', publicKeyPem: pubPem }, tok['admin']);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('PEER_ISSUER_TAKEN');
  });

  it('superAdminManaged firm: only the super admin may write; staff still read', async () => {
    await db.update(firms).set({ superAdminManaged: true }).where(eq(firms.id, firmId));
    const a = await request('PUT', S(), { issuer: 'https://pm.example', publicKeyPem: pubPem }, tok['admin']);
    expect(a.status).toBe(403);
    expect(a.json.error.code).toBe('FIRM_SUPER_ADMIN_MANAGED');
    expect((await request('PUT', S(), { issuer: 'https://pm.example', publicKeyPem: pubPem }, tok['sa'])).status).toBe(200);
    expect((await request('GET', S(), undefined, tok['staff'])).status).toBe(200);
  });

  it('test-token: ok / foreign firm / does not burn the jti', async () => {
    await request('PUT', S(), { isEnabled: true, issuer: 'https://pm.example', publicKeyPem: pubPem }, tok['admin']);
    const t = mint('https://pm.example', { pm_client_id: 'cl_9' });
    const r = await request('POST', `${S()}/test-token`, { token: t }, tok['admin']);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, issuer: 'https://pm.example', claims: { pm_client_id: 'cl_9' } });
    // Same token again is still ok (not consumed).
    expect((await request('POST', `${S()}/test-token`, { token: t }, tok['admin'])).json.ok).toBe(true);
    expect((await request('POST', `${S()}/test-token`, { token: t }, tok['staff'])).status).toBe(403);

    await db.insert(firmPeers).values({ firmId: otherFirmId, issuer: 'https://other.example', publicKeyPem: pubPem, isEnabled: true });
    const foreign = await request('POST', `${S()}/test-token`, { token: mint('https://other.example') }, tok['admin']);
    expect(foreign.json).toEqual({ ok: false, code: 'wrong_firm' });
    const junk = await request('POST', `${S()}/test-token`, { token: 'x'.repeat(40) }, tok['admin']);
    expect(junk.json).toEqual({ ok: false, code: 'malformed' });
  });
});

describe('pm-links', () => {
  const body = (o: Partial<Record<'pmClientId' | 'tenantId' | 'companyId' | 'contactId', string>> = {}) => ({
    pmClientId: 'cl_1', tenantId: tenantA, companyId: ids['cA1'], contactId: ids['ct'], ...o,
  });

  it('staff creates, lists, deletes; readonly refused', async () => {
    const c = await request('POST', L(), body(), tok['staff']);
    expect(c.status).toBe(201);
    expect(c.json).toMatchObject({ pmClientId: 'cl_1', active: true, company: { id: ids['cA1'] }, contact: { id: ids['ct'] } });
    const l = await request('GET', L(), undefined, tok['staff']);
    expect(l.json.links).toHaveLength(1);
    expect((await request('GET', L(), undefined, tok['ro'])).status).toBe(403);
    expect((await request('POST', L(), body({ pmClientId: 'cl_2' }), tok['ro'])).status).toBe(403);

    const d = await request('DELETE', `${L()}/${c.json.id}`, undefined, tok['staff']);
    expect(d.status).toBe(204);
    expect((await request('GET', L(), undefined, tok['staff'])).json.links).toHaveLength(0);
    const rows = await db.select().from(auditLogTable).where(eq(auditLogTable.tenantId, tenantA));
    expect(rows.filter((a) => a.entityType === 'pm_client_link').map((a) => a.action).sort()).toEqual(['create', 'delete']);
  });

  it('triple validation: unmanaged tenant, foreign company, foreign contact, contact not in company, duplicate', async () => {
    const unmanaged = await request('POST', L(), body({ tenantId: tenantB, companyId: ids['cB1'], contactId: ids['ctB'] }), tok['sa']);
    expect(unmanaged.status).toBe(404);
    const co = await request('POST', L(), body({ companyId: ids['cB1'] }), tok['sa']);
    expect(co.json.error.code).toBe('PEER_LINK_COMPANY_MISMATCH');
    const ct = await request('POST', L(), body({ contactId: ids['ctB'] }), tok['sa']);
    expect(ct.json.error.code).toBe('PEER_LINK_CONTACT_MISMATCH');
    const notIn = await request('POST', L(), body({ companyId: ids['cA2'] }), tok['sa']);
    expect(notIn.json.error.code).toBe('PEER_LINK_CONTACT_NOT_IN_COMPANY');
    expect((await request('POST', L(), body(), tok['sa'])).status).toBe(201);
    const dupe = await request('POST', L(), body(), tok['sa']);
    expect(dupe.status).toBe(409);
    expect(dupe.json.error.code).toBe('PEER_LINK_EXISTS');
    const badId = await request('POST', L(), body({ pmClientId: 'has space' }), tok['sa']);
    expect(badId.status).toBe(400);
  });

  it('staff without access to the tenant cannot link or unlink it; super admin can', async () => {
    const r = await request('POST', L(), body(), tok['staffNoAccess']);
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('NO_TENANT_ACCESS');
    const opts = await request('GET', `${L()}/options?tenantId=${tenantA}`, undefined, tok['staffNoAccess']);
    expect(opts.status).toBe(403);
    const c = await request('POST', L(), body(), tok['sa']);
    expect(c.status).toBe(201);
    expect((await request('DELETE', `${L()}/${c.json.id}`, undefined, tok['staffNoAccess'])).status).toBe(403);
    expect((await request('DELETE', `${L()}/${c.json.id}`, undefined, tok['staff'])).status).toBe(204);
  });

  it('options lists the tenant\'s companies and contacts with their company links', async () => {
    const r = await request('GET', `${L()}/options?tenantId=${tenantA}`, undefined, tok['staff']);
    expect(r.status).toBe(200);
    expect(r.json.tenant).toEqual({ id: tenantA, name: 'Peers A' });
    expect(r.json.companies.map((c: { name: string }) => c.name)).toEqual(['A One', 'A Two']);
    expect(r.json.contacts[0]).toMatchObject({ id: ids['ct'], companyIds: [ids['cA1']] });
    expect((await request('GET', `${L()}/options?tenantId=${tenantB}`, undefined, tok['sa'])).status).toBe(404);
  });
});
