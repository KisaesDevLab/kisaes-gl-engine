// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// D18 (Kurt, 2026-10-12; OPEN-QUESTIONS.md Q43) — a NON-EMPTY taxpayer staff list REPLACES
// the firm's linked-tenant rule for that taxpayer, and a listed user reads that taxpayer
// with the firm's full managed set of its linked tenants ("full data"), HTTP level.
//
// Fixture (Rivera household, firm A, links into T.schc / T.scorp / T.lp; practice tenant P
// with the flag ON is every staff user's ACTIVE tenant):
//   admin     firm_admin,    access {P}          → Q54: on every non-empty list as its manager, so it
//                                                  gets D18 full data like listed staff
//   admin2    firm_admin,    access {P}          → Q54: the manager of a list that leaves `admin` out
//   super     super admin (X-Firm-Id)            → bypass, full managed set
//   listed    firm_staff,    access {P}          → on the list, reaches NO linked tenant
//   listedLp  firm_staff,    access {P, lp}      → on the list, reaches lp only
//   ro        firm_readonly, access {P}          → on the list (read-only role)
//   all       firm_staff,    access {P, schc}    → NOT on the list, reaches schc
//   fb        firm B staff,  access {other, schc}

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import {
  auditLog, firms, firmUsers, taxEstFirmSettings, taxEstLinks, taxEstTaxpayers, taxEstTaxpayerStaff,
  tenantFeatureFlags, tenantFirmAssignments, userTenantAccess, users,
} from '../../db/schema/index.js';
import { taxEstAdjustments } from '../../db/schema/tax-estimator-years.js';
import { taxEstSnapshots } from '../../db/schema/tax-estimator-estimate.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { closeTbRedis } from '../../services/tb/tb-redis.js';
import { mkTenant, purgeTenants } from '../../services/tax-estimator/entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from '../../services/tax-estimator/rivera.test-fixtures.js';
import { REPORT_PACK_DOCUMENT_RENDERERS, type DocumentSectionContext } from '../../services/report-pack-documents.js';
import { resolvePackScope } from '../../services/tax-estimator/estimate-documents.service.js';
import { resolveScope, scopeForTaxpayer } from '../../services/tax-estimator/firm-scope.service.js';
import * as authService from '../../services/auth.service.js';
import { taxEstimatorRouter } from '../tax-estimator.routes.js';
import { reportsRouter } from '../reports.routes.js';

const FIRM_A = randomUUID();
const FIRM_B = randomUUID();
const SEED_USER = randomUUID();
const TE = '/api/v1/tax-estimator';
let fx: RiveraFixture;
let server: Server | null = null;
let port = 0;
let P = '';
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
let adjustmentId = '';
let paymentId = '';
let superSnapshotId = '';

type Res = { status: number; json: any; headers: http.IncomingHttpHeaders };

async function mkUser(key: string, activeTenant: string, opts: {
  firm?: string; firmRole?: 'firm_admin' | 'firm_staff' | 'firm_readonly'; access?: string[]; superAdmin?: boolean;
} = {}) {
  const [u] = await db.insert(users).values({
    tenantId: activeTenant, email: `te-d18-${key}-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash: await bcrypt.hash('x-secret-12345', 4), displayName: key, role: 'accountant', userType: 'staff',
    isSuperAdmin: opts.superAdmin === true,
  }).returning();
  uid[key] = u!.id;
  if (opts.firm) await db.insert(firmUsers).values({ firmId: opts.firm, userId: u!.id, firmRole: opts.firmRole ?? 'firm_staff' });
  for (const t of opts.access ?? []) await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: t, role: 'accountant' });
  tokens[key] = jwt.sign({ userId: u!.id, tenantId: activeTenant, role: 'accountant', isSuperAdmin: opts.superAdmin === true }, process.env['JWT_SECRET']!, { expiresIn: '30m' });
}

function tokenIn(key: string, tenantId: string) {
  tokens[`${key}@${tenantId}`] = jwt.sign({ userId: uid[key]!, tenantId, role: 'accountant', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '30m' });
  return `${key}@${tenantId}`;
}

function call(method: string, path: string, key: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens[key]}`, ...(key === 'super' ? { 'X-Firm-Id': FIRM_A } : {}), ...extra,
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}),
    };
    const r = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json: unknown = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Q54: a non-empty list must name a firm admin (or super admin); `admin` is added unless `raw`.
const setStaff = (keys: string[], raw = false) => call('PUT', `${TE}/taxpayers/${fx.taxpayerId}/staff`, 'admin', {
  userIds: (raw || keys.length === 0 ? keys : ['admin', ...keys]).map((k) => uid[k]!),
});
const setSwitch = (on: boolean) => call('PUT', `${TE}/firm-settings`, 'admin', { restrictTaxpayersToLinkedTenants: on });
const listIds = async (key: string) => {
  const r = await call('GET', `${TE}/taxpayers?limit=50`, key);
  expect(r.status, key).toBe(200);
  return (r.json.data as Array<{ id: string }>).map((t) => t.id);
};
const sc = () => `${TE}/taxpayers/${fx.taxpayerId}/years/2026/scenarios/${fx.baseScenarioId}`;
const estimate = async (key: string, body: Record<string, unknown> = { throughMonth: '2026-09' }) => {
  const r = await call('POST', `${sc()}/estimate`, key, body);
  expect(r.status, `${key} ${JSON.stringify(r.json)}`).toBe(200);
  return r.json.data as { entities: Array<{ tenantId: string; companyId: string; path: string }>; warnings: Array<{ code: string }>; summary: { total: string }; inputsHash: string; cached: boolean; elevatedAccess?: boolean };
};
const companies = (e: { entities: Array<{ companyId: string }> }) => e.entities.map((x) => x.companyId).sort();

beforeAll(async () => {
  await db.insert(firms).values([
    { id: FIRM_A, name: 'D18 Firm A', slug: `te-d18-a-${FIRM_A.slice(0, 8)}` },
    { id: FIRM_B, name: 'D18 Firm B', slug: `te-d18-b-${FIRM_B.slice(0, 8)}` },
  ]);
  fx = await seedRivera(FIRM_A, FIRM_B, SEED_USER);
  P = await mkTenant('TE-D18 Practice');
  await db.insert(tenantFirmAssignments).values([
    ...[P, fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })),
    { tenantId: fx.T.other, firmId: FIRM_B },
  ]);
  for (const t of [P, fx.T.other]) await db.insert(tenantFeatureFlags).values({ tenantId: t, flagKey: 'TAX_ESTIMATOR_V1', enabled: true });

  await mkUser('admin', P, { firm: FIRM_A, firmRole: 'firm_admin', access: [P] });
  await mkUser('admin2', P, { firm: FIRM_A, firmRole: 'firm_admin', access: [P] });
  await mkUser('super', P, { superAdmin: true });
  await mkUser('listed', P, { firm: FIRM_A, access: [P] });
  await mkUser('listedLp', P, { firm: FIRM_A, access: [P, fx.T.lp] });
  await mkUser('ro', P, { firm: FIRM_A, firmRole: 'firm_readonly', access: [P] });
  await mkUser('all', P, { firm: FIRM_A, access: [P, fx.T.schc] });
  await mkUser('fb', fx.T.other, { firm: FIRM_B, access: [fx.T.other, fx.T.schc] });
  // Q54: the no-list (D17) comparisons below need the firm capability; every non-admin member
  // holds it here (a list decides regardless of it — see taxpayer-visibility-q54.routes.test.ts).
  await db.update(firmUsers).set({ capabilities: { tax_estimator_view_taxpayers: true } })
    .where(inArray(firmUsers.userId, ['listed', 'listedLp', 'ro', 'all', 'fb'].map((k) => uid[k]!)));

  const app = express();
  app.use(express.json());
  app.use(TE, taxEstimatorRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });

  const [adj] = await db.select({ id: taxEstAdjustments.id }).from(taxEstAdjustments).where(eq(taxEstAdjustments.scenarioId, fx.baseScenarioId)).limit(1);
  adjustmentId = adj!.id;
  const pay = await call('POST', `${TE}/taxpayers/${fx.taxpayerId}/years/2026/payments`, 'admin', { jurisdiction: 'federal', date: '2026-10-01', amount: '100', source: 'manual', memo: 'd18' });
  expect(pay.status, JSON.stringify(pay.json)).toBe(201);
  paymentId = pay.json.data.id;
  const snap = await call('POST', `${sc()}/snapshots`, 'super', { throughMonth: '2026-09' });
  expect(snap.status, JSON.stringify(snap.json)).toBe(201);
  superSnapshotId = snap.json.data.id;
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B]));
  await db.delete(auditLog).where(inArray(auditLog.userId, [SEED_USER, ...Object.values(uid)]));
  await db.delete(firmUsers).where(inArray(firmUsers.firmId, [FIRM_A, FIRM_B]));
  await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, [FIRM_A, FIRM_B]));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other, P]);
  await db.delete(firms).where(inArray(firms.id, [FIRM_A, FIRM_B]));
  await closeTbRedis();
  await pool.end();
});

afterEach(async () => {
  await db.delete(taxEstTaxpayerStaff).where(eq(taxEstTaxpayerStaff.firmId, FIRM_A));
  await db.delete(taxEstFirmSettings).where(eq(taxEstFirmSettings.firmId, FIRM_A)); // no row = switch ON
});

describe('D18 visibility: a non-empty list replaces the linked-tenant rule', () => {
  it('a listed user who reaches NO linked tenant sees the taxpayer (list, detail); an unlisted user who reaches one does not', async () => {
    expect(await listIds('listed')).not.toContain(fx.taxpayerId); // empty list = D17 firm rule
    expect((await setStaff(['listed', 'listedLp', 'ro'])).status).toBe(200);
    for (const key of ['listed', 'listedLp', 'ro']) {
      expect(await listIds(key), key).toContain(fx.taxpayerId);
      const d = await call('GET', `${TE}/taxpayers/${fx.taxpayerId}`, key);
      expect(d.status, key).toBe(200);
      expect(d.json.data.staffRestricted).toBe(true);
      // Q44: dependents are part of the taxpayer — readable by every listed user.
      expect((await call('GET', `${TE}/taxpayers/${fx.taxpayerId}/dependents`, key)).status, key).toBe(200);
      // Q45: outside businesses are part of the taxpayer too.
      expect((await call('GET', `${TE}/taxpayers/${fx.taxpayerId}/outside-entities?taxYear=2026`, key)).status, key).toBe(200);
    }
    expect(await listIds('all')).not.toContain(fx.taxpayerId);
    expect((await call('GET', `${TE}/taxpayers/${fx.taxpayerId}`, 'all')).status).toBe(404);
    expect((await call('GET', `${TE}/taxpayers/${fx.taxpayerId}`, 'fb')).status).toBe(404);
  });

  it('an unlisted user who reaches a linked tenant gets the uniform 404 on every taxpayer route and id-keyed route', async () => {
    expect((await setStaff(['listed'])).status).toBe(200);
    const base = `${TE}/taxpayers/${fx.taxpayerId}`;
    const probes: Array<[string, string, string, unknown?]> = [
      ['GET', base, 'TE_TAXPAYER_NOT_FOUND'], ['GET', `${base}/links?taxYear=2026`, 'TE_TAXPAYER_NOT_FOUND'],
      ['GET', `${base}/contacts`, 'TE_TAXPAYER_NOT_FOUND'], ['GET', `${base}/contact-candidates`, 'TE_TAXPAYER_NOT_FOUND'],
      ['GET', `${base}/staff`, 'TE_TAXPAYER_NOT_FOUND'], ['GET', `${base}/years`, 'TE_TAXPAYER_NOT_FOUND'],
      ['GET', `${base}/years/2026`, 'TE_TAXPAYER_NOT_FOUND'], ['GET', `${base}/years/2026/scenarios`, 'TE_TAXPAYER_NOT_FOUND'],
      ['GET', `${base}/years/2026/readiness`, 'TE_TAXPAYER_NOT_FOUND'], ['GET', `${base}/years/2026/payments`, 'TE_TAXPAYER_NOT_FOUND'],
      ['GET', `${base}/years/2026/sch-ai-snapshots`, 'TE_TAXPAYER_NOT_FOUND'], ['GET', `${base}/years/2026/snapshots`, 'TE_TAXPAYER_NOT_FOUND'],
      ['POST', `${sc()}/estimate`, 'TE_TAXPAYER_NOT_FOUND', {}], ['POST', `${sc()}/pdf`, 'TE_TAXPAYER_NOT_FOUND', {}],
      ['PATCH', base, 'TE_TAXPAYER_NOT_FOUND', { displayName: 'Hijack' }], ['DELETE', base, 'TE_TAXPAYER_NOT_FOUND'],
      ['PUT', `${base}/persons/primary`, 'TE_TAXPAYER_NOT_FOUND', { firstName: 'X', lastName: 'Y', isBlind: false }],
      ['PUT', `${base}/links`, 'TE_TAXPAYER_NOT_FOUND', { personRole: 'primary', taxYear: 2026, tenantId: fx.T.schc, companyId: fx.C.schc, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false }],
      ['POST', `${base}/years/2026/payments`, 'TE_TAXPAYER_NOT_FOUND', { jurisdiction: 'federal', date: '2026-10-02', amount: '1', source: 'manual' }],
      ['POST', `${base}/years/2026/scenarios`, 'TE_TAXPAYER_NOT_FOUND', { name: 'What if' }],
      ['POST', `${sc()}/snapshots`, 'TE_TAXPAYER_NOT_FOUND', {}],
      ['PUT', `${base}/staff`, 'TE_TAXPAYER_NOT_FOUND', { userIds: [] }],
      ['GET', `${base}/dependents`, 'TE_TAXPAYER_NOT_FOUND'], ['POST', `${base}/dependents`, 'TE_TAXPAYER_NOT_FOUND', { displayName: 'Kid', dateOfBirth: '2016-01-01', kind: 'qualifying_child' }],
      ['PUT', `${base}/dependents/00000000-0000-4000-8000-000000000001`, 'TE_TAXPAYER_NOT_FOUND', { displayName: 'Kid', dateOfBirth: '2016-01-01', kind: 'qualifying_child' }], ['DELETE', `${base}/dependents/00000000-0000-4000-8000-000000000001`, 'TE_TAXPAYER_NOT_FOUND'],
      ['GET', `${base}/outside-entities`, 'TE_TAXPAYER_NOT_FOUND'], ['POST', `${base}/outside-entities`, 'TE_TAXPAYER_NOT_FOUND', { name: 'K-1 LP', entityType: 'partnership', personRole: 'primary' }],
      ['PUT', `${base}/outside-entities/00000000-0000-4000-8000-000000000001`, 'TE_TAXPAYER_NOT_FOUND', { name: 'K-1 LP', entityType: 'partnership', personRole: 'primary' }], ['DELETE', `${base}/outside-entities/00000000-0000-4000-8000-000000000001`, 'TE_TAXPAYER_NOT_FOUND'],
      ['PUT', `${base}/outside-entities/00000000-0000-4000-8000-000000000001/years/2026`, 'TE_TAXPAYER_NOT_FOUND', { entryMode: 'full_year', amountBasis: 'owner_share', amounts: { ordinary: 1000 } }], ['DELETE', `${base}/outside-entities/00000000-0000-4000-8000-000000000001/years/2026`, 'TE_TAXPAYER_NOT_FOUND'],
      ['GET', `${TE}/scenarios/${fx.baseScenarioId}/adjustments`, 'TE_SCENARIO_NOT_FOUND'],
      ['GET', `${TE}/scenarios/${fx.baseScenarioId}/state-rows`, 'TE_SCENARIO_NOT_FOUND'],
      ['PATCH', `${TE}/scenarios/${fx.baseScenarioId}`, 'TE_SCENARIO_NOT_FOUND', { name: 'Renamed' }],
      ['POST', `${TE}/scenarios/${fx.baseScenarioId}/clone`, 'TE_SCENARIO_NOT_FOUND', { name: 'Clone' }],
      ['PATCH', `${TE}/adjustments/${adjustmentId}`, 'TE_ADJUSTMENT_NOT_FOUND', { label: 'x' }],
      ['DELETE', `${TE}/adjustments/${adjustmentId}`, 'TE_ADJUSTMENT_NOT_FOUND'],
      ['PATCH', `${TE}/payments/${paymentId}`, 'TE_PAYMENT_NOT_FOUND', { memo: 'x' }],
      ['DELETE', `${TE}/payments/${paymentId}`, 'TE_PAYMENT_NOT_FOUND'],
      ['GET', `${TE}/snapshots/${superSnapshotId}`, 'TE_SNAPSHOT_NOT_FOUND'],
      ['GET', `${TE}/snapshots/${superSnapshotId}/compare`, 'TE_SNAPSHOT_NOT_FOUND'],
      ['GET', `${TE}/snapshots/${superSnapshotId}/pdf`, 'TE_SNAPSHOT_NOT_FOUND'],
    ];
    for (const [method, path, code, body] of probes) {
      const r = await call(method, path, 'all', body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json?.error?.code, `${method} ${path}`).toBe(code);
    }
  }, 120_000);

  it('switch OFF + list: the list still decides (members in, everyone else out)', async () => {
    expect((await setSwitch(false)).status).toBe(200);
    expect((await setStaff(['listed'])).status).toBe(200);
    expect(await listIds('listed')).toContain(fx.taxpayerId);
    expect((await call('GET', `${TE}/taxpayers/${fx.taxpayerId}`, 'all')).status).toBe(404);
    const e = await estimate('listed');
    expect(companies(e)).toEqual([fx.C.schc, fx.C.scorp, fx.C.lp].sort());
    expect(e.elevatedAccess).toBe(true);
  }, 180_000);
});

describe('D18 full data for a listed user', () => {
  it('the estimate includes the companies in tenants the listed user cannot reach, with no TE_TENANT_NOT_MANAGED, matching a super admin\'s', async () => {
    const full = await estimate('super');
    expect(companies(full)).toEqual([fx.C.schc, fx.C.scorp, fx.C.lp].sort());
    expect(full.elevatedAccess ?? false).toBe(false);
    expect((await setStaff(['listed', 'listedLp', 'ro'])).status).toBe(200);
    for (const key of ['listed', 'listedLp', 'ro']) {
      const e = await estimate(key);
      expect(companies(e), key).toEqual(companies(full));
      expect(e.warnings.map((w) => w.code), key).not.toContain('TE_TENANT_NOT_MANAGED');
      expect(e.summary.total, key).toBe(full.summary.total);
      expect(e.elevatedAccess, key).toBe(true);
    }
  }, 240_000);

  it('detail, links, readiness, payment ledger and Schedule AI list are the full view', async () => {
    expect((await setStaff(['listed'])).status).toBe(200);
    const base = `${TE}/taxpayers/${fx.taxpayerId}`;
    const d = await call('GET', base, 'listed');
    expect(d.json.data.elevatedAccess).toBe(true);
    const links = await call('GET', `${base}/links?taxYear=2026`, 'listed');
    expect(links.status).toBe(200);
    for (const l of links.json.data as Array<{ outOfScope: boolean; companyName: string | null; viaStaffList?: boolean }>) {
      expect(l.outOfScope).toBe(false);
      expect(l.companyName).not.toBeNull();
      expect(l.viaStaffList).toBe(true); // `listed` reaches none of the linked tenants itself
    }
    const rd = await call('GET', `${base}/years/2026/readiness?throughMonth=2026-09`, 'listed');
    expect(rd.status, JSON.stringify(rd.json)).toBe(200);
    expect(rd.json.data.outOfScopeLinks).toBe(0);
    expect((rd.json.data.entities as Array<{ inScope: boolean }>).every((x) => x.inScope)).toBe(true);
    const ledger = await call('GET', `${base}/years/2026/payments`, 'listed');
    expect(ledger.status).toBe(200);
    expect((ledger.json.data.warnings as Array<{ code: string }>).map((w) => w.code)).not.toContain('TE_TENANT_NOT_MANAGED');
    expect((ledger.json.data.payments as Array<{ source: string }>).some((p) => p.source === 'gl')).toBe(true);
    expect((await call('GET', `${base}/years/2026/sch-ai-snapshots`, 'listed')).status).toBe(200);
  }, 180_000);

  it('cache separation: elevated and non-elevated results never mix', async () => {
    // listedLp reaches lp only. Non-elevated first (empty list → D17 partial view: lp only).
    const partial1 = await estimate('listedLp');
    expect(companies(partial1)).toEqual([fx.C.lp]);
    expect(partial1.elevatedAccess ?? false).toBe(false);
    expect((await setStaff(['listedLp'])).status).toBe(200);
    const elevated = await estimate('listedLp');
    expect(companies(elevated)).toEqual([fx.C.schc, fx.C.scorp, fx.C.lp].sort());
    expect(elevated.inputsHash).not.toBe(partial1.inputsHash);
    const elevated2 = await estimate('listedLp');
    expect(elevated2.cached).toBe(true);
    expect(elevated2.elevatedAccess).toBe(true);
    expect((await setStaff([])).status).toBe(200);
    const partial2 = await estimate('listedLp');
    expect(companies(partial2)).toEqual([fx.C.lp]);
    expect(partial2.elevatedAccess ?? false).toBe(false);
    expect(partial2.inputsHash).toBe(partial1.inputsHash);
  }, 240_000);

  // Q54 (Kurt, 2026-10-13) restates the pre-Q54 "firm admins are unaffected" expectation: firm
  // admins are no longer a bypass, so a LISTED firm admin gets D18 full data like listed staff,
  // an UNLISTED one the uniform 404, and with no list the admin keeps its own (partial) scope.
  it('Q54: a listed firm admin gets full data (elevation); without a list the admin keeps its own scope', async () => {
    const own = await estimate('admin');
    expect(companies(own)).toEqual([]); // no list: the admin reaches P only, no elevation
    expect(own.elevatedAccess ?? false).toBe(false);
    expect((await setStaff(['listed'])).status).toBe(200); // admin is on it (manager)
    const a = await estimate('admin');
    expect(companies(a)).toEqual([fx.C.schc, fx.C.scorp, fx.C.lp].sort());
    expect(a.elevatedAccess).toBe(true);
    const s = await resolveScope(uid['admin']!, false, FIRM_A);
    expect((await scopeForTaxpayer(s, fx.taxpayerId)).elevation?.taxpayerId).toBe(fx.taxpayerId);
  }, 120_000);

  it('Q54: a firm admin NOT on the list gets the uniform 404, and saving such a list reports callerLostAccess', async () => {
    const put = await setStaff(['admin2', 'listed'], true);
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json.data.callerLostAccess).toBe(true);
    expect(put.json.data.members).toEqual([]);
    const r = await call('GET', `${TE}/taxpayers/${fx.taxpayerId}`, 'admin');
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe('TE_TAXPAYER_NOT_FOUND');
    expect((await call('GET', `${TE}/taxpayers/${fx.taxpayerId}`, 'admin2')).status).toBe(200);
    expect((await call('GET', `${TE}/taxpayers/${fx.taxpayerId}`, 'super')).status).toBe(200);
    // The unlisted admin can no longer edit the list either (it cannot see the taxpayer).
    expect((await setStaff([])).status).toBe(404);
  }, 120_000);
});

describe('D18 snapshots, PDFs and audit', () => {
  it('a listed user can finalize, view, compare and print with full data; audit rows carry elevated=true (metadata only)', async () => {
    expect((await setStaff(['listed'])).status).toBe(200);
    const created = await call('POST', `${sc()}/snapshots`, 'listed', { throughMonth: '2026-09' });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const id = created.json.data.id as string;
    expect(created.json.data.accessible).toBe(true);
    const [row] = await db.select({ tenantIds: taxEstSnapshots.tenantIds }).from(taxEstSnapshots).where(eq(taxEstSnapshots.id, id));
    expect([...row!.tenantIds].sort()).toEqual([fx.T.schc, fx.T.scorp, fx.T.lp].sort());
    for (const path of [`${TE}/snapshots/${id}`, `${TE}/snapshots/${id}/compare`, `${TE}/snapshots/${superSnapshotId}`]) {
      expect((await call('GET', path, 'listed')).status, path).toBe(200);
    }
    const hist = await call('GET', `${TE}/taxpayers/${fx.taxpayerId}/years/2026/snapshots`, 'listed');
    expect((hist.json.data as Array<{ accessible: boolean }>).every((x) => x.accessible)).toBe(true);
    const reprint = await call('GET', `${TE}/snapshots/${superSnapshotId}/pdf`, 'listed');
    expect(reprint.status).toBe(200);
    const pdf = await call('POST', `${sc()}/pdf`, 'listed', { throughMonth: '2026-09' });
    expect(pdf.status).toBe(200);

    const audits = await db.select().from(auditLog).where(and(eq(auditLog.userId, uid['listed']!), eq(auditLog.entityType, 'tax_est_snapshot')));
    const create = audits.find((r) => r.action === 'create' && r.entityId === id);
    expect((create!.afterData as Record<string, unknown>)['elevated']).toBe(true);
    const downloads = audits.filter((r) => r.action === 'download');
    expect(downloads.length).toBeGreaterThanOrEqual(2);
    for (const r of downloads) {
      const after = r.afterData as Record<string, unknown>;
      expect(after['elevated']).toBe(true);
      expect(JSON.stringify(after)).not.toMatch(/summary|federalTotal/);
    }
    // A super admin's download is not elevated (no flag).
    expect((await call('GET', `${TE}/snapshots/${superSnapshotId}/pdf`, 'super')).status).toBe(200);
    const [sup] = await db.select().from(auditLog).where(and(eq(auditLog.userId, uid['super']!), eq(auditLog.action, 'download')));
    expect((sup!.afterData as Record<string, unknown>)['elevated']).toBeUndefined();
  }, 300_000);

  it('Report Pack: choices, request-side generation and the worker re-check honour the list (and the full data)', async () => {
    expect((await setStaff(['listedLp'])).status).toBe(200);
    const pack = (key: string) => ({ 'X-Company-Id': fx.C.lp, Authorization: `Bearer ${tokens[tokenIn(key, fx.T.lp)]}` });
    const ch = await call('GET', '/api/v1/reports/tax-estimate/taxpayers', 'listedLp', undefined, pack('listedLp'));
    expect(ch.status).toBe(200);
    expect((ch.json.data as Array<{ id: string }>).map((t) => t.id)).toContain(fx.taxpayerId);
    const q = `taxpayer_id=${fx.taxpayerId}&as_of_date=2026-09-30`;
    const ok = await call('GET', `/api/v1/reports/tax-estimate?${q}`, 'listedLp', undefined, pack('listedLp'));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('application/pdf');
    const snapId = String(ok.headers['x-tax-estimate-snapshot-id'] ?? '');
    const rows = await db.select({ tenantIds: taxEstSnapshots.tenantIds, reason: taxEstSnapshots.reason }).from(taxEstSnapshots)
      .where(and(eq(taxEstSnapshots.taxpayerId, fx.taxpayerId), eq(taxEstSnapshots.reason, 'report_pack'), eq(taxEstSnapshots.createdBy, uid['listedLp']!)));
    expect(rows.length, snapId).toBeGreaterThan(0);
    expect([...rows[0]!.tenantIds].sort()).toEqual([fx.T.schc, fx.T.scorp, fx.T.lp].sort());

    const ctx = (requestedBy: string, tenantId: string, companyId: string): DocumentSectionContext => ({
      tenantId, companyId, companyName: 'x', rangeStart: '2026-07-01', rangeEnd: '2026-09-30', asOfDate: '2026-09-30',
      options: { taxpayerId: fx.taxpayerId }, allowAttachments: false, allowTransactions: false, renderHtml: async () => new Uint8Array(),
      allowTaxEstimate: true, requestedBy,
    });
    const render = REPORT_PACK_DOCUMENT_RENDERERS['tax-estimate']!;
    expect((await render(ctx(uid['listedLp']!, fx.T.lp, fx.C.lp))).byteLength).toBeGreaterThan(1000);
    await expect(render(ctx(uid['all']!, fx.T.schc, fx.C.schc))).rejects.toMatchObject({ statusCode: 404 });
    const all = await call('GET', `/api/v1/reports/tax-estimate?${q}`, 'all', undefined, { 'X-Company-Id': fx.C.schc, Authorization: `Bearer ${tokens[tokenIn('all', fx.T.schc)]}` });
    expect(all.status).toBe(404);
  }, 300_000);
});

describe('D18 boundaries: the list never grants tenant access outside the estimator reads', () => {
  const ent = (tenantId: string, companyId: string) => `${TE}/entities/${tenantId}/${companyId}`;

  it('cannot add or modify a link into a tenant the listed user cannot reach (TE_TENANT_NOT_MANAGED), nor remove one', async () => {
    expect((await setStaff(['listed'])).status).toBe(200);
    const body = { personRole: 'primary', taxYear: 2026, tenantId: fx.T.schc, companyId: fx.C.schc, profitPct: 90, lossPct: 90, isOfficer: false, activityType: 'active', activeParticipation: false };
    const up = await call('PUT', `${TE}/taxpayers/${fx.taxpayerId}/links`, 'listed', body);
    expect(up.status).toBe(404);
    expect(up.json.error.code).toBe('TE_TENANT_NOT_MANAGED');
    const [link] = await db.select({ id: taxEstLinks.id }).from(taxEstLinks).where(and(eq(taxEstLinks.taxpayerId, fx.taxpayerId), eq(taxEstLinks.tenantId, fx.T.schc)));
    const del = await call('DELETE', `${TE}/taxpayers/${fx.taxpayerId}/links/${link!.id}`, 'listed');
    expect(del.status).toBe(404);
    expect(del.json.error.code).toBe('TE_TENANT_NOT_MANAGED');
    expect(await db.select().from(taxEstLinks).where(eq(taxEstLinks.id, link!.id))).toHaveLength(1);
  });

  it('cannot read or edit that company\'s entity settings, year inputs, treatments, flags, readiness or P&L directly', async () => {
    expect((await setStaff(['listed'])).status).toBe(200);
    const e = ent(fx.T.schc, fx.C.schc);
    const probes: Array<[string, string, unknown?]> = [
      ['GET', `${e}/settings`], ['PUT', `${e}/settings`, {}],
      ['GET', `${e}/year-inputs/2026`], ['GET', `${e}/treatments`], ['PUT', `${e}/treatments`, { treatments: [{ accountId: randomUUID(), treatment: 'owner_sehi', nonRecurring: false }] }],
      ['GET', `${e}/treatment-suggestions`], ['GET', `${e}/transaction-flags?taxYear=2026`],
      ['GET', `${e}/readiness?taxYear=2026`], ['GET', `${e}/tax-basis-pl?taxYear=2026`],
    ];
    for (const [method, path, body] of probes) {
      const r = await call(method, path, 'listed', body);
      expect(r.status, `${method} ${path} ${JSON.stringify(r.json)}`).toBe(404);
      expect(r.json?.error?.code, `${method} ${path}`).toBe('TE_TENANT_NOT_MANAGED');
    }
  });

  it('cannot GL-link an adjustment or pin a payment into an unreachable tenant; the company picker and register stay on the own scope', async () => {
    expect((await setStaff(['listed'])).status).toBe(200);
    const adj = await call('PATCH', `${TE}/adjustments/${adjustmentId}`, 'listed', { glLinked: true, tenantId: fx.T.schc, companyId: fx.C.schc, accountId: randomUUID() });
    expect(adj.status, JSON.stringify(adj.json)).toBe(404);
    expect(adj.json.error.code).toBe('TE_TENANT_NOT_MANAGED');
    const pay = await call('POST', `${TE}/taxpayers/${fx.taxpayerId}/years/2026/payments`, 'listed', { jurisdiction: 'federal', date: '2026-04-15', amount: '6600', source: 'gl', tenantId: fx.T.schc, transactionId: fx.q1Txn });
    expect(pay.status, JSON.stringify(pay.json)).toBe(404);
    expect(pay.json.error.code).toBe('TE_TENANT_NOT_MANAGED');
    const opts = await call('GET', `${TE}/taxpayers/company-options?limit=100`, 'listed');
    expect(opts.status).toBe(200);
    expect((opts.json.data as Array<{ tenantId: string }>).some((o) => [fx.T.schc, fx.T.scorp, fx.T.lp].includes(o.tenantId))).toBe(false);
    const reg = await call('GET', `${TE}/register/transactions/${fx.q1Txn}`, 'listed', undefined, { 'X-Company-Id': fx.C.schc, Authorization: `Bearer ${tokens[tokenIn('listed', fx.T.schc)]}` });
    expect(reg.status).toBe(404);
    const firm = await call('GET', `${TE}/scope`, 'listed');
    expect(firm.json.data.managedTenantCount).toBe(1);
  });

  it('raw books: no tenant switch, no Report Pack scope in an unreachable tenant; other taxpayers stay hidden', async () => {
    expect((await setStaff(['listed'])).status).toBe(200);
    await expect(authService.switchTenant(uid['listed']!, fx.T.schc)).rejects.toMatchObject({ statusCode: 403 });
    await expect(resolvePackScope(fx.T.schc, uid['listed']!, false)).rejects.toMatchObject({ statusCode: 404 });
    // A second taxpayer linked into the same tenants, with no list, stays hidden from `listed`.
    const [other] = await db.insert(taxEstTaxpayers).values({ firmId: FIRM_A, displayName: 'Other Household', createdBy: uid['all']! }).returning();
    try {
      const [link] = await db.select().from(taxEstLinks).where(and(eq(taxEstLinks.taxpayerId, fx.taxpayerId), eq(taxEstLinks.tenantId, fx.T.schc)));
      const { taxEstPersons } = await import('../../db/schema/index.js');
      const [person] = await db.insert(taxEstPersons).values({ taxpayerId: other!.id, role: 'primary', firstName: 'O', lastName: 'H', sehiEligibleMonths: Array<boolean>(12).fill(true) }).returning();
      await db.insert(taxEstLinks).values({ taxpayerId: other!.id, personId: person!.id, taxYear: 2026, tenantId: fx.T.schc, companyId: link!.companyId, profitPct: '0', lossPct: '0' });
      expect((await call('GET', `${TE}/taxpayers/${other!.id}`, 'listed')).status).toBe(404);
      expect(await listIds('listed')).not.toContain(other!.id);
      // scopeForTaxpayer for the OTHER taxpayer adds nothing (not on its list).
      const s = await resolveScope(uid['listed']!, false, FIRM_A);
      expect((await scopeForTaxpayer(s, other!.id)).allowedTenantIds).toEqual(s.allowedTenantIds);
    } finally {
      await db.delete(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, other!.id));
    }
  });

  it('empty list keeps D17: the same user then reaches nothing', async () => {
    expect((await call('GET', `${TE}/taxpayers/${fx.taxpayerId}`, 'listed')).status).toBe(404);
    const s = await resolveScope(uid['listed']!, false, FIRM_A);
    expect((await scopeForTaxpayer(s, fx.taxpayerId)).elevation).toBeUndefined();
  });
});
