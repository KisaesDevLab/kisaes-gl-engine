// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator R4 review regressions (features/tax-estimator/docs/reviews/R4-portal-pack.md),
// HTTP level. Each block is the review's probe turned into an assertion:
//   R4-01  a Report Pack carrying the Tax Estimate section (config, runs, the PDF artifact)
//          is invisible to anyone who fails the Tax Estimator gates — client users, tenant
//          staff outside the firm — and a tax-bearing run is readable only by its requester,
//          in the company it was run for (R4-10).
//   R4-02  "View as Client" previews re-run the Tax Estimator gates on the initiator.
//   R4-05  the firm disclaimer's newlines are paragraphs (no '?'), and the voucher PDF
//          paginates a long disclaimer instead of drawing below the bottom margin.
//   R4-06  no base scenario → 404, never a what-if scenario.
//   R4-07  preview company mismatch is the uniform 404; the flags-off list is no-store.
//   R4-08  a grant of tax_estimates_access needs the Tax Estimator gates; omitting the
//          field keeps the stored value.

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
import { PDFDocument } from 'pdf-lib';
import { db, pool } from '../db/index.js';
import {
  auditLog, companies, firms, firmUsers, portalContactCompanies, portalContacts, portalContactSessions, previewSessions,
  reportPackRuns, taxEstFirmSettings, taxEstTaxpayerContacts, taxEstTaxpayers, tenantFeatureFlags, tenantFirmAssignments,
  userTenantAccess, users,
} from '../db/schema/index.js';
import { taxEstScenarios } from '../db/schema/tax-estimator-years.js';
import { errorHandler } from '../middleware/error-handler.js';
import { closeTbRedis } from '../services/tb/tb-redis.js';
import { purgeTenants } from '../services/tax-estimator/entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from '../services/tax-estimator/rivera.test-fixtures.js';
import { upsertFirmSettings } from '../services/tax-estimator/firm-settings.service.js';
import { pdfDrawnText } from '../services/tax-estimator/pdf-text.test-fixtures.js';
import { reportPackArtifactKey } from '../services/report-pack.service.js';
import { getProviderForTenant } from '../services/storage/storage-provider.factory.js';
import * as portalAuth from '../services/portal-auth.service.js';
import { reportPacksRouter } from './report-packs.routes.js';
import { reportsRouter } from './reports.routes.js';
import { portalTaxEstimatesPublicRouter } from './portal-tax-estimates-public.routes.js';
import { portalContactsRouter } from './portal-contacts.routes.js';

const FIRM_A = randomUUID();
const FIRM_B = randomUUID();
const USER = randomUUID();
let fx: RiveraFixture;
let server: Server | null = null;
let port = 0;
let otherCompany = '';
const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};
let contactId = '';
let contactCookie = '';

type Res = { status: number; json: any; raw: Buffer; headers: http.IncomingHttpHeaders };

async function mkUser(key: string, tenantId: string, opts: { userType?: string; role?: string; firm?: string; access?: string[] } = {}) {
  const role = opts.role ?? (opts.userType === 'client' ? 'owner' : 'accountant');
  const [u] = await db.insert(users).values({
    tenantId, email: `te-r4-${key}-${randomUUID().slice(0, 8)}@example.com`, passwordHash: await bcrypt.hash('x-secret-12345', 4),
    displayName: key, role, userType: opts.userType ?? 'staff',
  }).returning();
  userIds[key] = u!.id;
  if (opts.firm) await db.insert(firmUsers).values({ firmId: opts.firm, userId: u!.id, firmRole: 'firm_staff' });
  for (const t of opts.access ?? []) await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: t, role });
  tokens[key] = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '10m' });
}

function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Res> {
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
const portal = (cookie: string) => ({ Cookie: `kisbooks_portal_session=${cookie}` });
const preview = (token: string) => ({ Cookie: `kisbooks_portal_preview=${encodeURIComponent(token)}` });

async function setFlag(flagKey: 'CLIENT_PORTAL_V1' | 'TAX_ESTIMATOR_V1', enabled: boolean) {
  await db.insert(tenantFeatureFlags).values({ tenantId: fx.T.schc, flagKey, enabled })
    .onConflictDoUpdate({ target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey], set: { enabled } });
}

const PACK = (taxpayerId: string) => ({
  name: 'R4 tax pack', asOfMode: 'custom', asOfCustom: '2026-09-30', periodPreset: 'ytd', coverPage: false, toc: false,
  items: [{ reportId: 'tax-estimate', options: { taxpayerId } }],
});

beforeAll(async () => {
  await db.insert(firms).values([{ id: FIRM_A, name: 'Rivera CPA LLC', slug: `te-r4-a-${FIRM_A.slice(0, 8)}` }, { id: FIRM_B, name: 'Other Firm', slug: `te-r4-b-${FIRM_B.slice(0, 8)}` }]);
  fx = await seedRivera(FIRM_A, FIRM_B, USER);
  await db.insert(tenantFirmAssignments).values([fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })));
  await setFlag('CLIENT_PORTAL_V1', true);
  await setFlag('TAX_ESTIMATOR_V1', true);
  const [oc] = await db.insert(companies).values({ tenantId: fx.T.schc, businessName: 'Rivera Side Hustle' }).returning();
  otherCompany = oc!.id;
  await mkUser('staff', fx.T.schc, { firm: FIRM_A, access: [fx.T.schc, fx.T.scorp, fx.T.lp] });
  await mkUser('staff2', fx.T.schc, { firm: FIRM_A, access: [fx.T.schc, fx.T.scorp, fx.T.lp] });
  await mkUser('client', fx.T.schc, { userType: 'client' });
  // The tenant's in-house bookkeeper: staff, NOT a member of any firm.
  await mkUser('bookkeeper', fx.T.schc, { role: 'bookkeeper' });

  const [c] = await db.insert(portalContacts).values({ tenantId: fx.T.schc, email: `te-r4-contact-${randomUUID().slice(0, 8)}@ex.com`, status: 'active' }).returning();
  contactId = c!.id;
  await db.insert(portalContactCompanies).values([
    { contactId, companyId: fx.C.schc, taxEstimatesAccess: true },
    { contactId, companyId: otherCompany, taxEstimatesAccess: false },
  ]);
  await db.insert(taxEstTaxpayerContacts).values({ taxpayerId: fx.taxpayerId, portalContactId: contactId });
  contactCookie = crypto.randomBytes(32).toString('hex');
  await db.insert(portalContactSessions).values({
    tenantId: fx.T.schc, contactId, tokenHash: crypto.createHash('sha256').update(contactCookie).digest('hex'), expiresAt: new Date(Date.now() + 3600_000),
  });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportPacksRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use('/api/v1/practice/portal', portalContactsRouter);
  app.use('/api/portal/tax-estimates', portalTaxEstimatesPublicRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await db.delete(previewSessions).where(eq(previewSessions.tenantId, fx.T.schc));
  await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, contactId));
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B]));
  await db.delete(auditLog).where(eq(auditLog.userId, USER));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other]);
  await db.delete(firms).where(inArray(firms.id, [FIRM_A, FIRM_B]));
  await closeTbRedis();
  await pool.end();
});

describe('R4-01 / R4-10 — Report Pack with the Tax Estimate section', () => {
  let packId = '';

  it('pack config (taxpayer id) is 404 / unlisted for client users and non-firm staff; firm staff see it', async () => {
    const created = await call('POST', '/api/v1/reports/packs', as('staff'), PACK(fx.taxpayerId));
    expect(created.status).toBe(201);
    packId = created.json.id;
    const mine = await call('GET', `/api/v1/reports/packs/${packId}`, as('staff'));
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.json)).toContain(fx.taxpayerId);
    for (const who of ['client', 'bookkeeper']) {
      const r = await call('GET', `/api/v1/reports/packs/${packId}`, as(who));
      expect(r.status, who).toBe(404);
      expect(JSON.stringify(r.json), who).not.toContain(fx.taxpayerId);
      const list = await call('GET', '/api/v1/reports/packs', as(who));
      expect(list.status, who).toBe(200);
      expect(list.json.packs.map((p: { id: string }) => p.id), who).not.toContain(packId);
    }
    const staffList = await call('GET', '/api/v1/reports/packs', as('staff'));
    expect(staffList.json.packs.map((p: { id: string }) => p.id)).toContain(packId);
  });

  it('callers outside the gates cannot add the section, nor edit, copy, delete or run a pack that has it', async () => {
    expect((await call('POST', '/api/v1/reports/packs', as('bookkeeper'), PACK(fx.taxpayerId))).status).toBe(400);
    expect((await call('PUT', `/api/v1/reports/packs/${packId}`, as('bookkeeper'), { ...PACK(fx.taxpayerId), items: [] })).status).toBe(404);
    expect((await call('POST', `/api/v1/reports/packs/${packId}/duplicate`, as('client'))).status).toBe(404);
    expect((await call('POST', `/api/v1/reports/packs/${packId}/runs`, as('bookkeeper'), {})).status).toBe(404);
    expect((await call('DELETE', `/api/v1/reports/packs/${packId}`, as('bookkeeper'))).status).toBe(404);
    // A plain pack is untouched by the gate.
    const plain = await call('POST', '/api/v1/reports/packs', as('bookkeeper'), { name: 'Plain', items: [{ reportId: 'profit-loss' }] });
    expect(plain.status).toBe(201);
    expect((await call('GET', `/api/v1/reports/packs/${plain.json.id}`, as('bookkeeper'))).status).toBe(200);
  });

  it('a tax-bearing run and its PDF: 404 for client users, non-firm staff, another firm member and another company; the requester downloads', async () => {
    const [run] = await db.insert(reportPackRuns).values({
      packId, tenantId: fx.T.schc, companyId: fx.C.schc, rangeStart: '2026-01-01', rangeEnd: '2026-09-30', asOfDate: '2026-09-30',
      status: 'succeeded', progress: 100, allowAttachments: false, allowTransactions: false, allowTaxEstimate: true, requestedBy: userIds['staff']!,
      expiresAt: new Date(Date.now() + 600_000), pageCount: 1,
    }).returning();
    const doc = await PDFDocument.create();
    doc.addPage();
    const pdf = Buffer.from(await doc.save());
    const key = reportPackArtifactKey(fx.T.schc, run!.id);
    await (await getProviderForTenant(fx.T.schc)).upload(key, pdf, { fileName: `${run!.id}.pdf`, mimeType: 'application/pdf', sizeBytes: pdf.length });
    await db.update(reportPackRuns).set({ transientKey: key }).where(eq(reportPackRuns.id, run!.id));

    for (const [who, company] of [['client', undefined], ['bookkeeper', undefined], ['staff2', undefined], ['staff', otherCompany]] as const) {
      expect((await call('GET', `/api/v1/reports/packs/runs/${run!.id}`, as(who, company))).status, `${who} run`).toBe(404);
      expect((await call('GET', `/api/v1/reports/packs/runs/${run!.id}/pdf`, as(who, company))).status, `${who} pdf`).toBe(404);
    }
    expect((await call('GET', `/api/v1/reports/packs/runs/${run!.id}`, as('staff'))).status).toBe(200);
    const dl = await call('GET', `/api/v1/reports/packs/runs/${run!.id}/pdf`, as('staff'));
    expect(dl.status).toBe(200);
    expect(dl.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('R4-02 / R4-07 — preview sessions and uniform 404', () => {
  it('a preview started by staff outside the firm (no tax_estimator gate) sees nothing', async () => {
    const pv = await portalAuth.startPreview({
      initiatingUserId: userIds['bookkeeper']!, initiatingUserRole: 'bookkeeper', tenantId: fx.T.schc, contactId, companyId: fx.C.schc, origin: 'contact_detail',
    });
    const detail = await call('GET', `/api/portal/tax-estimates/${fx.taxpayerId}?year=2026`, preview(pv.token));
    expect(detail.status).toBe(404);
    expect(detail.json?.error?.code ?? detail.json?.code).toBe('TE_PORTAL_FORBIDDEN');
    expect((await call('GET', `/api/portal/tax-estimates/${fx.taxpayerId}/vouchers.pdf?year=2026`, preview(pv.token))).status).toBe(404);
    const list = await call('GET', '/api/portal/tax-estimates', preview(pv.token));
    expect(list.status).toBe(200);
    expect(list.json).toEqual({ featureEnabled: false, taxpayers: [] });
    expect(list.headers['cache-control']).toBe('no-store');
  });

  it('a preview by firm staff who pass the gates works; a company mismatch is the uniform 404', async () => {
    const pv = await portalAuth.startPreview({
      initiatingUserId: userIds['staff']!, initiatingUserRole: 'accountant', tenantId: fx.T.schc, contactId, companyId: fx.C.schc, origin: 'contact_detail',
    });
    const ok = await call('GET', `/api/portal/tax-estimates/${fx.taxpayerId}?year=2026`, preview(pv.token));
    expect(ok.status).toBe(200);
    expect(Number(ok.json.estimate.totals.total)).toBeGreaterThan(0);
    const mm = await call('GET', `/api/portal/tax-estimates/${fx.taxpayerId}?year=2026&companyId=${otherCompany}`, preview(pv.token));
    expect(mm.status).toBe(404);
    expect(JSON.stringify(mm.json)).toContain('TE_PORTAL_FORBIDDEN');
  }, 180_000);

  it('flags-off list answers no-store', async () => {
    await setFlag('TAX_ESTIMATOR_V1', false);
    try {
      const r = await call('GET', '/api/portal/tax-estimates', portal(contactCookie));
      expect(r.json).toEqual({ featureEnabled: false, taxpayers: [] });
      expect(r.headers['cache-control']).toBe('no-store');
    } finally {
      await setFlag('TAX_ESTIMATOR_V1', true);
    }
  });
});

describe('R4-05 — firm disclaimer paragraphs in the voucher PDF', () => {
  it('newlines are paragraph breaks, never "?"; a long disclaimer paginates above the bottom margin', async () => {
    await upsertFirmSettings({ ...fx.scopeA, firmRole: 'firm_admin' }, fx.actor, { disclaimerText: 'Paragraph one ends here.\nParagraph two starts here.\n\nThird.' });
    const v = await call('GET', `/api/portal/tax-estimates/${fx.taxpayerId}/vouchers.pdf?year=2026`, portal(contactCookie));
    expect(v.status).toBe(200);
    const texts = pdfDrawnText(v.raw).map((t) => t.text);
    expect(texts.join('\n')).not.toMatch(/here\.\?|\?\?Third/);
    expect(texts).toContain('Paragraph one ends here.');
    expect(texts).toContain('Paragraph two starts here.');
    expect(texts).toContain('Third.');
    const shortPages = (await PDFDocument.load(v.raw)).getPageCount();

    const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}: the firm's standard engagement terms apply to this estimate and every figure in it.`).join('\n');
    await upsertFirmSettings({ ...fx.scopeA, firmRole: 'firm_admin' }, fx.actor, { disclaimerText: long.slice(0, 4000) });
    const big = await call('GET', `/api/portal/tax-estimates/${fx.taxpayerId}/vouchers.pdf?year=2026`, portal(contactCookie));
    expect(big.status).toBe(200);
    const drawn = pdfDrawnText(big.raw);
    const pages = (await PDFDocument.load(big.raw)).getPageCount();
    expect(pages).toBeGreaterThan(shortPages); // the disclaimer continued on its own page(s)
    // Nothing drawn below the footer line (y = 34) — the old renderer went negative.
    expect(Math.min(...drawn.map((t) => t.y))).toBeGreaterThanOrEqual(34);
    await upsertFirmSettings({ ...fx.scopeA, firmRole: 'firm_admin' }, fx.actor, { disclaimerText: null });
  }, 180_000);
});

describe('R4-06 — no base scenario: fail closed', () => {
  it('the portal answers 404 instead of showing whichever scenario comes first', async () => {
    await db.update(taxEstScenarios).set({ isBase: false }).where(eq(taxEstScenarios.id, fx.baseScenarioId));
    try {
      expect((await call('GET', `/api/portal/tax-estimates/${fx.taxpayerId}?year=2026`, portal(contactCookie))).status).toBe(404);
    } finally {
      await db.update(taxEstScenarios).set({ isBase: true }).where(eq(taxEstScenarios.id, fx.baseScenarioId));
    }
  });
});

describe('R4-08 — tax_estimates_access from the portal-contacts admin', () => {
  const grants = async () => Object.fromEntries((await db.select().from(portalContactCompanies)
    .where(eq(portalContactCompanies.contactId, contactId))).map((r) => [r.companyId, r.taxEstimatesAccess]));

  it('omitting the field keeps the stored grant (no silent reset)', async () => {
    const r = await call('PUT', `/api/v1/practice/portal/contacts/${contactId}/companies`, as('bookkeeper'), {
      companies: [{ companyId: fx.C.schc, financialsAccess: true }, { companyId: otherCompany }],
    });
    expect(r.status).toBe(200);
    expect(await grants()).toEqual({ [fx.C.schc]: true, [otherCompany]: false });
  });

  it('granting needs the Tax Estimator gates; revoking does not; unchanged values pass', async () => {
    const put = (who: string, a: boolean, b: boolean) => call('PUT', `/api/v1/practice/portal/contacts/${contactId}/companies`, as(who), {
      companies: [{ companyId: fx.C.schc, taxEstimatesAccess: a }, { companyId: otherCompany, taxEstimatesAccess: b }],
    });
    const denied = await put('bookkeeper', true, true);
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.json)).toContain('TE_ACCESS_GRANT_FORBIDDEN');
    expect(await grants()).toEqual({ [fx.C.schc]: true, [otherCompany]: false });
    expect((await put('bookkeeper', true, false)).status).toBe(200); // unchanged
    expect((await put('bookkeeper', false, false)).status).toBe(200); // revoke
    expect(await grants()).toEqual({ [fx.C.schc]: false, [otherCompany]: false });
    expect((await put('staff', true, false)).status).toBe(200); // firm staff grant
    expect(await grants()).toEqual({ [fx.C.schc]: true, [otherCompany]: false });
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'tax_est_contact_access'), eq(auditLog.entityId, contactId))).limit(1);
    expect(row).toBeTruthy();
  });

  it('creating a contact with the grant needs the gates too', async () => {
    const body = (email: string) => ({ email, companies: [{ companyId: fx.C.schc, taxEstimatesAccess: true }], sendInvite: false });
    const denied = await call('POST', '/api/v1/practice/portal/contacts', as('bookkeeper'), body(`te-r4-new-${randomUUID().slice(0, 6)}@ex.com`));
    expect(denied.status).toBe(403);
    const ok = await call('POST', '/api/v1/practice/portal/contacts', as('staff'), body(`te-r4-new-${randomUUID().slice(0, 6)}@ex.com`));
    expect(ok.status).toBe(201);
    await db.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, ok.json.id));
  });
});
