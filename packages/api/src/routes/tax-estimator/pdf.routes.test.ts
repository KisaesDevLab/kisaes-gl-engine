// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  tenants, users, tenantFeatureFlags, firms, firmUsers, tenantFirmAssignments, userTenantAccess,
  companies, companyTaxProfiles, portalContacts, portalContactCompanies, auditLog,
  taxEstTaxpayers, taxEstYears, taxEstFirmSettings, taxEstAdjustmentTypes, accounts, taxEstSnapshots,
} from '../../db/schema/index.js';
import { taxEstimatorRouter } from '../tax-estimator.routes.js';
import { syncShippedSeeds } from '../../services/tax-estimator/tax-parameters.service.js';
import { syncShippedStateRules } from '../../services/tax-estimator/tax-state-rules.service.js';
import { closeTbRedis } from '../../services/tb/tb-redis.js';
import { errorHandler } from '../../middleware/error-handler.js';

// Phase 11 route test: standalone estimate PDF (guard chain + firm isolation). Fixture = the Phase 0 harness:
//   T1 practice (flag ON), T2 managed + reachable, T3 managed but NOT reachable by the
//   staff user, T4 a client of ANOTHER firm the staff user can reach.
//   Scope for firm-A staff = {T1, T2}. Firm-B staff (firm B, T4) has scope {T4}.

const API = '/api/v1/tax-estimator';
const BASE = `${API}/taxpayers`;
let server: Server | null = null;
let port = 0;
const ids = { t1: '', t2: '', t3: '', t4: '', firmA: '', firmB: '', c1: '', c2: '', c3: '', c4: '' };
const userIds: string[] = [];
let staffToken = '';
let readonlyToken = '';
let clientUserToken = '';
let firmBToken = '';
let adminToken = '';

function slug(p: string) { return `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

async function mkTenant(name: string) {
  const [t] = await db.insert(tenants).values({ name, slug: slug('tp') }).returning();
  return t!.id;
}
async function mkCompany(tenantId: string, name: string, entityType = 'sole_prop') {
  const [c] = await db.insert(companies).values({ tenantId, businessName: name, entityType }).returning();
  return c!.id;
}
async function mkUser(tenantId: string, role: string, userType = 'staff') {
  const [u] = await db.insert(users).values({
    tenantId, email: `${slug('u')}@example.com`, passwordHash: await bcrypt.hash('x-secret-12345', 4),
    displayName: role, role, userType,
  }).returning();
  userIds.push(u!.id);
  const token = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  return { id: u!.id, token };
}

function request(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: any; raw: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const raw = buf.toString('utf8');
        const base = { status: res.statusCode ?? 0, raw: buf, headers: res.headers };
        try { resolve({ ...base, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ ...base, json: raw }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function cleanDb() {
  const tids = [ids.t1, ids.t2, ids.t3, ids.t4].filter(Boolean);
  const fids = [ids.firmA, ids.firmB].filter(Boolean);
  if (fids.length) await db.delete(taxEstAdjustmentTypes).where(inArray(taxEstAdjustmentTypes.firmId, fids));
  if (fids.length) await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, fids));
  if (fids.length) await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, fids)); // persons/links/contacts cascade
  if (tids.length) {
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tids));
    await db.delete(portalContacts).where(inArray(portalContacts.tenantId, tids)); // cascades company grants
    await db.delete(accounts).where(inArray(accounts.tenantId, tids));
    await db.delete(companyTaxProfiles).where(inArray(companyTaxProfiles.tenantId, tids));
    await db.delete(companies).where(inArray(companies.tenantId, tids));
  }
  if (userIds.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, userIds));
  if (fids.length) {
    await db.delete(firmUsers).where(inArray(firmUsers.firmId, fids));
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, fids));
    await db.delete(firms).where(inArray(firms.id, fids));
  }
  for (const t of tids) {
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, t));
    await db.delete(users).where(eq(users.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
  userIds.length = 0;
  Object.keys(ids).forEach((k) => { (ids as Record<string, string>)[k] = ''; });
}

beforeAll(async () => {
  await syncShippedSeeds();
  await syncShippedStateRules();
}, 120_000);

beforeEach(async () => {
  await cleanDb();
  ids.t1 = await mkTenant('TP Practice');
  ids.t2 = await mkTenant('TP Client Reachable');
  ids.t3 = await mkTenant('TP Client Unreachable');
  ids.t4 = await mkTenant('TP Other Firm Client');
  ids.c1 = await mkCompany(ids.t1, 'Practice Co');
  ids.c2 = await mkCompany(ids.t2, 'Reachable Co');
  ids.c3 = await mkCompany(ids.t3, 'Unreachable Co');
  ids.c4 = await mkCompany(ids.t4, 'Other Firm Co');
  const [fa] = await db.insert(firms).values({ name: 'TP Firm A', slug: slug('fa') }).returning();
  const [fb] = await db.insert(firms).values({ name: 'TP Firm B', slug: slug('fb') }).returning();
  ids.firmA = fa!.id; ids.firmB = fb!.id;
  await db.insert(tenantFirmAssignments).values([
    { tenantId: ids.t1, firmId: ids.firmA }, { tenantId: ids.t2, firmId: ids.firmA },
    { tenantId: ids.t3, firmId: ids.firmA }, { tenantId: ids.t4, firmId: ids.firmB },
  ]);
  for (const t of [ids.t1, ids.t2, ids.t3, ids.t4]) {
    await db.insert(tenantFeatureFlags).values({ tenantId: t, flagKey: 'TAX_ESTIMATOR_V1', enabled: true });
  }
  const staff = await mkUser(ids.t1, 'accountant');
  staffToken = staff.token;
  await db.insert(firmUsers).values({ firmId: ids.firmA, userId: staff.id, firmRole: 'firm_staff' });
  await db.insert(userTenantAccess).values([
    { userId: staff.id, tenantId: ids.t1, role: 'accountant' },
    { userId: staff.id, tenantId: ids.t2, role: 'accountant' },
    { userId: staff.id, tenantId: ids.t4, role: 'accountant' }, // reachable, but another firm's client
  ]);
  const ro = await mkUser(ids.t1, 'accountant');
  readonlyToken = ro.token;
  await db.insert(firmUsers).values({ firmId: ids.firmA, userId: ro.id, firmRole: 'firm_readonly' });
  await db.insert(userTenantAccess).values({ userId: ro.id, tenantId: ids.t1, role: 'accountant' });
  clientUserToken = (await mkUser(ids.t1, 'owner', 'client')).token;
  const fb2 = await mkUser(ids.t4, 'accountant');
  firmBToken = fb2.token;
  await db.insert(firmUsers).values({ firmId: ids.firmB, userId: fb2.id, firmRole: 'firm_admin' });
  await db.insert(userTenantAccess).values({ userId: fb2.id, tenantId: ids.t4, role: 'accountant' });

  const adm = await mkUser(ids.t1, 'accountant');
  adminToken = adm.token;
  await db.insert(firmUsers).values({ firmId: ids.firmA, userId: adm.id, firmRole: 'firm_admin' });
  await db.insert(userTenantAccess).values({ userId: adm.id, tenantId: ids.t1, role: 'accountant' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/tax-estimator', taxEstimatorRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

async function mkTaxpayer(token = staffToken) {
  const r = await request('POST', BASE, token, { displayName: 'Rivera, Daniel & Maria', filingStatus: 'mfj', residentState: 'mo' });
  expect(r.status).toBe(201);
  return r.json.data.id as string;
}
const yr = (tp: string, y = 2026) => `${BASE}/${tp}/years/${y}`;
async function setUpYear(tp: string, body: Record<string, unknown> = {}, y = 2026) {
  const r = await request('PUT', yr(tp, y), staffToken, body);
  expect(r.status).toBe(200);
  return r.json.data as { year: Record<string, unknown>; scenarios: Array<{ id: string; isBase: boolean; name: string }> };
}
async function baseScenario(tp: string) {
  const d = await setUpYear(tp);
  return d.scenarios.find((s) => s.isBase)!.id;
}

async function mkPersonAndLink(tp: string, tenantId = ids.t2, companyId = ids.c2) {
  const p = await request('PUT', `${BASE}/${tp}/persons/primary`, staffToken, { firstName: 'Daniel', lastName: 'Rivera', dateOfBirth: '1980-02-02' });
  expect(p.status).toBe(200);
  const l = await request('PUT', `${BASE}/${tp}/links`, staffToken, { personRole: 'primary', taxYear: 2026, tenantId, companyId, profitPct: 100 });
  expect(l.status).toBe(200);
}
const est = (tp: string, sid: string) => `${yr(tp)}/scenarios/${sid}/estimate`;

const pdfUrl = (tp: string, sid: string) => `${yr(tp)}/scenarios/${sid}/pdf`;

describe('POST .../scenarios/:scenarioId/pdf', () => {
  it('returns a PDF for firm staff and read-only members, with an attachment filename', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    const r = await request('POST', pdfUrl(tp, sid), staffToken, { throughMonth: '2026-09' });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(String(r.headers['content-disposition'])).toMatch(/attachment; filename="tax-estimate-2026-[A-Za-z0-9-]+\.pdf"/);
    expect(r.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const ro = await request('POST', pdfUrl(tp, sid), readonlyToken, { throughMonth: '2026-09' });
    expect(ro.status).toBe(200);
    expect(ro.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('guard chain: no token 401, client user 404, flag OFF 404', async () => {
    const tp = await mkTaxpayer();
    const sid = await baseScenario(tp);
    expect((await request('POST', pdfUrl(tp, sid))).status).toBe(401);
    expect((await request('POST', pdfUrl(tp, sid), clientUserToken, {})).status).toBe(404);
    await db.update(tenantFeatureFlags).set({ enabled: false }).where(and(eq(tenantFeatureFlags.tenantId, ids.t1), eq(tenantFeatureFlags.flagKey, 'TAX_ESTIMATOR_V1')));
    expect((await request('POST', pdfUrl(tp, sid), staffToken, {})).status).toBe(404);
  });

  it('isolation: another firm and a scenario of another taxpayer are 404; unknown body keys are 400', async () => {
    const tp = await mkTaxpayer();
    const sid = await baseScenario(tp);
    expect((await request('POST', pdfUrl(tp, sid), firmBToken, {})).status).toBe(404);
    const tp2 = await mkTaxpayer();
    const sid2 = await baseScenario(tp2);
    expect((await request('POST', pdfUrl(tp, sid2), staffToken, {})).status).toBe(404);
    expect((await request('POST', pdfUrl(tp, sid), staffToken, { tenantIds: [ids.t4] })).status).toBe(400);
  });

  it('Phase 13: every download freezes a pdf snapshot and prints it (firm header, assumptions page); the snapshot re-prints', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    const r = await request('POST', pdfUrl(tp, sid), staffToken, { throughMonth: '2026-09' });
    expect(r.status).toBe(200);
    const snapId = String(r.headers['x-tax-estimate-snapshot-id']);
    expect(snapId).toMatch(/^[0-9a-f-]{36}$/);
    const [row] = await db.select().from(taxEstSnapshots).where(eq(taxEstSnapshots.id, snapId));
    expect(row?.reason).toBe('pdf');
    expect(row?.taxpayerId).toBe(tp);
    expect(row?.firmId).toBe(ids.firmA);
    // Read-only members download too: the snapshot is the audit record of what was issued.
    const ro = await request('POST', pdfUrl(tp, sid), readonlyToken, { throughMonth: '2026-09' });
    expect(ro.status).toBe(200);
    const all = await db.select().from(taxEstSnapshots).where(eq(taxEstSnapshots.taxpayerId, tp));
    expect(all.filter((x) => x.reason === 'pdf')).toHaveLength(2);
    // Re-print: same bytes shape, no new snapshot; another firm cannot.
    // The read-only member cannot reach T2 (D1), so this snapshot is not theirs to view.
    expect((await request('GET', `${API}/snapshots/${snapId}/pdf`, readonlyToken)).status).toBe(404);
    const again = await request('GET', `${API}/snapshots/${snapId}/pdf`, staffToken);
    expect(again.status).toBe(200);
    expect(again.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(again.headers['x-tax-estimate-snapshot-id']).toBe(snapId);
    expect((await db.select().from(taxEstSnapshots).where(eq(taxEstSnapshots.taxpayerId, tp))).length).toBe(2);
    expect((await request('GET', `${API}/snapshots/${snapId}/pdf`, firmBToken)).status).toBe(404);
  });
});

describe('R3 fixes on the PDF / estimate routes', () => {
  async function tenantReadonlyMember() {
    // The natural pairing R3-07 found: firm_readonly + an ACTIVE-tenant role of `readonly`.
    const u = await mkUser(ids.t1, 'readonly');
    await db.insert(firmUsers).values({ firmId: ids.firmA, userId: u.id, firmRole: 'firm_readonly' });
    await db.insert(userTenantAccess).values([
      { userId: u.id, tenantId: ids.t1, role: 'readonly' },
      { userId: u.id, tenantId: ids.t2, role: 'readonly' },
    ]);
    return u.token;
  }

  it('R3-07: a tenant-readonly member may POST /estimate and /pdf (reads) but not mutate', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    const ro = await tenantReadonlyMember();
    const e = await request('POST', est(tp, sid), ro, { throughMonth: '2026-09' });
    expect(e.status).toBe(200);
    expect(e.json.data.taxpayerId).toBe(tp);
    const pdf = await request('POST', pdfUrl(tp, sid), ro, { throughMonth: '2026-09' });
    expect(pdf.status).toBe(200);
    expect(pdf.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // Mutations still need write permission on the resource (and a staff firm role).
    const create = await request('POST', BASE, ro, { displayName: 'Nope', filingStatus: 'single', residentState: 'MO' });
    expect(create.status).toBe(403);
    expect(create.json.error.code).toBe('PERMISSION_DENIED');
    const snap = await request('POST', `${yr(tp)}/scenarios/${sid}/snapshots`, ro, {});
    expect(snap.status).toBe(403);
  });

  it('R3-06 / R3-16: every PDF writes a metadata-only download audit row (issued and re-printed)', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    await request('PUT', yr(tp), staffToken, { priorYearTax: '31500', priorYearAgi: '182000' });
    const r = await request('POST', pdfUrl(tp, sid), staffToken, { throughMonth: '2026-09' });
    expect(r.status).toBe(200);
    const snapId = String(r.headers['x-tax-estimate-snapshot-id']);
    const again = await request('GET', `${API}/snapshots/${snapId}/pdf`, staffToken);
    expect(again.status).toBe(200);
    const rows = await db.select().from(auditLog)
      .where(and(eq(auditLog.entityType, 'tax_est_snapshot'), eq(auditLog.entityId, snapId), eq(auditLog.action, 'download')));
    expect(rows).toHaveLength(2);
    const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, unknown>;
    const datas = rows.map((x) => parse(x.afterData));
    expect(datas.map((d) => d['issued']).sort()).toEqual([false, true]);
    for (const d of datas) {
      expect(d).toMatchObject({ firmId: ids.firmA, taxpayerId: tp, taxYear: 2026, scenarioId: sid, snapshotReason: 'pdf', format: 'pdf' });
      const blob = JSON.stringify(d);
      // Metadata only: no figures, no prior-year return information.
      expect(blob).not.toContain('31500');
      expect(blob).not.toContain('182000');
      expect(Object.keys(d).sort()).toEqual(['firmId', 'format', 'issued', 'payloadSha256', 'scenarioId', 'snapshotReason', 'taxYear', 'taxpayerId']);
    }
    expect(rows.every((x) => x.tenantId === ids.t1)).toBe(true);
  });

  it('R3-12: small lists accept limit/offset and return a total', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    await baseScenario(tp);
    await setUpYear(tp, {}, 2027);
    const years = await request('GET', `${BASE}/${tp}/years?limit=1&offset=1`, staffToken);
    expect(years.status).toBe(200);
    expect(years.json.total).toBe(2);
    expect(years.json.data).toHaveLength(1);
    expect(years.json.data[0].taxYear).toBe(2027);
    expect(years.json).toMatchObject({ limit: 1, offset: 1 });
    const scen = await request('GET', `${yr(tp)}/scenarios`, staffToken);
    expect(scen.json.total).toBe(1);
    const types = await request('GET', `${API}/adjustment-types?limit=2`, staffToken);
    expect(types.status).toBe(200);
    expect(types.json.data).toHaveLength(2);
    expect(types.json.total).toBeGreaterThan(2);
    const links = await request('GET', `${BASE}/${tp}/links?taxYear=2026&limit=1`, staffToken);
    expect(links.json).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(Array.isArray(links.json.warnings)).toBe(true);
    const contacts = await request('GET', `${BASE}/${tp}/contacts`, staffToken);
    expect(contacts.json).toMatchObject({ total: 0, data: [] });
    expect((await request('GET', `${API}/adjustment-types?limit=0`, staffToken)).status).toBe(400);
  });
});
