// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// D17 (Kurt, 2026-10-12) — taxpayer visibility controls, HTTP level.
//
// Fixture (Rivera household, firm A, links into T.schc / T.scorp / T.lp; practice tenant P
// with the flag ON is every staff user's ACTIVE tenant):
//   admin    firm_admin,    access {P}            → bypass: every firm taxpayer
//   super    super admin (X-Firm-Id)              → bypass
//   all      firm_staff,    access {P, schc}      → reaches Rivera through schc
//   partial  firm_staff,    access {P, lp}        → reaches Rivera through lp only (partial view)
//   none     firm_staff,    access {P}            → reaches no linked tenant
//   creator  firm_staff,    access {P}            → created the unlinked taxpayers
//   ro       firm_readonly, access {P, schc}
//   peer     firm_staff,    access {P, schc}      → the allow-list member in the Report Pack tests
//   fb       firm B staff,  access {other, schc}
// Taxpayers of firm A: Rivera (linked), Solo (unlinked, by creator), Ghost (unlinked, no
// creator → admins only), Departed (linked ONLY into a tenant firm A no longer manages, by
// creator → counts as unlinked).

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
  auditLog, firms, firmUsers, taxEstFirmSettings, taxEstLinks, taxEstPersons, taxEstTaxpayers, taxEstTaxpayerStaff,
  tenantFeatureFlags, tenantFirmAssignments, userTenantAccess, users,
} from '../../db/schema/index.js';
import { taxEstAdjustments } from '../../db/schema/tax-estimator-years.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { closeTbRedis } from '../../services/tb/tb-redis.js';
import { mkCompany, mkTenant, purgeTenants } from '../../services/tax-estimator/entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from '../../services/tax-estimator/rivera.test-fixtures.js';
import { REPORT_PACK_DOCUMENT_RENDERERS, type DocumentSectionContext } from '../../services/report-pack-documents.js';
import { resolvePackScope } from '../../services/tax-estimator/estimate-documents.service.js';
import { getTransactionFlag } from '../../services/tax-estimator/register-flags.service.js';
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
let gone = '';
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const tp = { rivera: '', solo: '', ghost: '', departed: '' };
let adjustmentId = '';
let paymentId = '';
let snapshotId = '';

type Res = { status: number; json: any; headers: http.IncomingHttpHeaders };

async function mkUser(key: string, activeTenant: string, opts: {
  firm?: string; firmRole?: 'firm_admin' | 'firm_staff' | 'firm_readonly'; access?: string[]; superAdmin?: boolean;
} = {}) {
  const [u] = await db.insert(users).values({
    tenantId: activeTenant, email: `te-vis-${key}-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash: await bcrypt.hash('x-secret-12345', 4), displayName: key, role: 'accountant', userType: 'staff',
    isSuperAdmin: opts.superAdmin === true,
  }).returning();
  uid[key] = u!.id;
  if (opts.firm) await db.insert(firmUsers).values({ firmId: opts.firm, userId: u!.id, firmRole: opts.firmRole ?? 'firm_staff' });
  for (const t of opts.access ?? []) await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: t, role: 'accountant' });
  tokens[key] = jwt.sign({ userId: u!.id, tenantId: activeTenant, role: 'accountant', isSuperAdmin: opts.superAdmin === true }, process.env['JWT_SECRET']!, { expiresIn: '30m' });
}

/** A second token for the same user with another ACTIVE tenant (Report Pack calls run inside the client). */
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

const listNames = async (key: string, q = 'limit=50') => {
  const r = await call('GET', `${TE}/taxpayers?${q}`, key);
  expect(r.status, key).toBe(200);
  return { names: (r.json.data as Array<{ displayName: string }>).map((t) => t.displayName).sort(), total: r.json.total as number, rows: r.json.data as Array<{ id: string; displayName: string; staffRestricted: boolean }> };
};
const setStaff = (userIds: string[], taxpayerId = tp.rivera, key = 'admin') => call('PUT', `${TE}/taxpayers/${taxpayerId}/staff`, key, { userIds });
const setSwitch = (on: boolean, key = 'admin') => call('PUT', `${TE}/firm-settings`, key, { restrictTaxpayersToLinkedTenants: on });

async function resetVisibility() {
  await db.delete(taxEstTaxpayerStaff).where(eq(taxEstTaxpayerStaff.firmId, FIRM_A));
  await db.delete(taxEstFirmSettings).where(eq(taxEstFirmSettings.firmId, FIRM_A)); // no row = switch ON
}

beforeAll(async () => {
  await db.insert(firms).values([
    { id: FIRM_A, name: 'Visibility Firm A', slug: `te-vis-a-${FIRM_A.slice(0, 8)}` },
    { id: FIRM_B, name: 'Visibility Firm B', slug: `te-vis-b-${FIRM_B.slice(0, 8)}` },
  ]);
  fx = await seedRivera(FIRM_A, FIRM_B, SEED_USER);
  P = await mkTenant('TE-VIS Practice');
  gone = await mkTenant('TE-VIS Former Client');
  const goneCo = await mkCompany(gone, 'Former Client Co');
  await db.insert(tenantFirmAssignments).values([
    ...[P, fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })),
    { tenantId: gone, firmId: FIRM_A, isActive: false },
    { tenantId: fx.T.other, firmId: FIRM_B },
  ]);
  for (const t of [P, fx.T.other]) await db.insert(tenantFeatureFlags).values({ tenantId: t, flagKey: 'TAX_ESTIMATOR_V1', enabled: true });

  await mkUser('admin', P, { firm: FIRM_A, firmRole: 'firm_admin', access: [P] });
  await mkUser('super', P, { superAdmin: true });
  await mkUser('all', P, { firm: FIRM_A, access: [P, fx.T.schc] });
  await mkUser('partial', P, { firm: FIRM_A, access: [P, fx.T.lp] });
  await mkUser('none', P, { firm: FIRM_A, access: [P] });
  await mkUser('creator', P, { firm: FIRM_A, access: [P] });
  await mkUser('ro', P, { firm: FIRM_A, firmRole: 'firm_readonly', access: [P, fx.T.schc] });
  await mkUser('peer', P, { firm: FIRM_A, access: [P, fx.T.schc] });
  await mkUser('fb', fx.T.other, { firm: FIRM_B, access: [fx.T.other, fx.T.schc] });

  const app = express();
  app.use(express.json());
  app.use(TE, taxEstimatorRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });

  tp.rivera = fx.taxpayerId;
  const solo = await call('POST', `${TE}/taxpayers`, 'creator', { displayName: 'Solo Unlinked', filingStatus: 'single' });
  expect(solo.status).toBe(201);
  tp.solo = solo.json.data.id;
  const [ghost] = await db.insert(taxEstTaxpayers).values({ firmId: FIRM_A, displayName: 'Ghost Unlinked', createdBy: null }).returning();
  tp.ghost = ghost!.id;
  const [dep] = await db.insert(taxEstTaxpayers).values({ firmId: FIRM_A, displayName: 'Departed Client', createdBy: uid['creator']! }).returning();
  tp.departed = dep!.id;
  const [person] = await db.insert(taxEstPersons).values({
    taxpayerId: tp.departed, role: 'primary', firstName: 'Dee', lastName: 'Parted', sehiEligibleMonths: Array<boolean>(12).fill(true),
  }).returning();
  await db.insert(taxEstLinks).values({ taxpayerId: tp.departed, personId: person!.id, taxYear: 2026, tenantId: gone, companyId: goneCo, profitPct: '100', lossPct: '100' });

  const [adj] = await db.select({ id: taxEstAdjustments.id }).from(taxEstAdjustments).where(eq(taxEstAdjustments.scenarioId, fx.baseScenarioId)).limit(1);
  adjustmentId = adj!.id;
  const pay = await call('POST', `${TE}/taxpayers/${tp.rivera}/years/2026/payments`, 'admin', { jurisdiction: 'federal', date: '2026-10-01', amount: '100', source: 'manual', memo: 'vis' });
  expect(pay.status, JSON.stringify(pay.json)).toBe(201);
  paymentId = pay.json.data.id;
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B])); // staff rows cascade
  await db.delete(auditLog).where(inArray(auditLog.userId, [SEED_USER, ...Object.values(uid)]));
  await db.delete(firmUsers).where(inArray(firmUsers.firmId, [FIRM_A, FIRM_B]));
  await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, [FIRM_A, FIRM_B]));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other, P, gone]);
  await db.delete(firms).where(inArray(firms.id, [FIRM_A, FIRM_B]));
  await closeTbRedis();
  await pool.end();
});

afterEach(resetVisibility);

describe('D17 linked-tenant rule (switch ON by default)', () => {
  it('the firm switch defaults ON when the firm never saved settings', async () => {
    const r = await call('GET', `${TE}/firm-settings`, 'admin');
    expect(r.status).toBe(200);
    expect(r.json.data.restrictTaxpayersToLinkedTenants).toBe(true);
  });

  it('the taxpayer list shows each actor exactly what the rule allows', async () => {
    const expected: Record<string, string[]> = {
      admin: ['Carlos & Maria Rivera', 'Departed Client', 'Ghost Unlinked', 'Solo Unlinked'],
      super: ['Carlos & Maria Rivera', 'Departed Client', 'Ghost Unlinked', 'Solo Unlinked'],
      all: ['Carlos & Maria Rivera'],
      partial: ['Carlos & Maria Rivera'],
      ro: ['Carlos & Maria Rivera'],
      none: [],
      creator: ['Departed Client', 'Solo Unlinked'],
      fb: [],
    };
    for (const [key, names] of Object.entries(expected)) {
      const got = await listNames(key);
      expect(got.names, key).toEqual(names);
      expect(got.total, key).toBe(names.length);
    }
  });

  it('pagination totals count only visible taxpayers', async () => {
    const admin = await listNames('admin', 'limit=1&offset=0');
    expect(admin.rows).toHaveLength(1);
    expect(admin.total).toBe(4);
    const creator = await listNames('creator', 'limit=1&offset=1');
    expect(creator.rows).toHaveLength(1);
    expect(creator.total).toBe(2);
    const none = await listNames('none', 'limit=1');
    expect(none.total).toBe(0);
  });

  it('every taxpayer-scoped route is 404 TE_TAXPAYER_NOT_FOUND for a taxpayer the caller cannot see', async () => {
    const base = `${TE}/taxpayers/${tp.rivera}`;
    const sc = `${base}/years/2026/scenarios/${fx.baseScenarioId}`;
    const probes: Array<[string, string, unknown?]> = [
      ['GET', base], ['GET', `${base}/links?taxYear=2026`], ['GET', `${base}/contacts`], ['GET', `${base}/contact-candidates`],
      ['GET', `${base}/staff`], ['GET', `${base}/years`], ['GET', `${base}/years/2026`], ['GET', `${base}/years/2026/scenarios`],
      ['GET', `${base}/years/2026/readiness`], ['GET', `${base}/years/2026/payments`], ['GET', `${base}/years/2026/sch-ai-snapshots`],
      ['GET', `${base}/years/2026/snapshots`], ['POST', `${sc}/estimate`, {}], ['POST', `${sc}/pdf`, {}],
      ['PATCH', base, { displayName: 'Hijack' }], ['DELETE', base],
      ['PUT', `${base}/persons/primary`, { firstName: 'X', lastName: 'Y', isBlind: false }],
      ['PUT', `${base}/links`, { personRole: 'primary', taxYear: 2026, tenantId: P, companyId: fx.C.schc, isOfficer: false, activityType: 'active', activeParticipation: false }],
      ['POST', `${base}/years/2026/payments`, { jurisdiction: 'federal', date: '2026-10-02', amount: '1', source: 'manual' }],
      ['POST', `${base}/years/2026/scenarios`, { name: 'What if' }],
      ['POST', `${sc}/snapshots`, {}],
      ['PUT', `${base}/staff`, { userIds: [] }],
    ];
    for (const [method, path, body] of probes) {
      const r = await call(method, path, 'none', body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json?.error?.code, `${method} ${path}`).toBe('TE_TAXPAYER_NOT_FOUND');
    }
    // Sanity: the same reads work for a member who reaches a linked tenant.
    for (const path of [base, `${base}/links?taxYear=2026`, `${base}/years/2026`, `${base}/staff`]) {
      expect((await call('GET', path, 'all')).status, path).toBe(200);
    }
  }, 120_000);

  it('scenario / adjustment / state-row / payment ids of a hidden taxpayer get the same 404 as another firm\'s', async () => {
    const probes: Array<[string, string, string, unknown?]> = [
      ['GET', `${TE}/scenarios/${fx.baseScenarioId}/adjustments`, 'TE_SCENARIO_NOT_FOUND'],
      ['GET', `${TE}/scenarios/${fx.baseScenarioId}/state-rows`, 'TE_SCENARIO_NOT_FOUND'],
      ['PATCH', `${TE}/scenarios/${fx.baseScenarioId}`, 'TE_SCENARIO_NOT_FOUND', { name: 'Renamed' }],
      ['POST', `${TE}/scenarios/${fx.baseScenarioId}/clone`, 'TE_SCENARIO_NOT_FOUND', { name: 'Clone' }],
      ['PATCH', `${TE}/adjustments/${adjustmentId}`, 'TE_ADJUSTMENT_NOT_FOUND', { label: 'x' }],
      ['DELETE', `${TE}/adjustments/${adjustmentId}`, 'TE_ADJUSTMENT_NOT_FOUND'],
      ['PATCH', `${TE}/payments/${paymentId}`, 'TE_PAYMENT_NOT_FOUND', { memo: 'x' }],
      ['DELETE', `${TE}/payments/${paymentId}`, 'TE_PAYMENT_NOT_FOUND'],
    ];
    for (const [method, path, code, body] of probes) {
      const r = await call(method, path, 'none', body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json?.error?.code, `${method} ${path}`).toBe(code);
    }
    expect((await call('GET', `${TE}/scenarios/${fx.baseScenarioId}/adjustments`, 'all')).status).toBe(200);
  });

  it('partial view: visible through ONE reachable linked tenant; the other links stay out of scope', async () => {
    const r = await call('GET', `${TE}/taxpayers/${tp.rivera}/links?taxYear=2026`, 'partial');
    expect(r.status).toBe(200);
    const byTenant = new Map((r.json.data as Array<{ tenantId: string; outOfScope: boolean; companyName: string | null }>).map((l) => [l.tenantId, l]));
    expect(byTenant.get(fx.T.lp)!.outOfScope).toBe(false);
    expect(byTenant.get(fx.T.schc)!.outOfScope).toBe(true);
    expect(byTenant.get(fx.T.schc)!.companyName).toBeNull();
    expect(byTenant.get(fx.T.scorp)!.outOfScope).toBe(true);
  });

  it('firm_readonly follows the same rule; firm admins and super admins see everything', async () => {
    expect((await call('GET', `${TE}/taxpayers/${tp.rivera}`, 'ro')).status).toBe(200);
    expect((await call('GET', `${TE}/taxpayers/${tp.solo}`, 'ro')).status).toBe(404);
    for (const key of ['admin', 'super']) {
      for (const id of Object.values(tp)) expect((await call('GET', `${TE}/taxpayers/${id}`, key)).status, `${key} ${id}`).toBe(200);
    }
  });

  it('unlinked taxpayer: its creator and bypass users only; no creator → bypass users only', async () => {
    expect((await call('GET', `${TE}/taxpayers/${tp.solo}`, 'creator')).status).toBe(200);
    for (const key of ['all', 'none', 'partial']) {
      const r = await call('GET', `${TE}/taxpayers/${tp.solo}`, key);
      expect(r.status, key).toBe(404);
      expect(r.json.error.code, key).toBe('TE_TAXPAYER_NOT_FOUND');
    }
    expect((await call('GET', `${TE}/taxpayers/${tp.solo}`, 'admin')).status).toBe(200);
    for (const key of ['creator', 'all', 'none']) expect((await call('GET', `${TE}/taxpayers/${tp.ghost}`, key)).status, key).toBe(404);
  });

  it('a link into a tenant the firm no longer manages is not an active link (creator keeps it, others do not)', async () => {
    expect((await call('GET', `${TE}/taxpayers/${tp.departed}`, 'creator')).status).toBe(200);
    expect((await call('GET', `${TE}/taxpayers/${tp.departed}`, 'all')).status).toBe(404);
  });

  it('once linked, the creator sees it only through a reachable tenant', async () => {
    const created = await call('POST', `${TE}/taxpayers`, 'creator', { displayName: 'Soon Linked', filingStatus: 'single' });
    const id = created.json.data.id as string;
    expect((await call('PUT', `${TE}/taxpayers/${id}/persons/primary`, 'creator', { firstName: 'Soon', lastName: 'Linked', isBlind: false })).status).toBe(200);
    // The creator cannot link into schc (not in their scope) and the admin's scope is {P}, so
    // a staff member who reaches schc links it (made its creator for the moment to see it).
    await db.update(taxEstTaxpayers).set({ createdBy: uid['all']! }).where(eq(taxEstTaxpayers.id, id)); // let `all` see it to link it
    const link = await call('PUT', `${TE}/taxpayers/${id}/links`, 'all', {
      personRole: 'primary', taxYear: 2026, tenantId: fx.T.schc, companyId: fx.C.schc, profitPct: 100, lossPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false,
    });
    expect(link.status, JSON.stringify(link.json)).toBe(200);
    await db.update(taxEstTaxpayers).set({ createdBy: uid['creator']! }).where(eq(taxEstTaxpayers.id, id));
    expect((await call('GET', `${TE}/taxpayers/${id}`, 'creator')).status).toBe(404); // linked now, and creator reaches no linked tenant
    expect((await call('GET', `${TE}/taxpayers/${id}`, 'all')).status).toBe(200);
    await db.delete(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, id));
  });

  it('another firm\'s member never sees firm A taxpayers, even reaching a linked tenant', async () => {
    const r = await call('GET', `${TE}/taxpayers/${tp.rivera}`, 'fb');
    expect(r.status).toBe(404);
  });
});

describe('D17 firm switch', () => {
  it('only firm admins (and super admins) can change it: staff and readonly get 403', async () => {
    const staff = await setSwitch(false, 'all');
    expect(staff.status).toBe(403);
    expect(staff.json.error.code).toBe('TE_FIRM_ADMIN_REQUIRED');
    expect((await setSwitch(false, 'ro')).status).toBe(403);
    const sup = await setSwitch(true, 'super');
    expect(sup.status).toBe(200);
  });

  it('OFF: every firm taxpayer is visible to staff; ON again restores the rule; each change is audited', async () => {
    const off = await setSwitch(false);
    expect(off.status).toBe(200);
    expect(off.json.data.restrictTaxpayersToLinkedTenants).toBe(false);
    expect((await listNames('none')).total).toBe(4);
    expect((await call('GET', `${TE}/taxpayers/${tp.ghost}`, 'none')).status).toBe(200);
    expect((await setSwitch(true)).status).toBe(200);
    expect((await listNames('none')).total).toBe(0);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'tax_est_visibility_switch'), eq(auditLog.entityId, FIRM_A)));
    const changes = rows.map((r) => [(r.beforeData as Record<string, boolean>)["restrictTaxpayersToLinkedTenants"], (r.afterData as Record<string, boolean>)["restrictTaxpayersToLinkedTenants"]]);
    expect(changes).toEqual(expect.arrayContaining([[true, false], [false, true]]));
    expect(rows.every((r) => r.userId === uid['admin'] && r.tenantId === P)).toBe(true);
    expect(Object.keys(rows[0]!.afterData as object).sort()).toEqual(['firmId', 'restrictTaxpayersToLinkedTenants']);
  });
});

describe('D17 per-taxpayer staff allow-list', () => {
  it('candidates: firm admins only; active firm staff / readonly holding tax_estimator', async () => {
    const r = await call('GET', `${TE}/taxpayers/${tp.rivera}/staff-candidates`, 'admin');
    expect(r.status).toBe(200);
    const ids = (r.json.data as Array<{ userId: string }>).map((c) => c.userId);
    for (const key of ['all', 'partial', 'none', 'creator', 'ro', 'peer']) expect(ids, key).toContain(uid[key]);
    for (const key of ['admin', 'super', 'fb']) expect(ids, key).not.toContain(uid[key]);
    expect(r.json.total).toBe(ids.length);
    const staff = await call('GET', `${TE}/taxpayers/${tp.rivera}/staff-candidates`, 'all');
    expect(staff.status).toBe(403);
    expect(staff.json.error.code).toBe('TE_FIRM_ADMIN_REQUIRED');
    expect((await call('GET', `${TE}/taxpayers/${tp.rivera}/staff-candidates`, 'none')).status).toBe(404);
  });

  it('non-admins cannot edit the list (403); a caller who cannot see the taxpayer gets 404', async () => {
    const staff = await setStaff([uid['all']!], tp.rivera, 'all');
    expect(staff.status).toBe(403);
    expect(staff.json.error.code).toBe('TE_FIRM_ADMIN_REQUIRED');
    expect((await setStaff([], tp.rivera, 'ro')).status).toBe(403);
    expect((await setStaff([], tp.rivera, 'none')).status).toBe(404);
    expect(await db.select().from(taxEstTaxpayerStaff).where(eq(taxEstTaxpayerStaff.taxpayerId, tp.rivera))).toHaveLength(0);
  });

  it('only eligible users can be added (422 TE_STAFF_NOT_ELIGIBLE)', async () => {
    for (const key of ['admin', 'fb']) {
      const r = await setStaff([uid[key]!]);
      expect(r.status, key).toBe(422);
      expect(r.json.error.code, key).toBe('TE_STAFF_NOT_ELIGIBLE');
    }
    expect((await setStaff([randomUUID()])).status).toBe(422);
  });

  it('a list: members see it, non-members get 404, firm admins and super admins always see it; changes audited', async () => {
    const put = await setStaff([uid['all']!]);
    expect(put.status).toBe(200);
    expect(put.json.data.members.map((m: { userId: string }) => m.userId)).toEqual([uid['all']]);
    expect(put.json.data.canEdit).toBe(true);

    const mine = await listNames('all');
    expect(mine.rows.find((t) => t.id === tp.rivera)!.staffRestricted).toBe(true);
    for (const key of ['ro', 'partial', 'peer']) {
      const r = await call('GET', `${TE}/taxpayers/${tp.rivera}`, key);
      expect(r.status, key).toBe(404);
      expect(r.json.error.code, key).toBe('TE_TAXPAYER_NOT_FOUND');
      expect((await listNames(key)).total, key).toBe(0);
    }
    for (const key of ['admin', 'super']) expect((await call('GET', `${TE}/taxpayers/${tp.rivera}`, key)).status, key).toBe(200);
    const adminList = await listNames('admin');
    expect(adminList.rows.find((t) => t.id === tp.rivera)!.staffRestricted).toBe(true);
    expect(adminList.rows.find((t) => t.id === tp.ghost)!.staffRestricted).toBe(false);
    const detail = await call('GET', `${TE}/taxpayers/${tp.rivera}`, 'all');
    expect(detail.json.data.staffRestricted).toBe(true);
    const view = await call('GET', `${TE}/taxpayers/${tp.rivera}/staff`, 'all');
    expect(view.status).toBe(200);
    expect(view.json.data.canEdit).toBe(false);
    expect(view.json.data.members[0].firmRole).toBe('firm_staff');

    const rows = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'tax_est_taxpayer_staff'), eq(auditLog.entityId, tp.rivera)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(uid['admin']);
    expect(rows[0]!.beforeData).toMatchObject({ userIds: [] });
    expect(rows[0]!.afterData).toMatchObject({ userIds: [uid['all']], added: [uid['all']], removed: [], firmId: FIRM_A });
    // An unchanged PUT writes no audit row.
    expect((await setStaff([uid['all']!])).status).toBe(200);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'tax_est_taxpayer_staff'), eq(auditLog.entityId, tp.rivera)))).toHaveLength(1);
  });

  it('the list never overrides the linked-tenant rule (switch ON); with the switch OFF it alone decides', async () => {
    expect((await setStaff([uid['none']!])).status).toBe(200);
    expect((await call('GET', `${TE}/taxpayers/${tp.rivera}`, 'none')).status).toBe(404); // member, but reaches no linked tenant
    expect((await call('GET', `${TE}/taxpayers/${tp.rivera}`, 'all')).status).toBe(404); // reaches schc, not a member
    expect((await setSwitch(false)).status).toBe(200);
    expect((await call('GET', `${TE}/taxpayers/${tp.rivera}`, 'none')).status).toBe(200);
    expect((await call('GET', `${TE}/taxpayers/${tp.rivera}`, 'all')).status).toBe(404);
  });

  it('clearing the list restores the tenant rule and is audited as a removal', async () => {
    expect((await setStaff([uid['all']!])).status).toBe(200);
    expect((await call('GET', `${TE}/taxpayers/${tp.rivera}`, 'partial')).status).toBe(404);
    const cleared = await setStaff([]);
    expect(cleared.status).toBe(200);
    expect(cleared.json.data.members).toEqual([]);
    expect((await call('GET', `${TE}/taxpayers/${tp.rivera}`, 'partial')).status).toBe(200);
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'tax_est_taxpayer_staff'), eq(auditLog.entityId, tp.rivera)));
    expect(rows.some((r) => JSON.stringify((r.afterData as { removed: string[] }).removed) === JSON.stringify([uid['all']]))).toBe(true);
  });
});

describe('D17 snapshots and PDFs', () => {
  beforeAll(async () => {
    const r = await call('POST', `${TE}/taxpayers/${tp.rivera}/years/2026/scenarios/${fx.baseScenarioId}/pdf`, 'admin', { throughMonth: '2026-09' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    snapshotId = String(r.headers['x-tax-estimate-snapshot-id']);
  }, 180_000);

  it('a hidden taxpayer\'s snapshot view, compare and re-print are the uniform 404', async () => {
    for (const path of [`${TE}/snapshots/${snapshotId}`, `${TE}/snapshots/${snapshotId}/pdf`, `${TE}/snapshots/${snapshotId}/compare`]) {
      const r = await call('GET', path, 'none');
      expect(r.status, path).toBe(404);
      expect(r.json.error.code, path).toBe('TE_SNAPSHOT_NOT_FOUND');
    }
    expect((await call('GET', `${TE}/snapshots/${snapshotId}`, 'all')).status).toBe(200);
    expect((await setStaff([uid['peer']!])).status).toBe(200);
    expect((await call('GET', `${TE}/snapshots/${snapshotId}`, 'all')).status).toBe(404);
    expect((await call('GET', `${TE}/snapshots/${snapshotId}`, 'peer')).status).toBe(200);
  }, 120_000);
});

describe('D17 Report Pack tax-estimate section', () => {
  const pack = (key: string) => ({ 'X-Company-Id': fx.C.schc, Authorization: `Bearer ${tokens[tokenIn(key, fx.T.schc)]}` });
  const choices = async (key: string) => {
    const r = await call('GET', '/api/v1/reports/tax-estimate/taxpayers', key, undefined, pack(key));
    expect(r.status, key).toBe(200);
    return (r.json.data as Array<{ id: string }>).map((t) => t.id);
  };
  const ctx = (requestedBy: string): DocumentSectionContext => ({
    tenantId: fx.T.schc, companyId: fx.C.schc, companyName: 'Rivera Plumbing LLC', rangeStart: '2026-07-01', rangeEnd: '2026-09-30', asOfDate: '2026-09-30',
    options: { taxpayerId: tp.rivera }, allowAttachments: false, allowTransactions: false, renderHtml: async () => new Uint8Array(),
    allowTaxEstimate: true, requestedBy,
  });
  const render = () => REPORT_PACK_DOCUMENT_RENDERERS['tax-estimate']!;

  it('taxpayer choices follow the requester\'s visibility', async () => {
    expect(await choices('all')).toContain(tp.rivera);
    expect((await setStaff([uid['peer']!])).status).toBe(200);
    expect(await choices('all')).not.toContain(tp.rivera);
    expect(await choices('peer')).toContain(tp.rivera);
  });

  it('generation (request side) refuses a taxpayer the requester cannot see', async () => {
    expect((await setStaff([uid['peer']!])).status).toBe(200);
    const q = `taxpayer_id=${tp.rivera}&as_of_date=2026-09-30`;
    const hidden = await call('GET', `/api/v1/reports/tax-estimate?${q}`, 'all', undefined, pack('all'));
    expect(hidden.status).toBe(404);
    const ok = await call('GET', `/api/v1/reports/tax-estimate?${q}`, 'peer', undefined, pack('peer'));
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('application/pdf');
  }, 180_000);

  it('the worker re-checks the requester\'s visibility at render time', async () => {
    expect((await setStaff([uid['peer']!])).status).toBe(200);
    await expect(render()(ctx(uid['all']!))).rejects.toMatchObject({ statusCode: 404 });
    const bytes = await render()(ctx(uid['peer']!));
    expect(bytes.byteLength).toBeGreaterThan(1000);
  }, 180_000);

  it('the register flag stays usable (entity data) while the taxpayer names stay hidden', async () => {
    expect((await setStaff([uid['peer']!])).status).toBe(200);
    const scope = await resolvePackScope(fx.T.schc, uid['all']!, false);
    const flag = await getTransactionFlag(scope, fx.T.schc, fx.C.schc, fx.q1Txn);
    expect(flag.linked).toBe(true);
    expect(flag.taxpayers).toEqual([]);
  });
});
