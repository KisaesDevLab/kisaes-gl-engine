// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Q54 (Kurt, 2026-10-13): firm_staff / firm_readonly members below hold "Tax Estimator: view
// taxpayers" (capabilities) so these pre-Q54 expectations hold as written; the Q54 matrix itself
// (capability off, unlisted firm admin, ...) is in tax-estimator/taxpayer-visibility-q54.routes.test.ts.

// Register / transaction-detail non-recurring flag (R7-07 #2) behind the real Tax
// Estimator guard chain. The caller works INSIDE a client tenant (T2, managed by firm A,
// flag ON): the firm is the active tenant's managing firm (like the Report Pack section),
// the tenant must be inside the caller's D1 scope, the transaction is loaded strictly by
// (active tenant, id) and must belong to the active company. C2 is linked to a firm-A
// taxpayer; C2b is not. T4 belongs to firm B.

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
  auditLog, firms, firmUsers, taxEstLinks, taxEstPersons, taxEstTaxpayers, taxEstTransactionFlags,
  tenantFeatureFlags, tenantFirmAssignments, userTenantAccess, users,
} from '../../db/schema/index.js';
import { taxEstimatorRouter } from '../tax-estimator.routes.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { mkAccount, mkCompany, mkTenant, post, purgeTenants, uniq } from '../../services/tax-estimator/entities.test-fixtures.js';

interface Resp { status: number; json: { data: Record<string, unknown>; error?: { code?: string }; code?: string } }

let server: Server | null = null;
let port = 0;
const T = { t1: '', t2: '', t4: '' };
const C = { c2: '', c2b: '', c4: '' };
const X = { a: '', b: '', four: '' };
const firmIds: string[] = [];
const userIds: string[] = [];
const tok: Record<string, string> = {};

async function mkUser(key: string, jwtTenant: string, opts: { firm?: string; firmRole?: string; access: string[]; userType?: string }) {
  const role = opts.userType === 'client' ? 'owner' : 'accountant';
  const [u] = await db.insert(users).values({
    tenantId: jwtTenant, email: `${uniq(key)}@example.com`, passwordHash: await bcrypt.hash('x-secret-12345', 4),
    displayName: key, role, isSuperAdmin: false, userType: opts.userType ?? 'staff',
  }).returning();
  userIds.push(u!.id);
  if (opts.firm) await db.insert(firmUsers).values({ firmId: opts.firm, userId: u!.id, firmRole: opts.firmRole ?? 'firm_staff', capabilities: { tax_estimator_view_taxpayers: true } });
  for (const t of opts.access) await db.insert(userTenantAccess).values({ userId: u!.id, tenantId: t, role });
  tok[key] = jwt.sign({ userId: u!.id, tenantId: jwtTenant, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
}

function request(method: string, path: string, token: string, company: string, body?: unknown): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/tax-estimator/register${path}`, method,
      headers: {
        Authorization: `Bearer ${token}`, 'X-Company-Id': company,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); } catch { resolve({ status: res.statusCode ?? 0, json: { data: {} } }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const code = (r: Resp) => r.json.error?.code ?? r.json.code;

async function setFlag(tenantId: string, enabled: boolean) {
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'TAX_ESTIMATOR_V1', enabled })
    .onConflictDoUpdate({ target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey], set: { enabled } });
}

beforeAll(async () => {
  T.t1 = await mkTenant('TEREG Practice');
  T.t2 = await mkTenant('TEREG Client');
  T.t4 = await mkTenant('TEREG Other Firm Client');
  const [fa] = await db.insert(firms).values({ name: 'TEREG Firm A', slug: uniq('rfa') }).returning();
  const [fb] = await db.insert(firms).values({ name: 'TEREG Firm B', slug: uniq('rfb') }).returning();
  firmIds.push(fa!.id, fb!.id);
  await db.insert(tenantFirmAssignments).values([
    { tenantId: T.t1, firmId: fa!.id }, { tenantId: T.t2, firmId: fa!.id }, { tenantId: T.t4, firmId: fb!.id },
  ]);
  for (const t of Object.values(T)) await setFlag(t, true);

  await mkUser('staff', T.t2, { firm: fa!.id, access: [T.t1, T.t2, T.t4] });
  await mkUser('readonly', T.t2, { firm: fa!.id, firmRole: 'firm_readonly', access: [T.t2] });
  await mkUser('otherFirm', T.t2, { firm: fb!.id, access: [T.t2] });
  await mkUser('client', T.t2, { userType: 'client', access: [T.t2] });

  C.c2 = await mkCompany(T.t2, 'Linked Co');
  C.c2b = await mkCompany(T.t2, 'Unlinked Co');
  C.c4 = await mkCompany(T.t4, 'Firm B Co');
  const bank = await mkAccount(T.t2, C.c2, '1010', 'Bank', 'asset', { detailType: 'checking' });
  const rev = await mkAccount(T.t2, C.c2, '4000', 'Sales', 'revenue');
  X.a = await post(T.t2, C.c2, '2026-03-10', [[bank, 30000, 0], [rev, 0, 30000]]);
  const bankB = await mkAccount(T.t2, C.c2b, '1011', 'Bank B', 'asset', { detailType: 'checking' });
  const revB = await mkAccount(T.t2, C.c2b, '4001', 'Sales B', 'revenue');
  X.b = await post(T.t2, C.c2b, '2026-03-11', [[bankB, 10, 0], [revB, 0, 10]]);
  const bank4 = await mkAccount(T.t4, C.c4, '1010', 'Bank', 'asset', { detailType: 'checking' });
  const rev4 = await mkAccount(T.t4, C.c4, '4000', 'Sales', 'revenue');
  X.four = await post(T.t4, C.c4, '2026-03-12', [[bank4, 5, 0], [rev4, 0, 5]]);

  const [tp] = await db.insert(taxEstTaxpayers).values({ firmId: fa!.id, displayName: 'Rivera household', filingStatus: 'mfj' }).returning();
  const [p] = await db.insert(taxEstPersons).values({ taxpayerId: tp!.id, role: 'primary', firstName: 'Dan', lastName: 'Rivera', sehiEligibleMonths: Array(12).fill(true) }).returning();
  await db.insert(taxEstLinks).values({ taxpayerId: tp!.id, personId: p!.id, taxYear: 2026, tenantId: T.t2, companyId: C.c2, profitPct: '100', lossPct: '100' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/tax-estimator', taxEstimatorRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}, 60_000);

afterAll(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, firmIds));
  if (userIds.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, userIds));
  await db.delete(firmUsers).where(inArray(firmUsers.firmId, firmIds));
  await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, firmIds));
  await db.delete(firms).where(inArray(firms.id, firmIds));
  await purgeTenants(Object.values(T));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await pool.end();
});

describe('register non-recurring flag — linked company', () => {
  it('reads the state, flags and unflags (audited), and lists the company flags for the register badges', async () => {
    const r0 = await request('GET', `/transactions/${X.a}`, tok['staff']!, C.c2);
    expect(r0.status).toBe(200);
    expect(r0.json.data).toMatchObject({ transactionId: X.a, companyId: C.c2, linked: true, nonRecurring: false, canEdit: true, updatedAt: null });
    expect(r0.json.data['taxpayers']).toEqual([expect.objectContaining({ displayName: 'Rivera household', years: [2026] })]);

    const on = await request('PUT', `/transactions/${X.a}`, tok['staff']!, C.c2, { nonRecurring: true });
    expect(on.status).toBe(200);
    expect(on.json.data).toMatchObject({ nonRecurring: true, linked: true });
    expect(on.json.data['updatedAt']).toEqual(expect.any(String));
    const [row] = await db.select().from(taxEstTransactionFlags).where(eq(taxEstTransactionFlags.transactionId, X.a));
    expect(row).toMatchObject({ tenantId: T.t2, nonRecurring: true });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, T.t2), eq(auditLog.entityId, row!.id)));
    expect(audits.map((a) => a.action)).toEqual(['create']);

    // Idempotent.
    expect((await request('PUT', `/transactions/${X.a}`, tok['staff']!, C.c2, { nonRecurring: true })).status).toBe(200);

    const list = await request('GET', '/flags', tok['staff']!, C.c2);
    expect(list.status).toBe(200);
    expect(list.json.data).toEqual({ companyId: C.c2, linked: true, canEdit: true, transactionIds: [X.a], total: 1, limit: 500 });

    const off = await request('PUT', `/transactions/${X.a}`, tok['staff']!, C.c2, { nonRecurring: false });
    expect(off.status).toBe(200);
    expect(off.json.data).toMatchObject({ nonRecurring: false, updatedAt: null });
    expect(await db.select().from(taxEstTransactionFlags).where(eq(taxEstTransactionFlags.transactionId, X.a))).toHaveLength(0);
    const audits2 = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, T.t2), eq(auditLog.entityId, row!.id)));
    expect(audits2.map((a) => a.action).sort()).toEqual(['create', 'delete']);
    expect((await request('GET', '/flags', tok['staff']!, C.c2)).json.data).toMatchObject({ transactionIds: [], total: 0 });
  });

  it('validates the body', async () => {
    expect((await request('PUT', `/transactions/${X.a}`, tok['staff']!, C.c2, { nonRecurring: 'yes' })).status).toBe(400);
    expect((await request('PUT', `/transactions/${X.a}`, tok['staff']!, C.c2, { nonRecurring: true, tenantId: T.t4 })).status).toBe(400);
    expect((await request('GET', '/transactions/not-a-uuid', tok['staff']!, C.c2)).status).toBe(400);
  });

  it('firm_readonly sees the state (canEdit false) and cannot change it', async () => {
    const r = await request('GET', `/transactions/${X.a}`, tok['readonly']!, C.c2);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ linked: true, canEdit: false });
    const w = await request('PUT', `/transactions/${X.a}`, tok['readonly']!, C.c2, { nonRecurring: true });
    expect(w.status).toBe(403);
  });
});

describe('register non-recurring flag — unlinked company and isolation (D1)', () => {
  it('an unlinked company reads linked:false and refuses a flag (409 TE_COMPANY_NOT_LINKED)', async () => {
    const r = await request('GET', `/transactions/${X.b}`, tok['staff']!, C.c2b);
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ linked: false, taxpayers: [], nonRecurring: false });
    const w = await request('PUT', `/transactions/${X.b}`, tok['staff']!, C.c2b, { nonRecurring: true });
    expect(w.status).toBe(409);
    expect(code(w)).toBe('TE_COMPANY_NOT_LINKED');
    expect((await request('GET', '/flags', tok['staff']!, C.c2b)).json.data).toMatchObject({ linked: false, transactionIds: [], total: 0 });
  });

  it('a transaction of another tenant, or of another company than the active one, is 404', async () => {
    const other = await request('GET', `/transactions/${X.four}`, tok['staff']!, C.c2);
    expect(other.status).toBe(404);
    expect(code(other)).toBe('TE_TRANSACTION_NOT_FOUND');
    expect((await request('PUT', `/transactions/${X.four}`, tok['staff']!, C.c2, { nonRecurring: true })).status).toBe(404);
    expect((await request('GET', `/transactions/${X.a}`, tok['staff']!, C.c2b)).status).toBe(404);
    expect(await db.select().from(taxEstTransactionFlags).where(eq(taxEstTransactionFlags.transactionId, X.four))).toHaveLength(0);
  });

  it('404 for another firm’s member, a client user, and with the flag off', async () => {
    expect((await request('GET', `/transactions/${X.a}`, tok['otherFirm']!, C.c2)).status).toBe(404);
    expect((await request('GET', '/flags', tok['otherFirm']!, C.c2)).status).toBe(404);
    expect((await request('GET', `/transactions/${X.a}`, tok['client']!, C.c2)).status).toBe(404);
    await setFlag(T.t2, false);
    try {
      expect((await request('GET', `/transactions/${X.a}`, tok['staff']!, C.c2)).status).toBe(404);
      expect((await request('PUT', `/transactions/${X.a}`, tok['staff']!, C.c2, { nonRecurring: true })).status).toBe(404);
    } finally {
      await setFlag(T.t2, true);
    }
  });
});
