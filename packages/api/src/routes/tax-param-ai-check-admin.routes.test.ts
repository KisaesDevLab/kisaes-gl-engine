// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// AI parameter check routes (OPEN-QUESTIONS Q44): super admin only. The Anthropic client is mocked.

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
import { taxParamAiCheckAdminRouter } from './tax-param-ai-check-admin.routes.js';
import { taxParamAiChecks, taxParamAiCheckRuns } from '../db/schema/tax-estimator-ai-checks.js';
import { aiConfig } from '../db/schema/index.js';
import { encrypt } from '../utils/encryption.js';
import * as aiSvc from '../services/tax-estimator/tax-param-ai-check.service.js';
import { errorHandler } from '../middleware/error-handler.js';
import { syncShippedSeeds } from '../services/tax-estimator/tax-parameters.service.js';

const Y1 = 2096;
const ZERO = '00000000-0000-0000-0000-000000000000';
const BASE = '/api/v1/admin/tax-param-ai-checks';

let server: Server | null = null;
let port = 0;
let staffToken = '';
let superAdminToken = '';
let tenantId = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use(BASE, taxParamAiCheckAdminRouter);
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

const RP = 'https://www.irs.gov/pub/irs-drop/rp-96.pdf';
let savedConfig: typeof aiConfig.$inferSelect | undefined;

async function clean() {
  await db.delete(taxParamAiChecks).where(gte(taxParamAiChecks.taxYear, Y1));
  await db.delete(taxParamAiCheckRuns).where(gte(taxParamAiCheckRuns.taxYear, Y1));
  await db.delete(taxParameters).where(gte(taxParameters.taxYear, Y1));
  await db.delete(taxParameterOverrides).where(gte(taxParameterOverrides.taxYear, Y1));
  await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, ZERO));
  if (tenantId) {
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  tenantId = '';
}

beforeEach(async () => {
  await clean();
  await seedUsers();
  let [c] = await db.select().from(aiConfig).limit(1);
  if (!c) [c] = await db.insert(aiConfig).values({ piiProtectionLevel: 'strict', cloudVisionEnabled: false, disclosureVersion: 1 }).returning();
  if (!savedConfig) savedConfig = c;
  await db.update(aiConfig).set({ isEnabled: true, anthropicApiKeyEncrypted: encrypt('sk-test-not-real') }).where(eq(aiConfig.id, c!.id));
  await syncShippedSeeds({ [Y1]: [{ key: 'se.ss_wage_base', value: 176100, status: 'unverified', citation: 'Fixture' }] });
  const text = `For ${Y1} the contribution and benefit base is $184,500.`;
  aiSvc.__setAiCheckDepsForTests({
    enqueue: async () => undefined,
    sleep: async () => undefined,
    clientFactory: () => ({
      messages: {
        create: async () => ({
          id: 'm', type: 'message', role: 'assistant', model: 'x', stop_reason: 'end_turn', stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 1 } },
          content: [
            { type: 'web_fetch_tool_result', tool_use_id: 't', caller: { type: 'direct' }, content: { type: 'web_fetch_result', url: RP, retrieved_at: null, content: { type: 'document', title: null, citations: null, source: { type: 'text', media_type: 'text/plain', data: text } } } },
            { type: 'text', citations: null, text: JSON.stringify({ verdict: 'differs', foundValue: '184500', quote: 'the contribution and benefit base is $184,500', sourceUrl: RP, sourceTitle: 'Rev. Proc.', sourceTaxYear: Y1, sourceKind: 'revenue_procedure', inflationIndexed: true, rationale: 'r', confidence: 'high' }) },
          ],
        }) as never,
      },
    }),
  });
  await startApp();
});

afterEach(async () => {
  aiSvc.__setAiCheckDepsForTests(null);
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await clean();
  if (savedConfig) {
    await db.update(aiConfig).set({ isEnabled: savedConfig.isEnabled, anthropicApiKeyEncrypted: savedConfig.anthropicApiKeyEncrypted }).where(eq(aiConfig.id, savedConfig.id));
  }
});

const S = () => superAdminToken;
const ANY_UUID = '00000000-0000-4000-8000-000000000000';

describe('tax-param AI check admin routes', () => {
  it('401 without a token and 403 for a non-super-admin on every endpoint', async () => {
    const calls: Array<[string, string, unknown?]> = [
      ['GET', '/availability'], ['GET', `/latest?year=${Y1}`], ['GET', `/checks/${ANY_UUID}`],
      ['POST', `/checks/${ANY_UUID}/apply`, { expectedValue: 1 }], ['GET', '/runs'], ['POST', '/runs', { scope: 'federal', year: Y1 }],
      ['GET', `/runs/${ANY_UUID}`], ['POST', `/runs/${ANY_UUID}/cancel`],
    ];
    for (const [m, p, b] of calls) {
      expect((await request(m, BASE + p, b)).status, `${m} ${p} anon`).toBe(401);
      expect((await request(m, BASE + p, b, staffToken)).status, `${m} ${p} staff`).toBe(403);
    }
    // Nothing ran for the staff user.
    expect(await db.select().from(taxParamAiCheckRuns).where(gte(taxParamAiCheckRuns.taxYear, Y1))).toHaveLength(0);
  });

  it('super admin: availability, run a single check, poll, latest, apply', async () => {
    const av = await request('GET', `${BASE}/availability`, undefined, S());
    expect(av.status).toBe(200);
    expect(av.json.data).toMatchObject({ available: true, maxSearchesPerCheck: 5, concurrency: 2 });

    expect((await request('POST', `${BASE}/runs`, { scope: 'single', year: Y1, key: 'NOT A KEY' }, S())).status).toBe(400);
    const created = await request('POST', `${BASE}/runs`, { scope: 'single', year: Y1, key: 'se.ss_wage_base' }, S());
    expect(created.status).toBe(202);
    expect(created.json.data).toMatchObject({ status: 'queued', total: 1 });
    await aiSvc.executeRun(created.json.data.id);
    const polled = await request('GET', `${BASE}/runs/${created.json.data.id}`, undefined, S());
    expect(polled.json.data).toMatchObject({ status: 'completed', done: 1, counts: { differs: 1 } });
    const runs = await request('GET', `${BASE}/runs?year=${Y1}`, undefined, S());
    expect(runs.json.data.runs).toHaveLength(1);

    const latest = await request('GET', `${BASE}/latest?year=${Y1}`, undefined, S());
    const check = latest.json.data.checks['se.ss_wage_base'];
    expect(check).toMatchObject({ verdict: 'differs', foundValue: 184500, stale: false });
    expect((await request('GET', `${BASE}/checks/${check.id}`, undefined, S())).json.data.id).toBe(check.id);

    expect((await request('POST', `${BASE}/checks/${check.id}/apply`, { expectedValue: 1 }, S())).status).toBe(409);
    const applied = await request('POST', `${BASE}/checks/${check.id}/apply`, { expectedValue: 176100 }, S());
    expect(applied.status).toBe(200);
    expect(applied.json.data).toMatchObject({ value: 184500 });
    const [ov] = await db.select().from(taxParameterOverrides).where(and(eq(taxParameterOverrides.taxYear, Y1), eq(taxParameterOverrides.key, 'se.ss_wage_base')));
    expect(ov).toMatchObject({ value: 184500, status: 'override', verifiedAt: null });
    expect(ov!.citation).toMatch(/^AI-sourced, verify:/);
  });

  it('cancel and 404s', async () => {
    const created = await request('POST', `${BASE}/runs`, { scope: 'federal', year: Y1 }, S());
    expect(created.status).toBe(202);
    const cancelled = await request('POST', `${BASE}/runs/${created.json.data.id}/cancel`, undefined, S());
    expect(cancelled.json.data.status).toBe('cancelled');
    expect((await request('GET', `${BASE}/runs/${ANY_UUID}`, undefined, S())).status).toBe(404);
    expect((await request('GET', `${BASE}/checks/${ANY_UUID}`, undefined, S())).status).toBe(404);
    expect((await request('GET', `${BASE}/checks/not-a-uuid`, undefined, S())).status).toBe(400);
  });
});
