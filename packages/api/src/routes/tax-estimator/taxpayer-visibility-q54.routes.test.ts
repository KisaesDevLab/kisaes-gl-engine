// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q54 (Kurt, 2026-10-13; OPEN-QUESTIONS.md Q54) — strict taxpayer visibility, HTTP level.
//
//   * A NON-EMPTY staff list hides the taxpayer from every firm admin it does not name (firm
//     admins are no longer a bypass); only the listed users and super admins see it. Listed
//     firm admins get D18 full data like listed staff.
//   * firm_staff / firm_readonly see an UNLISTED taxpayer only with the firm capability
//     "Tax Estimator: view taxpayers" (default OFF) AND the D17 linked-tenant rule — tenant-level
//     Accountant access alone no longer reveals a taxpayer — or as the creator of an unlinked one.
//
// Fixture (Rivera household, firm A, links into T.schc / T.scorp / T.lp; practice tenant P has
// the flag ON; T.schc too, for the company dashboard). Rivera carries a staff list naming
// `adminL` and `listedNoCap`; "Open Books" has NO list and is linked to the Sch C company;
// "Mine Unlinked" was created by `staffNoCap` and has no link.
//   super        super admin (X-Firm-Id A)
//   adminL       firm_admin, access {P, schc}       on Rivera's list
//   adminU       firm_admin, access {P, schc}       NOT on Rivera's list
//   staffCap     firm_staff + capability, {P, schc}
//   staffNoCap   firm_staff, no capability, {P, schc}   ← the production "ROCA accountant" case
//   capNoReach   firm_staff + capability, {P}
//   listedNoCap  firm_staff, no capability, {P}     on Rivera's list
//   ro           firm_readonly, no capability, {P, schc}
//   roCap        firm_readonly + capability, {P, schc}
//   fb           firm B staff + capability, {other, schc}
//   client       client user (user_type client) in T.schc

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
  auditLog, firms, firmUsers, taxEstFirmSettings, taxEstTaxpayers, taxEstTaxpayerStaff,
  tenantFeatureFlags, tenantFirmAssignments, userTenantAccess, users,
} from '../../db/schema/index.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { closeTbRedis } from '../../services/tb/tb-redis.js';
import { mkTenant, purgeTenants } from '../../services/tax-estimator/entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from '../../services/tax-estimator/rivera.test-fixtures.js';
import { createTaxpayer, upsertLink, upsertPerson } from '../../services/tax-estimator/taxpayers.service.js';
import { upsertYear } from '../../services/tax-estimator/years.service.js';
import { createSnapshot } from '../../services/tax-estimator/estimate-snapshots.service.js';
import { REPORT_PACK_DOCUMENT_RENDERERS, type DocumentSectionContext } from '../../services/report-pack-documents.js';
import { taxEstScenarios } from '../../db/schema/tax-estimator-years.js';
import { taxEstimatorRouter } from '../tax-estimator.routes.js';
import { reportsRouter } from '../reports.routes.js';
import { dashboardRouter } from '../dashboard.routes.js';

const FIRM_A = randomUUID();
const FIRM_B = randomUUID();
const SEED_USER = randomUUID();
const TE = '/api/v1/tax-estimator';
const DASH = '/api/v1/dashboard/tax-estimates';
const YEAR = 2026;
let fx: RiveraFixture;
let server: Server | null = null;
let port = 0;
let P = '';
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};
const tp = { rivera: '', open: '', mine: '' };
let openBase = '';
let riveraSnapshot = '';

const ALL = ['super', 'adminL', 'adminU', 'staffCap', 'staffNoCap', 'capNoReach', 'listedNoCap', 'ro', 'roCap', 'fb'] as const;
type Actor = typeof ALL[number];

/** Who sees which taxpayer under Q54 (the matrix every probe is checked against). */
const SEES: Record<Actor, Array<keyof typeof tp>> = {
  super: ['rivera', 'open', 'mine'],
  adminL: ['rivera', 'open', 'mine'],
  adminU: ['open', 'mine'], // listed Rivera hidden from a non-listed firm admin
  staffCap: ['open'], // capability + reaches schc; Mine is someone else's unlinked taxpayer
  staffNoCap: ['mine'], // reaches schc but no capability: only its own unlinked taxpayer
  capNoReach: [], // capability but reaches no linked tenant
  listedNoCap: ['rivera'], // listed wins, with no capability and no reach
  ro: [],
  roCap: ['open'],
  fb: [],
};

type Res = { status: number; json: any; headers: http.IncomingHttpHeaders };

async function mkUser(key: string, activeTenant: string, opts: {
  firm?: string; firmRole?: 'firm_admin' | 'firm_staff' | 'firm_readonly'; access?: string[]; superAdmin?: boolean; cap?: boolean; userType?: 'staff' | 'client';
} = {}) {
  const role = opts.userType === 'client' ? 'bookkeeper' : 'accountant';
  const [u] = await db.insert(users).values({
    tenantId: activeTenant, email: `te-q54-${key.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash: await bcrypt.hash('x-secret-12345', 4), displayName: key, role, userType: opts.userType ?? 'staff',
    isSuperAdmin: opts.superAdmin === true,
  }).returning();
  uid[key] = u!.id;
  if (opts.firm) {
    await db.insert(firmUsers).values({
      firmId: opts.firm, userId: u!.id, firmRole: opts.firmRole ?? 'firm_staff',
      capabilities: opts.cap ? { tax_estimator_view_taxpayers: true } : null,
    });
  }
  for (const t of opts.access ?? []) await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: t, role });
  tokens[key] = jwt.sign({ userId: u!.id, tenantId: activeTenant, role, isSuperAdmin: opts.superAdmin === true }, process.env['JWT_SECRET']!, { expiresIn: '30m' });
}

/** The same user acting inside another tenant (Report Pack / company dashboard run in the client). */
function tokenIn(key: string, tenantId: string) {
  const k = `${key}@${tenantId}`;
  tokens[k] = jwt.sign({ userId: uid[key]!, tenantId, role: 'accountant', isSuperAdmin: key === 'super' }, process.env['JWT_SECRET']!, { expiresIn: '30m' });
  return k;
}

function call(method: string, path: string, key: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${tokens[key]}`, ...(key.startsWith('super') ? { 'X-Firm-Id': FIRM_A } : {}), ...extra,
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}),
    };
    const r = http.request({ hostname: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const sees = (a: Actor, t: keyof typeof tp) => SEES[a].includes(t);
const baseOf = async (taxpayerId: string) => {
  const [s] = await db.select({ id: taxEstScenarios.id }).from(taxEstScenarios)
    .where(and(eq(taxEstScenarios.taxpayerId, taxpayerId), eq(taxEstScenarios.taxYear, YEAR), eq(taxEstScenarios.isBase, true)));
  return s!.id;
};
const scenarioOf = (t: keyof typeof tp) => (t === 'rivera' ? fx.baseScenarioId : openBase);

beforeAll(async () => {
  await db.insert(firms).values([
    { id: FIRM_A, name: 'Q54 Firm A', slug: `te-q54-a-${FIRM_A.slice(0, 8)}` },
    { id: FIRM_B, name: 'Q54 Firm B', slug: `te-q54-b-${FIRM_B.slice(0, 8)}` },
  ]);
  fx = await seedRivera(FIRM_A, FIRM_B, SEED_USER);
  P = await mkTenant('TE-Q54 Practice');
  await db.insert(tenantFirmAssignments).values([
    ...[P, fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })),
    { tenantId: fx.T.other, firmId: FIRM_B },
  ]);
  for (const t of [P, fx.T.schc, fx.T.other]) await db.insert(tenantFeatureFlags).values({ tenantId: t, flagKey: 'TAX_ESTIMATOR_V1', enabled: true });

  await mkUser('super', P, { superAdmin: true });
  await mkUser('adminL', P, { firm: FIRM_A, firmRole: 'firm_admin', access: [P, fx.T.schc] });
  await mkUser('adminU', P, { firm: FIRM_A, firmRole: 'firm_admin', access: [P, fx.T.schc] });
  await mkUser('staffCap', P, { firm: FIRM_A, access: [P, fx.T.schc], cap: true });
  await mkUser('staffNoCap', P, { firm: FIRM_A, access: [P, fx.T.schc] });
  await mkUser('capNoReach', P, { firm: FIRM_A, access: [P], cap: true });
  await mkUser('listedNoCap', P, { firm: FIRM_A, access: [P] });
  await mkUser('ro', P, { firm: FIRM_A, firmRole: 'firm_readonly', access: [P, fx.T.schc] });
  await mkUser('roCap', P, { firm: FIRM_A, firmRole: 'firm_readonly', access: [P, fx.T.schc], cap: true });
  await mkUser('fb', fx.T.other, { firm: FIRM_B, access: [fx.T.other, fx.T.schc], cap: true });
  await mkUser('client', fx.T.schc, { access: [fx.T.schc], userType: 'client' });

  const app = express();
  app.use(express.json());
  app.use(TE, taxEstimatorRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });

  tp.rivera = fx.taxpayerId;
  const o = await createTaxpayer(fx.scopeA, fx.actor, { displayName: 'Open Books', filingStatus: 'single', residentState: 'MO' });
  tp.open = o.id;
  await upsertPerson(fx.scopeA, fx.actor, o.id, 'primary', { firstName: 'Open', lastName: 'Books', dateOfBirth: '1970-01-01', isBlind: false });
  await upsertLink(fx.scopeA, fx.actor, o.id, { personRole: 'primary', taxYear: YEAR, tenantId: fx.T.schc, companyId: fx.C.schc, profitPct: 10, isOfficer: false, activityType: 'active', activeParticipation: false });
  await upsertYear(fx.scopeA, fx.actor, o.id, YEAR, {});
  openBase = await baseOf(o.id);
  const mine = await call('POST', `${TE}/taxpayers`, 'staffNoCap', { displayName: 'Mine Unlinked', filingStatus: 'single' });
  expect(mine.status, JSON.stringify(mine.json)).toBe(201);
  tp.mine = mine.json.data.id;
  await db.update(taxEstTaxpayers).set({ showOnCompanyDashboard: true }).where(inArray(taxEstTaxpayers.id, [tp.rivera, tp.open]));

  // Rivera's list: adminL (the manager) + listedNoCap. Saved by adminL through the API.
  const put = await call('PUT', `${TE}/taxpayers/${tp.rivera}/staff`, 'adminL', { userIds: [uid['adminL']!, uid['listedNoCap']!] });
  expect(put.status, JSON.stringify(put.json)).toBe(200);

  const snap = await createSnapshot(fx.scopeA, fx.actor, { taxpayerId: tp.rivera, taxYear: YEAR, scenarioId: fx.baseScenarioId, reason: 'finalize' });
  riveraSnapshot = snap.id;
}, 600_000);

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

describe('Q54 visibility matrix', () => {
  it('list: names AND totals follow the matrix', async () => {
    const byId = new Map(Object.entries(tp).map(([k, v]) => [v, k]));
    for (const a of ALL) {
      const r = await call('GET', `${TE}/taxpayers?limit=50`, a, undefined, a === 'fb' ? { 'X-Firm-Id': FIRM_A } : {});
      if (a === 'fb') { expect(r.status, a).toBe(404); continue; } // not a member of firm A
      expect(r.status, a).toBe(200);
      const got = (r.json.data as Array<{ id: string }>).map((t) => byId.get(t.id)).filter(Boolean).sort();
      expect(got, a).toEqual([...SEES[a]].sort());
      expect(r.json.total, a).toBe(SEES[a].length);
    }
  });

  it('by-id, staff list, portal contact mapping and snapshots list: 200 iff visible, else the uniform 404', async () => {
    for (const a of ALL) {
      for (const t of Object.keys(tp) as Array<keyof typeof tp>) {
        for (const path of [`${TE}/taxpayers/${tp[t]}`, `${TE}/taxpayers/${tp[t]}/staff`, `${TE}/taxpayers/${tp[t]}/contacts`, `${TE}/taxpayers/${tp[t]}/years/${YEAR}/snapshots`]) {
          if (t === 'mine' && path.endsWith('/snapshots')) continue; // no year
          const r = await call('GET', path, a);
          if (sees(a, t)) expect(r.status, `${a} ${path}`).toBe(200);
          else {
            expect(r.status, `${a} ${t} ${path}`).toBe(404);
            if (a !== 'fb') expect(r.json.error.code, `${a} ${path}`).toBe('TE_TAXPAYER_NOT_FOUND');
          }
        }
      }
    }
  }, 120_000);

  it('estimate compute: 200 iff visible; a listed firm admin gets D18 full data (elevated)', async () => {
    for (const a of ALL) {
      for (const t of ['rivera', 'open'] as const) {
        const r = await call('POST', `${TE}/taxpayers/${tp[t]}/years/${YEAR}/scenarios/${scenarioOf(t)}/estimate`, a, {});
        expect(r.status, `${a} ${t} ${JSON.stringify(r.json?.error)}`).toBe(sees(a, t) ? 200 : 404);
        if (a === 'adminL' && t === 'rivera') {
          expect(r.json.data.elevatedAccess).toBe(true);
          const companies = (r.json.data.entities as Array<{ companyId: string }>).map((e) => e.companyId).sort();
          expect(companies).toEqual([fx.C.schc, fx.C.scorp, fx.C.lp].sort());
        }
        if (a === 'listedNoCap' && t === 'rivera') expect(r.json.data.elevatedAccess).toBe(true);
      }
    }
  }, 300_000);

  it('PDF and snapshot view: a non-listed firm admin and an uncapable staff get 404', async () => {
    const pdf = (a: Actor) => call('POST', `${TE}/taxpayers/${tp.rivera}/years/${YEAR}/scenarios/${fx.baseScenarioId}/pdf`, a, { throughMonth: '2026-09' });
    for (const a of ['adminU', 'staffCap', 'staffNoCap'] as const) expect((await pdf(a)).status, a).toBe(404);
    const ok = await pdf('adminL');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('application/pdf');
    for (const a of ALL) {
      const r = await call('GET', `${TE}/snapshots/${riveraSnapshot}`, a);
      expect(r.status, a).toBe(sees(a, 'rivera') ? 200 : 404);
    }
    const openPdf = await call('POST', `${TE}/taxpayers/${tp.open}/years/${YEAR}/scenarios/${openBase}/pdf`, 'staffNoCap', { throughMonth: '2026-09' });
    expect(openPdf.status).toBe(404);
  }, 300_000);

  it('Report Pack choices and the worker re-check follow the matrix (in the client tenant)', async () => {
    const inSchc: Actor[] = ['super', 'adminL', 'adminU', 'staffCap', 'staffNoCap', 'ro', 'roCap', 'fb'];
    for (const a of inSchc) {
      const k = tokenIn(a, fx.T.schc);
      const r = await call('GET', '/api/v1/reports/tax-estimate/taxpayers', k, undefined, { 'X-Company-Id': fx.C.schc });
      const ids: string[] = r.status === 200 ? (r.json.data as Array<{ id: string }>).map((t) => t.id) : [];
      expect(ids.includes(tp.rivera), `${a} rivera`).toBe(sees(a, 'rivera'));
      expect(ids.includes(tp.open), `${a} open`).toBe(sees(a, 'open'));
    }
    const render = REPORT_PACK_DOCUMENT_RENDERERS['tax-estimate']!;
    const ctx = (requestedBy: string, taxpayerId: string): DocumentSectionContext => ({
      tenantId: fx.T.schc, companyId: fx.C.schc, companyName: 'Rivera Plumbing LLC', rangeStart: '2026-07-01', rangeEnd: '2026-09-30', asOfDate: '2026-09-30',
      options: { taxpayerId }, allowAttachments: false, allowTransactions: false, renderHtml: async () => new Uint8Array(),
      allowTaxEstimate: true, requestedBy,
    });
    await expect(render(ctx(uid['adminU']!, tp.rivera))).rejects.toMatchObject({ statusCode: 404 });
    await expect(render(ctx(uid['staffNoCap']!, tp.open))).rejects.toMatchObject({ statusCode: 404 });
    expect((await render(ctx(uid['adminL']!, tp.rivera))).byteLength).toBeGreaterThan(1000);
  }, 300_000);

  it('company dashboard cards and firm-wide cards count only visible taxpayers', async () => {
    for (const a of ['super', 'adminL', 'adminU', 'staffCap', 'staffNoCap', 'roCap', 'ro'] as const) {
      const r = await call('GET', DASH, tokenIn(a, fx.T.schc), undefined, { 'X-Company-Id': fx.C.schc });
      expect(r.status, a).toBe(200);
      const ids = ((r.json.data?.taxpayers ?? []) as Array<{ taxpayerId: string }>).map((t) => t.taxpayerId).sort();
      const want = (['rivera', 'open'] as const).filter((t) => sees(a, t)).map((t) => tp[t]).sort();
      expect(ids, a).toEqual(want);
      if (want.length === 0) expect(r.json.data, a).toBeNull();
    }
    for (const a of ALL) {
      if (a === 'fb') continue;
      const r = await call('GET', `${TE}/dashboard`, a);
      expect(r.status, a).toBe(200);
      if (SEES[a].length === 0) expect(r.json.data, a).toBeNull();
      else expect(r.json.data.visibleTaxpayers, a).toBe(SEES[a].length);
    }
  }, 300_000);

  it('owner-candidates (Q50) list only visible taxpayers linked to the business', async () => {
    for (const a of ['super', 'adminL', 'adminU', 'staffCap', 'staffNoCap'] as const) {
      const r = await call('GET', `${TE}/entities/${fx.T.schc}/${fx.C.schc}/owner-candidates?taxYear=${YEAR}`, a);
      expect(r.status, a).toBe(200);
      const ids = [...new Set((r.json.data.candidates as Array<{ taxpayerId: string }>).map((c) => c.taxpayerId))].sort();
      expect(ids, a).toEqual((['rivera', 'open'] as const).filter((t) => sees(a, t)).map((t) => tp[t]).sort());
    }
  });

  it('client users and another firm get 404', async () => {
    expect((await call('GET', `${TE}/taxpayers`, 'client')).status).toBe(404);
    expect((await call('GET', `${TE}/taxpayers/${tp.open}`, 'fb', undefined, { 'X-Firm-Id': FIRM_A })).status).toBe(404);
  });

  it('GET /scope tells the UI whether the caller sees unlisted taxpayers', async () => {
    const want: Partial<Record<Actor, boolean>> = { super: true, adminU: true, staffCap: true, roCap: true, staffNoCap: false, listedNoCap: false, ro: false };
    for (const [a, v] of Object.entries(want)) {
      const r = await call('GET', `${TE}/scope`, a);
      expect(r.status, a).toBe(200);
      expect(r.json.data.canViewUnlistedTaxpayers, a).toBe(v);
    }
  });

  it('the capability is re-read on every request (revoking it hides the taxpayer at once)', async () => {
    expect((await call('GET', `${TE}/taxpayers/${tp.open}`, 'staffCap')).status).toBe(200);
    await db.update(firmUsers).set({ capabilities: {} }).where(eq(firmUsers.userId, uid['staffCap']!));
    try {
      expect((await call('GET', `${TE}/taxpayers/${tp.open}`, 'staffCap')).status).toBe(404);
    } finally {
      await db.update(firmUsers).set({ capabilities: { tax_estimator_view_taxpayers: true } }).where(eq(firmUsers.userId, uid['staffCap']!));
    }
  });
});

describe('Q54 staff-list management', () => {
  it('only firm admins who can see the taxpayer (and super admins) may edit it', async () => {
    const list = [uid['adminL']!, uid['listedNoCap']!];
    expect((await call('PUT', `${TE}/taxpayers/${tp.rivera}/staff`, 'adminU', { userIds: list })).status).toBe(404);
    const staff = await call('PUT', `${TE}/taxpayers/${tp.rivera}/staff`, 'listedNoCap', { userIds: list });
    expect(staff.status).toBe(403);
    expect(staff.json.error.code).toBe('TE_FIRM_ADMIN_REQUIRED');
    const sup = await call('PUT', `${TE}/taxpayers/${tp.rivera}/staff`, 'super', { userIds: list });
    expect(sup.status).toBe(200);
    expect(sup.json.data.callerLostAccess).toBeUndefined();
    const view = await call('GET', `${TE}/taxpayers/${tp.rivera}/staff`, 'adminL');
    expect(view.json.data.canEdit).toBe(true);
  });

  it('a list without a firm admin / super admin is refused 422 TE_STAFF_LIST_NO_MANAGER (an inactive admin does not count)', async () => {
    const r = await call('PUT', `${TE}/taxpayers/${tp.open}/staff`, 'adminU', { userIds: [uid['staffCap']!] });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('TE_STAFF_LIST_NO_MANAGER');
    // Deactivate adminL's membership: a list naming only adminL + staff has no ACTIVE manager.
    await db.update(firmUsers).set({ isActive: false }).where(eq(firmUsers.userId, uid['adminL']!));
    try {
      const r2 = await call('PUT', `${TE}/taxpayers/${tp.rivera}/staff`, 'super', { userIds: [uid['adminL']!, uid['listedNoCap']!, uid['staffCap']!] });
      expect(r2.status).toBe(422);
    } finally {
      await db.update(firmUsers).set({ isActive: true }).where(eq(firmUsers.userId, uid['adminL']!));
    }
    expect(await db.select().from(taxEstTaxpayerStaff).where(eq(taxEstTaxpayerStaff.taxpayerId, tp.open))).toHaveLength(0);
  });

  it('a firm admin who saves a list without themselves loses access (callerLostAccess) — audited', async () => {
    const r = await call('PUT', `${TE}/taxpayers/${tp.open}/staff`, 'adminU', { userIds: [uid['adminL']!, uid['staffNoCap']!] });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.callerLostAccess).toBe(true);
    expect((await call('GET', `${TE}/taxpayers/${tp.open}`, 'adminU')).status).toBe(404);
    expect((await call('GET', `${TE}/taxpayers/${tp.open}`, 'staffNoCap')).status).toBe(200); // listed, no capability
    expect((await call('GET', `${TE}/taxpayers/${tp.open}`, 'staffCap')).status).toBe(404); // capability, not listed
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'tax_est_taxpayer_staff'), eq(auditLog.entityId, tp.open)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(uid['adminU']);
    expect(rows[0]!.afterData).toMatchObject({ userIds: [uid['adminL']!, uid['staffNoCap']!].sort() });
    // adminL (listed) clears it again: everyone back to the firm rule.
    expect((await call('PUT', `${TE}/taxpayers/${tp.open}/staff`, 'adminL', { userIds: [] })).status).toBe(200);
    expect((await call('GET', `${TE}/taxpayers/${tp.open}`, 'adminU')).status).toBe(200);
  });
});
