// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q52 — dashboard cards: route auth / isolation, audience, data-source
// precedence (cache → snapshot → not computed), figures equal the estimate's, 30-day window.
//
// Fixture: the Rivera household (firm A; links into T.schc / T.scorp / T.lp) plus "Other
// Owner" linked to the same Sch C company. Practice tenant P has the flag ON for the firm
// cards; T.schc (the company whose dashboard we open) has it ON for the company cards.
//   admin   firm_admin A, access {P, schc, scorp, lp}   → bypass, full scope
//   staff   firm_staff A, access {P, schc}              → sees Rivera via schc (partial books)
//   none    firm_staff A, access {P}                    → reaches no linked tenant
//   peer    firm_staff A, access {P, schc}              → the staff-list member (D18)
//   fb      firm B staff, access {other, schc}          → another firm
//   owner   tenant owner of T.schc, not a firm member, e-mail = Rivera's portal contact
//   owner2  tenant owner of T.schc with no matching contact
//   client  client user (user_type client, role bookkeeper) whose e-mail ALSO matches the contact
//
// Q54 (Kurt, 2026-10-13): (1) firm_staff members need the firm capability "Tax Estimator: view
// taxpayers" for the D17 rule — staff / none / peer / fb are granted it below so the Q52
// expectations hold as written; (2) company-dashboard cards appear only for taxpayers switched
// to "Show on linked company dashboards" (default OFF) — both taxpayers are switched ON in
// beforeAll, and the 'Q54 company-dashboard switch' block tests the OFF default.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { dAdd, dRoundDollars, dSub, type CompanyTaxEstimatesDTO, type EstimateResultDTO } from '@kis-books/shared';
import { db, pool } from '../db/index.js';
import {
  auditLog, firms, firmUsers, portalContactCompanies, portalContacts, taxEstFirmSettings, taxEstTaxpayerContacts, taxEstTaxpayers,
  taxEstTaxpayerStaff, tenantFeatureFlags, tenantFirmAssignments, userTenantAccess, users,
} from '../db/schema/index.js';
import { taxEstDashboardSummaries } from '../db/schema/tax-estimator-dashboard.js';
import { taxEstPortalContactOptions } from '../db/schema/tax-estimator-portal.js';
import { taxEstScenarios } from '../db/schema/tax-estimator-years.js';
import { createScenario } from '../services/tax-estimator/scenarios.service.js';
import { errorHandler } from '../middleware/error-handler.js';
import { closeTbRedis } from '../services/tb/tb-redis.js';
import { mkTenant, purgeTenants } from '../services/tax-estimator/entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from '../services/tax-estimator/rivera.test-fixtures.js';
import { createTaxpayer, upsertLink, upsertPerson, updateTaxpayer } from '../services/tax-estimator/taxpayers.service.js';
import { upsertYear } from '../services/tax-estimator/years.service.js';
import { createSnapshot } from '../services/tax-estimator/estimate-snapshots.service.js';
import { computeEstimate } from '../services/tax-estimator/estimate.service.js';
import { resolveScope, type FirmScope } from '../services/tax-estimator/firm-scope.service.js';
import { resolvePackScope } from '../services/tax-estimator/estimate-documents.service.js';
import { toPortalEstimate } from '../services/tax-estimator/portal-estimates.service.js';
import { companyCardsForStaff, firmDashboard } from '../services/tax-estimator/dashboard-cards.service.js';
import { dashboardRouter } from './dashboard.routes.js';
import { taxEstimatorRouter } from './tax-estimator.routes.js';

const FIRM_A = randomUUID();
const FIRM_B = randomUUID();
const SEED_USER = randomUUID();
const DASH = '/api/v1/dashboard/tax-estimates';
const TE = '/api/v1/tax-estimator';
const YEAR = 2026;
let fx: RiveraFixture;
let server: Server | null = null;
let port = 0;
let P = '';
let otherOwner = '';
let ownerContactId = '';
const CONTACT_EMAIL = `rivera-${randomUUID().slice(0, 8)}@example.com`;
const tokens: Record<string, string> = {};
const uid: Record<string, string> = {};

type Res = { status: number; json: any };

async function mkUser(key: string, activeTenant: string, opts: {
  firm?: string; firmRole?: 'firm_admin' | 'firm_staff' | 'firm_readonly'; access?: string[]; role?: string; userType?: 'staff' | 'client'; email?: string;
} = {}) {
  const role = opts.role ?? 'accountant';
  const [u] = await db.insert(users).values({
    tenantId: activeTenant, email: opts.email ?? `te-dash-${key}-${randomUUID().slice(0, 8)}@example.com`,
    passwordHash: await bcrypt.hash('x-secret-12345', 4), displayName: key, role, userType: opts.userType ?? 'staff',
  }).returning();
  uid[key] = u!.id;
  if (opts.firm) await db.insert(firmUsers).values({ firmId: opts.firm, userId: u!.id, firmRole: opts.firmRole ?? 'firm_staff' });
  for (const t of opts.access ?? []) await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: t, role });
  tokens[key] = jwt.sign({ userId: u!.id, tenantId: activeTenant, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '30m' });
}

function tokenIn(key: string, tenantId: string, role = 'accountant') {
  const k = `${key}@${tenantId}`;
  tokens[k] = jwt.sign({ userId: uid[key]!, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '30m' });
  return k;
}

function call(method: string, path: string, key: string, extra: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: '127.0.0.1', port, path, method, headers: { Authorization: `Bearer ${tokens[key]}`, ...extra } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json: unknown = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

async function setFlag(tenantId: string, enabled: boolean) {
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'TAX_ESTIMATOR_V1', enabled })
    .onConflictDoUpdate({ target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey], set: { enabled } });
}

const scopeOf = (key: string) => resolveScope(uid[key]!, false, FIRM_A);
const names = (d: CompanyTaxEstimatesDTO | null) => (d?.taxpayers ?? []).map((t) => t.displayName).sort();

beforeAll(async () => {
  await db.insert(firms).values([
    { id: FIRM_A, name: 'Dash Firm A', slug: `te-dash-a-${FIRM_A.slice(0, 8)}` },
    { id: FIRM_B, name: 'Dash Firm B', slug: `te-dash-b-${FIRM_B.slice(0, 8)}` },
  ]);
  fx = await seedRivera(FIRM_A, FIRM_B, SEED_USER);
  P = await mkTenant('TE-DASH Practice');
  await db.insert(tenantFirmAssignments).values([
    ...[P, fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })),
    { tenantId: fx.T.other, firmId: FIRM_B },
  ]);
  for (const t of [P, fx.T.schc, fx.T.other]) await setFlag(t, true);

  await mkUser('admin', fx.T.schc, { firm: FIRM_A, firmRole: 'firm_admin', access: [P, fx.T.schc, fx.T.scorp, fx.T.lp] });
  await mkUser('staff', fx.T.schc, { firm: FIRM_A, access: [P, fx.T.schc] });
  await mkUser('none', P, { firm: FIRM_A, access: [P] });
  await mkUser('peer', fx.T.schc, { firm: FIRM_A, access: [P, fx.T.schc] });
  await mkUser('fb', fx.T.schc, { firm: FIRM_B, access: [fx.T.other, fx.T.schc] });
  await mkUser('owner', fx.T.schc, { role: 'owner', access: [fx.T.schc], email: CONTACT_EMAIL.toUpperCase() });
  await mkUser('owner2', fx.T.schc, { role: 'owner', access: [fx.T.schc] });
  await mkUser('client', fx.T.schc, { role: 'bookkeeper', userType: 'client', access: [fx.T.schc], email: `x${CONTACT_EMAIL}` });
  await db.update(firmUsers).set({ capabilities: { tax_estimator_view_taxpayers: true } })
    .where(inArray(firmUsers.userId, ['staff', 'none', 'peer', 'fb'].map((k) => uid[k]!)));

  // A second firm-A taxpayer linked to the same company, not mapped to the owner's contact.
  const o = await createTaxpayer(fx.scopeA, fx.actor, { displayName: 'Other Owner', filingStatus: 'single', residentState: 'MO' });
  otherOwner = o.id;
  await upsertPerson(fx.scopeA, fx.actor, o.id, 'primary', { firstName: 'Other', lastName: 'Owner', dateOfBirth: '1970-01-01', isBlind: false });
  await upsertLink(fx.scopeA, fx.actor, o.id, { personRole: 'primary', taxYear: YEAR, tenantId: fx.T.schc, companyId: fx.C.schc, profitPct: 10, isOfficer: false, activityType: 'active', activeParticipation: false });
  await upsertYear(fx.scopeA, fx.actor, o.id, YEAR, {});
  // Q54: both taxpayers on the company dashboards (the switch defaults OFF).
  await db.update(taxEstTaxpayers).set({ showOnCompanyDashboard: true }).where(inArray(taxEstTaxpayers.id, [fx.taxpayerId, o.id]));

  // The owner's portal contact: Rivera mapped, tax estimates access on the Sch C company.
  const [c] = await db.insert(portalContacts).values({ tenantId: fx.T.schc, email: CONTACT_EMAIL, status: 'active' }).returning();
  await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId: fx.C.schc, taxEstimatesAccess: true });
  await db.insert(taxEstTaxpayerContacts).values({ taxpayerId: fx.taxpayerId, portalContactId: c!.id });
  ownerContactId = c!.id;
  // The client user's contact (same mapping) — a client user who is not the owner still sees nothing.
  const [c2] = await db.insert(portalContacts).values({ tenantId: fx.T.schc, email: `x${CONTACT_EMAIL}`, status: 'active' }).returning();
  await db.insert(portalContactCompanies).values({ contactId: c2!.id, companyId: fx.C.schc, taxEstimatesAccess: true });
  await db.insert(taxEstTaxpayerContacts).values({ taxpayerId: fx.taxpayerId, portalContactId: c2!.id });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/dashboard', dashboardRouter);
  app.use(TE, taxEstimatorRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}, 600_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B])); // cascades summaries, snapshots, contacts map
  await db.delete(auditLog).where(inArray(auditLog.userId, [SEED_USER, ...Object.values(uid)]));
  await db.delete(firmUsers).where(inArray(firmUsers.firmId, [FIRM_A, FIRM_B]));
  await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, [FIRM_A, FIRM_B]));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other, P]);
  await db.delete(firms).where(inArray(firms.id, [FIRM_A, FIRM_B]));
  await closeTbRedis();
  await pool.end();
});

// ── data-source precedence + figures (service level, fixed "today") ──
const TODAY = new Date('2026-12-16T12:00:00Z');
const SNAP_DAY = new Date('2026-12-15T12:00:00Z');
let adminPack: FirmScope;
let snapTotal = '';

describe('company cards: data source precedence (cache → snapshot → not computed)', () => {
  it('nothing computed and no snapshot → "Not computed yet" for staff', async () => {
    adminPack = await resolvePackScope(fx.T.schc, uid['admin']!, false);
    const d = await companyCardsForStaff(adminPack, fx.T.schc, fx.C.schc, { today: TODAY });
    expect(d?.audience).toBe('staff');
    expect(names(d)).toEqual(['Carlos & Maria Rivera', 'Other Owner']);
    for (const t of d!.taxpayers) {
      expect(t.status).toBe('not_computed');
      expect(t.source).toBeNull();
      expect(t.jurisdictions).toEqual([]);
    }
  });

  it('a finalized snapshot (no current cache entry) is shown as the snapshot', async () => {
    // Frozen on another day: its cache entry carries that day's key, so today's peek misses.
    const snap = await createSnapshot(adminPack, { tenantId: fx.T.schc, userId: uid['admin']! }, { taxpayerId: fx.taxpayerId, taxYear: YEAR, scenarioId: fx.baseScenarioId, reason: 'finalize' }, { today: SNAP_DAY });
    snapTotal = snap.summary!.total;
    const d = await companyCardsForStaff(adminPack, fx.T.schc, fx.C.schc, { today: TODAY });
    const r = d!.taxpayers.find((t) => t.taxpayerId === fx.taxpayerId)!;
    expect(r.status).toBe('ok');
    expect(r.source).toBe('snapshot');
    expect(r.changeSinceSnapshot).toBeNull();
    expect(r.totals?.total).toMatch(/^\d+$/);
  });

  it('a current cached live estimate wins over the snapshot; figures equal the engine / portal projection', async () => {
    const live: EstimateResultDTO = await computeEstimate(adminPack, { taxpayerId: fx.taxpayerId, taxYear: YEAR, scenarioId: fx.baseScenarioId }, { today: TODAY });
    const d = await companyCardsForStaff(adminPack, fx.T.schc, fx.C.schc, { today: TODAY });
    const r = d!.taxpayers.find((t) => t.taxpayerId === fx.taxpayerId)!;
    expect(r.source).toBe('live');
    expect(r.asOf).toBe(live.computedAt);
    expect(r.totals).toEqual({ total: dRoundDollars(live.summary.total), federal: dRoundDollars(live.summary.federalTotal), state: dRoundDollars(live.summary.stateTotal) });
    expect(r.changeSinceSnapshot?.amount).toBe(dRoundDollars(dSub(dRoundDollars(live.summary.total), dRoundDollars(snapTotal))));

    const p = toPortalEstimate(live, { taxpayer: { id: fx.taxpayerId, displayName: 'x' }, source: 'live', asOf: live.computedAt, firmName: null, disclaimer: '', today: '2026-12-16' });
    let short = '0';
    for (const j of p.jurisdictions) {
      const fig = r.jurisdictions!.find((x) => x.jurisdiction === j.jurisdiction)!;
      const due = j.installments.filter((i) => i.dueDate <= '2026-12-16');
      const exp = due.reduce((s, i) => dAdd(s, i.remaining), '0');
      expect(fig.shortfall).toBe(dRoundDollars(exp));
      expect(fig.requiredToDate).toBe(dRoundDollars(due.reduce((s, i) => dAdd(s, i.amount), '0')));
      short = dAdd(short, exp);
      // Next voucher = first installment due today or later (Q4, Jan 15 2027).
      const next = j.installments.find((i) => i.dueDate >= '2026-12-16');
      expect(fig.nextVoucher?.dueDate ?? null).toBe(next?.dueDate ?? null);
    }
    expect(r.shortfall).toBe(dRoundDollars(short));
    const fed = r.jurisdictions!.find((x) => x.jurisdiction === 'federal')!;
    expect(fed.penalty).toBe(dRoundDollars(live.federalEstimates.penalty?.total ?? '0'));
    expect(r.penalty).toBe(dRoundDollars([live.federalEstimates, ...live.stateEstimates].reduce((s, e) => dAdd(s, e.penalty?.total ?? '0'), '0')));
  });

  it('the live compute stored a dashboard summary (encrypted, tenant set = the tenants read)', async () => {
    const rows = await db.select().from(taxEstDashboardSummaries).where(eq(taxEstDashboardSummaries.taxpayerId, fx.taxpayerId));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0]!;
    expect([...row.tenantIds].sort()).toEqual([fx.T.schc, fx.T.scorp, fx.T.lp].sort());
    expect(row.summaryEncrypted).not.toContain('federal');
  });
});

describe('firm cards: window boundaries, behind, D1 / D17 / D18', () => {
  it('a voucher due exactly 30 days ahead is in the window; 31 days ahead is not', async () => {
    const scope = await scopeOf('admin');
    const in30 = await firmDashboard(scope, { today: TODAY }); // 2026-12-16 + 30 = 2027-01-15 (Q4)
    const q4 = in30!.vouchersDue.filter((v) => v.taxpayerId === fx.taxpayerId);
    expect(q4.length).toBeGreaterThan(0);
    expect(q4.every((v) => v.dueDate === '2027-01-15' && v.installment === 'Q4' && v.source === 'live')).toBe(true);
    const in31 = await firmDashboard(scope, { today: new Date('2026-12-15T12:00:00Z') });
    expect(in31!.vouchersDue.filter((v) => v.taxpayerId === fx.taxpayerId)).toEqual([]);
    // Due today is inside the window too (lower bound inclusive).
    const onDay = await firmDashboard(scope, { today: new Date('2027-01-15T12:00:00Z') });
    expect(onDay!.vouchersDue.some((v) => v.taxpayerId === fx.taxpayerId && v.dueDate === '2027-01-15')).toBe(true);
  });

  it('behind = the as-of shortfall and the engine penalty, the same figures as the company card', async () => {
    const scope = await scopeOf('admin');
    const d = await firmDashboard(scope, { today: TODAY });
    const company = await companyCardsForStaff(adminPack, fx.T.schc, fx.C.schc, { today: TODAY });
    const card = company!.taxpayers.find((t) => t.taxpayerId === fx.taxpayerId)!;
    const b = d!.behind.find((x) => x.taxpayerId === fx.taxpayerId);
    if (Number(card.shortfall) > 0) {
      expect(b?.shortfall).toBe(card.shortfall);
      expect(b?.penalty).toBe(card.penalty);
    } else {
      expect(b).toBeUndefined();
    }
    // "Other Owner" has a year but no estimate and no snapshot.
    expect(d!.notComputed.map((n) => n.taxpayerId)).toContain(otherOwner);
  });

  it('a summary is never shown to a viewer who cannot reach every tenant it read (D1 partial view)', async () => {
    const scope = await scopeOf('staff'); // reaches schc only; the admin's summary read schc + scorp + lp
    const d = await firmDashboard(scope, { today: TODAY });
    expect(d).not.toBeNull();
    expect(d!.vouchersDue.some((v) => v.taxpayerId === fx.taxpayerId && v.source === 'live')).toBe(false);
    expect(d!.behind.some((v) => v.taxpayerId === fx.taxpayerId && v.source === 'live')).toBe(false);
  });

  it('D18: a staff list that does not name the viewer hides the taxpayer from the firm and company cards', async () => {
    await db.insert(taxEstTaxpayerStaff).values({ firmId: FIRM_A, taxpayerId: fx.taxpayerId, userId: uid['peer']!, createdBy: uid['admin']! });
    try {
      const firm = await firmDashboard(await scopeOf('staff'), { today: TODAY });
      const ids = [...(firm?.vouchersDue ?? []), ...(firm?.behind ?? []), ...(firm?.notComputed ?? [])].map((x) => x.taxpayerId);
      expect(ids).not.toContain(fx.taxpayerId);
      const r = await call('GET', DASH, 'staff');
      expect(r.status).toBe(200);
      expect(names(r.json.data)).toEqual(['Other Owner']);
      // The listed peer sees it (with the D18 widened scope → the admin-equivalent summary).
      const peer = await firmDashboard(await scopeOf('peer'), { today: TODAY });
      expect(peer!.vouchersDue.some((v) => v.taxpayerId === fx.taxpayerId)).toBe(true);
    } finally {
      await db.delete(taxEstTaxpayerStaff).where(eq(taxEstTaxpayerStaff.firmId, FIRM_A));
    }
  });

  it('a viewer who sees no taxpayer gets null (cards hidden)', async () => {
    expect(await firmDashboard(await scopeOf('none'), { today: TODAY })).toBeNull();
  });
});

describe('routes: company dashboard audience and isolation', () => {
  it('staff passing the gates get the staff cards (with penalty / not-computed rows)', async () => {
    const r = await call('GET', DASH, 'admin');
    expect(r.status).toBe(200);
    expect(r.json.data.audience).toBe('staff');
    expect(names(r.json.data)).toEqual(['Carlos & Maria Rivera', 'Other Owner']);
    expect(r.json.data.taxpayers.find((t: { taxpayerId: string }) => t.taxpayerId === otherOwner).status).toBe('not_computed');
  });

  it('another firm\'s staff working in the same tenant get nothing; their refresh is a 404', async () => {
    const r = await call('GET', DASH, 'fb');
    expect(r.status).toBe(200);
    expect(r.json.data).toBeNull();
    const ref = await call('POST', `${DASH}/${fx.taxpayerId}/refresh`, 'fb');
    expect(ref.status).toBe(404);
    expect(ref.json.error.code).toBe('TE_TAXPAYER_NOT_FOUND');
  });

  it('the owner sees ONLY the taxpayer they personally are, portal-style (no penalty, no "not computed")', async () => {
    const r = await call('GET', DASH, 'owner');
    expect(r.status).toBe(200);
    const d = r.json.data as CompanyTaxEstimatesDTO;
    expect(d.audience).toBe('owner');
    expect(names(d)).toEqual(['Carlos & Maria Rivera']);
    const t = d.taxpayers[0]!;
    expect(t.status).toBe('ok');
    expect(t.source).toBe('snapshot'); // portal_shows live, no portal cache entry today → finalized snapshot
    expect(t.penalty).toBeNull();
    expect(t.jurisdictions!.every((j) => j.penalty === null)).toBe(true);
    expect(Object.keys(t).sort()).toEqual(['asOf', 'booksThrough', 'changeSinceSnapshot', 'displayName', 'jurisdictions', 'penalty', 'shortfall', 'source', 'status', 'taxYear', 'taxpayerId', 'totals']);
    // The owner may not refresh.
    expect((await call('POST', `${DASH}/${fx.taxpayerId}/refresh`, 'owner')).status).toBe(404);
  });

  it('portal_shows = snapshot is respected for the owner', async () => {
    await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: 'snapshot' });
    try {
      const r = await call('GET', DASH, 'owner');
      expect(r.json.data.taxpayers[0].source).toBe('snapshot');
    } finally {
      await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: null });
    }
  });

  it('an owner with no matching portal contact, and a client user who is not the owner, see nothing', async () => {
    for (const key of ['owner2', 'client']) {
      const r = await call('GET', DASH, key);
      if (r.status === 200) expect(r.json.data, key).toBeNull();
      else expect([403, 404], key).toContain(r.status);
    }
  });

  it('flag OFF on the company tenant hides the cards for everyone', async () => {
    await setFlag(fx.T.schc, false);
    try {
      for (const key of ['admin', 'owner']) {
        const r = await call('GET', DASH, key);
        expect(r.status, key).toBe(200);
        expect(r.json.data, key).toBeNull();
      }
    } finally {
      await setFlag(fx.T.schc, true);
    }
  });

  it('staff refresh computes the linked taxpayer live and returns its card', async () => {
    const r = await call('POST', `${DASH}/${fx.taxpayerId}/refresh`, 'admin');
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.data.source).toBe('live');
    expect(r.json.data.status).toBe('ok');
  });
});

describe('routes: firm-wide dashboard', () => {
  it('admin gets the firm cards; a refresh is a read-POST and stores a summary', async () => {
    const pt = tokenIn('admin', P);
    const ref = await call('POST', `${TE}/dashboard/taxpayers/${fx.taxpayerId}/years/${YEAR}/refresh`, pt);
    expect(ref.status, JSON.stringify(ref.json)).toBe(200);
    expect(typeof ref.json.data.computedAt).toBe('string');
    const r = await call('GET', `${TE}/dashboard`, pt);
    expect(r.status).toBe(200);
    expect(r.json.data.windowDays).toBe(30);
    expect(r.json.data.visibleTaxpayers).toBe(2);
  });

  it('a staff member who sees no taxpayer gets null; another firm is a 404', async () => {
    const r = await call('GET', `${TE}/dashboard`, 'none');
    expect(r.status).toBe(200);
    expect(r.json.data).toBeNull();
    const fb = await call('GET', `${TE}/dashboard`, 'fb', { 'X-Firm-Id': FIRM_A });
    expect(fb.status).toBe(404);
    const hid = await call('POST', `${TE}/dashboard/taxpayers/${fx.taxpayerId}/years/${YEAR}/refresh`, 'none');
    expect(hid.status).toBe(404);
    expect(hid.json.error.code).toBe('TE_TAXPAYER_NOT_FOUND');
  });

  it('client users get 404 on the firm dashboard', async () => {
    const r = await call('GET', `${TE}/dashboard`, 'client');
    expect(r.status).toBe(404);
  });

});

// Integration (v0.9.228): the owner card follows the Q51 portal options and the scenario the
// portal shows by default (Base; snapshot mode = Base's own latest finalized snapshot).
describe('owner card × Q51 portal options', () => {
  const ownerCard = async () => {
    const r = await call('GET', DASH, 'owner');
    expect(r.status).toBe(200);
    expect(r.json.data.audience).toBe('owner');
    return r.json.data.taxpayers[0] as CompanyTaxEstimatesDTO['taxpayers'][number];
  };
  const setOptions = (contactId: string, quarterlyEstimates: boolean) => db.insert(taxEstPortalContactOptions)
    .values({ portalContactId: contactId, tenantId: fx.T.schc, quarterlyEstimates })
    .onConflictDoUpdate({ target: taxEstPortalContactOptions.portalContactId, set: { quarterlyEstimates } });

  it('Quarterly estimates OFF for the contact: no next voucher / paid-vs-required; the projected total stays', async () => {
    const before = await ownerCard();
    expect(before.jurisdictions).toBeDefined();
    await setOptions(ownerContactId, false);
    try {
      const t = await ownerCard();
      expect(t.status).toBe('ok');
      expect(t.totals).toEqual(before.totals);
      expect('jurisdictions' in t).toBe(false);
      expect('shortfall' in t).toBe(false);
      expect(t.penalty).toBeNull();
    } finally {
      await db.delete(taxEstPortalContactOptions).where(eq(taxEstPortalContactOptions.portalContactId, ownerContactId));
    }
    expect((await ownerCard()).jurisdictions).toBeDefined();
  });

  it('several contacts with the owner\'s e-mail: the most restrictive options apply (AND)', async () => {
    // A second active contact of the tenant with the same e-mail (other case), not even mapped
    // to the taxpayer, has the section off — the owner card hides it although the mapped one allows it.
    const [dup] = await db.insert(portalContacts).values({ tenantId: fx.T.schc, email: CONTACT_EMAIL.toUpperCase(), status: 'active' }).returning();
    try {
      await setOptions(dup!.id, false);
      await setOptions(ownerContactId, true);
      const t = await ownerCard();
      expect('jurisdictions' in t).toBe(false);
      expect(t.totals).not.toBeNull();
      // A paused duplicate does not count.
      await db.update(portalContacts).set({ status: 'paused' }).where(eq(portalContacts.id, dup!.id));
      expect((await ownerCard()).jurisdictions).toBeDefined();
    } finally {
      await db.delete(taxEstPortalContactOptions).where(inArray(taxEstPortalContactOptions.portalContactId, [ownerContactId, dup!.id]));
      await db.delete(portalContacts).where(eq(portalContacts.id, dup!.id));
    }
  });

  it('snapshot mode: Base\'s latest finalized snapshot only, never a newer one of a shared what-if', async () => {
    const adminScope = await resolvePackScope(fx.T.schc, uid['admin']!, false);
    const base = await createSnapshot(adminScope, { tenantId: fx.T.schc, userId: uid['admin']! }, { taxpayerId: fx.taxpayerId, taxYear: YEAR, scenarioId: fx.baseScenarioId, reason: 'finalize' }, { today: SNAP_DAY });
    const whatIf = (await createScenario(fx.scopeA, fx.actor, fx.taxpayerId, YEAR, 'If you buy the truck')).id;
    await db.update(taxEstScenarios).set({ showInPortal: true }).where(eq(taxEstScenarios.id, whatIf));
    const wi = await createSnapshot(adminScope, { tenantId: fx.T.schc, userId: uid['admin']! }, { taxpayerId: fx.taxpayerId, taxYear: YEAR, scenarioId: whatIf, reason: 'finalize' }, { today: SNAP_DAY });
    expect(wi.createdAt > base.createdAt).toBe(true); // the what-if's is the newest finalized snapshot
    await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: 'snapshot' });
    try {
      const t = await ownerCard();
      expect(t.source).toBe('snapshot');
      expect(t.asOf).toBe(base.createdAt);
      // Kurt 2026-10-13: staff cards are Base-only too — the newer what-if snapshot is never used.
      const staff = await companyCardsForStaff(adminScope, fx.T.schc, fx.C.schc, { today: TODAY });
      const st = staff!.taxpayers.find((x) => x.taxpayerId === fx.taxpayerId)!;
      if (st.source === 'snapshot') expect(st.asOf).toBe(base.createdAt);
      expect(st.asOf).not.toBe(wi.createdAt);
      const firm = await firmDashboard(adminScope, { today: TODAY });
      const asOfs = [...(firm?.vouchersDue ?? []), ...(firm?.behind ?? [])].filter((r) => r.taxpayerId === fx.taxpayerId).map((r) => r.asOf);
      expect(asOfs).not.toContain(wi.createdAt);
    } finally {
      await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: null });
    }
  });
});

// Q54 (Kurt, 2026-10-13): per-taxpayer switch "Show on linked company dashboards" (migration
// 0215, default OFF). OFF hides the taxpayer's company cards for staff AND the owner; the
// firm-wide cards are unaffected; editing it is a taxpayer write (audited, readonly 403,
// hidden 404).
describe('Q54 company-dashboard switch', () => {
  const setShow = (key: string, id: string, on: boolean) => new Promise<Res>((resolve, reject) => {
    const data = JSON.stringify({ showOnCompanyDashboard: on });
    const r = http.request({
      hostname: '127.0.0.1', port, path: `${TE}/taxpayers/${id}`, method: 'PATCH',
      headers: { Authorization: `Bearer ${tokens[key]}`, 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { let json: unknown = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; } resolve({ status: res.statusCode ?? 0, json }); });
    });
    r.on('error', reject); r.write(data); r.end();
  });

  it('a new taxpayer defaults OFF', async () => {
    const t = await createTaxpayer(fx.scopeA, fx.actor, { displayName: 'Default Off', filingStatus: 'single' });
    expect(t.showOnCompanyDashboard).toBe(false);
    await db.delete(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, t.id));
  });

  it('OFF hides the company cards for staff and owner (section gone when none qualifies); firm cards unaffected; ON restores', async () => {
    await db.update(taxEstTaxpayers).set({ showOnCompanyDashboard: false }).where(eq(taxEstTaxpayers.id, fx.taxpayerId));
    try {
      const staff = await call('GET', DASH, 'staff');
      expect(names(staff.json.data)).toEqual(['Other Owner']);
      const owner = await call('GET', DASH, 'owner');
      expect(owner.status).toBe(200);
      expect(owner.json.data).toBeNull(); // the owner's only taxpayer is switched off → no section
      const refresh = await call('POST', `${DASH}/${fx.taxpayerId}/refresh`, 'admin');
      expect(refresh.status).toBe(404);
      expect(refresh.json.error.code).toBe('TE_TAXPAYER_NOT_FOUND');
      await db.update(taxEstTaxpayers).set({ showOnCompanyDashboard: false }).where(eq(taxEstTaxpayers.id, otherOwner));
      const none = await call('GET', DASH, 'admin');
      expect(none.json.data).toBeNull();
      // Firm-wide Tax Estimator cards still count both taxpayers.
      const firm = await call('GET', `${TE}/dashboard`, tokenIn('admin', P));
      expect(firm.json.data.visibleTaxpayers).toBe(2);
    } finally {
      await db.update(taxEstTaxpayers).set({ showOnCompanyDashboard: true }).where(inArray(taxEstTaxpayers.id, [fx.taxpayerId, otherOwner]));
    }
    expect(names((await call('GET', DASH, 'staff')).json.data)).toEqual(['Carlos & Maria Rivera', 'Other Owner']);
    expect((await call('GET', DASH, 'owner')).json.data.audience).toBe('owner');
  });

  it('ON still follows visibility: a staff list that does not name the viewer hides the card', async () => {
    await db.insert(taxEstTaxpayerStaff).values([
      { firmId: FIRM_A, taxpayerId: otherOwner, userId: uid['admin']!, createdBy: uid['admin']! },
    ]);
    try {
      expect(names((await call('GET', DASH, 'staff')).json.data)).toEqual(['Carlos & Maria Rivera']);
      expect(names((await call('GET', DASH, 'admin')).json.data)).toEqual(['Carlos & Maria Rivera', 'Other Owner']);
    } finally {
      await db.delete(taxEstTaxpayerStaff).where(eq(taxEstTaxpayerStaff.firmId, FIRM_A));
    }
  });

  it('toggle: firm staff may (audited before/after); readonly 403; a hidden taxpayer 404', async () => {
    const pt = tokenIn('staff', P);
    const off = await setShow(pt, otherOwner, false);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(off.json.data.showOnCompanyDashboard).toBe(false);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, otherOwner));
    const row = rows.find((r) => r.entityType === 'tax_est_taxpayer' && r.userId === uid['staff']);
    expect(row).toBeDefined();
    expect((row!.beforeData as { showOnCompanyDashboard: boolean }).showOnCompanyDashboard).toBe(true);
    expect((row!.afterData as { showOnCompanyDashboard: boolean }).showOnCompanyDashboard).toBe(false);
    expect((await setShow(pt, otherOwner, true)).status).toBe(200);

    await mkUser('ro', P, { firm: FIRM_A, firmRole: 'firm_readonly', access: [P, fx.T.schc] });
    await db.update(firmUsers).set({ capabilities: { tax_estimator_view_taxpayers: true } }).where(eq(firmUsers.userId, uid['ro']!));
    const ro = await setShow('ro', otherOwner, false);
    expect(ro.status).toBe(403);

    // `none` reaches no linked tenant → Other Owner is hidden from it.
    const hidden = await setShow('none', otherOwner, false);
    expect(hidden.status).toBe(404);
    expect(hidden.json.error.code).toBe('TE_TAXPAYER_NOT_FOUND');
    const [t] = await db.select({ on: taxEstTaxpayers.showOnCompanyDashboard }).from(taxEstTaxpayers).where(eq(taxEstTaxpayers.id, otherOwner));
    expect(t!.on).toBe(true);
  });
});
