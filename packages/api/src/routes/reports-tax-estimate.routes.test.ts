// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q54 (Kurt, 2026-10-13): firm_staff / firm_readonly members below hold "Tax Estimator: view
// taxpayers" (capabilities) so these pre-Q54 expectations hold as written; the Q54 matrix itself
// (capability off, unlisted firm admin, ...) is in tax-estimator/taxpayer-visibility-q54.routes.test.ts.

// Tax Estimator Phase 13 — the Report Pack `tax-estimate` section's request-side gates:
// /reports/catalog lists it only for callers who pass the Tax Estimator gates;
// /reports/tax-estimate/taxpayers (pack-builder choices) and /reports/tax-estimate (the
// section PDF, snapshot reason 'report_pack') answer 404 to client users, with the flag
// off, to non-members of the managing firm, and to API keys.

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
import { db, pool } from '../db/index.js';
import {
  auditLog, firms, firmUsers, taxEstFirmSettings, taxEstSnapshots, taxEstTaxpayers, tenantFeatureFlags, tenantFirmAssignments,
  userTenantAccess, users,
} from '../db/schema/index.js';
import { errorHandler } from '../middleware/error-handler.js';
import { closeTbRedis } from '../services/tb/tb-redis.js';
import { purgeTenants } from '../services/tax-estimator/entities.test-fixtures.js';
import { seedRivera, type RiveraFixture } from '../services/tax-estimator/rivera.test-fixtures.js';
import { reportPacksRouter } from './report-packs.routes.js';
import { reportsRouter } from './reports.routes.js';

const FIRM_A = randomUUID();
const FIRM_B = randomUUID();
const USER = randomUUID();
let fx: RiveraFixture;
let server: Server | null = null;
let port = 0;
const tokens: Record<string, string> = {};

async function mkUser(key: string, tenantId: string, opts: { userType?: string; firm?: string; access?: string[] } = {}) {
  const [u] = await db.insert(users).values({
    tenantId, email: `te13r-${key}-${randomUUID().slice(0, 8)}@example.com`, passwordHash: await bcrypt.hash('x-secret-12345', 4),
    displayName: key, role: opts.userType === 'client' ? 'owner' : 'accountant', userType: opts.userType ?? 'staff',
  }).returning();
  if (opts.firm) await db.insert(firmUsers).values({ firmId: opts.firm, userId: u!.id, firmRole: 'firm_staff', capabilities: { tax_estimator_view_taxpayers: true } });
  for (const t of opts.access ?? []) await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: t, role: 'accountant' });
  tokens[key] = jwt.sign({ userId: u!.id, tenantId, role: opts.userType === 'client' ? 'owner' : 'accountant', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
}

function get(path: string, token: string): Promise<{ status: number; json: any; raw: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'X-Company-Id': fx.C.schc },
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
    req.on('error', reject);
    req.end();
  });
}

async function setFlag(enabled: boolean) {
  await db.insert(tenantFeatureFlags).values({ tenantId: fx.T.schc, flagKey: 'TAX_ESTIMATOR_V1', enabled })
    .onConflictDoUpdate({ target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey], set: { enabled } });
}

beforeAll(async () => {
  await db.insert(firms).values([{ id: FIRM_A, name: 'Rivera CPA LLC', slug: `te13r-a-${FIRM_A.slice(0, 8)}` }, { id: FIRM_B, name: 'Other Firm', slug: `te13r-b-${FIRM_B.slice(0, 8)}` }]);
  fx = await seedRivera(FIRM_A, FIRM_B, USER);
  await db.insert(tenantFirmAssignments).values([fx.T.schc, fx.T.scorp, fx.T.lp].map((tenantId) => ({ tenantId, firmId: FIRM_A })));
  await setFlag(true);
  await mkUser('staff', fx.T.schc, { firm: FIRM_A, access: [fx.T.schc, fx.T.scorp, fx.T.lp] });
  await mkUser('client', fx.T.schc, { userType: 'client' });
  await mkUser('otherFirm', fx.T.schc, { firm: FIRM_B, access: [fx.T.schc] }); // reaches the tenant, wrong firm
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportPacksRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}, 300_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B]));
  await db.delete(auditLog).where(eq(auditLog.userId, USER));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other]);
  await db.delete(firms).where(inArray(firms.id, [FIRM_A, FIRM_B]));
  await closeTbRedis();
  await pool.end();
});

const hasTax = (catalog: Array<{ id: string }>) => catalog.some((d) => d.id === 'tax-estimate');

describe('Report Pack tax-estimate gates', () => {
  it('catalog lists the section only for firm staff of the managing firm with the flag on', async () => {
    expect(hasTax((await get('/api/v1/reports/catalog', tokens['staff']!)).json.catalog)).toBe(true);
    expect(hasTax((await get('/api/v1/reports/catalog', tokens['otherFirm']!)).json.catalog)).toBe(false);
    await setFlag(false);
    expect(hasTax((await get('/api/v1/reports/catalog', tokens['staff']!)).json.catalog)).toBe(false);
    await setFlag(true);
  });

  it('taxpayer choices: the linked taxpayer for staff; 404 for client users, another firm, flag off', async () => {
    const ok = await get('/api/v1/reports/tax-estimate/taxpayers', tokens['staff']!);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ data: [{ id: fx.taxpayerId, displayName: 'Carlos & Maria Rivera', years: [2026], scenarios: expect.any(Array) }], total: 1 });
    expect(ok.json.data[0].scenarios[0]).toMatchObject({ taxYear: 2026, isBase: true }); // QA D10
    expect((await get('/api/v1/reports/tax-estimate/taxpayers', tokens['client']!)).status).toBe(404);
    expect((await get('/api/v1/reports/tax-estimate/taxpayers', tokens['otherFirm']!)).status).toBe(404);
    await setFlag(false);
    expect((await get('/api/v1/reports/tax-estimate/taxpayers', tokens['staff']!)).status).toBe(404);
    await setFlag(true);
  });

  it('section PDF: report_pack snapshot for staff; gated like the choices; taxpayer required', async () => {
    const url = `/api/v1/reports/tax-estimate?taxpayer_id=${fx.taxpayerId}&as_of_date=2026-09-30`;
    const r = await get(url, tokens['staff']!);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('application/pdf');
    expect(r.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const [snap] = await db.select().from(taxEstSnapshots).where(eq(taxEstSnapshots.id, String(r.headers['x-tax-estimate-snapshot-id'])));
    expect(snap?.reason).toBe('report_pack');
    expect((await get(url, tokens['client']!)).status).toBe(404);
    expect((await get(url, tokens['otherFirm']!)).status).toBe(404);
    expect((await get('/api/v1/reports/tax-estimate?as_of_date=2026-09-30', tokens['staff']!)).status).toBe(400);
    const snaps = await db.select().from(taxEstSnapshots).where(and(eq(taxEstSnapshots.taxpayerId, fx.taxpayerId), eq(taxEstSnapshots.reason, 'report_pack')));
    expect(snaps).toHaveLength(1);
  }, 180_000);
});
