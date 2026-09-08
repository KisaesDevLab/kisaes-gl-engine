// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Vibe PM peer API: token → link → the existing portal routers, pinned
// to the linked company. Covers the auth surface, the discovery
// endpoints, company scoping (query, JSON, multipart, id-addressed
// rows), the per-request link re-validation, and cookie isolation.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, firms, firmPeers, pmClientLinks, tenantFirmAssignments,
  portalContacts, portalContactCompanies, portalContactSessions, portalSettingsPerCompany,
  portalQuestions, portalReceipts, documentRequests, tenantFeatureFlags, auditLog as auditLogTable,
} from '../db/schema/index.js';
import { peerPmRouter } from './peer-pm.routes.js';
import { portalQuestionsPublicRouter } from './portal-questions-public.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { PEER_AUDIENCE, PEER_TOKEN_TYP, resetPeerTouchThrottleForTests } from '../services/peer-token.service.js';
import { setPeerJtiClientForTests, closePeerJtiStore, type JtiRedisLike } from '../utils/peer-jti-store.js';

const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pubPem = kp.publicKey.export({ type: 'spki', format: 'pem' }) as string;

let server: Server | null = null;
let port = 0;
let tenantId = '';
let firmId = '';
let issuer = '';
const ids: Record<string, string> = {};

function fakeRedis(): JtiRedisLike {
  const keys = new Set<string>();
  return { async set(key) { if (keys.has(key)) return null; keys.add(key); return 'OK'; } };
}

function mint(extra: Record<string, unknown> = {}, opts: { iss?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: opts.iss ?? issuer, aud: PEER_AUDIENCE, iat: now, exp: now + 120, jti: crypto.randomUUID(), ...extra },
    kp.privateKey,
    { algorithm: 'ES256', header: { typ: PEER_TOKEN_TYP } as jwt.JwtHeader },
  );
}
const forClient = (client = 'cl_1', extra: Record<string, unknown> = {}) => mint({ pm_client_id: client, actor: { email: 'pm-user@example.com' }, ...extra });

interface Res { status: number; json: any; headers: http.IncomingHttpHeaders }

function request(method: string, pathname: string, opts: {
  token?: string; body?: unknown; headers?: Record<string, string>; raw?: Buffer; cookie?: string;
} = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = opts.raw ?? (opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        ...(opts.raw ? {} : { 'Content-Type': 'application/json' }),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.cookie ? { Cookie: `kisbooks_portal_session=${opts.cookie}` } : {}),
        ...(data ? { 'Content-Length': String(data.length) } : {}),
        ...(opts.headers ?? {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null, headers: res.headers }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function multipart(fields: Record<string, string>, file?: { name: string; filename: string; type: string; data: Buffer }): { raw: Buffer; headers: Record<string, string> } {
  const boundary = '----peer' + crypto.randomBytes(8).toString('hex');
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    parts.push(file.data);
    parts.push(Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { raw: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } };
}

// 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/peer/pm', peerPmRouter);
  app.use('/api/portal/questions', portalQuestionsPublicRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}

async function seed() {
  const sfx = Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  const [t] = await db.insert(tenants).values({ name: 'Peer Tenant', slug: 'peer-t-' + sfx }).returning();
  tenantId = t!.id;
  const [f] = await db.insert(firms).values({ name: 'Peer Firm', slug: 'peer-f-' + sfx }).returning();
  firmId = f!.id;
  issuer = `https://pm-${sfx}.example`;
  await db.insert(firmPeers).values({ firmId, issuer, publicKeyPem: pubPem, isEnabled: true });
  await db.insert(tenantFirmAssignments).values({ tenantId, firmId, isActive: true });

  const [c1] = await db.insert(companies).values({ tenantId, businessName: 'Linked Co' }).returning();
  const [c2] = await db.insert(companies).values({ tenantId, businessName: 'Sibling Co' }).returning();
  ids['c1'] = c1!.id; ids['c2'] = c2!.id;

  const [contact] = await db.insert(portalContacts).values({ tenantId, email: `peer-${sfx}@example.com`, firstName: 'Pat', lastName: 'Client', status: 'active' }).returning();
  ids['contact'] = contact!.id;
  await db.insert(portalContactCompanies).values([
    { contactId: contact!.id, companyId: c1!.id, financialsAccess: true, bankingAccess: true, questionsForUsAccess: true, filesAccess: true },
    { contactId: contact!.id, companyId: c2!.id, filesAccess: true },
  ]);
  await db.insert(pmClientLinks).values({ firmId, pmClientId: 'cl_1', tenantId, companyId: c1!.id, contactId: contact!.id });

  const staffId = crypto.randomUUID();
  const mkQ = async (key: string, companyId: string) => {
    const [q] = await db.insert(portalQuestions).values({
      tenantId, companyId, body: `Question for ${key}`, status: 'open', createdBy: staffId,
      assignedContactId: contact!.id, notifiedAt: new Date(),
    }).returning();
    ids[key] = q!.id;
  };
  await mkQ('q1', c1!.id);
  await mkQ('q2', c2!.id);

  const mkDr = async (key: string, companyId: string) => {
    const [d] = await db.insert(documentRequests).values({
      tenantId, companyId, contactId: contact!.id, documentType: 'bank_statement', description: `Statement ${key}`,
      periodLabel: '2026-08', status: 'pending',
    }).returning();
    ids[key] = d!.id;
  };
  await mkDr('dr1', c1!.id);
  await mkDr('dr2', c2!.id);
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'RECURRING_DOC_REQUESTS_V1', enabled: true, rolloutPercent: 100 });
}

async function cleanDb() {
  if (tenantId) {
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    await db.delete(portalReceipts).where(eq(portalReceipts.tenantId, tenantId));
    await db.delete(documentRequests).where(eq(documentRequests.tenantId, tenantId));
    await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, tenantId));
    await db.delete(pmClientLinks).where(eq(pmClientLinks.tenantId, tenantId));
    await db.delete(portalContactSessions).where(eq(portalContactSessions.tenantId, tenantId));
    await db.delete(portalContacts).where(eq(portalContacts.tenantId, tenantId));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
    const cos = await db.select({ id: companies.id }).from(companies).where(eq(companies.tenantId, tenantId));
    if (cos.length) await db.delete(portalSettingsPerCompany).where(inArray(portalSettingsPerCompany.companyId, cos.map((c) => c.id)));
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  if (firmId) {
    await db.delete(firmPeers).where(eq(firmPeers.firmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  tenantId = ''; firmId = '';
}

beforeEach(async () => {
  setPeerJtiClientForTests(fakeRedis());
  resetPeerTouchThrottleForTests();
  await cleanDb();
  await seed();
  await startApp();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

afterAll(async () => { await closePeerJtiStore(); });

describe('peer auth surface', () => {
  it('401 without a bearer, with a cookie only, with a bad token', async () => {
    expect((await request('GET', '/api/peer/pm/health')).status).toBe(401);
    expect((await request('GET', '/api/peer/pm/health', { cookie: 'abc' })).status).toBe(401);
    const r = await request('GET', '/api/peer/pm/health', { token: 'garbage-garbage-garbage-garbage' });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('PEER_TOKEN_INVALID');
  });

  it('refuses any request carrying an Origin header (browsers)', async () => {
    const r = await request('GET', '/api/peer/pm/health', { token: mint(), headers: { Origin: 'https://evil.example' } });
    expect(r.status).toBe(401);
  });

  it('a replayed token is refused', async () => {
    const t = mint();
    expect((await request('GET', '/api/peer/pm/health', { token: t })).status).toBe(200);
    expect((await request('GET', '/api/peer/pm/health', { token: t })).status).toBe(401);
  });

  it('every response is no-store', async () => {
    const r = await request('GET', '/api/peer/pm/health', { token: mint() });
    expect(r.headers['cache-control']).toBe('private, no-store');
  });

  it('a peer bearer is worthless on the cookie portal API', async () => {
    const r = await request('GET', `/api/portal/questions?companyId=${ids['c1']}`, { token: forClient() });
    expect(r.status).toBe(401);
  });
});

describe('discovery', () => {
  it('/health names the firm; /links lists the firm\'s links', async () => {
    const h = await request('GET', '/api/peer/pm/health', { token: mint() });
    expect(h.json).toMatchObject({ ok: true, issuer, firm: { id: firmId, name: 'Peer Firm' } });
    const l = await request('GET', '/api/peer/pm/links', { token: mint() });
    expect(l.status).toBe(200);
    expect(l.json.links).toHaveLength(1);
    expect(l.json.links[0]).toMatchObject({ pmClientId: 'cl_1', active: true, company: { id: ids['c1'] } });
  });

  it('/portal/context needs pm_client_id and reflects tenant flags ∧ contact grants', async () => {
    const noClient = await request('GET', '/api/peer/pm/portal/context', { token: mint() });
    expect(noClient.status).toBe(400);
    expect(noClient.json.error.code).toBe('PEER_CLIENT_ID_REQUIRED');

    const r = await request('GET', '/api/peer/pm/portal/context', { token: forClient() });
    expect(r.status).toBe(200);
    expect(r.json.company).toEqual({ id: ids['c1'], name: 'Linked Co' });
    expect(r.json.contact.id).toBe(ids['contact']);
    expect(r.json.permissions.bankingAccess).toBe(true);
    // Banking grant is on but the tenant flag is off → feature false.
    expect(r.json.features.banking).toBe(false);
    expect(r.json.features.financials).toBe(true);
    expect(r.json.features.documentRequests).toBe(true);
    expect(r.json.features.questionsForUs).toBe(true);

    await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'PORTAL_BANKING_V1', enabled: true, rolloutPercent: 100 });
    const r2 = await request('GET', '/api/peer/pm/portal/context', { token: forClient() });
    expect(r2.json.features.banking).toBe(true);
    expect(r2.json.features.bankRepair).toBe(false); // no bank_repair_access grant
  });

  it('unknown client → uniform 404 PM_LINK_NOT_FOUND', async () => {
    const r = await request('GET', '/api/peer/pm/portal/context', { token: forClient('cl_nope') });
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('PM_LINK_NOT_FOUND');
  });
});

describe('link re-validation per request', () => {
  const ctx = () => request('GET', '/api/peer/pm/portal/context', { token: forClient() });

  it('paused contact → 404', async () => {
    await db.update(portalContacts).set({ status: 'paused' }).where(eq(portalContacts.id, ids['contact']!));
    expect((await ctx()).status).toBe(404);
  });
  it('contact unlinked from the company → 404', async () => {
    await db.delete(portalContactCompanies).where(eq(portalContactCompanies.companyId, ids['c1']!));
    expect((await ctx()).status).toBe(404);
  });
  it('tenant detached from the firm → 404', async () => {
    await db.update(tenantFirmAssignments).set({ isActive: false }).where(eq(tenantFirmAssignments.tenantId, tenantId));
    expect((await ctx()).status).toBe(404);
  });
  it('company portal paused → 404', async () => {
    await db.insert(portalSettingsPerCompany).values({ companyId: ids['c1']!, paused: true });
    expect((await ctx()).status).toBe(404);
  });
  it('peer disabled → 401 (the token itself is refused)', async () => {
    await db.update(firmPeers).set({ isEnabled: false }).where(eq(firmPeers.firmId, firmId));
    expect((await ctx()).status).toBe(401);
  });
});

describe('portal routers via the peer', () => {
  it('questions list is pinned to the linked company; a foreign companyId is a 400', async () => {
    const r = await request('GET', '/api/peer/pm/portal/questions', { token: forClient() });
    expect(r.status).toBe(200);
    const bodies = [...r.json.open, ...r.json.answered].map((q: { body: string }) => q.body);
    expect(bodies).toContain('Question for q1');
    expect(bodies).not.toContain('Question for q2');

    const same = await request('GET', `/api/peer/pm/portal/questions?companyId=${ids['c1']}`, { token: forClient() });
    expect(same.status).toBe(200);
    const other = await request('GET', `/api/peer/pm/portal/questions?companyId=${ids['c2']}`, { token: forClient() });
    expect(other.status).toBe(400);
    expect(other.json.error.code).toBe('PEER_COMPANY_MISMATCH');
  });

  it('id-addressed question in a sibling company is a 404 even though the contact may see it via cookie', async () => {
    expect((await request('GET', `/api/peer/pm/portal/questions/${ids['q1']}`, { token: forClient() })).status).toBe(200);
    expect((await request('GET', `/api/peer/pm/portal/questions/${ids['q2']}`, { token: forClient() })).status).toBe(404);
    const ans = await request('POST', `/api/peer/pm/portal/questions/${ids['q2']}/answers`, { token: forClient(), body: { body: 'hello' } });
    expect(ans.status).toBe(404);
  });

  it('POST /ask: JSON companyId is forced to the link; a mismatch is a 400', async () => {
    const ok = await request('POST', '/api/peer/pm/portal/questions/ask', { token: forClient(), body: { body: 'Why is this here?' } });
    expect(ok.status).toBe(201);
    const [row] = await db.select({ companyId: portalQuestions.companyId }).from(portalQuestions).where(eq(portalQuestions.id, ok.json.id));
    expect(row?.companyId).toBe(ids['c1']);
    const bad = await request('POST', '/api/peer/pm/portal/questions/ask', { token: forClient(), body: { companyId: ids['c2'], body: 'sneaky' } });
    expect(bad.status).toBe(400);
  });

  it('document-requests are filtered to the linked company', async () => {
    const r = await request('GET', '/api/peer/pm/portal/document-requests', { token: forClient() });
    expect(r.status).toBe(200);
    expect(r.json.featureEnabled).toBe(true);
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual([ids['dr1']]);
  });

  it('multipart receipt: wrong companyId → 400, sibling doc request → 403, correct → 201', async () => {
    const wrong = multipart({ companyId: ids['c2']! }, { name: 'file', filename: 'r.png', type: 'image/png', data: PNG });
    const w = await request('POST', '/api/peer/pm/portal/receipts/upload', { token: forClient(), raw: wrong.raw, headers: wrong.headers });
    expect(w.status).toBe(400);
    expect(w.json.error.code).toBe('PEER_COMPANY_MISMATCH');

    const redirect = multipart({ companyId: ids['c1']!, documentRequestId: ids['dr2']! }, { name: 'file', filename: 'r.png', type: 'image/png', data: PNG });
    const rd = await request('POST', '/api/peer/pm/portal/receipts/upload', { token: forClient(), raw: redirect.raw, headers: redirect.headers });
    expect(rd.status).toBe(403);
    expect(rd.json.error.code).toBe('PEER_COMPANY_MISMATCH');

    const good = multipart({ documentRequestId: ids['dr1']! }, { name: 'file', filename: 'r.png', type: 'image/png', data: PNG });
    const g = await request('POST', '/api/peer/pm/portal/receipts/upload', { token: forClient(), raw: good.raw, headers: good.headers });
    expect(g.status).toBe(201);
    const [rec] = await db.select({ companyId: portalReceipts.companyId }).from(portalReceipts).where(eq(portalReceipts.id, g.json.id));
    expect(rec?.companyId).toBe(ids['c1']);
  });

  it('financials list is scoped; banking self-hides on the flag', async () => {
    const f = await request('GET', '/api/peer/pm/portal/financials', { token: forClient() });
    expect(f.status).toBe(200);
    expect(f.json.reports).toEqual([]);
    const b = await request('GET', '/api/peer/pm/portal/banking/accounts', { token: forClient() });
    expect(b.status).toBe(200);
    expect(b.json.featureEnabled).toBe(false);
  });

  it('a stale portal cookie on the same request never overrides the peer identity', async () => {
    // A second contact of a different company with a live session cookie.
    const [other] = await db.insert(portalContacts).values({ tenantId, email: `other-${Date.now()}@example.com`, status: 'active' }).returning();
    await db.insert(portalContactCompanies).values({ contactId: other!.id, companyId: ids['c2']! });
    const raw = crypto.randomBytes(32).toString('hex');
    await db.insert(portalContactSessions).values({
      tenantId, contactId: other!.id, tokenHash: crypto.createHash('sha256').update(raw).digest('hex'), expiresAt: new Date(Date.now() + 3600_000),
    });
    const r = await request('GET', '/api/peer/pm/portal/context', { token: forClient(), cookie: raw });
    expect(r.status).toBe(200);
    expect(r.json.contact.id).toBe(ids['contact']);
  });

  it('writes an audit row per token naming the PM actor', async () => {
    await request('GET', '/api/peer/pm/portal/context', { token: forClient() });
    await new Promise((r) => setTimeout(r, 80));
    const rows = await db.select().from(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    const peerRows = rows.filter((r) => r.entityType === 'portal_peer_access');
    expect(peerRows).toHaveLength(1);
    const after = typeof peerRows[0]!.afterData === 'string' ? JSON.parse(peerRows[0]!.afterData as string) : peerRows[0]!.afterData;
    expect(after).toMatchObject({ pmClientId: 'cl_1', companyId: ids['c1'], actor: { email: 'pm-user@example.com' } });
    expect(peerRows[0]!.userId).toBeNull();
  });
});
