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
import { eq, gte } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { tenants, users, tenantFeatureFlags, firms, firmUsers, tenantFirmAssignments, userTenantAccess } from '../../db/schema/index.js';
import { stateEstimateRules } from '../../db/schema/tax-estimator-state-rules.js';
import { taxEstimatorRouter } from '../tax-estimator.routes.js';
import { errorHandler } from '../../middleware/error-handler.js';
import { syncShippedStateRules } from '../../services/tax-estimator/tax-state-rules.service.js';

// Read endpoints sit behind the full taxEstimatorRouter guard chain; this pins
// that the state-rules mount inherits it (the chain itself is covered in
// tax-estimator.routes.test.ts).
const Y = 2088;
let server: Server | null = null;
let port = 0;
let tenantId = '';
let firmId = '';
const userIds: string[] = [];
let staffToken = '';
let clientToken = '';
let outsiderToken = '';

const slug = (p: string) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function mkUser(role: string, userType = 'staff') {
  const [u] = await db.insert(users).values({
    tenantId, email: `${slug('u')}@example.com`, passwordHash: await bcrypt.hash('x-secret-12345', 4),
    displayName: role, role, userType,
  }).returning();
  userIds.push(u!.id);
  return { id: u!.id, token: jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' }) };
}

function request(path: string, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers: token ? { Authorization: `Bearer ${token}` } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function cleanDb() {
  if (userIds.length) await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  if (firmId) {
    await db.delete(firmUsers).where(eq(firmUsers.firmId, firmId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  if (tenantId) {
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  await db.delete(stateEstimateRules).where(gte(stateEstimateRules.taxYear, Y));
  userIds.length = 0; tenantId = ''; firmId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'SR Practice', slug: slug('sr') }).returning();
  tenantId = t!.id;
  const [f] = await db.insert(firms).values({ name: 'SR Firm', slug: slug('srf') }).returning();
  firmId = f!.id;
  await db.insert(tenantFirmAssignments).values({ tenantId, firmId });
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'TAX_ESTIMATOR_V1', enabled: true });
  const staff = await mkUser('accountant');
  staffToken = staff.token;
  await db.insert(firmUsers).values({ firmId, userId: staff.id, firmRole: 'firm_staff' });
  await db.insert(userTenantAccess).values({ userId: staff.id, tenantId, role: 'accountant' });
  clientToken = (await mkUser('owner', 'client')).token;
  outsiderToken = (await mkUser('accountant')).token;
  await syncShippedStateRules([
    { state: 'TX', year: Y, key: 'has_income_tax', value: false, status: 'verified', citation: 'Fixture' },
    { state: 'AR', year: Y, key: 'required_threshold', value: 1000, status: 'verified', citation: 'Fixture' },
  ]);

  const app = express();
  app.use(express.json());
  app.use('/api/v1/tax-estimator', taxEstimatorRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('GET /api/v1/tax-estimator/state-rules', () => {
  const base = '/api/v1/tax-estimator/state-rules';

  it('guard chain is inherited: 401 anon, 404 client user_type, 404 staff without a firm', async () => {
    expect((await request(`${base}/${Y}`)).status).toBe(401);
    expect((await request(`${base}/${Y}`, clientToken)).status).toBe(404);
    expect((await request(`${base}/${Y}/AR`, clientToken)).status).toBe(404);
    expect((await request(`${base}/${Y}`, outsiderToken)).status).toBe(404);
  });

  it('firm staff read the 51 summaries and a state\'s rules', async () => {
    const list = await request(`${base}/${Y}`, staffToken);
    expect(list.status).toBe(200);
    expect(list.json.data).toHaveLength(51);
    expect(list.json.data.find((s: { state: string }) => s.state === 'TX')).toMatchObject({ status: 'complete', hasIncomeTax: false });
    const one = await request(`${base}/${Y}/AR`, staffToken);
    expect(one.status).toBe(200);
    expect(one.json.data).toMatchObject({ state: 'AR', year: Y, complete: false });
    expect(one.json.data.rules[0]).toMatchObject({ key: 'required_threshold', value: 1000 });
  });

  it('400 on a bad year or state', async () => {
    expect((await request(`${base}/abc`, staffToken)).status).toBe(400);
    expect((await request(`${base}/${Y}/ZZ`, staffToken)).status).toBe(400);
  });
});
