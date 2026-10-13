// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q54 (Kurt, 2026-10-13): firm_staff / firm_readonly members below hold "Tax Estimator: view
// taxpayers" (capabilities) so these pre-Q54 expectations hold as written; the Q54 matrix itself
// (capability off, unlisted firm admin, ...) is in tax-estimator/taxpayer-visibility-q54.routes.test.ts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  tenants, users, tenantFeatureFlags, firms, firmUsers, tenantFirmAssignments, userTenantAccess,
  companies, companyTaxProfiles, portalContacts, portalContactCompanies, auditLog,
  taxEstTaxpayers, taxEstFirmSettings,
} from '../../db/schema/index.js';
import { taxEstimatorRouter } from '../tax-estimator.routes.js';
import { errorHandler } from '../../middleware/error-handler.js';

// Phase 3 route isolation tests (MODULE.md D1). Fixture = the Phase 0 harness:
//   T1 practice (flag ON), T2 managed + reachable, T3 managed but NOT reachable by the
//   staff user, T4 a client of ANOTHER firm the staff user can reach.
//   Scope for firm-A staff = {T1, T2}. Firm-B staff (firm B, T4) has scope {T4}.

const BASE = '/api/v1/tax-estimator/taxpayers';
let server: Server | null = null;
let port = 0;
const ids = { t1: '', t2: '', t3: '', t4: '', firmA: '', firmB: '', c1: '', c2: '', c3: '', c4: '' };
const userIds: string[] = [];
let staffToken = '';
let readonlyToken = '';
let clientUserToken = '';
let firmBToken = '';

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

function request(method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: any }> {
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
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
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
  if (fids.length) await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, fids)); // persons/links/contacts cascade
  if (fids.length) await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, fids));
  if (tids.length) {
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tids));
    await db.delete(portalContacts).where(inArray(portalContacts.tenantId, tids)); // cascades company grants
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
  // D17: this suite pins the pre-D17 view (every firm member sees every firm taxpayer), so the
  // firm switch is OFF here; the visibility rules have their own suite
  // (taxpayer-visibility.routes.test.ts).
  await db.insert(taxEstFirmSettings).values({ firmId: ids.firmA, restrictTaxpayersToLinkedTenants: false });
  await db.insert(tenantFirmAssignments).values([
    { tenantId: ids.t1, firmId: ids.firmA }, { tenantId: ids.t2, firmId: ids.firmA },
    { tenantId: ids.t3, firmId: ids.firmA }, { tenantId: ids.t4, firmId: ids.firmB },
  ]);
  for (const t of [ids.t1, ids.t2, ids.t3, ids.t4]) {
    await db.insert(tenantFeatureFlags).values({ tenantId: t, flagKey: 'TAX_ESTIMATOR_V1', enabled: true });
  }
  const staff = await mkUser(ids.t1, 'accountant');
  staffToken = staff.token;
  await db.insert(firmUsers).values({ firmId: ids.firmA, userId: staff.id, firmRole: 'firm_staff', capabilities: { tax_estimator_view_taxpayers: true } });
  await db.insert(userTenantAccess).values([
    { userId: staff.id, tenantId: ids.t1, role: 'accountant' },
    { userId: staff.id, tenantId: ids.t2, role: 'accountant' },
    { userId: staff.id, tenantId: ids.t4, role: 'accountant' }, // reachable, but another firm's client
  ]);
  const ro = await mkUser(ids.t1, 'accountant');
  readonlyToken = ro.token;
  await db.insert(firmUsers).values({ firmId: ids.firmA, userId: ro.id, firmRole: 'firm_readonly', capabilities: { tax_estimator_view_taxpayers: true } });
  await db.insert(userTenantAccess).values({ userId: ro.id, tenantId: ids.t1, role: 'accountant' });
  clientUserToken = (await mkUser(ids.t1, 'owner', 'client')).token;
  const fb2 = await mkUser(ids.t4, 'accountant');
  firmBToken = fb2.token;
  await db.insert(firmUsers).values({ firmId: ids.firmB, userId: fb2.id, firmRole: 'firm_admin' });
  await db.insert(userTenantAccess).values({ userId: fb2.id, tenantId: ids.t4, role: 'accountant' });

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

async function mkTaxpayer(token = staffToken, body: Record<string, unknown> = {}) {
  const r = await request('POST', BASE, token, { displayName: 'Rivera, Daniel & Maria', filingStatus: 'mfj', residentState: 'mo', ...body });
  expect(r.status).toBe(201);
  return r.json.data as { id: string };
}
const person = (role: string, first: string, extra: Record<string, unknown> = {}) =>
  ({ firstName: first, lastName: 'Rivera', isBlind: false, ...extra, _role: role });
async function mkPerson(taxpayerId: string, role: 'primary' | 'spouse', first = role === 'primary' ? 'Daniel' : 'Maria') {
  const { _role, ...body } = person(role, first);
  const r = await request('PUT', `${BASE}/${taxpayerId}/persons/${role}`, staffToken, body);
  expect(r.status).toBe(200);
  return r.json.data as { id: string };
}
const linkBody = (over: Record<string, unknown> = {}) => ({
  personRole: 'primary', taxYear: 2026, tenantId: ids.t2, companyId: ids.c2, profitPct: 100, lossPct: 100, ...over,
});

describe('taxpayer CRUD', () => {
  it('creates, reads, lists (paginated with total), updates and archives; firm comes from scope not the body', async () => {
    const created = await request('POST', BASE, staffToken, {
      displayName: 'Rivera', filingStatus: 'mfj', residentState: 'mo', firmId: ids.firmB,
    });
    expect(created.status).toBe(201);
    expect(created.json.data.residentState).toBe('MO');
    const id = created.json.data.id as string;
    const [row] = await db.select().from(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, id));
    expect(row!.firmId).toBe(ids.firmA); // body firmId ignored

    await mkTaxpayer(staffToken, { displayName: 'Zed' });
    const list = await request('GET', `${BASE}?limit=1&offset=0&sortBy=displayName&sortDir=desc`, staffToken);
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(2);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0].displayName).toBe('Zed');

    const upd = await request('PATCH', `${BASE}/${id}`, staffToken, { filingStatus: 'single', safeHarborOverride: 'lesser_of' });
    expect(upd.status).toBe(200);
    expect(upd.json.data.safeHarborOverride).toBe('lesser_of');

    expect((await request('DELETE', `${BASE}/${id}`, staffToken)).json.data.isActive).toBe(false);
    expect((await request('GET', BASE, staffToken)).json.total).toBe(1); // archived hidden by default
    expect((await request('GET', `${BASE}?status=archived`, staffToken)).json.total).toBe(1);
  });

  it('QA D4: rejects a resident state outside the 51 jurisdictions (400) and filters the list by state (D29)', async () => {
    const zz = await request('POST', BASE, staffToken, { displayName: 'ZZ case', filingStatus: 'single', residentState: 'ZZ' });
    expect(zz.status).toBe(400);
    expect(JSON.stringify(zz.json)).toContain('two-letter state code');
    expect((await request('POST', BASE, staffToken, { displayName: 'Missouri', filingStatus: 'single', residentState: 'Missouri' })).status).toBe(400);
    const mo = await mkTaxpayer(staffToken, { displayName: 'Mo person', residentState: 'mo' }) as { id: string; residentState: string };
    expect(mo.residentState).toBe('MO');
    const tp = await mkTaxpayer(staffToken, { displayName: 'Ks person', residentState: 'KS' });
    expect((await request('PATCH', `${BASE}/${tp.id}`, staffToken, { residentState: 'ZZ' })).status).toBe(400);
    const list = await request('GET', `${BASE}?residentState=mo`, staffToken);
    expect(list.status).toBe(200);
    expect(list.json.data.map((r: { displayName: string }) => r.displayName)).toEqual(['Mo person']);
    expect((await request('GET', `${BASE}?residentState=ZZ`, staffToken)).status).toBe(400);
  });

  it('rejects invalid input (422/400) and audits mutations in the caller\'s active tenant with the firm id', async () => {
    expect((await request('POST', BASE, staffToken, { displayName: '', filingStatus: 'mfj' })).status).toBe(400);
    expect((await request('POST', BASE, staffToken, { displayName: 'X', filingStatus: 'nope' })).status).toBe(400);
    const tp = await mkTaxpayer();
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, ids.t1), eq(auditLog.entityType, 'tax_est_taxpayer'), eq(auditLog.entityId, tp.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('create');
    expect(JSON.stringify(rows[0]!.afterData)).toContain(ids.firmA);
  });
});

describe('access control', () => {
  it('firm_readonly can read but every mutation is 403', async () => {
    const tp = await mkTaxpayer();
    expect((await request('GET', BASE, readonlyToken)).status).toBe(200);
    expect((await request('GET', `${BASE}/${tp.id}`, readonlyToken)).status).toBe(200);
    expect((await request('POST', BASE, readonlyToken, { displayName: 'x', filingStatus: 'single' })).status).toBe(403);
    expect((await request('PATCH', `${BASE}/${tp.id}`, readonlyToken, { displayName: 'y' })).status).toBe(403);
    expect((await request('DELETE', `${BASE}/${tp.id}`, readonlyToken)).status).toBe(403);
    expect((await request('PUT', `${BASE}/${tp.id}/persons/primary`, readonlyToken, { firstName: 'a', lastName: 'b' })).status).toBe(403);
    expect((await request('PUT', `${BASE}/${tp.id}/links`, readonlyToken, linkBody())).status).toBe(403);
    expect((await request('POST', `${BASE}/${tp.id}/contacts`, readonlyToken, { portalContactId: ids.c1 })).status).toBe(403);
  });

  it('user_type client gets 404 on the whole router', async () => {
    expect((await request('GET', BASE, clientUserToken)).status).toBe(404);
    expect((await request('POST', BASE, clientUserToken, { displayName: 'x', filingStatus: 'single' })).status).toBe(404);
    expect((await request('GET', `${BASE}/company-options`, clientUserToken)).status).toBe(404);
  });

  it('a firm-B user cannot read or modify a firm-A taxpayer (404) and never sees it listed', async () => {
    const tp = await mkTaxpayer();
    await mkPerson(tp.id, 'primary');
    const g = await request('GET', `${BASE}/${tp.id}`, firmBToken);
    expect(g.status).toBe(404);
    expect(g.json.error.code).toBe('TE_TAXPAYER_NOT_FOUND');
    expect((await request('PATCH', `${BASE}/${tp.id}`, firmBToken, { displayName: 'hijack' })).status).toBe(404);
    expect((await request('DELETE', `${BASE}/${tp.id}`, firmBToken)).status).toBe(404);
    expect((await request('PUT', `${BASE}/${tp.id}/persons/primary`, firmBToken, { firstName: 'a', lastName: 'b' })).status).toBe(404);
    expect((await request('DELETE', `${BASE}/${tp.id}/persons/primary`, firmBToken)).status).toBe(404);
    expect((await request('GET', `${BASE}/${tp.id}/links?taxYear=2026`, firmBToken)).status).toBe(404);
    expect((await request('PUT', `${BASE}/${tp.id}/links`, firmBToken, linkBody({ tenantId: ids.t4, companyId: ids.c4 }))).status).toBe(404);
    expect((await request('GET', `${BASE}/${tp.id}/contacts`, firmBToken)).status).toBe(404);
    expect((await request('GET', BASE, firmBToken)).json.total).toBe(0);
    const [still] = await db.select().from(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, tp.id));
    expect(still!.displayName).toBe('Rivera, Daniel & Maria');
    expect(still!.isActive).toBe(true);
  });
});

describe('persons', () => {
  it('requires a primary before a spouse, validates DOB and SEHI months, and removes in the right order', async () => {
    const tp = await mkTaxpayer();
    const url = (role: string) => `${BASE}/${tp.id}/persons/${role}`;
    const noPrimary = await request('PUT', url('spouse'), staffToken, { firstName: 'M', lastName: 'R' });
    expect(noPrimary.status).toBe(422);
    expect(noPrimary.json.error.code).toBe('TE_PRIMARY_REQUIRED');
    const future = await request('PUT', url('primary'), staffToken, { firstName: 'D', lastName: 'R', dateOfBirth: '2999-01-01' });
    expect(future.status).toBe(422);
    expect(future.json.error.code).toBe('TE_DOB_IN_FUTURE');
    expect((await request('PUT', url('primary'), staffToken, { firstName: 'D', lastName: 'R', sehiEligibleMonths: [true] })).status).toBe(400);
    const months = Array(12).fill(true); months[0] = false;
    const ok = await request('PUT', url('primary'), staffToken, { firstName: 'D', lastName: 'R', dateOfBirth: '1980-05-01', sehiEligibleMonths: months });
    expect(ok.status).toBe(200);
    expect(ok.json.data.sehiEligibleMonths[0]).toBe(false);
    expect((await request('PUT', url('spouse'), staffToken, { firstName: 'M', lastName: 'R' })).status).toBe(200);
    expect((await request('PUT', url('spouse'), staffToken, { firstName: 'Maria', lastName: 'R' })).status).toBe(200); // upsert, not a 3rd person
    const detail = await request('GET', `${BASE}/${tp.id}`, staffToken);
    expect(detail.json.data.persons).toHaveLength(2);
    expect((await request('DELETE', url('primary'), staffToken)).status).toBe(422);
    expect((await request('DELETE', url('spouse'), staffToken)).status).toBe(200);
    expect((await request('DELETE', url('primary'), staffToken)).status).toBe(200);
  });
});

describe('dependents (Q44)', () => {
  const kid = (extra: Record<string, unknown> = {}) => ({ displayName: 'Tobi Rivera', dateOfBirth: '2016-03-10', relationship: 'son', kind: 'qualifying_child', ...extra });

  it('CRUD: create, list (on the detail and the list route), update, remove — audited without name or date of birth', async () => {
    const tp = await mkTaxpayer();
    const created = await request('POST', `${BASE}/${tp.id}/dependents`, staffToken, kid({ isStudent: false, monthsLivedWith: 12 }));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const depId = created.json.data.id as string;
    expect(created.json.data).toMatchObject({ displayName: 'Tobi Rivera', dateOfBirth: '2016-03-10', kind: 'qualifying_child', monthsLivedWith: 12, firstTaxYear: null });
    const detail = await request('GET', `${BASE}/${tp.id}`, readonlyToken);
    expect(detail.json.data.dependents.map((d: { id: string }) => d.id)).toEqual([depId]);
    const list = await request('GET', `${BASE}/${tp.id}/dependents`, readonlyToken);
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(1);
    const upd = await request('PUT', `${BASE}/${tp.id}/dependents/${depId}`, staffToken, kid({ displayName: 'Tobi R.', isDisabled: true, lastTaxYear: 2030 }));
    expect(upd.status).toBe(200);
    expect(upd.json.data).toMatchObject({ displayName: 'Tobi R.', isDisabled: true, lastTaxYear: 2030 });
    expect((await request('DELETE', `${BASE}/${tp.id}/dependents/${depId}`, staffToken)).status).toBe(200);
    expect((await request('DELETE', `${BASE}/${tp.id}/dependents/${depId}`, staffToken)).json.error.code).toBe('TE_DEPENDENT_NOT_FOUND');
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'tax_est_dependent'), eq(auditLog.entityId, depId)));
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'delete', 'update']);
    const blob = JSON.stringify(rows.map((r) => [r.beforeData, r.afterData]));
    expect(blob).not.toContain('Tobi');
    expect(blob).not.toContain('2016-03-10');
  });

  it('validation: date of birth required and not in the future, months 0–12, last year not before first, no SSN field', async () => {
    const tp = await mkTaxpayer();
    const url = `${BASE}/${tp.id}/dependents`;
    expect((await request('POST', url, staffToken, { displayName: 'x', kind: 'qualifying_child' })).status).toBe(400);
    expect((await request('POST', url, staffToken, kid({ monthsLivedWith: 13 }))).status).toBe(400);
    expect((await request('POST', url, staffToken, kid({ firstTaxYear: 2027, lastTaxYear: 2026 }))).status).toBe(400);
    const future = await request('POST', url, staffToken, kid({ dateOfBirth: '2999-01-01' }));
    expect(future.status).toBe(422);
    expect(future.json.error.code).toBe('TE_DOB_IN_FUTURE');
    const ssn = await request('POST', url, staffToken, kid({ ssn: '123-45-6789' }));
    expect(ssn.status).toBe(201);
    expect(JSON.stringify(ssn.json)).not.toContain('123-45-6789');
  });

  it('a dependent id of another taxpayer is TE_DEPENDENT_NOT_FOUND (keyed by the taxpayer)', async () => {
    const a = await mkTaxpayer(); const b = await mkTaxpayer(staffToken, { displayName: 'Other' });
    const dep = (await request('POST', `${BASE}/${a.id}/dependents`, staffToken, kid())).json.data.id as string;
    const r = await request('PUT', `${BASE}/${b.id}/dependents/${dep}`, staffToken, kid({ displayName: 'Moved' }));
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('TE_DEPENDENT_NOT_FOUND');
    expect((await request('DELETE', `${BASE}/${b.id}/dependents/${dep}`, staffToken)).status).toBe(404);
  });

  it('firm_readonly reads but cannot write (403); firm B and client users get 404', async () => {
    const tp = await mkTaxpayer();
    const dep = (await request('POST', `${BASE}/${tp.id}/dependents`, staffToken, kid())).json.data.id as string;
    expect((await request('POST', `${BASE}/${tp.id}/dependents`, readonlyToken, kid())).status).toBe(403);
    expect((await request('PUT', `${BASE}/${tp.id}/dependents/${dep}`, readonlyToken, kid())).status).toBe(403);
    expect((await request('DELETE', `${BASE}/${tp.id}/dependents/${dep}`, readonlyToken)).status).toBe(403);
    for (const [method, path, body] of [
      ['GET', `${BASE}/${tp.id}/dependents`], ['POST', `${BASE}/${tp.id}/dependents`, kid()],
      ['PUT', `${BASE}/${tp.id}/dependents/${dep}`, kid()], ['DELETE', `${BASE}/${tp.id}/dependents/${dep}`],
    ] as Array<[string, string, unknown?]>) {
      const fb = await request(method, path, firmBToken, body);
      expect(fb.status, `${method} ${path}`).toBe(404);
      expect(fb.json.error.code).toBe('TE_TAXPAYER_NOT_FOUND');
      expect((await request(method, path, clientUserToken, body)).status, `client ${method} ${path}`).toBe(404);
    }
  });
});

describe('outside businesses (Q45)', () => {
  const biz = (extra: Record<string, unknown> = {}) => ({ name: 'Lakeside Partners LP', entityType: 'partnership', personRole: 'primary', profitPct: 25, partnerSeStatus: 'limited', activityType: 'passive', ...extra });
  const amounts = (extra: Record<string, unknown> = {}) => ({ entryMode: 'full_year', amountBasis: 'owner_share', amounts: { ordinary: '60000', interest: 2000 }, ...extra });

  it('CRUD: definition, per-year amounts (list by taxYear), clear a year, remove — audited', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    const created = await request('POST', `${BASE}/${tp.id}/outside-entities`, staffToken, biz());
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.data.id as string;
    expect(created.json.data).toMatchObject({ name: 'Lakeside Partners LP', entityType: 'partnership', personRole: 'primary', profitPct: 25, partnerSeStatus: 'limited', years: [], year: null });

    const y = await request('PUT', `${BASE}/${tp.id}/outside-entities/${id}/years/2026`, staffToken, amounts());
    expect(y.status, JSON.stringify(y.json)).toBe(200);
    expect(y.json.data.years).toEqual([2026]);
    expect(y.json.data.year).toMatchObject({ taxYear: 2026, entryMode: 'full_year', amountBasis: 'owner_share', throughMonth: null, guaranteedPayments: '0' });
    expect(y.json.data.year.amounts).toMatchObject({ ordinary: '60000', interest: '2000', rental: '0' });
    // A second year has its own mode, basis and through month; the definition carries forward.
    const y25 = await request('PUT', `${BASE}/${tp.id}/outside-entities/${id}/years/2025`, staffToken, amounts({ entryMode: 'ytd', throughMonth: 9, amountBasis: 'entity_total', amounts: { ordinary: '-1500.25' } }));
    expect(y25.json.data.year).toMatchObject({ taxYear: 2025, entryMode: 'ytd', throughMonth: 9, amountBasis: 'entity_total' });
    expect(y25.json.data.year.amounts.ordinary).toBe('-1500.25');

    const l26 = await request('GET', `${BASE}/${tp.id}/outside-entities?taxYear=2026`, readonlyToken);
    expect(l26.status).toBe(200);
    expect(l26.json.total).toBe(1);
    expect(l26.json.data[0].years).toEqual([2025, 2026]);
    expect(l26.json.data[0].year.amountBasis).toBe('owner_share');
    const l24 = await request('GET', `${BASE}/${tp.id}/outside-entities?taxYear=2024`, readonlyToken);
    expect(l24.json.data[0].year).toBeNull();

    const upd = await request('PUT', `${BASE}/${tp.id}/outside-entities/${id}`, staffToken, biz({ name: 'Lakeside LP', stateSourcing: 'ks' }));
    expect(upd.status).toBe(200);
    expect(upd.json.data).toMatchObject({ name: 'Lakeside LP', stateSourcing: 'KS' });

    expect((await request('DELETE', `${BASE}/${tp.id}/outside-entities/${id}/years/2025`, staffToken)).status).toBe(200);
    expect((await request('DELETE', `${BASE}/${tp.id}/outside-entities/${id}/years/2025`, staffToken)).json.error.code).toBe('TE_OUTSIDE_ENTITY_NOT_FOUND');
    const del = await request('DELETE', `${BASE}/${tp.id}/outside-entities/${id}`, staffToken);
    expect(del.json.data).toEqual({ removed: true, removedYears: 1 });
    expect((await request('GET', `${BASE}/${tp.id}/outside-entities`, staffToken)).json.total).toBe(0);

    const rows = await db.select().from(auditLog).where(inArray(auditLog.entityType, ['tax_est_outside_entity', 'tax_est_outside_entity_year']));
    const mine = rows.filter((r) => JSON.stringify([r.beforeData, r.afterData]).includes(tp.id));
    expect(mine.filter((r) => r.entityType === 'tax_est_outside_entity').map((r) => r.action).sort()).toEqual(['create', 'delete', 'update']);
    expect(mine.filter((r) => r.entityType === 'tax_est_outside_entity_year').map((r) => r.action).sort()).toEqual(['create', 'create', 'delete']);
    expect(JSON.stringify(mine.map((r) => r.afterData))).toContain(ids.firmA);
  });

  it('validation mirrors the link rules and the entity type; YTD needs a through month', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    const url = `${BASE}/${tp.id}/outside-entities`;
    const limited = await request('POST', url, staffToken, biz({ entityType: 'sch_c' }));
    expect(limited.status).toBe(422);
    expect(limited.json.error.code).toBe('TE_LIMITED_ONLY_PARTNERSHIP');
    const officer = await request('POST', url, staffToken, biz({ isOfficer: true }));
    expect(officer.json.error.code).toBe('TE_OFFICER_ONLY_SCORP');
    const spouse = await request('POST', url, staffToken, biz({ personRole: 'spouse' }));
    expect(spouse.status).toBe(422);
    expect(spouse.json.error.code).toBe('TE_OUTSIDE_PERSON_MISSING');
    expect((await request('POST', url, staffToken, biz({ stateSourcing: 'ZZ' }))).status).toBe(400);
    expect((await request('POST', url, staffToken, biz({ profitPct: 101 }))).status).toBe(400);
    expect((await request('POST', url, staffToken, biz({ entityType: 'trust' }))).status).toBe(400);
    const schc = (await request('POST', url, staffToken, biz({ entityType: 'sch_c', partnerSeStatus: null, name: 'Side gig' }))).json.data.id as string;
    const yUrl = `${url}/${schc}/years/2026`;
    expect((await request('PUT', yUrl, staffToken, amounts({ entryMode: 'ytd' }))).status).toBe(400);
    expect((await request('PUT', yUrl, staffToken, amounts({ entryMode: 'ytd', throughMonth: 13 }))).status).toBe(400);
    expect((await request('PUT', yUrl, staffToken, amounts({ ownerSehi: '-5' }))).status).toBe(400);
    expect((await request('PUT', yUrl, staffToken, amounts({ amounts: { ordinary: 'lots' } }))).status).toBe(400);
    const gp = await request('PUT', yUrl, staffToken, amounts({ guaranteedPayments: 5000 }));
    expect(gp.status).toBe(422);
    expect(gp.json.error.code).toBe('TE_OUTSIDE_FIELD_NOT_APPLICABLE');
    expect((await request('PUT', yUrl, staffToken, amounts({ officerWages: 5000 }))).json.error.code).toBe('TE_OUTSIDE_FIELD_NOT_APPLICABLE');
    expect((await request('PUT', `${BASE}/${tp.id}/outside-entities/${schc}/years/1999`, staffToken, amounts())).status).toBe(400);
  });

  it('an outside id of another taxpayer is TE_OUTSIDE_ENTITY_NOT_FOUND (keyed by the taxpayer)', async () => {
    const a = await mkTaxpayer(); await mkPerson(a.id, 'primary');
    const b = await mkTaxpayer(staffToken, { displayName: 'Other' }); await mkPerson(b.id, 'primary');
    const id = (await request('POST', `${BASE}/${a.id}/outside-entities`, staffToken, biz())).json.data.id as string;
    for (const [method, path, body] of [
      ['PUT', `${BASE}/${b.id}/outside-entities/${id}`, biz()], ['DELETE', `${BASE}/${b.id}/outside-entities/${id}`],
      ['PUT', `${BASE}/${b.id}/outside-entities/${id}/years/2026`, amounts()], ['DELETE', `${BASE}/${b.id}/outside-entities/${id}/years/2026`],
    ] as Array<[string, string, unknown?]>) {
      const r = await request(method, path, staffToken, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json.error.code).toBe('TE_OUTSIDE_ENTITY_NOT_FOUND');
    }
    expect((await request('GET', `${BASE}/${b.id}/outside-entities`, staffToken)).json.total).toBe(0);
  });

  it('firm_readonly reads but cannot write (403); firm B and client users get 404; removing the person removes the business', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary'); await mkPerson(tp.id, 'spouse');
    const id = (await request('POST', `${BASE}/${tp.id}/outside-entities`, staffToken, biz({ personRole: 'spouse' }))).json.data.id as string;
    expect((await request('GET', `${BASE}/${tp.id}/outside-entities`, readonlyToken)).status).toBe(200);
    const writes: Array<[string, string, unknown?]> = [
      ['POST', `${BASE}/${tp.id}/outside-entities`, biz()], ['PUT', `${BASE}/${tp.id}/outside-entities/${id}`, biz()],
      ['DELETE', `${BASE}/${tp.id}/outside-entities/${id}`], ['PUT', `${BASE}/${tp.id}/outside-entities/${id}/years/2026`, amounts()],
      ['DELETE', `${BASE}/${tp.id}/outside-entities/${id}/years/2026`],
    ];
    for (const [method, path, body] of writes) expect((await request(method, path, readonlyToken, body)).status, `readonly ${method} ${path}`).toBe(403);
    for (const [method, path, body] of [['GET', `${BASE}/${tp.id}/outside-entities`] as [string, string, unknown?], ...writes]) {
      const fb = await request(method, path, firmBToken, body);
      expect(fb.status, `${method} ${path}`).toBe(404);
      expect(fb.json.error.code).toBe('TE_TAXPAYER_NOT_FOUND');
      expect((await request(method, path, clientUserToken, body)).status, `client ${method} ${path}`).toBe(404);
    }
    expect((await request('DELETE', `${BASE}/${tp.id}/persons/spouse`, staffToken)).status).toBe(200);
    expect((await request('GET', `${BASE}/${tp.id}/outside-entities`, staffToken)).json.total).toBe(0);
  });
});

describe('links: firm scope (D1)', () => {
  it('linking a company in a tenant the firm manages but the caller cannot reach -> 404 TE_TENANT_NOT_MANAGED', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    const r = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ tenantId: ids.t3, companyId: ids.c3 }));
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('TE_TENANT_NOT_MANAGED');
  });

  it('linking a company in ANOTHER firm\'s tenant the caller can reach -> 404', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    const r = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ tenantId: ids.t4, companyId: ids.c4 }));
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('TE_TENANT_NOT_MANAGED');
  });

  it('a company id paired with the wrong (in-scope) tenant is a 404, not a cross-tenant link', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    const r = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ tenantId: ids.t2, companyId: ids.c3 }));
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.json)).not.toContain('Unreachable');
  });

  it('links a company in a different in-scope tenant than the caller\'s active tenant and lists it with Client — Company names', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    const r = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody());
    expect(r.status).toBe(200);
    expect(r.json.data.link.tenantName).toBe('TP Client Reachable');
    expect(r.json.data.link.companyName).toBe('Reachable Co');
    expect(r.json.data.link.outOfScope).toBe(false);
    const list = await request('GET', `${BASE}/${tp.id}/links?taxYear=2026`, staffToken);
    expect(list.json.total).toBe(1);
    expect((await request('GET', `${BASE}/${tp.id}/links?taxYear=2025`, staffToken)).json.total).toBe(0);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, ids.t1), eq(auditLog.entityType, 'tax_est_link')));
    expect(audits).toHaveLength(1); // audit tenant = caller's active tenant, not the linked tenant
  });

  it('a link whose tenant later leaves the firm stays stored but is flagged outOfScope, names withheld, and dropped from options', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    const linked = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody());
    await db.update(tenantFirmAssignments).set({ isActive: false }).where(eq(tenantFirmAssignments.tenantId, ids.t2));
    const list = await request('GET', `${BASE}/${tp.id}/links?taxYear=2026`, staffToken);
    expect(list.json.total).toBe(1);
    expect(list.json.data[0].outOfScope).toBe(true);
    expect(list.json.data[0].tenantName).toBeNull();
    expect(list.json.data[0].companyName).toBeNull();
    expect(JSON.stringify(list.json)).not.toContain('Reachable');
    expect(list.json.warnings).toEqual([]); // excluded from computed totals
    const opts = await request('GET', `${BASE}/company-options`, staffToken);
    expect(opts.json.data.map((o: { tenantId: string }) => o.tenantId)).not.toContain(ids.t2);
    // Re-saving the stale link is a write into an unmanaged tenant.
    expect((await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody())).status).toBe(404);
    // Cleanup of the firm's own stale row is allowed.
    expect((await request('DELETE', `${BASE}/${tp.id}/links/${linked.json.data.link.id}`, staffToken)).status).toBe(204);
  });

  it('company-options never returns out-of-scope tenants and paginates/filters', async () => {
    const all = await request('GET', `${BASE}/company-options`, staffToken);
    expect(all.status).toBe(200);
    const tenantsSeen = all.json.data.map((o: { tenantId: string }) => o.tenantId).sort();
    expect(tenantsSeen).toEqual([ids.t1, ids.t2].sort());
    expect(all.json.total).toBe(2);
    expect(JSON.stringify(all.json)).not.toContain('Unreachable');
    expect(JSON.stringify(all.json)).not.toContain('Other Firm');
    const paged = await request('GET', `${BASE}/company-options?limit=1&offset=1`, staffToken);
    expect(paged.json.data).toHaveLength(1);
    expect(paged.json.total).toBe(2);
    const q = await request('GET', `${BASE}/company-options?q=reachable`, staffToken);
    expect(q.json.data.map((o: { companyName: string }) => o.companyName)).toEqual(['Reachable Co']);
    // q matching an out-of-scope client name still returns nothing.
    expect((await request('GET', `${BASE}/company-options?q=Unreachable%20Co`, staffToken)).json.total).toBe(0);
    // Firm B sees only its own.
    const b = await request('GET', `${BASE}/company-options`, firmBToken);
    expect(b.json.data.map((o: { tenantId: string }) => o.tenantId)).toEqual([ids.t4]);
  });
});

describe('links: validation', () => {
  it('profit/loss % across all persons for one company+year must not exceed 100 (422) and warns under 100', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary'); await mkPerson(tp.id, 'spouse');
    const first = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ profitPct: 60, lossPct: 60 }));
    expect(first.status).toBe(200);
    expect(first.json.data.warnings.map((w: { code: string }) => w.code).sort()).toEqual(['LOSS_PCT_UNDER_100', 'PROFIT_PCT_UNDER_100']);
    const over = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ personRole: 'spouse', profitPct: 40.0001, lossPct: 40 }));
    expect(over.status).toBe(422);
    expect(over.json.error.code).toBe('TE_LINK_PCT_OVER_100');
    const exact = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ personRole: 'spouse', profitPct: 40, lossPct: 40 }));
    expect(exact.status).toBe(200);
    expect(exact.json.data.warnings).toEqual([]);
    // Re-saving the same person's link replaces (does not add to) their own share.
    expect((await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ profitPct: 60, lossPct: 60 }))).status).toBe(200);
    // A different tax year is a separate bucket.
    expect((await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ taxYear: 2025, profitPct: 100 }))).status).toBe(200);
    expect((await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ profitPct: 101 }))).status).toBe(400);
  });

  it('limited partner only for partnerships; officer only for S corps (return form wins over entity type)', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    const limited = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ partnerSeStatus: 'limited' }));
    expect(limited.status).toBe(422);
    expect(limited.json.error.code).toBe('TE_LIMITED_ONLY_PARTNERSHIP');
    const officer = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ isOfficer: true }));
    expect(officer.status).toBe(422);
    expect(officer.json.error.code).toBe('TE_OFFICER_ONLY_SCORP');

    await db.update(companies).set({ entityType: 'partnership' }).where(eq(companies.id, ids.c2));
    expect((await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ partnerSeStatus: 'limited' }))).status).toBe(200);
    // TB profile 1120S overrides the companies.entity_type fallback.
    await db.insert(companyTaxProfiles).values({ tenantId: ids.t2, companyId: ids.c2, returnForm: '1120S' });
    expect((await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ partnerSeStatus: 'limited' }))).status).toBe(422);
    expect((await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ isOfficer: true }))).status).toBe(200);
  });

  it('rental defaults qbi_eligible from the entity setting (false when none); overrides need a reason; allowed-loss needs a reason', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    const rental = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ activityType: 'rental', activeParticipation: true }));
    expect(rental.status).toBe(200);
    expect(rental.json.data.link.qbiEligible).toBe(false);
    const noReason = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ activityType: 'rental', qbiEligible: true }));
    expect(noReason.status).toBe(422);
    expect(noReason.json.error.code).toBe('TE_OVERRIDE_REASON_REQUIRED');
    const withReason = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ activityType: 'rental', qbiEligible: true, qbiOverrideReason: 'Rev. Proc. 2019-38 safe harbor met' }));
    expect(withReason.json.data.link.qbiEligible).toBe(true);
    expect((await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ allowedLossOverride: '5000' }))).status).toBe(422);
    const loss = await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ allowedLossOverride: 5000.5, allowedLossReason: 'Basis worksheet' }));
    expect(loss.status).toBe(200);
    expect(loss.json.data.link.allowedLossOverride).toBe('5000.5000');
  });

  it('removing a person removes that person\'s links', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary'); await mkPerson(tp.id, 'spouse');
    await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody({ personRole: 'spouse', profitPct: 50 }));
    await request('DELETE', `${BASE}/${tp.id}/persons/spouse`, staffToken);
    expect((await request('GET', `${BASE}/${tp.id}/links?taxYear=2026`, staffToken)).json.total).toBe(0);
  });
});

describe('portal contacts', () => {
  async function mkContact(tenantId: string, email: string) {
    const [c] = await db.insert(portalContacts).values({ tenantId, email }).returning();
    return c!.id;
  }

  it('rejects a portal contact whose tenant is out of scope (unreachable or another firm)', async () => {
    const tp = await mkTaxpayer();
    for (const [t, e] of [[ids.t3, 'a@x.test'], [ids.t4, 'b@x.test']] as const) {
      const cid = await mkContact(t, e);
      const r = await request('POST', `${BASE}/${tp.id}/contacts`, staffToken, { portalContactId: cid, grantAccess: true });
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe('TE_TENANT_NOT_MANAGED');
    }
    expect((await request('GET', `${BASE}/${tp.id}/contacts`, staffToken)).json.total).toBe(0);
  });

  it('QA D11: from the practice tenant, the picker lists the linked client companies\' active contacts (in scope only)', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody()); // c2 in t2; the caller's active tenant is t1
    const yes = await mkContact(ids.t2, 'owner@client.test');
    await db.insert(portalContactCompanies).values({ contactId: yes, companyId: ids.c2 });
    await mkContact(ids.t2, 'no-company@client.test'); // a contact of the tenant without access to the linked company
    const gone = await mkContact(ids.t2, 'deleted@client.test');
    await db.update(portalContacts).set({ status: 'deleted' }).where(eq(portalContacts.id, gone));
    await db.insert(portalContactCompanies).values({ contactId: gone, companyId: ids.c2 });
    const r = await request('GET', `${BASE}/${tp.id}/contact-candidates`, staffToken);
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual([expect.objectContaining({ portalContactId: yes, tenantId: ids.t2, email: 'owner@client.test', companyNames: ['Reachable Co'] })]);
    expect(r.json.total).toBe(1);
    expect((await request('GET', `${BASE}/${tp.id}/contact-candidates`, firmBToken)).status).toBe(404);
  });

  it('links an in-scope contact, grants tax_estimates_access only with grantAccess, and revokes on unlink', async () => {
    const tp = await mkTaxpayer(); await mkPerson(tp.id, 'primary');
    await request('PUT', `${BASE}/${tp.id}/links`, staffToken, linkBody());
    const cid = await mkContact(ids.t2, 'client@x.test');
    await db.insert(portalContactCompanies).values({ contactId: cid, companyId: ids.c2 });
    const access = async () => (await db.select().from(portalContactCompanies).where(eq(portalContactCompanies.contactId, cid)))[0]!.taxEstimatesAccess;

    const plain = await request('POST', `${BASE}/${tp.id}/contacts`, staffToken, { portalContactId: cid });
    expect(plain.status).toBe(201);
    expect(plain.json.data.grantedCompanies).toBe(0);
    expect(await access()).toBe(false);

    const granted = await request('POST', `${BASE}/${tp.id}/contacts`, staffToken, { portalContactId: cid, grantAccess: true });
    expect(granted.json.data.grantedCompanies).toBe(1);
    expect(granted.json.data.contact.taxEstimatesAccess).toBe(true);
    expect(await access()).toBe(true);
    const list = await request('GET', `${BASE}/${tp.id}/contacts`, staffToken);
    expect(list.json.total).toBe(1);

    const gone = await request('DELETE', `${BASE}/${tp.id}/contacts/${cid}?revokeAccess=true`, staffToken);
    expect(gone.json.data.revokedCompanies).toBe(1);
    expect(await access()).toBe(false);
    expect((await request('GET', `${BASE}/${tp.id}/contacts`, staffToken)).json.total).toBe(0);
  });
});
