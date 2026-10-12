// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator Phase 13 — portal isolation (PHASES.md acceptance; MODULE.md "Access").
// The portal router must enforce: portal session → CLIENT_PORTAL_V1 + TAX_ESTIMATOR_V1
// on the CONTACT's tenant → contact ↔ taxpayer mapping → tax_estimates_access on a
// company the taxpayer is linked to → the taxpayer belongs to the firm managing the
// contact's tenant. And the payload is an ALLOW-LIST: asserted key by key below, so a
// field added to the projection without a privacy decision fails here.

import { randomUUID } from 'node:crypto';
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import {
  auditLog, companies, firms, portalContactCompanies, portalContacts, portalContactSessions, taxEstFirmSettings,
  taxEstTaxpayerContacts, taxEstTaxpayers, tenantFeatureFlags, tenantFirmAssignments,
} from '../db/schema/index.js';
import { errorHandler } from '../middleware/error-handler.js';
import { closeTbRedis } from '../services/tb/tb-redis.js';
import { purgeTenants } from '../services/tax-estimator/entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from '../services/tax-estimator/rivera.test-fixtures.js';
import { createTaxpayer, upsertLink, upsertPerson, updateTaxpayer } from '../services/tax-estimator/taxpayers.service.js';
import { upsertYear } from '../services/tax-estimator/years.service.js';
import { createSnapshot } from '../services/tax-estimator/estimate-snapshots.service.js';
import { portalTaxEstimatesPublicRouter } from './portal-tax-estimates-public.routes.js';

const FIRM_A = randomUUID();
const FIRM_B = randomUUID();
const USER = randomUUID();
const BASE = '/api/portal/tax-estimates';

let fx: RiveraFixture;
let server: Server | null = null;
let port = 0;
let otherCompany = '';
let firmBTaxpayer = '';
let hankTaxpayer = '';
const contacts: Record<string, string> = {};
const cookies: Record<string, string> = {};

function request(path: string, cookie?: string): Promise<{ status: number; json: any; raw: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'GET',
      headers: cookie ? { Cookie: `kisbooks_portal_session=${cookie}` } : {},
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        const text = raw.toString('utf8');
        let json: unknown = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json, raw, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function mkContact(key: string, companyAccess: Array<{ companyId: string; taxEstimatesAccess: boolean }>, mapTo: string[]) {
  const [c] = await db.insert(portalContacts).values({ tenantId: fx.T.schc, email: `${key}-${randomUUID().slice(0, 8)}@ex.com`, status: 'active' }).returning();
  contacts[key] = c!.id;
  for (const a of companyAccess) await db.insert(portalContactCompanies).values({ contactId: c!.id, companyId: a.companyId, taxEstimatesAccess: a.taxEstimatesAccess });
  for (const tp of mapTo) await db.insert(taxEstTaxpayerContacts).values({ taxpayerId: tp, portalContactId: c!.id });
  const token = crypto.randomBytes(32).toString('hex');
  await db.insert(portalContactSessions).values({
    tenantId: fx.T.schc, contactId: c!.id, tokenHash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600_000),
  });
  cookies[key] = token;
}

async function setFlag(flagKey: 'CLIENT_PORTAL_V1' | 'TAX_ESTIMATOR_V1', enabled: boolean) {
  await db.insert(tenantFeatureFlags).values({ tenantId: fx.T.schc, flagKey, enabled })
    .onConflictDoUpdate({ target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey], set: { enabled } });
}

beforeAll(async () => {
  await db.insert(firms).values([{ id: FIRM_A, name: 'Rivera CPA LLC', slug: `te13p-a-${FIRM_A.slice(0, 8)}` }, { id: FIRM_B, name: 'Other Firm', slug: `te13p-b-${FIRM_B.slice(0, 8)}` }]);
  fx = await seedRivera(FIRM_A, FIRM_B, USER);
  // Firm A manages the Rivera tenants (the contact lives in T.schc); firm B manages T.other.
  await db.insert(tenantFirmAssignments).values([fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })));
  await db.insert(tenantFirmAssignments).values({ tenantId: fx.T.other, firmId: FIRM_B });
  await setFlag('CLIENT_PORTAL_V1', true);
  await setFlag('TAX_ESTIMATOR_V1', true);
  const [oc] = await db.insert(companies).values({ tenantId: fx.T.schc, businessName: 'Rivera Side Hustle' }).returning();
  otherCompany = oc!.id;

  // A firm-B taxpayer linked to the SAME company (firm B's scope reaches T.schc in the
  // fixture) — invisible to the portal because T.schc is managed by firm A.
  const b = await createTaxpayer(fx.scopeB, fx.actor, { displayName: 'Firm B Person', filingStatus: 'single', residentState: 'MO' });
  firmBTaxpayer = b.id;
  await upsertPerson(fx.scopeB, fx.actor, b.id, 'primary', { firstName: 'B', lastName: 'Person', dateOfBirth: '1970-01-01', isBlind: false });
  await upsertLink(fx.scopeB, fx.actor, b.id, { personRole: 'primary', taxYear: 2026, tenantId: fx.T.schc, companyId: fx.C.schc, profitPct: 100, isOfficer: false, activityType: 'active', activeParticipation: false });
  await upsertYear(fx.scopeB, fx.actor, b.id, 2026, {});
  // A firm-A taxpayer with NO link into the contact's tenant (S corp only).
  const h = await createTaxpayer(fx.scopeA, fx.actor, { displayName: 'Other Owner', filingStatus: 'single', residentState: 'MO' });
  hankTaxpayer = h.id;
  await upsertPerson(fx.scopeA, fx.actor, h.id, 'primary', { firstName: 'Other', lastName: 'Owner', dateOfBirth: '1970-01-01', isBlind: false });
  await upsertLink(fx.scopeA, fx.actor, h.id, { personRole: 'primary', taxYear: 2026, tenantId: fx.T.scorp, companyId: fx.C.scorp, profitPct: 50, isOfficer: false, activityType: 'active', activeParticipation: false });
  await upsertYear(fx.scopeA, fx.actor, h.id, 2026, {});

  await mkContact('good', [{ companyId: fx.C.schc, taxEstimatesAccess: true }, { companyId: otherCompany, taxEstimatesAccess: true }], [fx.taxpayerId, firmBTaxpayer, hankTaxpayer]);
  await mkContact('noAccess', [{ companyId: fx.C.schc, taxEstimatesAccess: false }], [fx.taxpayerId]);
  await mkContact('unmapped', [{ companyId: fx.C.schc, taxEstimatesAccess: true }], []);

  const app = express();
  app.use(express.json());
  app.use(BASE, portalTaxEstimatesPublicRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B])); // cascades persons, links, contacts, snapshots
  await db.delete(auditLog).where(eq(auditLog.userId, USER));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other]);
  await db.delete(firms).where(inArray(firms.id, [FIRM_A, FIRM_B]));
  await closeTbRedis();
  await pool.end();
});

// ── the allow-list ──
const ALLOWED_PATHS = new Set([
  'estimate', 'unavailableReason',
  'estimate.taxpayer', 'estimate.taxpayer.id', 'estimate.taxpayer.displayName',
  'estimate.taxYear', 'estimate.source', 'estimate.asOf', 'estimate.booksThrough', 'estimate.firmName', 'estimate.disclaimer',
  'estimate.totals', 'estimate.totals.total', 'estimate.totals.federal', 'estimate.totals.state',
  'estimate.jurisdictions', 'estimate.jurisdictions[]', 'estimate.jurisdictions[].jurisdiction', 'estimate.jurisdictions[].label',
  'estimate.jurisdictions[].estimatesRequired', 'estimate.jurisdictions[].installments', 'estimate.jurisdictions[].installments[]',
  ...['label', 'dueDate', 'amount', 'paid', 'remaining', 'status', 'paidOn'].map((k) => `estimate.jurisdictions[].installments[].${k}`),
  'estimate.jurisdictions[].nextPayment', ...['label', 'dueDate', 'amount'].map((k) => `estimate.jurisdictions[].nextPayment.${k}`),
  'estimate.jurisdictions[].totals', ...['required', 'withholding', 'estimatesPaid', 'remaining'].map((k) => `estimate.jurisdictions[].totals.${k}`),
  'estimate.payments', 'estimate.payments[]', ...['date', 'jurisdiction', 'amount'].map((k) => `estimate.payments[].${k}`),
]);

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

describe('GET /api/portal/tax-estimates (list)', () => {
  it('no session 401; flags off → featureEnabled:false', async () => {
    expect((await request(BASE)).status).toBe(401);
    await setFlag('TAX_ESTIMATOR_V1', false);
    const off = await request(`${BASE}?companyId=${fx.C.schc}`, cookies['good']);
    expect(off.status).toBe(200);
    expect(off.json).toEqual({ featureEnabled: false, taxpayers: [] });
    await setFlag('TAX_ESTIMATOR_V1', true);
    await setFlag('CLIENT_PORTAL_V1', false);
    expect((await request(BASE, cookies['good'])).json.featureEnabled).toBe(false);
    await setFlag('CLIENT_PORTAL_V1', true);
  });

  it('lists only mapped taxpayers of the managing firm linked to a company the contact has access on', async () => {
    const r = await request(`${BASE}?companyId=${fx.C.schc}`, cookies['good']);
    expect(r.status).toBe(200);
    // Not the firm-B taxpayer on the same company; not the firm-A taxpayer with no link into this tenant.
    expect(r.json).toEqual({ featureEnabled: true, taxpayers: [{ id: fx.taxpayerId, displayName: 'Carlos & Maria Rivera', years: [2026] }] });
    // A company of the contact the taxpayer is not linked to → nothing.
    expect((await request(`${BASE}?companyId=${otherCompany}`, cookies['good'])).json.taxpayers).toEqual([]);
    // No tax_estimates_access, or not mapped → nothing.
    expect((await request(BASE, cookies['noAccess'])).json.taxpayers).toEqual([]);
    expect((await request(BASE, cookies['unmapped'])).json.taxpayers).toEqual([]);
  });
});

describe('GET /api/portal/tax-estimates/:taxpayerId', () => {
  it('404 for a contact without access, an unmapped contact, another firm\'s taxpayer, an unlinked taxpayer, a bad id, flags off', async () => {
    const url = (tp: string, extra = '') => `${BASE}/${tp}?year=2026${extra}`;
    expect((await request(url(fx.taxpayerId), cookies['noAccess'])).status).toBe(404);
    expect((await request(url(fx.taxpayerId), cookies['unmapped'])).status).toBe(404);
    expect((await request(url(firmBTaxpayer), cookies['good'])).status).toBe(404);
    expect((await request(url(hankTaxpayer), cookies['good'])).status).toBe(404);
    expect((await request(url(fx.taxpayerId, `&companyId=${otherCompany}`), cookies['good'])).status).toBe(404);
    expect((await request(`${BASE}/${fx.taxpayerId}?year=2025`, cookies['good'])).status).toBe(404);
    expect((await request(`${BASE}/not-a-uuid`, cookies['good'])).status).toBe(404);
    expect((await request(`${BASE}/${fx.taxpayerId}/vouchers.pdf`, cookies['noAccess'])).status).toBe(404);
    await setFlag('TAX_ESTIMATOR_V1', false);
    expect((await request(url(fx.taxpayerId), cookies['good'])).status).toBe(404);
    await setFlag('TAX_ESTIMATOR_V1', true);
    await setFlag('CLIENT_PORTAL_V1', false);
    expect((await request(url(fx.taxpayerId), cookies['good'])).status).toBe(404);
    await setFlag('CLIENT_PORTAL_V1', true);
  });

  it('live by default: the allow-listed summary only — no owners, adjustments, rates, traces or prior-year figures', async () => {
    const r = await request(`${BASE}/${fx.taxpayerId}?year=2026&companyId=${fx.C.schc}`, cookies['good']);
    expect(r.status).toBe(200);
    const extra = [...paths(r.json)].filter((p) => !ALLOWED_PATHS.has(p));
    expect(extra).toEqual([]);
    const e = r.json.estimate;
    expect(e.source).toBe('live');
    expect(e.taxYear).toBe(2026);
    expect(e.firmName).toBe('Rivera CPA LLC');
    expect(e.disclaimer.length).toBeGreaterThan(10);
    expect(e.jurisdictions.map((j: { jurisdiction: string }) => j.jurisdiction)).toEqual(['federal', 'MO', 'AR']);
    expect(e.jurisdictions[0].label).toBe('Federal (IRS)');
    expect(e.jurisdictions[0].installments).toHaveLength(4);
    expect(Number(e.totals.total)).toBeGreaterThan(0);
    expect(new Date(e.asOf).toString()).not.toBe('Invalid Date');
    // Values: no other business names, no persons, no prior-year tax / AGI or the prior-year harbor.
    const text = r.raw.toString('utf8');
    for (const banned of ['Maria Designs', 'Oak Street', 'Rivera Plumbing', '31500', '182000', '34650', '7050', 'SEP contribution', 'Interest income', 'trace', 'parameter', 'rate']) {
      expect(text).not.toContain(banned);
    }
  }, 180_000);

  it('voucher PDF download', async () => {
    const r = await request(`${BASE}/${fx.taxpayerId}/vouchers.pdf?year=2026`, cookies['good']);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 180_000);

  it('portal_shows = snapshot: nothing until a FINALIZED snapshot exists (a pdf snapshot does not count), then the frozen figures', async () => {
    await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: 'snapshot' });
    const url = `${BASE}/${fx.taxpayerId}?year=2026`;
    expect((await request(url, cookies['good'])).json).toEqual({ estimate: null, unavailableReason: 'no_snapshot' });
    await createSnapshot(fx.scopeA, fx.actor, { taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: fx.baseScenarioId, throughMonth: '2026-09', reason: 'pdf' });
    expect((await request(url, cookies['good'])).json.unavailableReason).toBe('no_snapshot');
    const snap = await createSnapshot(fx.scopeA, fx.actor, { taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: fx.baseScenarioId, throughMonth: '2026-09', reason: 'finalize' });
    const r = await request(url, cookies['good']);
    expect(r.status).toBe(200);
    expect(r.json.estimate.source).toBe('snapshot');
    expect(r.json.estimate.asOf).toBe(snap.createdAt);
    expect(r.json.estimate.booksThrough).toBe('2026-09');
    expect([...paths(r.json)].filter((p) => !ALLOWED_PATHS.has(p))).toEqual([]);
    expect(r.json.estimate.totals.total).toBe(snap.summary!.total);
    await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: null });
  }, 180_000);

  it('a tenant leaving the firm hides everything (no managing firm → 404 / empty list)', async () => {
    await db.update(tenantFirmAssignments).set({ isActive: false }).where(and(eq(tenantFirmAssignments.tenantId, fx.T.schc), eq(tenantFirmAssignments.firmId, FIRM_A)));
    expect((await request(BASE, cookies['good'])).json.taxpayers).toEqual([]);
    expect((await request(`${BASE}/${fx.taxpayerId}?year=2026`, cookies['good'])).status).toBe(404);
    await db.update(tenantFirmAssignments).set({ isActive: true }).where(and(eq(tenantFirmAssignments.tenantId, fx.T.schc), eq(tenantFirmAssignments.firmId, FIRM_A)));
  });
});
