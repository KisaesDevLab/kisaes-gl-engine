// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Entities routes (Phase 4) behind the real Tax Estimator guard chain.
// T1 practice tenant (flag ON), T2 managed client the staff user can reach,
// T3 managed client the user can NOT reach, T4 another firm's client the user
// CAN reach. Scope for the firm-A staff user = {T1, T2}: every entities route
// must 404 TE_TENANT_NOT_MANAGED for T3 and T4 (D1), even though T4 is
// reachable by switching tenants.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import {
  firms, firmUsers, taxEstAccountTreatments, taxEstEntitySettings, taxEstEntityYearInputs, taxEstTransactionFlags,
  tenantFeatureFlags, tenantFirmAssignments, userTenantAccess, users,
} from '../../db/schema/index.js';
import { taxEstimatorRouter } from '../tax-estimator.routes.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { mkAccount, mkCompany, mkTenant, post, purgeTenants, uniq } from '../../services/tax-estimator/entities.test-fixtures.js';

interface Resp { status: number; json: { data?: unknown; error?: { code?: string } } }

let server: Server | null = null;
let port = 0;
const T = { t1: '', t2: '', t3: '', t4: '' };
const C = { c2: '', c3: '', c4: '' };
const X = { meals2: '', txn2: '', meals4: '', txn4: '' };
const firmIds: string[] = [];
const userIds: string[] = [];
let staffToken = '';
let readonlyToken = '';

async function mkUser(tenantId: string, role: string): Promise<{ id: string; token: string }> {
  const [u] = await db.insert(users).values({
    tenantId, email: `${uniq('u')}@example.com`, passwordHash: await bcrypt.hash('x-secret-12345', 4),
    displayName: role, role, isSuperAdmin: false, userType: 'staff',
  }).returning();
  userIds.push(u!.id);
  const token = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  return { id: u!.id, token };
}

function request(method: string, path: string, token: string, body?: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); }
        catch { resolve({ status: res.statusCode ?? 0, json: {} }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const base = (t: string, c: string) => `/api/v1/tax-estimator/entities/${t}/${c}`;

beforeAll(async () => {
  T.t1 = await mkTenant('TE4R Practice');
  T.t2 = await mkTenant('TE4R Client Reachable');
  T.t3 = await mkTenant('TE4R Client Unreachable');
  T.t4 = await mkTenant('TE4R Other Firm Client');
  const [fa] = await db.insert(firms).values({ name: 'TE4R Firm A', slug: uniq('fa') }).returning();
  const [fb] = await db.insert(firms).values({ name: 'TE4R Firm B', slug: uniq('fb') }).returning();
  firmIds.push(fa!.id, fb!.id);
  await db.insert(tenantFirmAssignments).values([
    { tenantId: T.t1, firmId: fa!.id }, { tenantId: T.t2, firmId: fa!.id },
    { tenantId: T.t3, firmId: fa!.id }, { tenantId: T.t4, firmId: fb!.id },
  ]);
  for (const t of Object.values(T)) {
    await db.insert(tenantFeatureFlags).values({ tenantId: t, flagKey: 'TAX_ESTIMATOR_V1', enabled: true });
  }
  const staff = await mkUser(T.t1, 'accountant');
  staffToken = staff.token;
  await db.insert(firmUsers).values({ firmId: fa!.id, userId: staff.id, firmRole: 'firm_staff' });
  await db.insert(userTenantAccess).values([
    { userId: staff.id, tenantId: T.t1, role: 'accountant' },
    { userId: staff.id, tenantId: T.t2, role: 'accountant' },
    { userId: staff.id, tenantId: T.t4, role: 'accountant' },
  ]);
  const ro = await mkUser(T.t1, 'accountant');
  readonlyToken = ro.token;
  await db.insert(firmUsers).values({ firmId: fa!.id, userId: ro.id, firmRole: 'firm_readonly' });
  await db.insert(userTenantAccess).values([
    { userId: ro.id, tenantId: T.t1, role: 'accountant' }, { userId: ro.id, tenantId: T.t2, role: 'accountant' },
  ]);

  C.c2 = await mkCompany(T.t2, 'Client Two', { accountingMethod: 'cash' });
  C.c3 = await mkCompany(T.t3, 'Client Three');
  C.c4 = await mkCompany(T.t4, 'Client Four');
  const bank2 = await mkAccount(T.t2, C.c2, '1010', 'Bank', 'asset', { detailType: 'checking' });
  const rev2 = await mkAccount(T.t2, C.c2, '4000', 'Sales', 'revenue');
  X.meals2 = await mkAccount(T.t2, C.c2, '6420', 'Meals', 'expense');
  await post(T.t2, C.c2, '2026-02-10', [[bank2, 1000, 0], [rev2, 0, 1000]]);
  X.txn2 = await post(T.t2, C.c2, '2026-02-11', [[X.meals2, 200, 0], [bank2, 0, 200]]);
  const bank4 = await mkAccount(T.t4, C.c4, '1010', 'Bank', 'asset', { detailType: 'checking' });
  X.meals4 = await mkAccount(T.t4, C.c4, '6420', 'Meals', 'expense');
  X.txn4 = await post(T.t4, C.c4, '2026-02-11', [[X.meals4, 50, 0], [bank4, 0, 50]]);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/tax-estimator', taxEstimatorRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  if (userIds.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, userIds));
  await db.delete(firmUsers).where(inArray(firmUsers.firmId, firmIds));
  await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, firmIds));
  await db.delete(firms).where(inArray(firms.id, firmIds));
  await purgeTenants(Object.values(T));
  await pool.end();
});

describe('entities routes — happy path inside the scope', () => {
  it('settings, year inputs, treatments, suggestions, flags, readiness, tax-basis P&L', async () => {
    const b = base(T.t2, C.c2);
    const s = await request('GET', `${b}/settings`, staffToken);
    expect(s.status).toBe(200);
    expect((s.json.data as { resolved: { taxMethod: string } }).resolved.taxMethod).toBe('cash');

    const put = await request('PUT', `${b}/settings`, staffToken, { isSstb: true, stateSourcing: 'mo' });
    expect(put.status).toBe(200);
    expect((put.json.data as { settings: { isSstb: boolean; stateSourcing: string } }).settings).toMatchObject({ isSstb: true, stateSourcing: 'MO' });

    expect((await request('PUT', `${b}/year-inputs/2026`, staffToken, { ubia: '5000' })).status).toBe(200);
    expect((await request('PUT', `${b}/year-inputs/2026`, staffToken, { w2WagesOverride: '10' })).status).toBe(400);
    const yi = await request('GET', `${b}/year-inputs/2026`, staffToken);
    expect((yi.json.data as { ubia: string }).ubia).toBe('5000.0000');

    const sug = await request('GET', `${b}/treatment-suggestions`, staffToken);
    expect((sug.json.data as Array<{ accountId: string }>).map((x) => x.accountId)).toContain(X.meals2);

    const tr = await request('PUT', `${b}/treatments`, staffToken, {
      treatments: [{ accountId: X.meals2, treatment: 'nondeductible_pct', pct: '50', nonRecurring: false }],
    });
    expect(tr.status).toBe(200);
    expect((tr.json.data as { total: number }).total).toBe(1);
    expect((await request('PUT', `${b}/treatments`, staffToken, {
      treatments: [{ accountId: X.meals2, treatment: 'nondeductible_pct', nonRecurring: false }],
    })).status).toBe(400); // pct required

    const fl = await request('PUT', `${b}/transaction-flags`, staffToken, { flags: [{ transactionId: X.txn2, nonRecurring: true }] });
    expect(fl.status).toBe(200);
    expect((await request('GET', `${b}/transaction-flags`, staffToken)).json.data).toMatchObject({ total: 1 });

    const pl = await request('GET', `${b}/tax-basis-pl?taxYear=2026&through=2026-03`, staffToken);
    expect(pl.status).toBe(200);
    const plData = pl.json.data as { bookNetIncome: string; taxBasisProfit: string; nonRecurring: { ordinary: string } };
    expect(Number(plData.bookNetIncome)).toBe(800);
    expect(Number(plData.taxBasisProfit)).toBe(900);
    expect(Number(plData.nonRecurring.ordinary)).toBe(-100);

    const rd = await request('GET', `${b}/readiness?through=2026-03`, staffToken);
    expect(rd.status).toBe(200);
    expect((rd.json.data as { lastClosedMonth: string | null }).lastClosedMonth).toBeNull();

    expect((await request('GET', `${b}/tax-basis-pl?taxYear=2026&through=2027-01`, staffToken)).status).toBe(400);
    expect((await request('GET', `${b}/readiness?through=2026-13`, staffToken)).status).toBe(400);
  });

  it('firm_readonly can read but not mutate', async () => {
    const b = base(T.t2, C.c2);
    expect((await request('GET', `${b}/settings`, readonlyToken)).status).toBe(200);
    expect((await request('PUT', `${b}/settings`, readonlyToken, { isSstb: false })).status).toBe(403);
    expect((await request('PUT', `${b}/treatments`, readonlyToken, {
      treatments: [{ accountId: X.meals2, treatment: null, nonRecurring: false }],
    })).status).toBe(403);
  });
});

describe('entities routes — isolation (D1)', () => {
  const endpoints = (t: string, c: string, account: string, txn: string): Array<[string, string, unknown?]> => [
    ['GET', `${base(t, c)}/settings`],
    ['PUT', `${base(t, c)}/settings`, { isSstb: true }],
    ['GET', `${base(t, c)}/year-inputs/2026`],
    ['PUT', `${base(t, c)}/year-inputs/2026`, { ubia: '1' }],
    ['GET', `${base(t, c)}/treatments`],
    ['PUT', `${base(t, c)}/treatments`, { treatments: [{ accountId: account, treatment: 'owner_personal', nonRecurring: false }] }],
    ['GET', `${base(t, c)}/treatment-suggestions`],
    ['GET', `${base(t, c)}/transaction-flags`],
    ['PUT', `${base(t, c)}/transaction-flags`, { flags: [{ transactionId: txn, nonRecurring: true }] }],
    ['GET', `${base(t, c)}/readiness?through=2026-03`],
    ['GET', `${base(t, c)}/tax-basis-pl?taxYear=2026&through=2026-03`],
  ];

  it('another firm\'s client the user CAN reach → 404 TE_TENANT_NOT_MANAGED on every route', async () => {
    for (const [method, path, body] of endpoints(T.t4, C.c4, X.meals4, X.txn4)) {
      const r = await request(method, path, staffToken, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json.error?.code, `${method} ${path}`).toBe('TE_TENANT_NOT_MANAGED');
    }
  });

  it('a managed client the user can NOT reach → 404 TE_TENANT_NOT_MANAGED on every route', async () => {
    for (const [method, path, body] of endpoints(T.t3, C.c3, X.meals4, X.txn4)) {
      const r = await request(method, path, staffToken, body);
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.json.error?.code, `${method} ${path}`).toBe('TE_TENANT_NOT_MANAGED');
    }
  });

  it('pairing an in-scope tenant with another tenant\'s company / account / transaction is a 404', async () => {
    expect((await request('GET', `${base(T.t2, C.c4)}/settings`, staffToken)).json.error?.code).toBe('TE_COMPANY_NOT_FOUND');
    const acct = await request('PUT', `${base(T.t2, C.c2)}/treatments`, staffToken, {
      treatments: [{ accountId: X.meals4, treatment: 'owner_personal', nonRecurring: false }],
    });
    expect(acct.status).toBe(404);
    const txn = await request('PUT', `${base(T.t2, C.c2)}/transaction-flags`, staffToken, { flags: [{ transactionId: X.txn4, nonRecurring: true }] });
    expect(txn.status).toBe(404);
  });

  it('nothing was written into the out-of-scope tenants', async () => {
    for (const t of [T.t3, T.t4]) {
      expect(await db.select().from(taxEstEntitySettings).where(eq(taxEstEntitySettings.tenantId, t))).toHaveLength(0);
      expect(await db.select().from(taxEstEntityYearInputs).where(eq(taxEstEntityYearInputs.tenantId, t))).toHaveLength(0);
      expect(await db.select().from(taxEstAccountTreatments).where(eq(taxEstAccountTreatments.tenantId, t))).toHaveLength(0);
      expect(await db.select().from(taxEstTransactionFlags).where(eq(taxEstTransactionFlags.tenantId, t))).toHaveLength(0);
    }
  });

  it('malformed path ids are rejected by Zod', async () => {
    expect((await request('GET', '/api/v1/tax-estimator/entities/not-a-uuid/also-not/settings', staffToken)).status).toBe(400);
  });
});
