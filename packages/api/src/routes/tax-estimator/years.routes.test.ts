// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

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
  taxEstTaxpayers, taxEstYears, taxEstFirmSettings, taxEstAdjustmentTypes, accounts,
} from '../../db/schema/index.js';
import { taxEstimatorRouter } from '../tax-estimator.routes.js';
import { ensureShippedAdjustmentTypes } from '../../services/tax-estimator/tax-parameters.service.js';
import { errorHandler } from '../../middleware/error-handler.js';

// Phase 5 route tests (annual settings, scenarios, adjustments, state rows, firm settings) (MODULE.md D1). Fixture = the Phase 0 harness:
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

beforeEach(async () => {
  await cleanDb();
  // Other suites truncate firms (cascading to the shipped adjustment-type catalog); restore it.
  await ensureShippedAdjustmentTypes();
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
async function typeId(code: string) {
  const [t] = await db.select().from(taxEstAdjustmentTypes).where(eq(taxEstAdjustmentTypes.code, code));
  return t!.id;
}
const adjBody = async (over: Record<string, unknown> = {}) => ({
  adjustmentTypeId: await typeId('sep_solo_401k'), label: 'SEP', amount: 15000, cadence: 'annual', startMonth: 1, endMonth: 12, ...over,
});

describe('annual settings and prior-year encryption (D9)', () => {
  it('returns defaults for an unsaved year, creates the year and exactly one Base on save, and keeps one Base on re-save', async () => {
    const tp = await mkTaxpayer();
    const empty = await request('GET', yr(tp), staffToken);
    expect(empty.status).toBe(200);
    expect(empty.json.data.exists).toBe(false);
    expect(empty.json.data.scenarios).toEqual([]);
    expect(empty.json.data.year.rateMode).toBe('brackets');
    expect(empty.json.data.effectiveSafeHarborRule).toBe('lesser_of'); // firm default

    const first = await setUpYear(tp, { deductionMode: 'itemized', itemized: { saltPaid: 11000 }, creditsNonrefundable: 2200 });
    expect(first.scenarios).toHaveLength(1);
    expect(first.scenarios[0]).toMatchObject({ name: 'Base', isBase: true });
    const second = await setUpYear(tp, { rateMode: 'effective', effectiveRateOverride: 0.18 });
    expect(second.scenarios).toHaveLength(1);
    expect(second.year).toMatchObject({ rateMode: 'effective', effectiveRateOverride: 0.18, deductionMode: 'itemized' });
    expect((second.year as { creditsNonrefundable: string }).creditsNonrefundable).toBe('2200.0000');

    expect((await request('PUT', yr(tp), staffToken, { rateMode: 'effective', effectiveRateOverride: null })).status).toBe(400);
    expect((await request('PUT', yr(tp), staffToken, { itemized: { bogus: 1 } })).status).toBe(400);
  });

  it('encrypts prior-year tax/AGI at rest, returns them only on the single-year GET, never in lists or audit rows', async () => {
    const tp = await mkTaxpayer();
    const d = await setUpYear(tp, { priorYearTax: '31500', priorYearAgi: '182000.55' });
    expect(d.year).toMatchObject({ priorYearTax: '31500', priorYearAgi: '182000.55', priorYearTaxPresent: true });

    const [row] = await db.select().from(taxEstYears).where(eq(taxEstYears.taxpayerId, tp));
    expect(row!.priorYearTaxEncrypted).toBeTruthy();
    expect(row!.priorYearTaxEncrypted).not.toContain('31500');
    expect(row!.priorYearAgiEncrypted).not.toContain('182000');
    expect(row!.priorYearTaxEncrypted!.split(':')).toHaveLength(3); // iv:tag:ciphertext

    const list = await request('GET', `${BASE}/${tp}/years`, staffToken);
    expect(list.json.data).toEqual([{ taxYear: 2026, priorYearTaxPresent: true, priorYearAgiPresent: true, scenarioCount: 1 }]);
    expect(JSON.stringify(list.json)).not.toContain('31500');

    // Re-save with the same prior-year values is not a change; a new value is.
    await setUpYear(tp, { priorYearTax: '31500' });
    await setUpYear(tp, { priorYearTax: '40000.25' });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, ids.t1), eq(auditLog.entityType, 'tax_est_year')));
    expect(audits.length).toBeGreaterThanOrEqual(3);
    const blob = JSON.stringify(audits.map((a) => [a.beforeData, a.afterData]));
    for (const secret of ['31500', '40000.25', '182000', row!.priorYearTaxEncrypted!]) expect(blob).not.toContain(secret);
    expect(blob).toContain('"changed":true');
    // A clear (null) removes the value.
    const cleared = await setUpYear(tp, { priorYearTax: null });
    expect(cleared.year).toMatchObject({ priorYearTax: null, priorYearTaxPresent: false });
  });

  it('resolves the effective safe-harbor rule: year > taxpayer override > firm default', async () => {
    const tp = await mkTaxpayer();
    await request('PATCH', `${BASE}/${tp}`, staffToken, { safeHarborOverride: 'prior_year' });
    expect((await request('GET', yr(tp), staffToken)).json.data.effectiveSafeHarborRule).toBe('prior_year');
    await setUpYear(tp, { safeHarborRule: 'current_year' });
    expect((await request('GET', yr(tp), staffToken)).json.data.effectiveSafeHarborRule).toBe('current_year');
  });
});

describe('scenarios', () => {
  it('creates, renames, clones deeply (adjustments and state rows), protects Base, caps at 6, rejects duplicate names', async () => {
    const tp = await mkTaxpayer();
    const base = await baseScenario(tp);
    expect((await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody())).status).toBe(201);
    expect((await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ label: 'Truck', cadence: 'one_time', startMonth: 12, endMonth: 12, amount: 50000 }))).status).toBe(201);
    expect((await request('PUT', `${API}/scenarios/${base}/state-rows`, staffToken, {
      rows: [{ residency: 'resident', state: 'mo', effectiveRate: 0.04 }, { residency: 'nonresident', state: 'ar', effectiveRate: 0.039, sourcedManual: true, sourcedIncome: 8000 }],
    })).status).toBe(200);

    const clone = await request('POST', `${API}/scenarios/${base}/clone`, staffToken);
    expect(clone.status).toBe(201);
    expect(clone.json.data).toMatchObject({ name: 'Copy of Base', isBase: false, sourceScenarioId: base });
    const cid = clone.json.data.id as string;
    const cAdj = await request('GET', `${API}/scenarios/${cid}/adjustments`, staffToken);
    expect(cAdj.json.total).toBe(2);
    expect(cAdj.json.data.map((a: { label: string }) => a.label).sort()).toEqual(['SEP', 'Truck']);
    const cRows = await request('GET', `${API}/scenarios/${cid}/state-rows`, staffToken);
    expect(cRows.json.data.map((r: { state: string }) => r.state)).toEqual(['MO', 'AR']);
    // Deep: editing the clone leaves Base untouched.
    await request('PATCH', `${API}/adjustments/${cAdj.json.data[0].id}`, staffToken, { amount: 1 });
    const bAdj = await request('GET', `${API}/scenarios/${base}/adjustments`, staffToken);
    expect(bAdj.json.data.map((a: { amount: string }) => Number(a.amount)).sort((x: number, y: number) => x - y)).toEqual([15000, 50000]);

    expect((await request('PATCH', `${API}/scenarios/${cid}`, staffToken, { name: 'Buy truck in Dec' })).json.data.name).toBe('Buy truck in Dec');
    expect((await request('PATCH', `${API}/scenarios/${cid}`, staffToken, { name: 'base' })).json.error.code).toBe('TE_SCENARIO_NAME_TAKEN');
    // QA D21: Base keeps its name; a clone can be named.
    const renBase = await request('PATCH', `${API}/scenarios/${base}`, staffToken, { name: 'Not Base' });
    expect(renBase.status).toBe(422);
    expect(renBase.json.error.code).toBe('TE_BASE_SCENARIO_PROTECTED');
    const named = await request('POST', `${API}/scenarios/${base}/clone`, staffToken, { name: 'Buy truck in December' });
    expect(named.status).toBe(201);
    expect(named.json.data.name).toBe('Buy truck in December');
    expect((await request('POST', `${API}/scenarios/${base}/clone`, staffToken, { name: 'buy truck in december' })).json.error.code).toBe('TE_SCENARIO_NAME_TAKEN');
    expect((await request('DELETE', `${API}/scenarios/${named.json.data.id}`, staffToken)).status).toBe(204);
    const delBase = await request('DELETE', `${API}/scenarios/${base}`, staffToken);
    expect(delBase.status).toBe(422);
    expect(delBase.json.error.code).toBe('TE_BASE_SCENARIO_PROTECTED');

    for (let i = 0; i < 4; i++) expect((await request('POST', `${yr(tp)}/scenarios`, staffToken, { name: `S${i}` })).status).toBe(201);
    const over = await request('POST', `${yr(tp)}/scenarios`, staffToken, { name: 'Seventh' });
    expect(over.status).toBe(422);
    expect(over.json.error.code).toBe('TE_SCENARIO_CAP');
    expect((await request('POST', `${API}/scenarios/${base}/clone`, staffToken)).json.error.code).toBe('TE_SCENARIO_CAP');
    expect((await request('DELETE', `${API}/scenarios/${cid}`, staffToken)).status).toBe(204);
    expect((await request('GET', `${API}/scenarios/${cid}/adjustments`, staffToken)).status).toBe(404);
  });

  it('refuses to add a scenario before the year is saved', async () => {
    const tp = await mkTaxpayer();
    const r = await request('POST', `${yr(tp)}/scenarios`, staffToken, { name: 'X' });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('TE_YEAR_NOT_SET_UP');
  });
});

describe('adjustments', () => {
  it('returns the live monthly strip, paginates, merges patches and normalises one_time', async () => {
    const tp = await mkTaxpayer();
    const base = await baseScenario(tp);
    const a = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ amount: '1000', cadence: 'annual' }));
    expect(a.status).toBe(201);
    expect(a.json.data.monthly).toHaveLength(12);
    expect(a.json.data.monthly.reduce((s: number, n: number) => s + Math.round(n * 100), 0)).toBe(100000);
    expect(a.json.data.adjustmentTypeName).toBe('SEP/solo 401k contribution');

    const q = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ label: 'Q', amount: 300, cadence: 'quarterly' }));
    expect(q.json.data.monthly.every((n: number) => n === 100)).toBe(true);

    const once = await request('PATCH', `${API}/adjustments/${a.json.data.id}`, staffToken, { cadence: 'one_time', startMonth: 5, endMonth: 9 });
    expect(once.status).toBe(200);
    expect(once.json.data).toMatchObject({ endMonth: 5 });
    expect(once.json.data.monthly[4]).toBe(1000);

    const page = await request('GET', `${API}/scenarios/${base}/adjustments?limit=1&offset=1`, staffToken);
    expect(page.json).toMatchObject({ total: 2, limit: 1, offset: 1 });
    expect(page.json.data).toHaveLength(1);

    const bad = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ startMonth: 8, endMonth: 3 }));
    expect(bad.status).toBe(400);
    expect((await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ amount: null }))).status).toBe(400);
    expect((await request('DELETE', `${API}/adjustments/${a.json.data.id}`, staffToken)).status).toBe(204);
  });

  it('QA D1: a §179 vehicle / tax-vs-book depreciation needs an entity link (422), owner SEHI refuses one, and a link is accepted', async () => {
    const tp = await mkTaxpayer();
    const base = await baseScenario(tp);
    const person = await request('PUT', `${BASE}/${tp}/persons/primary`, staffToken, { firstName: 'Carlos', lastName: 'Rivera', isBlind: false });
    expect(person.status).toBe(200);
    const link = await request('PUT', `${BASE}/${tp}/links`, staffToken, { personRole: 'primary', taxYear: 2026, tenantId: ids.t2, companyId: ids.c2, profitPct: 100, lossPct: 100 });
    expect(link.status).toBe(200);
    const linkId = link.json.data.link.id as string;
    const truck = { adjustmentTypeId: await typeId('vehicle_179'), label: 'Truck', amount: 60000, cadence: 'one_time', startMonth: 12, endMonth: 12 };
    const unlinked = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, truck);
    expect(unlinked.status).toBe(422);
    expect(unlinked.json.error.code).toBe('TE_ADJUSTMENT_LINK_REQUIRED');
    expect(unlinked.json.error.message).toMatch(/itemized/);
    const dep = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, { ...truck, adjustmentTypeId: await typeId('depreciation_tax_vs_book') });
    expect(dep.json.error.code).toBe('TE_ADJUSTMENT_LINK_REQUIRED');
    const linked = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, { ...truck, linkId });
    expect(linked.status).toBe(201);
    expect(linked.json.data.linkId).toBe(linkId);
    // Clearing the link on update is refused the same way.
    const cleared = await request('PATCH', `${API}/adjustments/${linked.json.data.id}`, staffToken, { linkId: null });
    expect(cleared.json.error.code).toBe('TE_ADJUSTMENT_LINK_REQUIRED');
    const sehi = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ adjustmentTypeId: await typeId('owner_health_insurance'), linkId }));
    expect(sehi.status).toBe(422);
    expect(sehi.json.error.code).toBe('TE_ADJUSTMENT_LINK_NOT_ALLOWED');
    expect((await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ adjustmentTypeId: await typeId('owner_health_insurance') }))).status).toBe(201);
  });

  it('rejects a person that is not the taxpayer\'s and an inactive or unknown type', async () => {
    const tp = await mkTaxpayer();
    const base = await baseScenario(tp);
    const r = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ personId: '11111111-1111-4111-8111-111111111111' }));
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('TE_ADJUSTMENT_PERSON_INVALID');
    const t = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ adjustmentTypeId: '11111111-1111-4111-8111-111111111111' }));
    expect(t.status).toBe(404);
    expect(t.json.error.code).toBe('TE_ADJUSTMENT_TYPE_NOT_FOUND');
  });

  it('GL link: an in-scope tenant works; unmanaged / unreachable / other-firm tenants are 404 TE_TENANT_NOT_MANAGED', async () => {
    const tp = await mkTaxpayer();
    const base = await baseScenario(tp);
    const mkAcct = async (tenantId: string, companyId: string) => {
      const [a] = await db.insert(accounts).values({ tenantId, companyId, name: 'Owner health', accountType: 'expense' }).returning();
      return a!.id;
    };
    const ok = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({
      glLinked: true, tenantId: ids.t2, companyId: ids.c2, accountId: await mkAcct(ids.t2, ids.c2), amount: null, cadence: 'monthly',
    }));
    expect(ok.status).toBe(201);
    expect(ok.json.data).toMatchObject({ glLinked: true, amount: null, tenantId: ids.t2 });

    for (const [t, c] of [[ids.t3, ids.c3], [ids.t4, ids.c4]] as const) {
      const r = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({
        glLinked: true, tenantId: t, companyId: c, accountId: await mkAcct(t, c),
      }));
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe('TE_TENANT_NOT_MANAGED');
    }
    // PATCH into an unmanaged tenant is refused too, and a company from another tenant is not accepted.
    const patch = await request('PATCH', `${API}/adjustments/${ok.json.data.id}`, staffToken, { tenantId: ids.t3, companyId: ids.c3, accountId: await mkAcct(ids.t3, ids.c3) });
    expect(patch.json.error.code).toBe('TE_TENANT_NOT_MANAGED');
    const wrongCo = await request('PATCH', `${API}/adjustments/${ok.json.data.id}`, staffToken, { companyId: ids.c1 });
    expect(wrongCo.status).toBe(404);
    expect(wrongCo.json.error.code).toBe('TE_COMPANY_NOT_FOUND');
  });
});

describe('state rows', () => {
  it('requires exactly one resident, no duplicate states, nonresident != resident; PUT is atomic', async () => {
    const tp = await mkTaxpayer();
    const base = await baseScenario(tp);
    const url = `${API}/scenarios/${base}/state-rows`;
    expect((await request('GET', url, staffToken)).json.data).toEqual([]);
    const good = await request('PUT', url, staffToken, { rows: [
      { residency: 'nonresident', state: 'ar', effectiveRate: 0.039, sourcedManual: false },
      { residency: 'resident', state: 'mo', effectiveRate: 0.04, base: 'federal_agi', creditOverride: 312 },
    ] });
    expect(good.status).toBe(200);
    expect(good.json.data.map((r: { residency: string }) => r.residency)).toEqual(['resident', 'nonresident']);
    expect(good.json.data[1]).toMatchObject({ state: 'AR', sourcedManual: false, sourcedIncome: null });

    const none = await request('PUT', url, staffToken, { rows: [{ residency: 'nonresident', state: 'ar', effectiveRate: 0.03 }] });
    expect(none.json.error.code).toBe('TE_STATE_ONE_RESIDENT');
    const two = await request('PUT', url, staffToken, { rows: [
      { residency: 'resident', state: 'mo', effectiveRate: 0.04 }, { residency: 'resident', state: 'il', effectiveRate: 0.04 }] });
    expect(two.json.error.code).toBe('TE_STATE_ONE_RESIDENT');
    const same = await request('PUT', url, staffToken, { rows: [
      { residency: 'resident', state: 'mo', effectiveRate: 0.04 }, { residency: 'nonresident', state: 'MO', effectiveRate: 0.04 }] });
    expect(same.json.error.code).toBe('TE_STATE_NONRESIDENT_EQUALS_RESIDENT');
    const dup = await request('PUT', url, staffToken, { rows: [
      { residency: 'resident', state: 'mo', effectiveRate: 0.04 }, { residency: 'nonresident', state: 'ar', effectiveRate: 0.04 },
      { residency: 'nonresident', state: 'AR', effectiveRate: 0.04 }] });
    expect(dup.json.error.code).toBe('TE_STATE_DUPLICATE');
    expect((await request('PUT', url, staffToken, { rows: [{ residency: 'resident', state: 'mo', effectiveRate: 0.5 }] })).status).toBe(400);
    expect((await request('PUT', url, staffToken, { rows: [{ residency: 'resident', state: 'mo', effectiveRate: 0.04, base: 'custom' }] })).status).toBe(400);
    // After every failed replace the original set is intact.
    expect((await request('GET', url, staffToken)).json.data).toHaveLength(2);
  });

  it('Q53: rate mode and nonresident mode default to brackets / ratio, round-trip, are kept when omitted, and are validated', async () => {
    const tp = await mkTaxpayer();
    const base = await baseScenario(tp);
    const url = `${API}/scenarios/${base}/state-rows`;
    const first = await request('PUT', url, staffToken, { rows: [
      { residency: 'resident', state: 'mo', effectiveRate: 0 },
      { residency: 'nonresident', state: 'ks', effectiveRate: 0.05, sourcedManual: true, sourcedIncome: 40000 },
    ] });
    expect(first.status).toBe(200);
    expect(first.json.data.map((r: { state: string; rateMode: string; nonresidentMode: string }) => [r.state, r.rateMode, r.nonresidentMode])).toEqual([['MO', 'brackets', 'ratio'], ['KS', 'brackets', 'ratio']]);
    const set = await request('PUT', url, staffToken, { rows: [
      { residency: 'resident', state: 'mo', effectiveRate: 0.04, rateMode: 'effective' },
      { residency: 'nonresident', state: 'ks', effectiveRate: 0.05, sourcedManual: true, sourcedIncome: 40000, nonresidentMode: 'sourced_rate' },
    ] });
    expect(set.json.data.map((r: { rateMode: string; nonresidentMode: string }) => [r.rateMode, r.nonresidentMode])).toEqual([['effective', 'ratio'], ['brackets', 'sourced_rate']]);
    // Omitted on PUT = keep the saved modes (an older client).
    const kept = await request('PUT', url, staffToken, { rows: [
      { residency: 'resident', state: 'mo', effectiveRate: 0.04 },
      { residency: 'nonresident', state: 'ks', effectiveRate: 0.05, sourcedManual: true, sourcedIncome: 40000 },
    ] });
    expect(kept.json.data.map((r: { rateMode: string; nonresidentMode: string }) => [r.rateMode, r.nonresidentMode])).toEqual([['effective', 'ratio'], ['brackets', 'sourced_rate']]);
    expect((await request('PUT', url, staffToken, { rows: [{ residency: 'resident', state: 'mo', effectiveRate: 0.04, rateMode: 'table' }] })).status).toBe(400);
    expect((await request('PUT', url, staffToken, { rows: [{ residency: 'resident', state: 'mo', effectiveRate: 0.04, nonresidentMode: 'flat' }] })).status).toBe(400);
  });

  it('Q53 / Q39: the year inputs carry the unrecaptured §1250 and collectibles gains', async () => {
    const tp = await mkTaxpayer();
    const d = await setUpYear(tp, { unrecaptured1250Gain: 15000, collectiblesGain: 5000 });
    expect(Number(d.year['unrecaptured1250Gain'])).toBe(15000);
    expect(Number(d.year['collectiblesGain'])).toBe(5000);
    const again = await setUpYear(tp, { careExpenses: 100 });
    expect(Number(again.year['unrecaptured1250Gain'])).toBe(15000);
    expect((await request('PUT', yr(tp), staffToken, { collectiblesGain: -1 })).status).toBe(400);
  });
});

describe('adjustment types', () => {
  it('lists the shipped catalog, lets a firm add/edit/delete custom types, keeps shipped read-only and other firms invisible', async () => {
    const list = await request('GET', `${API}/adjustment-types`, staffToken);
    expect(list.status).toBe(200);
    const names = list.json.data.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['Meals (50%)', 'Capital gain long-term', 'Vehicle purchase (§179)']));
    const meals = list.json.data.find((t: { code: string }) => t.code === 'meals');
    expect(meals).toMatchObject({ isShipped: true, defaultPct: 50, kind: 'addback' });

    const created = await request('POST', `${API}/adjustment-types`, staffToken, { name: 'Crypto gain', kind: 'income', isCapitalGainSt: true });
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ isShipped: false, firmId: ids.firmA });
    const cid = created.json.data.id as string;
    expect((await request('POST', `${API}/adjustment-types`, staffToken, { name: 'crypto GAIN', kind: 'income' })).json.error.code).toBe('TE_ADJUSTMENT_TYPE_NAME_TAKEN');
    expect((await request('PATCH', `${API}/adjustment-types/${cid}`, staffToken, { defaultPct: 25 })).json.data.defaultPct).toBe(25);

    const shipped = await request('PATCH', `${API}/adjustment-types/${meals.id}`, staffToken, { defaultPct: 100 });
    expect(shipped.status).toBe(403);
    expect(shipped.json.error.code).toBe('TE_ADJUSTMENT_TYPE_READONLY');
    expect((await request('DELETE', `${API}/adjustment-types/${meals.id}`, staffToken)).status).toBe(403);

    // Firm B cannot see or touch firm A's custom type.
    expect((await request('GET', `${API}/adjustment-types`, firmBToken)).json.data.some((t: { id: string }) => t.id === cid)).toBe(false);
    expect((await request('PATCH', `${API}/adjustment-types/${cid}`, firmBToken, { name: 'x' })).status).toBe(404);
    expect((await request('DELETE', `${API}/adjustment-types/${cid}`, firmBToken)).status).toBe(404);

    // In use -> 409; unused -> deletable.
    const tp = await mkTaxpayer();
    const base = await baseScenario(tp);
    const used = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody({ adjustmentTypeId: cid }));
    expect(used.status).toBe(201);
    expect((await request('DELETE', `${API}/adjustment-types/${cid}`, staffToken)).json.error.code).toBe('TE_ADJUSTMENT_TYPE_IN_USE');
    await request('DELETE', `${API}/adjustments/${used.json.data.id}`, staffToken);
    expect((await request('DELETE', `${API}/adjustment-types/${cid}`, staffToken)).status).toBe(204);
  });
});

describe('firm settings', () => {
  it('returns defaults, lets only firm_admin write, and the readonly role is refused', async () => {
    const def = await request('GET', `${API}/firm-settings`, staffToken);
    expect(def.json.data).toMatchObject({
      firmId: ids.firmA, safeHarborDefault: 'lesser_of', portalShows: 'live', disclaimerText: null,
      effectiveDisclaimerText: 'Projection based on bookkeeping records and the assumptions listed. Not a tax return.',
    });
    const staffPut = await request('PUT', `${API}/firm-settings`, staffToken, { safeHarborDefault: 'prior_year' });
    expect(staffPut.status).toBe(403);
    expect(staffPut.json.error.code).toBe('TE_FIRM_ADMIN_REQUIRED');
    expect((await request('PUT', `${API}/firm-settings`, readonlyToken, { portalShows: 'snapshot' })).json.error.code).toBe('TE_NOT_FIRM_STAFF');

    const put = await request('PUT', `${API}/firm-settings`, adminToken, { safeHarborDefault: 'prior_year', disclaimerText: 'Custom words.', portalShows: 'snapshot' });
    expect(put.status).toBe(200);
    expect(put.json.data).toMatchObject({ safeHarborDefault: 'prior_year', effectiveDisclaimerText: 'Custom words.', portalShows: 'snapshot' });
    // Partial update keeps the rest; empty disclaimer restores the shipped text.
    const reset = await request('PUT', `${API}/firm-settings`, adminToken, { disclaimerText: '' });
    expect(reset.json.data).toMatchObject({ safeHarborDefault: 'prior_year', disclaimerText: null });
    expect(reset.json.data.effectiveDisclaimerText).toContain('Not a tax return');
    // The firm default now drives a taxpayer's resolved rule.
    const tp = await mkTaxpayer();
    expect((await request('GET', yr(tp), staffToken)).json.data.effectiveSafeHarborRule).toBe('prior_year');
    // Firm B is unaffected.
    expect((await request('GET', `${API}/firm-settings`, firmBToken)).json.data.safeHarborDefault).toBe('lesser_of');
  });
});

describe('isolation', () => {
  it('another firm gets 404 on every taxpayer-, scenario- and adjustment-scoped endpoint; nothing leaks', async () => {
    const tp = await mkTaxpayer();
    await setUpYear(tp, { priorYearTax: '31500' });
    const base = (await request('GET', yr(tp), staffToken)).json.data.scenarios[0].id as string;
    const adj = await request('POST', `${API}/scenarios/${base}/adjustments`, staffToken, await adjBody());
    const adjId = adj.json.data.id as string;
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `${BASE}/${tp}/years`], ['GET', yr(tp)], ['PUT', yr(tp), { rateMode: 'brackets' }],
      ['GET', `${yr(tp)}/scenarios`], ['POST', `${yr(tp)}/scenarios`, { name: 'Nope' }],
      ['PATCH', `${API}/scenarios/${base}`, { name: 'Nope' }], ['DELETE', `${API}/scenarios/${base}`],
      ['POST', `${API}/scenarios/${base}/clone`],
      ['GET', `${API}/scenarios/${base}/adjustments`], ['POST', `${API}/scenarios/${base}/adjustments`, await adjBody()],
      ['PATCH', `${API}/adjustments/${adjId}`, { amount: 1 }], ['DELETE', `${API}/adjustments/${adjId}`],
      ['GET', `${API}/scenarios/${base}/state-rows`],
      ['PUT', `${API}/scenarios/${base}/state-rows`, { rows: [{ residency: 'resident', state: 'mo', effectiveRate: 0.04 }] }],
    ];
    for (const [m, p, b] of calls) {
      const r = await request(m, p, firmBToken, b);
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(JSON.stringify(r.json)).not.toContain('31500');
    }
    // Firm A's data is untouched.
    expect((await request('GET', `${API}/scenarios/${base}/adjustments`, staffToken)).json.total).toBe(1);
    expect((await request('GET', yr(tp), staffToken)).json.data.year.priorYearTax).toBe('31500');
  });

  it('firm-id / tenant ids in a body are ignored; read-only users cannot mutate; client users get 404', async () => {
    const tp = await mkTaxpayer();
    const base = await baseScenario(tp);
    await request('PUT', `${API}/firm-settings`, adminToken, { safeHarborDefault: 'current_year', firmId: ids.firmB });
    expect((await request('GET', `${API}/firm-settings`, firmBToken)).json.data.safeHarborDefault).toBe('lesser_of');

    const ro: Array<[string, string, unknown?]> = [
      ['PUT', yr(tp), {}], ['POST', `${yr(tp)}/scenarios`, { name: 'x' }], ['PATCH', `${API}/scenarios/${base}`, { name: 'x' }],
      ['DELETE', `${API}/scenarios/${base}`], ['POST', `${API}/scenarios/${base}/clone`],
      ['POST', `${API}/scenarios/${base}/adjustments`, await adjBody()], ['PUT', `${API}/scenarios/${base}/state-rows`, { rows: [] }],
      ['POST', `${API}/adjustment-types`, { name: 'x', kind: 'income' }],
    ];
    for (const [m, p, b] of ro) expect((await request(m, p, readonlyToken, b)).status, `${m} ${p}`).toBe(403);
    // Read-only can still read.
    expect((await request('GET', yr(tp), readonlyToken)).status).toBe(200);

    for (const p of [yr(tp), `${API}/adjustment-types`, `${API}/firm-settings`, `${API}/scenarios/${base}/adjustments`]) {
      expect((await request('GET', p, clientUserToken)).status, p).toBe(404);
    }
    expect((await request('GET', yr(tp))).status).toBe(401);
  });
});
