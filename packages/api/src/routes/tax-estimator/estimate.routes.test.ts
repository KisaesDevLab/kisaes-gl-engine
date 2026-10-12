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
  taxEstTaxpayers, taxEstYears, taxEstFirmSettings, taxEstAdjustmentTypes, accounts,
} from '../../db/schema/index.js';
import { taxEstimatorRouter } from '../tax-estimator.routes.js';
import { syncShippedSeeds } from '../../services/tax-estimator/tax-parameters.service.js';
import { syncShippedStateRules } from '../../services/tax-estimator/tax-state-rules.service.js';
import { closeTbRedis } from '../../services/tb/tb-redis.js';
import { errorHandler } from '../../middleware/error-handler.js';

// Phase 10b route tests (estimate, readiness, payment ledger, Schedule AI snapshots, the new
// year / state-row inputs) (MODULE.md D1, D9). Fixture = the Phase 0 harness:
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

describe('POST .../estimate and GET .../readiness', () => {
  it('computes a live estimate for firm staff and read-only members; the second call is cached', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    const a = await request('POST', est(tp, sid), staffToken, { throughMonth: '2026-09', refresh: true });
    expect(a.status).toBe(200);
    expect(a.json.data.federal.federalTotal).toBe('0');
    expect(a.json.data.entities.map((e: { companyId: string }) => e.companyId)).toEqual([ids.c2]);
    expect(a.json.data.federalEstimates.jurisdiction).toBe('federal');
    const b = await request('POST', est(tp, sid), staffToken, { throughMonth: '2026-09' });
    expect(b.status).toBe(200);
    expect(b.json.data.cached).toBe(true);
    // The read-only member reaches only the practice tenant: the T2 company is out of THEIR scope (D1).
    const ro = await request('POST', est(tp, sid), readonlyToken, { throughMonth: '2026-09' });
    expect(ro.status).toBe(200);
    expect(ro.json.data.cached).toBe(false);
    expect(ro.json.data.entities).toEqual([]);
    const rd = await request('GET', `${yr(tp)}/readiness`, staffToken);
    expect(rd.status).toBe(200);
    expect(rd.json.data.entities).toHaveLength(1);
    expect(rd.json.data.entities[0].inScope).toBe(true);
    expect(rd.json.data.schAiPeriods).toHaveLength(3);
  });

  it('404s another firm, a client user, a scenario of another taxpayer, and rejects unknown body keys', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    expect((await request('POST', est(tp, sid), firmBToken, {})).status).toBe(404);
    expect((await request('GET', `${yr(tp)}/readiness`, firmBToken)).status).toBe(404);
    expect((await request('POST', est(tp, sid), clientUserToken, {})).status).toBe(404);
    const tp2 = await mkTaxpayer();
    const sid2 = await baseScenario(tp2);
    const cross = await request('POST', est(tp, sid2), staffToken, {});
    expect(cross.status).toBe(404);
    expect(cross.json.error?.code ?? cross.json.code).toBe('TE_SCENARIO_NOT_FOUND');
    expect((await request('POST', est(tp, sid), staffToken, { tenantIds: [ids.t4] })).status).toBe(400);
  });

  it('a link into a tenant the caller can no longer reach is left out with TE_TENANT_NOT_MANAGED', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    await db.update(userTenantAccess).set({ isActive: false }).where(eq(userTenantAccess.tenantId, ids.t2));
    const r = await request('POST', est(tp, sid), staffToken, { throughMonth: '2026-09', refresh: true });
    expect(r.status).toBe(200);
    expect(r.json.data.entities).toEqual([]);
    expect(r.json.data.warnings.map((w: { code: string }) => w.code)).toContain('TE_TENANT_NOT_MANAGED');
    expect(JSON.stringify(r.json.data)).not.toContain('Reachable Co');
  });
});

describe('payment ledger routes', () => {
  it('CRUD with audit; readonly may read but not write; firm B gets 404', async () => {
    const tp = await mkTaxpayer();
    await baseScenario(tp);
    const created = await request('POST', `${yr(tp)}/payments`, staffToken, { jurisdiction: 'federal', date: '2026-04-15', amount: '6600', memo: 'Q1' });
    expect(created.status).toBe(201);
    const pid = created.json.data.id as string;
    expect(created.json.data).toMatchObject({ source: 'manual', jurisdiction: 'federal', date: '2026-04-15', stored: true });
    const mo = await request('POST', `${yr(tp)}/payments`, staffToken, { jurisdiction: 'mo', date: '2026-04-15', amount: 1208 });
    expect(mo.status).toBe(201);
    expect(mo.json.data.jurisdiction).toBe('MO');
    const list = await request('GET', `${yr(tp)}/payments?limit=1`, readonlyToken);
    expect(list.status).toBe(200);
    expect(list.json.data.total).toBe(2);
    expect(list.json.data.payments).toHaveLength(1);
    expect(list.json.data.totals).toMatchObject({ federal: '6600.0000', MO: '1208.0000' });
    expect((await request('POST', `${yr(tp)}/payments`, readonlyToken, { jurisdiction: 'federal', date: '2026-04-15', amount: 1 })).status).toBe(403);
    expect((await request('PATCH', `${API}/payments/${pid}`, readonlyToken, { amount: 1 })).status).toBe(403);
    expect((await request('GET', `${yr(tp)}/payments`, firmBToken)).status).toBe(404);
    expect((await request('PATCH', `${API}/payments/${pid}`, firmBToken, { amount: 1 })).status).toBe(404);
    expect((await request('DELETE', `${API}/payments/${pid}`, firmBToken)).status).toBe(404);
    const patched = await request('PATCH', `${API}/payments/${pid}`, staffToken, { amount: '6500.50' });
    expect(patched.status).toBe(200);
    expect(patched.json.data.amount).toBe('6500.5000');
    expect((await request('DELETE', `${API}/payments/${pid}`, staffToken)).status).toBe(204);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, ids.t1), eq(auditLog.entityType, 'tax_est_payment')));
    expect(audits.map((a) => a.action).sort()).toEqual(['create', 'create', 'delete', 'update']);
  });

  it('validates: a date is required (except a prior-year overpayment), GL rows need a reachable tenant + real transaction', async () => {
    const tp = await mkTaxpayer();
    await baseScenario(tp);
    expect((await request('POST', `${yr(tp)}/payments`, staffToken, { jurisdiction: 'federal', amount: 100 })).status).toBe(400);
    const op = await request('POST', `${yr(tp)}/payments`, staffToken, { jurisdiction: 'federal', amount: 700, source: 'prior_year_overpayment' });
    expect(op.status).toBe(201);
    expect(op.json.data.date).toBeNull();
    const unreachable = await request('POST', `${yr(tp)}/payments`, staffToken, { jurisdiction: 'federal', date: '2026-04-15', amount: 1, source: 'gl', tenantId: ids.t3, transactionId: '00000000-0000-0000-0000-000000000001' });
    expect(unreachable.status).toBe(404);
    expect(unreachable.json.error?.code ?? unreachable.json.code).toBe('TE_TENANT_NOT_MANAGED');
    const missingTxn = await request('POST', `${yr(tp)}/payments`, staffToken, { jurisdiction: 'federal', date: '2026-04-15', amount: 1, source: 'gl', tenantId: ids.t2, transactionId: '00000000-0000-0000-0000-000000000001' });
    expect(missingTxn.status).toBe(404);
    expect(missingTxn.json.error?.code ?? missingTxn.json.code).toBe('TE_TRANSACTION_NOT_FOUND');
    expect((await request('POST', `${yr(tp)}/payments`, staffToken, { jurisdiction: 'XYZ', date: '2026-04-15', amount: 1 })).status).toBe(400);
  });
});

describe('Schedule AI snapshot routes', () => {
  it('lists (any member) and captures (staff only; nothing for an unreached period)', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    await baseScenario(tp);
    const list = await request('GET', `${yr(tp)}/sch-ai-snapshots`, readonlyToken);
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(0);
    expect((await request('POST', `${yr(tp)}/sch-ai-snapshots`, readonlyToken, {})).status).toBe(403);
    expect((await request('POST', `${yr(tp)}/sch-ai-snapshots`, firmBToken, {})).status).toBe(404);
    const future = await request('POST', `${yr(tp, 2099)}/sch-ai-snapshots`, staffToken, { periodIndex: 0 });
    expect(future.status).toBe(422);
    const cap = await request('POST', `${yr(tp)}/sch-ai-snapshots`, staffToken, { periodIndex: 0 });
    expect(cap.status).toBe(200);
    expect(cap.json.data.captured.map((s: { periodEnd: string; companyId: string }) => [s.periodEnd, s.companyId])).toEqual([['2026-03-31', ids.c2]]);
  });
});

describe('Phase 10b inputs on the year and state rows', () => {
  it('round-trips person inputs, MFS / NII / farmer fields on the year', async () => {
    const tp = await mkTaxpayer();
    const body = {
      personInputs: { primary: { retirementPlanType: 'solo_401k', employeeDeferral: 23500, w2Wages: 40000, w2SocialSecurityWages: 41000 } },
      mfsLivedApartAllYear: true, niiAllocableDeductions: '1250.50', isFisherman: true,
      farmerGross: { current: { primary: { farming: 90000, fishing: 0, totalGross: 120000 } } },
    };
    const d = await setUpYear(tp, body);
    expect(d.year).toMatchObject({ ...body, niiAllocableDeductions: '1250.5000' });
    expect((await request('PUT', yr(tp), staffToken, { personInputs: { primary: { retirementPlanType: 'ira' } } })).status).toBe(400);
  });

  it('state rows keep gate inputs and write-only prior-year state tax / AGI (D9): omitted keeps, null clears, never returned or audited', async () => {
    const tp = await mkTaxpayer();
    const sid = await baseScenario(tp);
    const put = (rows: unknown[]) => request('PUT', `${API}/scenarios/${sid}/state-rows`, staffToken, { rows });
    const r1 = await put([{ residency: 'resident', state: 'MO', effectiveRate: 0.04, withholding: '2000', otherCredits: '50', grossIncome: '210000', priorYearTax: '7050', priorYearAgi: '182000' }]);
    expect(r1.status).toBe(200);
    expect(r1.json.data[0]).toMatchObject({ withholding: '2000.0000', otherCredits: '50.0000', grossIncome: '210000.0000', priorYearTaxPresent: true, priorYearAgiPresent: true });
    expect(JSON.stringify(r1.json.data)).not.toContain('7050');
    // The Phase 5 UI sends rows without the new fields: everything saved for MO is kept.
    const r2 = await put([{ residency: 'resident', state: 'MO', effectiveRate: 0.045 }]);
    expect(r2.json.data[0]).toMatchObject({ effectiveRate: 0.045, withholding: '2000.0000', priorYearTaxPresent: true });
    const r3 = await put([{ residency: 'resident', state: 'MO', effectiveRate: 0.045, priorYearTax: null, withholding: null }]);
    expect(r3.json.data[0]).toMatchObject({ withholding: null, priorYearTaxPresent: false, priorYearAgiPresent: true });
    const [row] = await db.execute<{ t: string | null; a: string | null }>(sql`SELECT prior_year_tax_encrypted AS t, prior_year_agi_encrypted AS a FROM tax_est_state_rows WHERE scenario_id = ${sid}`).then((x) => x.rows);
    expect(row!.t).toBeNull();
    expect(row!.a).not.toContain('182000'); // ciphertext at rest
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, ids.t1), eq(auditLog.entityType, 'tax_est_state_rows')));
    expect(JSON.stringify(audits)).not.toContain('7050');
    expect(JSON.stringify(audits)).not.toContain('182000');
    // The credential re-encryption sweep discovers the new *_encrypted columns.
    const cols = await db.execute<{ column_name: string }>(sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'tax_est_state_rows' AND column_name LIKE '%\_encrypted'`);
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual(['prior_year_agi_encrypted', 'prior_year_tax_encrypted']);
  });
});

describe('Phase 12 snapshot routes', () => {
  it('finalize (staff), history (any member), read-only view and compare; PUT / PATCH / DELETE are 409 TE_SNAPSHOT_IMMUTABLE', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    const fin = `${yr(tp)}/scenarios/${sid}/snapshots`;
    expect((await request('POST', fin, readonlyToken, {})).status).toBe(403);
    expect((await request('POST', fin, staffToken, { reason: 'nope' })).status).toBe(400);
    const created = await request('POST', fin, staffToken, { throughMonth: '2026-09', note: 'Q3' });
    expect(created.status).toBe(201);
    const snap = created.json.data;
    expect(snap).toMatchObject({ reason: 'finalize', note: 'Q3', accessible: true, scenarioId: sid });
    expect(snap.payload.assumptions.sections).toHaveLength(11);
    expect(snap.payload.disclaimerText).toBe('Projection based on bookkeeping records and the assumptions listed. Not a tax return.');

    const list = await request('GET', `${yr(tp)}/snapshots?limit=10`, staffToken);
    expect(list.status).toBe(200);
    expect(list.json.total).toBe(1);
    expect(list.json.data[0].id).toBe(snap.id);
    const view = await request('GET', `${API}/snapshots/${snap.id}`, staffToken);
    expect(view.status).toBe(200);
    expect(view.json.data.payloadSha256).toBe(snap.payloadSha256);
    const cmp = await request('GET', `${API}/snapshots/${snap.id}/compare`, staffToken);
    expect(cmp.status).toBe(200);
    expect(cmp.json.data.summary.snapshot).toEqual(snap.summary);

    for (const m of ['PUT', 'PATCH', 'DELETE']) {
      const r = await request(m, `${API}/snapshots/${snap.id}`, staffToken, m === 'DELETE' ? undefined : { note: 'x' });
      expect(r.status).toBe(409);
      expect(r.json.error?.code ?? r.json.code).toBe('TE_SNAPSHOT_IMMUTABLE');
    }
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, ids.t1), eq(auditLog.entityType, 'tax_est_snapshot')));
    expect(audits.map((a) => a.action)).toEqual(['create']);
  });

  it('cross-firm and client isolation: firm B and a client user get 404 on every snapshot route', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    const created = await request('POST', `${yr(tp)}/scenarios/${sid}/snapshots`, staffToken, { throughMonth: '2026-09' });
    expect(created.status).toBe(201);
    const id = created.json.data.id as string;
    for (const token of [firmBToken, clientUserToken]) {
      expect((await request('GET', `${API}/snapshots/${id}`, token)).status).toBe(404);
      expect((await request('GET', `${API}/snapshots/${id}/compare`, token)).status).toBe(404);
      expect((await request('GET', `${yr(tp)}/snapshots`, token)).status).toBe(404);
      expect((await request('POST', `${yr(tp)}/scenarios/${sid}/snapshots`, token, {})).status).toBe(404);
    }
    // The read-only member cannot reach the T2 company in the snapshot (D1): row without figures, view 404.
    const ro = await request('GET', `${yr(tp)}/snapshots`, readonlyToken);
    expect(ro.status).toBe(200);
    expect(ro.json.data[0]).toMatchObject({ id, accessible: false, summary: null });
    const roView = await request('GET', `${API}/snapshots/${id}`, readonlyToken);
    expect(roView.status).toBe(404);
    expect(roView.json.error?.code ?? roView.json.code).toBe('TE_TENANT_NOT_MANAGED');
  });

  it('the firm disclaimer and portal default set on the firm-settings route flow into the estimate and the next snapshot', async () => {
    const tp = await mkTaxpayer();
    await mkPersonAndLink(tp);
    const sid = await baseScenario(tp);
    expect((await request('PUT', `${API}/firm-settings`, adminToken, { disclaimerText: 'Firm A words.', portalShows: 'snapshot', safeHarborDefault: 'current_year' })).status).toBe(200);
    const e = await request('POST', est(tp, sid), staffToken, { throughMonth: '2026-09', refresh: true });
    expect(e.json.data).toMatchObject({ disclaimerText: 'Firm A words.', portalShows: 'snapshot', firmSafeHarborDefault: 'current_year', safeHarborRule: 'current_year', safeHarborRuleSource: 'firm_default' });
    expect(e.json.data.assumptions.disclaimerText).toBe('Firm A words.');
    const s = await request('POST', `${yr(tp)}/scenarios/${sid}/snapshots`, staffToken, { throughMonth: '2026-09' });
    expect(s.json.data.payload.disclaimerText).toBe('Firm A words.');
    expect(s.json.data.payload.firmSettings).toMatchObject({ portalShows: 'snapshot', safeHarborDefault: 'current_year' });
    // Firm B's estimate is untouched by firm A's settings.
    const fb = await request('GET', `${API}/firm-settings`, firmBToken);
    expect(fb.json.data.effectiveDisclaimerText).not.toBe('Firm A words.');
  });
});

afterAll(async () => { await closeTbRedis(); });
