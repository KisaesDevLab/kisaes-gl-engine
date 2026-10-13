// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Q51 — per-portal-contact view options and shared scenarios, HTTP level.
//   - defaults reproduce the pre-Q51 response byte for byte,
//   - a section switched off is ABSENT from the JSON (not hidden), the voucher PDF needs
//     quarterly_estimates, the client estimate PDF needs pdf_download (and is audited),
//   - the calculation summary carries only allow-listed fields,
//   - Base is always offered; a what-if only when shared, otherwise 404; snapshot mode offers
//     a scenario only when it has a finalized snapshot,
//   - grant / revoke asymmetry (Q41(7)): tenant-side staff may switch sections off, not on,
//   - options of one contact never reach another (shared Redis estimate cache), another
//     tenant's staff cannot read or write them, and "View as Client" shows the contact's view.

import { randomUUID } from 'node:crypto';
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import {
  auditLog, companies, firms, firmUsers, portalContactCompanies, portalContacts, portalContactSessions, previewSessions,
  taxEstFirmSettings, taxEstPortalContactOptions, taxEstTaxpayerContacts, taxEstTaxpayers, tenantFeatureFlags, tenantFirmAssignments,
  userTenantAccess, users,
} from '../db/schema/index.js';
import { errorHandler } from '../middleware/error-handler.js';
import { closeTbRedis } from '../services/tb/tb-redis.js';
import { purgeTenants } from '../services/tax-estimator/entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from '../services/tax-estimator/rivera.test-fixtures.js';
import { updateTaxpayer } from '../services/tax-estimator/taxpayers.service.js';
import { createScenario } from '../services/tax-estimator/scenarios.service.js';
import { createSnapshot } from '../services/tax-estimator/estimate-snapshots.service.js';
import { resolveForContact } from '../services/tax-estimator/portal-estimates.service.js';
import * as portalAuth from '../services/portal-auth.service.js';
import { portalTaxEstimatesPublicRouter } from './portal-tax-estimates-public.routes.js';
import { portalContactsRouter } from './portal-contacts.routes.js';
import { taxEstimatorRouter } from './tax-estimator.routes.js';

const FIRM_A = randomUUID();
const FIRM_B = randomUUID();
const USER = randomUUID();
const BASE = '/api/portal/tax-estimates';
let fx: RiveraFixture;
let server: Server | null = null;
let port = 0;
let whatIf = '';
let privatePlan = '';
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};
const contacts: Record<string, string> = {};
const cookies: Record<string, string> = {};

type Res = { status: number; json: any; raw: Buffer; headers: http.IncomingHttpHeaders };

function call(method: string, path: string, headers: Record<string, string> = {}, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { ...headers, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(data)) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let json: unknown = null;
        try { json = JSON.parse(raw.toString('utf8')); } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, json, raw, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const as = (key: string, companyId?: string) => ({ Authorization: `Bearer ${tokens[key]}`, 'X-Company-Id': companyId ?? fx.C.schc });
const portal = (key: string) => ({ Cookie: `kisbooks_portal_session=${cookies[key]}` });
const preview = (token: string) => ({ Cookie: `kisbooks_portal_preview=${encodeURIComponent(token)}` });
const detail = (key: string, extra = '') => call('GET', `${BASE}/${fx.taxpayerId}?year=2026${extra}`, portal(key));
const optionsUrl = (key: string) => `/api/v1/practice/portal/contacts/${contacts[key]}/tax-estimate-options`;

async function mkUser(key: string, tenantId: string, opts: { role?: string; firm?: string; access?: string[] } = {}) {
  const role = opts.role ?? 'accountant';
  const [u] = await db.insert(users).values({
    tenantId, email: `te-q51-${key}-${randomUUID().slice(0, 8)}@example.com`, passwordHash: await bcrypt.hash('x-secret-12345', 4),
    displayName: key, role, userType: 'staff',
  }).returning();
  userIds[key] = u!.id;
  if (opts.firm) await db.insert(firmUsers).values({ firmId: opts.firm, userId: u!.id, firmRole: 'firm_staff' });
  for (const t of opts.access ?? []) await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: t, role });
  tokens[key] = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '10m' });
}

async function mkContact(key: string, tenantId: string, companyId: string, mapTo: string[]) {
  const [c] = await db.insert(portalContacts).values({ tenantId, email: `te-q51-${key}-${randomUUID().slice(0, 8)}@ex.com`, status: 'active' }).returning();
  contacts[key] = c!.id;
  await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId, taxEstimatesAccess: true });
  for (const tp of mapTo) await db.insert(taxEstTaxpayerContacts).values({ taxpayerId: tp, portalContactId: c!.id });
  const token = crypto.randomBytes(32).toString('hex');
  await db.insert(portalContactSessions).values({
    tenantId, contactId: c!.id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600_000),
  });
  cookies[key] = token;
}

async function setFlag(tenantId: string, flagKey: 'CLIENT_PORTAL_V1' | 'TAX_ESTIMATOR_V1', enabled: boolean) {
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey, enabled })
    .onConflictDoUpdate({ target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey], set: { enabled } });
}

function paths(v: unknown, prefix = '', out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    out.add(`${prefix}[]`);
    for (const x of v) paths(x, `${prefix}[]`, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      paths(x, p, out);
    }
  }
  return out;
}

const SUMMARY_PATHS = new Set([
  'estimate.calculationSummary',
  ...['businesses', 'otherIncome', 'states'].flatMap((k) => [`estimate.calculationSummary.${k}`, `estimate.calculationSummary.${k}[]`]),
  'estimate.calculationSummary.businesses[].name', 'estimate.calculationSummary.businesses[].amount',
  'estimate.calculationSummary.otherIncome[].label', 'estimate.calculationSummary.otherIncome[].amount',
  'estimate.calculationSummary.states[].state', 'estimate.calculationSummary.states[].label', 'estimate.calculationSummary.states[].amount',
  'estimate.calculationSummary.deduction', 'estimate.calculationSummary.deduction.kind', 'estimate.calculationSummary.deduction.amount',
  ...['totalIncome', 'adjustmentsTotal', 'agi', 'additionalDeductions', 'qbiDeduction', 'taxableIncome', 'regularTax', 'credits',
    'selfEmploymentTax', 'additionalMedicareTax', 'niit', 'federalTotal', 'stateTotal', 'total'].map((k) => `estimate.calculationSummary.${k}`),
]);

beforeAll(async () => {
  await db.insert(firms).values([{ id: FIRM_A, name: 'Rivera CPA LLC', slug: `te-q51-a-${FIRM_A.slice(0, 8)}` }, { id: FIRM_B, name: 'Other Firm', slug: `te-q51-b-${FIRM_B.slice(0, 8)}` }]);
  fx = await seedRivera(FIRM_A, FIRM_B, USER);
  await db.insert(tenantFirmAssignments).values([fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })));
  await db.insert(tenantFirmAssignments).values({ tenantId: fx.T.other, firmId: FIRM_B });
  for (const t of [fx.T.schc, fx.T.other]) {
    await setFlag(t, 'CLIENT_PORTAL_V1', true);
    await setFlag(t, 'TAX_ESTIMATOR_V1', true);
  }
  await mkUser('staff', fx.T.schc, { firm: FIRM_A, access: [fx.T.schc, fx.T.scorp, fx.T.lp] });
  await mkUser('bookkeeper', fx.T.schc, { role: 'bookkeeper' }); // tenant staff, NOT a firm member
  await mkUser('otherStaff', fx.T.other, { firm: FIRM_B, access: [fx.T.other] });
  await mkContact('good', fx.T.schc, fx.C.schc, [fx.taxpayerId]);
  await mkContact('spouse', fx.T.schc, fx.C.schc, [fx.taxpayerId]);
  const [oc] = await db.insert(companies).values({ tenantId: fx.T.other, businessName: 'Other Tenant Co' }).returning();
  await mkContact('elsewhere', fx.T.other, oc!.id, []);
  whatIf = (await createScenario(fx.scopeA, fx.actor, fx.taxpayerId, 2026, 'If you buy the truck')).id;
  privatePlan = (await createScenario(fx.scopeA, fx.actor, fx.taxpayerId, 2026, 'Staff only plan')).id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/practice/portal', portalContactsRouter);
  app.use('/api/v1/tax-estimator', taxEstimatorRouter);
  app.use(BASE, portalTaxEstimatesPublicRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await db.delete(previewSessions).where(eq(previewSessions.tenantId, fx.T.schc));
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B]));
  await db.delete(auditLog).where(inArray(auditLog.tenantId, [fx.T.schc, fx.T.other, fx.T.scorp, fx.T.lp]));
  await db.delete(auditLog).where(eq(auditLog.userId, USER));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other]);
  await db.delete(firms).where(inArray(firms.id, [FIRM_A, FIRM_B]));
  await closeTbRedis();
  await pool.end();
});

describe('defaults = the view before Q51', () => {
  it('the detail is byte-identical to the pre-Q51 projection; no new keys; estimate PDF 404, vouchers 200', async () => {
    const r = await detail('good');
    expect(r.status).toBe(200);
    const resolved = await resolveForContact({ contactId: contacts['good']!, tenantId: fx.T.schc, companyId: null }, fx.taxpayerId, 2026);
    expect(r.raw.toString('utf8')).toBe(JSON.stringify({ estimate: resolved.full, unavailableReason: null }));
    expect(Object.keys(r.json)).toEqual(['estimate', 'unavailableReason']);
    expect(r.json.estimate.calculationSummary).toBeUndefined();
    expect((await call('GET', `${BASE}/${fx.taxpayerId}/estimate.pdf?year=2026`, portal('good'))).status).toBe(404);
    expect((await call('GET', `${BASE}/${fx.taxpayerId}/vouchers.pdf?year=2026`, portal('good'))).status).toBe(200);
  }, 180_000);
});

describe('options editor — grant / revoke asymmetry (Q41(7))', () => {
  it('GET returns the defaults; canGrant only for staff who pass the Tax Estimator gates', async () => {
    const s = await call('GET', optionsUrl('good'), as('staff'));
    expect(s.status).toBe(200);
    expect(s.json).toEqual({ options: { calculationSummary: false, quarterlyEstimates: true, paymentsOnRecord: true, pdfDownload: false }, canGrant: true });
    const b = await call('GET', optionsUrl('good'), as('bookkeeper'));
    expect(b.status).toBe(200);
    expect(b.json.canGrant).toBe(false);
  });

  it('tenant-side staff may switch a section off but not on; firm staff may grant; every change is audited', async () => {
    const denied = await call('PUT', optionsUrl('good'), as('bookkeeper'), { calculationSummary: true });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.json)).toContain('TE_ACCESS_GRANT_FORBIDDEN');
    // A mixed request (one revoke + one grant) is refused whole.
    expect((await call('PUT', optionsUrl('good'), as('bookkeeper'), { paymentsOnRecord: false, pdfDownload: true })).status).toBe(403);
    expect(await db.select().from(taxEstPortalContactOptions).where(eq(taxEstPortalContactOptions.portalContactId, contacts['good']!))).toEqual([]);

    const revoked = await call('PUT', optionsUrl('good'), as('bookkeeper'), { paymentsOnRecord: false });
    expect(revoked.status).toBe(200);
    expect(revoked.json.options.paymentsOnRecord).toBe(false);
    const granted = await call('PUT', optionsUrl('good'), as('staff'), { calculationSummary: true, pdfDownload: true });
    expect(granted.status).toBe(200);
    expect(granted.json.options).toEqual({ calculationSummary: true, quarterlyEstimates: true, paymentsOnRecord: false, pdfDownload: true });
    // Re-granting a revoked section is a grant again.
    expect((await call('PUT', optionsUrl('good'), as('bookkeeper'), { paymentsOnRecord: true })).status).toBe(403);
    expect((await call('PUT', optionsUrl('good'), as('staff'), {})).status).toBe(400);

    const rows = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, fx.T.schc), eq(auditLog.entityType, 'tax_est_portal_options'), eq(auditLog.entityId, contacts['good']!)));
    const afters = rows.map((r) => r.afterData as { granted: string[]; revoked: string[]; via: string });
    expect(afters).toEqual(expect.arrayContaining([
      expect.objectContaining({ revoked: ['paymentsOnRecord'], granted: [], via: 'portal_contact' }),
      expect.objectContaining({ granted: ['calculationSummary', 'pdfDownload'], revoked: [] }),
    ]));
    expect(rows.map((r) => r.userId)).toEqual(expect.arrayContaining([userIds['bookkeeper'], userIds['staff']]));
  });

  it('another tenant\'s staff can neither read nor write a contact\'s options (404)', async () => {
    expect((await call('GET', optionsUrl('good'), as('otherStaff', undefined))).status).toBe(404);
    expect((await call('PUT', optionsUrl('good'), as('otherStaff'), { paymentsOnRecord: false })).status).toBe(404);
    expect((await call('GET', optionsUrl('good'), { Authorization: `Bearer ${tokens['otherStaff']}` })).status).toBe(404);
  });
});

describe('the portal applies the contact\'s options server-side', () => {
  it('payments absent, calculation summary present (allow-listed), PDF offered; the other contact still sees the defaults', async () => {
    const r = await detail('good');
    expect(r.status).toBe(200);
    expect(r.json.estimate.payments).toBeUndefined();
    expect(Array.isArray(r.json.estimate.jurisdictions)).toBe(true);
    expect(r.json.pdfDownload).toBe(true);
    const s = r.json.estimate.calculationSummary;
    expect(s).toBeTruthy();
    const extra = [...paths(r.json.estimate.calculationSummary, 'estimate.calculationSummary')].filter((p) => !SUMMARY_PATHS.has(p));
    expect(extra).toEqual([]);
    expect(s.total).toBe(r.json.estimate.totals.total);
    // Only the taxpayer's own share per business: never the entity total of a business the
    // taxpayer owns only part of, never an owner name, rate, trace or warning.
    const resolved = await resolveForContact({ contactId: contacts['good']!, tenantId: fx.T.schc, companyId: null }, fx.taxpayerId, 2026);
    const partial = resolved.result!.federal.entities.filter((e) => e.shares.every((x) => Number(x.profitFraction) < 1));
    expect(partial.length).toBeGreaterThan(0);
    for (const e of partial) {
      const row = s.businesses.find((b: { name: string }) => b.name === e.companyName);
      expect(row).toBeTruthy();
      expect(Number(row.amount)).not.toBe(Math.round(Number(e.projectedProfit)));
    }
    const text = JSON.stringify(s);
    for (const banned of ['Carlos', 'Maria Rivera', 'trace', 'rate', 'marginal', 'parameter', 'warning', 'verify', 'Verify', '%', 'owner']) {
      expect(text, banned).not.toContain(banned);
    }
    // Isolation: the spouse contact shares the cached estimate but keeps the default view.
    const other = await detail('spouse');
    const resolvedOther = await resolveForContact({ contactId: contacts['spouse']!, tenantId: fx.T.schc, companyId: null }, fx.taxpayerId, 2026);
    expect(other.raw.toString('utf8')).toBe(JSON.stringify({ estimate: resolvedOther.full, unavailableReason: null }));
  }, 180_000);

  it('the client estimate PDF downloads (audited) only for a contact with pdf_download', async () => {
    const pdf = await call('GET', `${BASE}/${fx.taxpayerId}/estimate.pdf?year=2026`, portal('good'));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.headers['cache-control']).toBe('no-store');
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, fx.T.schc), eq(auditLog.entityType, 'tax_est_portal_pdf')));
    expect(row?.action).toBe('download');
    expect(row?.afterData).toMatchObject({ portalContactId: contacts['good'], taxYear: 2026, scenarioId: fx.baseScenarioId, source: 'live', preview: false });
    expect((await call('GET', `${BASE}/${fx.taxpayerId}/estimate.pdf?year=2026`, portal('spouse'))).status).toBe(404);
    expect((await call('GET', `${BASE}/${fx.taxpayerId}/estimate.pdf?year=2026`, portal('elsewhere'))).status).toBe(404);
  }, 180_000);

  it('quarterly estimates off: no installments / next payment in the JSON and the voucher PDF is 404', async () => {
    expect((await call('PUT', optionsUrl('good'), as('bookkeeper'), { quarterlyEstimates: false })).status).toBe(200);
    const r = await detail('good');
    expect(r.json.estimate.jurisdictions).toBeUndefined();
    expect(r.json.estimate.totals.total).toBeTruthy(); // the projected total always stays
    expect(r.raw.toString('utf8')).not.toContain('nextPayment');
    expect((await call('GET', `${BASE}/${fx.taxpayerId}/vouchers.pdf?year=2026`, portal('good'))).status).toBe(404);
    expect((await call('GET', `${BASE}/${fx.taxpayerId}/vouchers.pdf?year=2026`, portal('spouse'))).status).toBe(200);
    expect((await call('PUT', optionsUrl('good'), as('staff'), { quarterlyEstimates: true })).status).toBe(200);
  }, 180_000);

  it('"View as Client" shows the previewed contact\'s options', async () => {
    const pvGood = await portalAuth.startPreview({
      initiatingUserId: userIds['staff']!, initiatingUserRole: 'accountant', tenantId: fx.T.schc, contactId: contacts['good']!, companyId: fx.C.schc, origin: 'contact_detail',
    });
    const g = await call('GET', `${BASE}/${fx.taxpayerId}?year=2026`, preview(pvGood.token));
    expect(g.status).toBe(200);
    expect(g.json.estimate.calculationSummary).toBeTruthy();
    expect(g.json.estimate.payments).toBeUndefined();
    expect(g.json.pdfDownload).toBe(true);
    const pvSpouse = await portalAuth.startPreview({
      initiatingUserId: userIds['staff']!, initiatingUserRole: 'accountant', tenantId: fx.T.schc, contactId: contacts['spouse']!, companyId: fx.C.schc, origin: 'contact_detail',
    });
    const sp = await call('GET', `${BASE}/${fx.taxpayerId}?year=2026`, preview(pvSpouse.token));
    expect(sp.status).toBe(200);
    expect(Object.keys(sp.json)).toEqual(['estimate', 'unavailableReason']);
    expect(sp.json.estimate.calculationSummary).toBeUndefined();
    expect(Array.isArray(sp.json.estimate.payments)).toBe(true);
    expect((await call('GET', `${BASE}/${fx.taxpayerId}/estimate.pdf?year=2026`, preview(pvSpouse.token))).status).toBe(404);
  }, 180_000);
});

describe('scenarios shared in the portal', () => {
  it('only Base until staff share a what-if; then a picker; an unshared or malformed scenario is 404', async () => {
    expect((await detail('spouse')).json.scenarios).toBeUndefined();
    expect((await detail('spouse', `&scenarioId=${whatIf}`)).status).toBe(404);
    // Tenant staff outside the firm cannot share a scenario.
    expect([403, 404]).toContain((await call('PATCH', `/api/v1/tax-estimator/scenarios/${whatIf}`, as('bookkeeper'), { showInPortal: true })).status);
    const shared = await call('PATCH', `/api/v1/tax-estimator/scenarios/${whatIf}`, as('staff'), { showInPortal: true });
    expect(shared.status).toBe(200);
    expect(shared.json.data).toMatchObject({ id: whatIf, name: 'If you buy the truck', showInPortal: true });
    // Base ignores the switch (always shown).
    const baseRes = await call('PATCH', `/api/v1/tax-estimator/scenarios/${fx.baseScenarioId}`, as('staff'), { showInPortal: true });
    expect(baseRes.status).toBe(200);
    expect(baseRes.json.data.showInPortal).toBe(false);

    const r = await detail('spouse');
    expect(r.json.scenarios).toEqual([
      { id: fx.baseScenarioId, name: 'Base', isBase: true },
      { id: whatIf, name: 'If you buy the truck', isBase: false },
    ]);
    expect(r.json.scenarioId).toBe(fx.baseScenarioId);
    const picked = await detail('spouse', `&scenarioId=${whatIf}`);
    expect(picked.status).toBe(200);
    expect(picked.json.scenarioId).toBe(whatIf);
    expect((await detail('spouse', `&scenarioId=${privatePlan}`)).status).toBe(404);
    expect((await detail('spouse', '&scenarioId=not-a-uuid')).status).toBe(404);
    expect((await detail('spouse', `&scenarioId=${randomUUID()}`)).status).toBe(404);
    expect((await call('GET', `${BASE}/${fx.taxpayerId}/vouchers.pdf?year=2026&scenarioId=${whatIf}`, portal('spouse'))).status).toBe(200);
    expect((await call('GET', `${BASE}/${fx.taxpayerId}/vouchers.pdf?year=2026&scenarioId=${privatePlan}`, portal('spouse'))).status).toBe(404);
  }, 180_000);

  it('snapshot mode: a scenario is offered only with a finalized snapshot of its own', async () => {
    await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: 'snapshot' });
    try {
      expect((await detail('spouse')).json).toEqual({ estimate: null, unavailableReason: 'no_snapshot' });
      const truck = await createSnapshot(fx.scopeA, fx.actor, { taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: whatIf, throughMonth: '2026-09', reason: 'finalize' });
      const onlyTruck = await detail('spouse');
      expect(onlyTruck.json.estimate.source).toBe('snapshot');
      expect(onlyTruck.json.estimate.asOf).toBe(truck.createdAt);
      expect(onlyTruck.json.scenarios).toBeUndefined(); // one scenario offered: no picker
      expect((await detail('spouse', `&scenarioId=${fx.baseScenarioId}`)).status).toBe(404);
      const base = await createSnapshot(fx.scopeA, fx.actor, { taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: fx.baseScenarioId, throughMonth: '2026-09', reason: 'finalize' });
      const both = await detail('spouse');
      expect(both.json.scenarioId).toBe(fx.baseScenarioId);
      expect(both.json.estimate.asOf).toBe(base.createdAt);
      expect(both.json.scenarios.map((s: { id: string }) => s.id)).toEqual([fx.baseScenarioId, whatIf]);
      // The client estimate PDF of a snapshot is that snapshot (audited with its id).
      const pdf = await call('GET', `${BASE}/${fx.taxpayerId}/estimate.pdf?year=2026&scenarioId=${whatIf}`, portal('good'));
      expect(pdf.status).toBe(200);
      const rows = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, fx.T.schc), eq(auditLog.entityType, 'tax_est_portal_pdf')));
      expect(rows.map((x) => x.afterData)).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'snapshot', snapshotId: truck.id, scenarioId: whatIf })]));
    } finally {
      await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: null });
    }
  }, 300_000);
});

describe('taxpayer page (firm side)', () => {
  it('lists each linked contact\'s options and lets firm staff set them; tenant staff and unlinked contacts are refused', async () => {
    const list = await call('GET', `/api/v1/tax-estimator/taxpayers/${fx.taxpayerId}/contacts`, as('staff'));
    expect(list.status).toBe(200);
    const spouse = list.json.data.find((c: { portalContactId: string }) => c.portalContactId === contacts['spouse']);
    expect(spouse.portalOptions).toEqual({ calculationSummary: false, quarterlyEstimates: true, paymentsOnRecord: true, pdfDownload: false });
    const set = await call('PUT', `/api/v1/tax-estimator/taxpayers/${fx.taxpayerId}/contacts/${contacts['spouse']}/portal-options`, as('staff'), { pdfDownload: true });
    expect(set.status).toBe(200);
    expect(set.json.data.portalOptions.pdfDownload).toBe(true);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'tax_est_portal_options'), eq(auditLog.entityId, contacts['spouse']!)));
    expect(audit?.tenantId).toBe(fx.T.schc); // the CONTACT's tenant
    expect(audit?.afterData).toMatchObject({ via: 'taxpayer', taxpayerId: fx.taxpayerId, granted: ['pdfDownload'] });
    expect([403, 404]).toContain((await call('PUT', `/api/v1/tax-estimator/taxpayers/${fx.taxpayerId}/contacts/${contacts['spouse']}/portal-options`, as('bookkeeper'), { pdfDownload: false })).status);
    const unlinked = await call('PUT', `/api/v1/tax-estimator/taxpayers/${fx.taxpayerId}/contacts/${contacts['elsewhere']}/portal-options`, as('staff'), { pdfDownload: true });
    expect(unlinked.status).toBe(404);
  });

  it('options are per contact: deleting the contact removes its row', async () => {
    await db.delete(portalContacts).where(eq(portalContacts.id, contacts['spouse']!));
    expect(await db.select().from(taxEstPortalContactOptions).where(eq(taxEstPortalContactOptions.portalContactId, contacts['spouse']!))).toEqual([]);
  });
});
