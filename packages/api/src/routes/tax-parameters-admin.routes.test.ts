// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, and, gte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, auditLog as auditLogTable } from '../db/schema/index.js';
import { taxParameters, taxParameterOverrides } from '../db/schema/tax-estimator.js';
import { taxParametersAdminRouter } from './tax-parameters-admin.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { syncShippedSeeds } from '../services/tax-estimator/tax-parameters.service.js';

const Y1 = 2096;
const Y2 = 2097;
const ZERO = '00000000-0000-0000-0000-000000000000';
const BASE = '/api/v1/admin/tax-parameters';

let server: Server | null = null;
let port = 0;
let staffToken = '';
let superAdminToken = '';
let tenantId = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, taxParametersAdminRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(data ? { 'Content-Length': String(data.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: raw });
          }
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedUsers() {
  const [t] = await db.insert(tenants).values({ name: 'TP Admin', slug: 'tp-admin-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const passwordHash = await bcrypt.hash('super-secret-123', 12);
  const [sa] = await db.insert(users).values({
    tenantId, email: `tp-super-${Date.now()}@example.com`, passwordHash, displayName: 'Super', role: 'owner', isSuperAdmin: true,
  }).returning();
  const [st] = await db.insert(users).values({
    tenantId, email: `tp-staff-${Date.now()}@example.com`, passwordHash, displayName: 'Staff', role: 'bookkeeper', isSuperAdmin: false,
  }).returning();
  superAdminToken = jwt.sign({ userId: sa!.id, tenantId, role: 'owner', isSuperAdmin: true }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  staffToken = jwt.sign({ userId: st!.id, tenantId, role: 'bookkeeper', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
}

async function clean() {
  await db.delete(taxParameters).where(gte(taxParameters.taxYear, Y1));
  await db.delete(taxParameterOverrides).where(gte(taxParameterOverrides.taxYear, Y1));
  await db.delete(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_parameter')));
  if (tenantId) {
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  tenantId = '';
}

beforeEach(async () => {
  await clean();
  await seedUsers();
  await syncShippedSeeds({
    [Y1]: [
      { key: 'se.nese_factor', value: 0.9235, status: 'verified', citation: 'IRC 1402(a)(12)' },
      { key: 'return_due_date', value: '2096-04-15', status: 'verified', citation: 'Fixture' },
    ],
  });
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await clean();
});

const S = () => superAdminToken;

describe('tax-parameters admin routes', () => {
  it('401 without a token and 403 for non-super-admin on every endpoint', async () => {
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/years'], ['GET', `/${Y1}`], ['PUT', `/${Y1}/se.ss_rate`, { value: 0.1, reason: 'abc' }],
      ['DELETE', `/${Y1}/se.ss_rate`], ['POST', `/${Y2}/create-from-prior`], ['GET', `/${Y1}/diff`],
      ['POST', `/${Y1}/adopt-shipped`, {}], ['GET', `/${Y1}/changes`],
    ];
    for (const [m, p, b] of calls) {
      expect((await request(m, BASE + p, b)).status, `${m} ${p} anon`).toBe(401);
      expect((await request(m, BASE + p, b, staffToken)).status, `${m} ${p} staff`).toBe(403);
    }
  });

  it('GET /years and GET /:year', async () => {
    const years = await request('GET', `${BASE}/years`, undefined, S());
    expect(years.status).toBe(200);
    expect(years.json.data.years).toContain(Y1);
    expect(years.json.data.shippedYears).toContain(Y1);
    const one = await request('GET', `${BASE}/${Y1}`, undefined, S());
    expect(one.status).toBe(200);
    expect(one.json.data).toMatchObject({ year: Y1, isFallback: false });
    expect(one.json.data.completeness.present).toBe(2);
    const fb = await request('GET', `${BASE}/${Y2}`, undefined, S());
    expect(fb.json.data).toMatchObject({ isFallback: true, fallbackYear: Y1 });
  });

  it('PUT sets an override, DELETE reverts it', async () => {
    const put = await request('PUT', `${BASE}/${Y1}/se.nese_factor`, { value: 0.9, reason: 'Testing' }, S());
    expect(put.status).toBe(200);
    expect(put.json.data).toMatchObject({ key: 'se.nese_factor', value: 0.9, source: 'override', shippedValue: 0.9235 });
    const del = await request('DELETE', `${BASE}/${Y1}/se.nese_factor`, undefined, S());
    expect(del.status).toBe(200);
    const get = await request('GET', `${BASE}/${Y1}`, undefined, S());
    expect(get.json.data.parameters.find((p: { key: string }) => p.key === 'se.nese_factor').source).toBe('seed');
    expect((await request('DELETE', `${BASE}/${Y1}/se.nese_factor`, undefined, S())).status).toBe(404);
  });

  it('create-from-prior, diff, adopt-shipped and changes', async () => {
    const created = await request('POST', `${BASE}/${Y2}/create-from-prior`, undefined, S());
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ year: Y2, fromYear: Y1, created: 2, rolledDates: ['return_due_date'] });
    expect((await request('POST', `${BASE}/${Y2}/create-from-prior`, undefined, S())).status).toBe(409);

    await syncShippedSeeds({ [Y2]: [{ key: 'se.nese_factor', value: 0.8, status: 'verified', citation: 'Fixture' }] });
    const diff = await request('GET', `${BASE}/${Y2}/diff`, undefined, S());
    expect(diff.status).toBe(200);
    expect(diff.json.data.rows).toHaveLength(1);
    expect(diff.json.data.rows[0]).toMatchObject({ key: 'se.nese_factor', shippedValue: 0.8, provisionalValue: 0.9235 });

    const adopt = await request('POST', `${BASE}/${Y2}/adopt-shipped`, { keys: ['se.nese_factor'] }, S());
    expect(adopt.status).toBe(200);
    expect(adopt.json.data.adopted).toEqual(['se.nese_factor']);

    const changes = await request('GET', `${BASE}/${Y2}/changes?limit=5`, undefined, S());
    expect(changes.status).toBe(200);
    expect(changes.json.data.rows.map((r: { action: string }) => r.action)).toEqual(['shipped_adopted', 'year_created']);
    expect(changes.json.data.rows[0].userEmail).toMatch(/tp-super/);
  });

  it('400 on bad input', async () => {
    expect((await request('GET', `${BASE}/1999`, undefined, S())).status).toBe(400);
    expect((await request('GET', `${BASE}/abc`, undefined, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/Bad%20Key!`, { value: 1, reason: 'abc' }, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/not.a.key`, { value: 1, reason: 'abc' }, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/se.ss_rate`, { value: 'x', reason: 'abc' }, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/se.ss_rate`, { value: 0.1, reason: 'ab' }, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/se.ss_rate`, { reason: 'abc' }, S())).status).toBe(400);
    expect((await request('POST', `${BASE}/${Y1}/adopt-shipped`, { keys: 'se.ss_rate' }, S())).status).toBe(400);
    expect((await request('GET', `${BASE}/${Y1}/changes?limit=0`, undefined, S())).status).toBe(400);
    const bad = await request('PUT', `${BASE}/${Y1}/not.a.key`, { value: 1, reason: 'abc' }, S());
    expect(bad.json.error?.code).toBe('TE_PARAM_INVALID');
  });
});

describe('R7 in-app Verify routes', () => {
  it('super admin only; per-row verify records who/when/note; bulk verify needs confirm:true', async () => {
    for (const [p, b] of [[`/${Y1}/return_due_date/verify`, {}], [`/${Y1}/verify-all`, { confirm: true }]] as const) {
      expect((await request('POST', BASE + p, b)).status).toBe(401);
      expect((await request('POST', BASE + p, b, staffToken)).status).toBe(403);
    }
    await syncShippedSeeds({ [Y1]: [
      { key: 'se.nese_factor', value: 0.9235, status: 'unverified', citation: 'IRC 1402(a)(12)' },
      { key: 'return_due_date', value: '2096-04-15', status: 'unverified', citation: 'Fixture' },
    ] });
    const one = await request('POST', `${BASE}/${Y1}/se.nese_factor/verify`, { note: 'Statute' }, S());
    expect(one.status).toBe(200);
    expect(one.json.data).toMatchObject({ key: 'se.nese_factor', status: 'verified', verificationNote: 'Statute' });
    expect(one.json.data.verifiedByEmail).toMatch(/tp-super/);
    expect((await request('POST', `${BASE}/${Y1}/verify-all`, {}, S())).status).toBe(400);
    const all = await request('POST', `${BASE}/${Y1}/verify-all`, { confirm: true, note: 'Batch' }, S());
    expect(all.status).toBe(200);
    expect(all.json.data.verified).toEqual(['return_due_date']);
    expect((await request('POST', `${BASE}/${Y1}/not.a.key/verify`, {}, S())).json.error?.code).toBe('TE_PARAM_INVALID');
    // still overridable with a reason
    const ov = await request('PUT', `${BASE}/${Y1}/se.nese_factor`, { value: 0.9, reason: 'Testing' }, S());
    expect(ov.json.data).toMatchObject({ source: 'override', status: 'unverified' });
    // R6-04: the dialog's expectedValue must still be the row's value
    const stale = await request('POST', `${BASE}/${Y1}/se.nese_factor/verify`, { expectedValue: 0.9235 }, S());
    expect(stale.status).toBe(409);
    expect(stale.json.error?.code).toBe('TE_PARAM_CHANGED');
    expect(stale.json.error?.details).toMatchObject({ currentValue: 0.9 });
    expect((await request('POST', `${BASE}/${Y1}/se.nese_factor/verify`, { expectedValue: 0.9 }, S())).json.data.status).toBe('verified');
    const changes = await request('GET', `${BASE}/${Y1}/changes?limit=5`, undefined, S());
    expect(changes.json.data.rows.map((r: { action: string }) => r.action)).toEqual(['verified', 'override_set', 'verified', 'verified']);
  });
});
