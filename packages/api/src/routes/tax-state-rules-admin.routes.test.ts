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
import type { StateRuleSeedRow } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, users, auditLog as auditLogTable } from '../db/schema/index.js';
import { stateEstimateRules, stateEstimateRuleOverrides } from '../db/schema/tax-estimator-state-rules.js';
import { taxStateRulesAdminRouter } from './tax-state-rules-admin.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { syncShippedStateRules } from '../services/tax-estimator/tax-state-rules.service.js';

const Y1 = 2086;
const Y2 = 2087;
const ZERO = '00000000-0000-0000-0000-000000000000';
const BASE = '/api/v1/admin/tax-state-rules';

let server: Server | null = null;
let port = 0;
let staffToken = '';
let superAdminToken = '';
let tenantId = '';

const FIXTURE: StateRuleSeedRow[] = [
  { state: 'AR', year: Y1, key: 'has_income_tax', value: true, status: 'verified', citation: 'Fixture' },
  { state: 'AR', year: Y1, key: 'required_threshold', value: 1000, status: 'verified', citation: 'Fixture' },
  { state: 'AR', year: Y1, key: 'installments.due_dates', value: ['2086-04-15'], status: 'verified', citation: 'Fixture' },
  { state: 'TX', year: Y1, key: 'has_income_tax', value: false, status: 'verified', citation: 'Fixture' },
];

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, taxStateRulesAdminRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

function request(method: string, pathname: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedUsers() {
  const [t] = await db.insert(tenants).values({ name: 'SR Admin', slug: 'sr-admin-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const passwordHash = await bcrypt.hash('super-secret-123', 12);
  const [sa] = await db.insert(users).values({
    tenantId, email: `sr-super-${Date.now()}@example.com`, passwordHash, displayName: 'Super', role: 'owner', isSuperAdmin: true,
  }).returning();
  const [st] = await db.insert(users).values({
    tenantId, email: `sr-staff-${Date.now()}@example.com`, passwordHash, displayName: 'Staff', role: 'bookkeeper', isSuperAdmin: false,
  }).returning();
  superAdminToken = jwt.sign({ userId: sa!.id, tenantId, role: 'owner', isSuperAdmin: true }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  staffToken = jwt.sign({ userId: st!.id, tenantId, role: 'bookkeeper', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
}

async function clean() {
  await db.delete(stateEstimateRules).where(gte(stateEstimateRules.taxYear, Y1));
  await db.delete(stateEstimateRuleOverrides).where(gte(stateEstimateRuleOverrides.taxYear, Y1));
  await db.delete(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_state_rule')));
  if (tenantId) {
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  tenantId = '';
}

beforeEach(async () => { await clean(); await seedUsers(); await syncShippedStateRules(FIXTURE); await startApp(); });
afterEach(async () => {
  if (server) { await new Promise<void>((resolve) => server!.close(() => resolve())); server = null; }
  await clean();
});

const S = () => superAdminToken;

describe('tax-state-rules admin routes', () => {
  it('401 without a token and 403 for non-super-admin on every endpoint', async () => {
    const calls: Array<[string, string, unknown?]> = [
      ['GET', `/${Y1}/summary`], ['GET', `/${Y1}/AR`], ['PUT', `/${Y1}/AR/required_threshold`, { value: 1, reason: 'abc' }],
      ['DELETE', `/${Y1}/AR/required_threshold`], ['POST', `/${Y2}/create-from-prior`], ['GET', `/${Y1}/diff`],
      ['POST', `/${Y1}/adopt-shipped`, {}], ['GET', `/${Y1}/changes`],
    ];
    for (const [m, p, b] of calls) {
      expect((await request(m, BASE + p, b)).status, `${m} ${p} anon`).toBe(401);
      expect((await request(m, BASE + p, b, staffToken)).status, `${m} ${p} staff`).toBe(403);
    }
  });

  it('GET summary lists 51 jurisdictions and GET :state returns the rules', async () => {
    const sum = await request('GET', `${BASE}/${Y1}/summary`, undefined, S());
    expect(sum.status).toBe(200);
    expect(sum.json.data).toHaveLength(51);
    expect(sum.json.data.find((s: { state: string }) => s.state === 'TX')).toMatchObject({ status: 'complete', hasIncomeTax: false });
    expect(sum.json.data.find((s: { state: string }) => s.state === 'AR')).toMatchObject({ status: 'partial', usesFederalFallback: true });

    const ar = await request('GET', `${BASE}/${Y1}/ar`, undefined, S()); // case-insensitive
    expect(ar.status).toBe(200);
    expect(ar.json.data).toMatchObject({ year: Y1, state: 'AR', isFallback: false, complete: false });
    expect(ar.json.data.rules).toHaveLength(3);
    const fb = await request('GET', `${BASE}/${Y2}/AR`, undefined, S());
    expect(fb.json.data).toMatchObject({ isFallback: true, fallbackYear: Y1 });
  });

  it('PUT sets an override, DELETE reverts it', async () => {
    const put = await request('PUT', `${BASE}/${Y1}/AR/required_threshold`, { value: 2000, reason: 'Testing' }, S());
    expect(put.status).toBe(200);
    expect(put.json.data).toMatchObject({ state: 'AR', key: 'required_threshold', value: 2000, source: 'override', shippedValue: 1000 });
    const del = await request('DELETE', `${BASE}/${Y1}/AR/required_threshold`, undefined, S());
    expect(del.status).toBe(200);
    expect(del.json.data).toMatchObject({ state: 'AR', reverted: true });
    const get = await request('GET', `${BASE}/${Y1}/AR`, undefined, S());
    expect(get.json.data.rules.find((p: { key: string }) => p.key === 'required_threshold').source).toBe('seed');
    expect((await request('DELETE', `${BASE}/${Y1}/AR/required_threshold`, undefined, S())).status).toBe(404);
  });

  it('create-from-prior, diff, adopt-shipped and changes', async () => {
    const created = await request('POST', `${BASE}/${Y2}/create-from-prior`, undefined, S());
    expect(created.status).toBe(201);
    expect(created.json.data).toMatchObject({ year: Y2, fromYear: Y1, created: 4, states: 2 });
    expect(created.json.data.rolledDates).toEqual(['AR:installments.due_dates']);
    expect((await request('POST', `${BASE}/${Y2}/create-from-prior`, undefined, S())).status).toBe(409);

    await syncShippedStateRules([{ state: 'AR', year: Y2, key: 'required_threshold', value: 800, status: 'verified', citation: 'Fixture' }]);
    const diff = await request('GET', `${BASE}/${Y2}/diff`, undefined, S());
    expect(diff.status).toBe(200);
    expect(diff.json.data.rows).toHaveLength(1);
    expect(diff.json.data.rows[0]).toMatchObject({ state: 'AR', key: 'required_threshold', shippedValue: 800, provisionalValue: 1000 });

    const adopt = await request('POST', `${BASE}/${Y2}/adopt-shipped`, { keys: ['AR:required_threshold'] }, S());
    expect(adopt.status).toBe(200);
    expect(adopt.json.data.adopted).toEqual(['AR:required_threshold']);

    const changes = await request('GET', `${BASE}/${Y2}/changes?limit=5`, undefined, S());
    expect(changes.status).toBe(200);
    expect(changes.json.data.rows.map((r: { action: string }) => r.action)).toEqual(['shipped_adopted', 'year_created']);
    expect(changes.json.data.rows[0].userEmail).toMatch(/sr-super/);
  });

  it('400 on bad input', async () => {
    expect((await request('GET', `${BASE}/1999/summary`, undefined, S())).status).toBe(400);
    expect((await request('GET', `${BASE}/abc/AR`, undefined, S())).status).toBe(400);
    expect((await request('GET', `${BASE}/${Y1}/ZZ`, undefined, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/AR/Bad%20Key!`, { value: 1, reason: 'abc' }, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/AR/not.a.key`, { value: 1, reason: 'abc' }, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/AR/required_threshold`, { value: 'x', reason: 'abc' }, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/AR/required_threshold`, { value: 1, reason: 'ab' }, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/AR/required_threshold`, { reason: 'abc' }, S())).status).toBe(400);
    expect((await request('PUT', `${BASE}/${Y1}/AR/safe_harbor.high_agi_rule`, { value: { threshold: 1 }, reason: 'abc' }, S())).status).toBe(400);
    expect((await request('POST', `${BASE}/${Y1}/adopt-shipped`, { keys: 'AR:x' }, S())).status).toBe(400);
    expect((await request('POST', `${BASE}/${Y1}/adopt-shipped`, { keys: ['bad'] }, S())).status).toBe(400);
    expect((await request('GET', `${BASE}/${Y1}/changes?limit=0`, undefined, S())).status).toBe(400);
    const bad = await request('PUT', `${BASE}/${Y1}/AR/not.a.key`, { value: 1, reason: 'abc' }, S());
    expect(bad.json.error?.code).toBe('TE_STATE_RULE_INVALID');
  });
});

describe('R7 in-app Verify routes', () => {
  it('super admin only; per-row and per-jurisdiction bulk verify', async () => {
    for (const [p, b] of [[`/${Y1}/AR/required_threshold/verify`, {}], [`/${Y1}/AR/verify-all`, { confirm: true }]] as const) {
      expect((await request('POST', BASE + p, b)).status).toBe(401);
      expect((await request('POST', BASE + p, b, staffToken)).status).toBe(403);
    }
    await syncShippedStateRules(FIXTURE.map((r) => (r.state === 'AR' ? { ...r, status: 'unverified' as const } : r)));
    const one = await request('POST', `${BASE}/${Y1}/AR/required_threshold/verify`, { note: 'AR DFA' }, S());
    expect(one.status).toBe(200);
    expect(one.json.data).toMatchObject({ state: 'AR', key: 'required_threshold', status: 'verified', verificationNote: 'AR DFA' });
    expect((await request('POST', `${BASE}/${Y1}/AR/verify-all`, { confirm: false }, S())).status).toBe(400);
    const all = await request('POST', `${BASE}/${Y1}/ar/verify-all`, { confirm: true }, S());
    expect(all.status).toBe(200);
    expect(all.json.data.verified.sort()).toEqual(['AR:has_income_tax', 'AR:installments.due_dates']);
    // R6-04: a stale expectedValue is refused
    await request('PUT', `${BASE}/${Y1}/AR/required_threshold`, { value: 1200, reason: 'DFA notice' }, S());
    const stale = await request('POST', `${BASE}/${Y1}/AR/required_threshold/verify`, { expectedValue: 1000 }, S());
    expect(stale.status).toBe(409);
    expect(stale.json.error?.code).toBe('TE_PARAM_CHANGED');
  });
});
