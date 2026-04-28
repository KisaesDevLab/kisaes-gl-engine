// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import type { ConditionAST, ActionsField } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  tenants,
  users,
  conditionalRules,
  conditionalRuleAudit,
  tenantFeatureFlags,
  auditLog as auditLogTable,
  firms,
  firmUsers,
  tenantFirmAssignments,
} from '../db/schema/index.js';
import { conditionalRulesRouter } from './conditional-rules.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let otherTenantId = '';
let ownerToken = '';
let bookkeeperToken = '';
let readonlyToken = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/practice/conditional-rules', conditionalRulesRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
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

async function seedTenantWithFlagOn(): Promise<string> {
  const [t] = await db.insert(tenants).values({
    name: 'CR Test',
    slug: 'cr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  }).returning();
  await db.insert(tenantFeatureFlags).values({
    tenantId: t!.id,
    flagKey: 'CONDITIONAL_RULES_V1',
    enabled: true,
  });
  return t!.id;
}

async function seedUser(tId: string, role: string) {
  const [u] = await db.insert(users).values({
    tenantId: tId,
    email: `${role}-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: await bcrypt.hash('secret-123-456', 12),
    role,
    displayName: role,
  }).returning();
  const token = jwt.sign(
    { userId: u!.id, tenantId: tId, role, isSuperAdmin: false },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );
  return { id: u!.id, token };
}

async function cleanDb() {
  for (const id of [tenantId, otherTenantId].filter(Boolean)) {
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, id));
    await db.delete(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, id));
    await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, id));
    // 3-tier rules plan, Phase 2 — Phase 2 tests create
    // firms / firm_users / tenant_firm_assignments. Drop the
    // assignment rows for this tenant; the firm + firm_users get
    // GC'd lazily (test seeds use unique slugs per run so accumulation
    // is harmless until the next aggressive-truncate sweep).
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, id));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, id));
    await db.delete(users).where(eq(users.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
  tenantId = '';
  otherTenantId = '';
}

// Phase 2 — sweep firm rows the suite creates. Called from
// afterEach so they don't accumulate across tests in the same
// run. We don't track ids per-test; instead, delete every firm
// whose slug starts with the suite's prefixes.
async function cleanFirms() {
  const prefixes = ['test-firm-', 'active-firm-'];
  for (const prefix of prefixes) {
    const rows = await db.query.firms.findMany({
      where: sql`${firms.slug} LIKE ${prefix + '%'}`,
    });
    for (const r of rows) {
      await db.delete(firmUsers).where(eq(firmUsers.firmId, r.id));
      await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, r.id));
      await db.delete(firms).where(eq(firms.id, r.id));
    }
  }
}

const SAMPLE_CONDITION: ConditionAST = {
  type: 'leaf',
  field: 'descriptor',
  operator: 'contains',
  value: 'amazon',
};

const SAMPLE_ACTIONS: ActionsField = [
  { type: 'set_account', accountId: '00000000-0000-0000-0000-000000000010' },
];

beforeEach(async () => {
  await cleanDb();
  tenantId = await seedTenantWithFlagOn();
  ownerToken = (await seedUser(tenantId, 'owner')).token;
  bookkeeperToken = (await seedUser(tenantId, 'bookkeeper')).token;
  readonlyToken = (await seedUser(tenantId, 'readonly')).token;
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
  await cleanFirms();
});

describe('conditional-rules routes — gates', () => {
  it('401 without token', async () => {
    const { status } = await request('GET', '/api/v1/practice/conditional-rules');
    expect(status).toBe(401);
  });

  it('403 for readonly role', async () => {
    const { status } = await request('GET', '/api/v1/practice/conditional-rules', undefined, readonlyToken);
    expect(status).toBe(403);
  });

  it('404 when CONDITIONAL_RULES_V1 disabled', async () => {
    await db.update(tenantFeatureFlags).set({ enabled: false }).where(eq(tenantFeatureFlags.tenantId, tenantId));
    const { status } = await request('GET', '/api/v1/practice/conditional-rules', undefined, bookkeeperToken);
    expect(status).toBe(404);
  });
});

describe('POST /', () => {
  it('creates a rule and returns 201', async () => {
    const { status, json } = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Amazon → office supplies',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    expect(status).toBe(201);
    expect(json.id).toBeDefined();
    expect(json.name).toBe('Amazon → office supplies');
    expect(json.priority).toBe(100);
    expect(json.active).toBe(true);
  });

  it('rejects malformed AST with 400', async () => {
    const { status } = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'bad',
        conditions: { type: 'leaf', field: 'descriptor', operator: 'gt', value: 0 },
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    expect(status).toBe(400);
  });

  it('rejects deferred field (class_id) with 400', async () => {
    const { status, json } = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'class rule',
        conditions: { type: 'leaf', field: 'class_id', operator: 'eq', value: 'c1' },
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toMatch(/not yet supported/);
  });

  it('rejects percentage splits that do not sum to 100', async () => {
    const { status } = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'bad split',
        conditions: SAMPLE_CONDITION,
        actions: [
          {
            type: 'split_by_percentage',
            splits: [
              { accountId: '00000000-0000-0000-0000-000000000010', percent: 30 },
              { accountId: '00000000-0000-0000-0000-000000000011', percent: 40 },
            ],
          },
        ],
      },
      bookkeeperToken,
    );
    expect(status).toBe(400);
  });

  it('rejects branching depth > MAX_BRANCH_DEPTH', async () => {
    let actions: ActionsField = [{ type: 'set_account', accountId: '00000000-0000-0000-0000-000000000010' }];
    for (let i = 0; i < 10; i++) {
      actions = { if: SAMPLE_CONDITION, then: actions };
    }
    const { status } = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      { name: 'deep', conditions: SAMPLE_CONDITION, actions },
      bookkeeperToken,
    );
    expect(status).toBe(400);
  });
});

describe('GET / + GET /:id', () => {
  it('lists rules with stats', async () => {
    await request('POST', '/api/v1/practice/conditional-rules', {
      name: 'Rule A',
      conditions: SAMPLE_CONDITION,
      actions: SAMPLE_ACTIONS,
    }, bookkeeperToken);
    const { status, json } = await request('GET', '/api/v1/practice/conditional-rules', undefined, bookkeeperToken);
    expect(status).toBe(200);
    expect(json.rules).toHaveLength(1);
    expect(json.rules[0].name).toBe('Rule A');
  });

  it('isolates list per tenant', async () => {
    otherTenantId = await seedTenantWithFlagOn();
    const otherToken = (await seedUser(otherTenantId, 'bookkeeper')).token;
    await request('POST', '/api/v1/practice/conditional-rules', {
      name: 'Other tenant rule',
      conditions: SAMPLE_CONDITION,
      actions: SAMPLE_ACTIONS,
    }, otherToken);
    const { json } = await request('GET', '/api/v1/practice/conditional-rules', undefined, bookkeeperToken);
    expect(json.rules).toHaveLength(0);
  });

  it('GET /:id returns 404 for cross-tenant id', async () => {
    otherTenantId = await seedTenantWithFlagOn();
    const otherToken = (await seedUser(otherTenantId, 'bookkeeper')).token;
    const created = await request('POST', '/api/v1/practice/conditional-rules', {
      name: 'A', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS,
    }, otherToken);
    const { status } = await request('GET', `/api/v1/practice/conditional-rules/${created.json.id}`, undefined, bookkeeperToken);
    expect(status).toBe(404);
  });
});

describe('Phase 5b — sandbox / suggestions / import-export', () => {
  it('POST /sandbox/run returns trace + matched + appliedActions for a sample context', async () => {
    const { status, json } = await request(
      'POST',
      '/api/v1/practice/conditional-rules/sandbox/run',
      {
        rule: { conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS },
        sampleContext: {
          descriptor: 'AMAZON MKTPLACE',
          amount: 42.5,
          amount_sign: 1,
          account_source_id: 'acct-1',
          date: '2026-04-15',
          day_of_week: 3,
        },
      },
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.matched).toBe(true);
    expect(json.appliedActions).toHaveLength(1);
    expect(json.trace.matched).toBe(true);
  });

  it('POST /sandbox/run-batch returns totals + first matches array', async () => {
    const { status, json } = await request(
      'POST',
      '/api/v1/practice/conditional-rules/sandbox/run-batch',
      { rule: { conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS } },
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(typeof json.totalScanned).toBe('number');
    expect(typeof json.totalMatched).toBe('number');
    expect(Array.isArray(json.firstMatches)).toBe(true);
  });

  it('GET /:id/audit returns paginated audit log (empty for a fresh rule)', async () => {
    const create = await request('POST', '/api/v1/practice/conditional-rules', {
      name: 'A', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS,
    }, bookkeeperToken);
    const id = create.json.id;
    const { status, json } = await request(
      'GET',
      `/api/v1/practice/conditional-rules/${id}/audit?limit=10`,
      undefined,
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(Array.isArray(json.rows)).toBe(true);
    expect(json.nextCursor).toBeNull();
  });

  it('GET /suggestions returns an array', async () => {
    const { status, json } = await request(
      'GET',
      '/api/v1/practice/conditional-rules/suggestions',
      undefined,
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(Array.isArray(json.suggestions)).toBe(true);
  });

  it('GET /bank-source-accounts returns the picker list', async () => {
    const { status, json } = await request(
      'GET',
      '/api/v1/practice/conditional-rules/bank-source-accounts',
      undefined,
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(Array.isArray(json.accounts)).toBe(true);
  });

  it('GET /export.json returns a versioned bundle', async () => {
    await request('POST', '/api/v1/practice/conditional-rules', {
      name: 'Export A', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS,
    }, bookkeeperToken);
    const { status, json } = await request(
      'GET',
      '/api/v1/practice/conditional-rules/export.json',
      undefined,
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.version).toBe(1);
    expect(json.rules.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /import accepts a valid bundle and inserts rules', async () => {
    const bundle = {
      version: 1,
      rules: [
        { name: 'Imported A', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS },
        { name: 'Imported B', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS, priority: 50 },
      ],
    };
    const { status, json } = await request(
      'POST',
      '/api/v1/practice/conditional-rules/import',
      bundle,
      bookkeeperToken,
    );
    expect(status).toBe(201);
    expect(json.imported).toBe(2);
    const list = await request('GET', '/api/v1/practice/conditional-rules', undefined, bookkeeperToken);
    expect(list.json.rules).toHaveLength(2);
  });

  it('POST /import is atomic — rejects whole bundle on partial failure', async () => {
    const bundle = {
      version: 1,
      rules: [
        { name: 'OK rule', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS },
        {
          name: 'Bad rule',
          conditions: { type: 'leaf', field: 'class_id', operator: 'eq', value: 'x' },
          actions: SAMPLE_ACTIONS,
        },
      ],
    };
    const { status } = await request(
      'POST',
      '/api/v1/practice/conditional-rules/import',
      bundle,
      bookkeeperToken,
    );
    expect(status).toBe(400);
    const list = await request('GET', '/api/v1/practice/conditional-rules', undefined, bookkeeperToken);
    expect(list.json.rules).toHaveLength(0);
  });
});

describe('PUT / DELETE / reorder', () => {
  it('PUT updates fields', async () => {
    const create = await request('POST', '/api/v1/practice/conditional-rules', {
      name: 'A', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS,
    }, bookkeeperToken);
    const id = create.json.id;
    const { status, json } = await request('PUT', `/api/v1/practice/conditional-rules/${id}`, {
      name: 'Renamed',
      active: false,
    }, bookkeeperToken);
    expect(status).toBe(200);
    expect(json.name).toBe('Renamed');
    expect(json.active).toBe(false);
  });

  it('DELETE rejected for bookkeeper, allowed for owner', async () => {
    const create = await request('POST', '/api/v1/practice/conditional-rules', {
      name: 'A', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS,
    }, bookkeeperToken);
    const id = create.json.id;
    const denied = await request('DELETE', `/api/v1/practice/conditional-rules/${id}`, undefined, bookkeeperToken);
    expect(denied.status).toBe(403);
    const ok = await request('DELETE', `/api/v1/practice/conditional-rules/${id}`, undefined, ownerToken);
    expect(ok.status).toBe(200);
  });

  it('reorder re-sequences priorities in 100-step increments', async () => {
    const a = (await request('POST', '/api/v1/practice/conditional-rules', { name: 'A', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS }, bookkeeperToken)).json.id;
    const b = (await request('POST', '/api/v1/practice/conditional-rules', { name: 'B', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS }, bookkeeperToken)).json.id;
    const { status } = await request('POST', '/api/v1/practice/conditional-rules/reorder', {
      orderedIds: [b, a],
    }, bookkeeperToken);
    expect(status).toBe(200);
    const list = (await request('GET', '/api/v1/practice/conditional-rules', undefined, bookkeeperToken)).json;
    const byId = new Map(list.rules.map((r: { id: string; priority: number }) => [r.id, r.priority]));
    expect(byId.get(b)).toBe(100);
    expect(byId.get(a)).toBe(200);
  });
});

// 3-tier rules plan, Phase 2 — scope coverage. The existing
// suite above creates rules without specifying scope, which the
// service defaults to tenant_user. These tests cover the new
// scope wire-shape, the per-tier role gates, and the
// flag-OFF/flag-ON behavior toggle.
describe('Phase 2 — scope-aware CRUD', () => {
  it('POST defaults to scope=tenant_user when omitted (Phase-1 compat)', async () => {
    const { status, json } = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      { name: 'Implicit user rule', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS },
      bookkeeperToken,
    );
    expect(status).toBe(201);
    expect(json.scope).toBe('tenant_user');
    expect(json.ownerUserId).toBeTruthy();
    expect(json.ownerFirmId).toBeNull();
    expect(json.tenantId).toBe(tenantId);
  });

  it('POST scope=tenant_firm rejected when tenant has no managing firm (404)', async () => {
    // RULES_TIERED_V1 must be enabled for the scope to actually
    // matter. Even when enabled, a solo book (no
    // tenant_firm_assignments row) cannot host firm rules.
    await db.insert(tenantFeatureFlags).values({
      tenantId,
      flagKey: 'RULES_TIERED_V1',
      enabled: true,
    }).onConflictDoNothing();
    const { status } = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Tenant-firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    expect(status).toBe(404);
  });

  it('POST scope=global_firm rejected when caller is not firm_admin (403)', async () => {
    await db.insert(tenantFeatureFlags).values({
      tenantId,
      flagKey: 'RULES_TIERED_V1',
      enabled: true,
    }).onConflictDoNothing();
    // Provision a firm + assign this tenant + caller is firm_staff (not admin).
    const [firm] = await db.insert(firms).values({
      name: 'Test Firm',
      slug: `test-firm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    await db.insert(tenantFirmAssignments).values({
      tenantId,
      firmId: firm!.id,
    });
    // Decode bookkeeper userId from the JWT and add as firm_staff.
    const decoded = (await import('jsonwebtoken')).default.decode(bookkeeperToken) as {
      userId: string;
    };
    await db.insert(firmUsers).values({
      firmId: firm!.id,
      userId: decoded.userId,
      firmRole: 'firm_staff',
    });
    const { status } = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Global firm rule',
        scope: 'global_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    expect(status).toBe(403);
  });

  it('POST scope=tenant_firm succeeds for firm_staff with active assignment', async () => {
    await db.insert(tenantFeatureFlags).values({
      tenantId,
      flagKey: 'RULES_TIERED_V1',
      enabled: true,
    }).onConflictDoNothing();
    const [firm] = await db.insert(firms).values({
      name: 'Active Firm',
      slug: `active-firm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    await db.insert(tenantFirmAssignments).values({
      tenantId,
      firmId: firm!.id,
    });
    const decoded = (await import('jsonwebtoken')).default.decode(bookkeeperToken) as {
      userId: string;
    };
    await db.insert(firmUsers).values({
      firmId: firm!.id,
      userId: decoded.userId,
      firmRole: 'firm_staff',
    });
    const { status, json } = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    expect(status).toBe(201);
    expect(json.scope).toBe('tenant_firm');
    expect(json.ownerFirmId).toBe(firm!.id);
    expect(json.ownerUserId).toBeNull();
    expect(json.tenantId).toBe(tenantId);
  });

  it('GET ?scope=tenant_user filters when flag is ON', async () => {
    await db.insert(tenantFeatureFlags).values({
      tenantId,
      flagKey: 'RULES_TIERED_V1',
      enabled: true,
    }).onConflictDoNothing();
    // Seed a tenant_user rule via the API.
    await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      { name: 'User rule', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS },
      bookkeeperToken,
    );
    const { status, json } = await request(
      'GET',
      '/api/v1/practice/conditional-rules?scope=tenant_user',
      undefined,
      bookkeeperToken,
    );
    expect(status).toBe(200);
    for (const r of json.rules) {
      expect(r.scope).toBe('tenant_user');
    }
  });

  it('flag-OFF list ignores ?scope= param (returns tenant_user only)', async () => {
    // Without the flag, GET ?scope=global_firm should still
    // return only the tenant_user rules (Phase-1 compat).
    await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      { name: 'User rule', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS },
      bookkeeperToken,
    );
    const { json } = await request(
      'GET',
      '/api/v1/practice/conditional-rules?scope=global_firm',
      undefined,
      bookkeeperToken,
    );
    expect(json.rules.every((r: { scope: string }) => r.scope === 'tenant_user')).toBe(true);
  });
});

// 3-tier rules plan, Phase 3 — promote / demote / fork +
// tenant-overrides. Each test seeds a firm + assignment + the
// tier flag, then exercises the transition. Solo-book tenants
// (no firm assignment) remain on the Phase-1 path and would
// 404 every transition.
describe('Phase 3 — tier transitions', () => {
  // Helper: enable RULES_TIERED_V1, provision a firm, assign
  // the test tenant to it, and promote the bookkeeper to a firm
  // role of the caller's choosing. Returns the firm id.
  async function setupFirmContext(role: 'firm_admin' | 'firm_staff' = 'firm_admin'): Promise<string> {
    await db
      .insert(tenantFeatureFlags)
      .values({ tenantId, flagKey: 'RULES_TIERED_V1', enabled: true })
      .onConflictDoNothing();
    const [firm] = await db
      .insert(firms)
      .values({
        name: 'Tier Firm',
        slug: `test-firm-tier-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      })
      .returning();
    await db.insert(tenantFirmAssignments).values({ tenantId, firmId: firm!.id });
    const decoded = (await import('jsonwebtoken')).default.decode(bookkeeperToken) as {
      userId: string;
    };
    await db.insert(firmUsers).values({
      firmId: firm!.id,
      userId: decoded.userId,
      firmRole: role,
    });
    return firm!.id;
  }

  it('promote tenant_user → tenant_firm (firm_staff allowed)', async () => {
    await setupFirmContext('firm_staff');
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      { name: 'User rule', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS },
      bookkeeperToken,
    );
    const { status, json } = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/promote`,
      {},
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.scope).toBe('tenant_firm');
    expect(json.ownerFirmId).toBeTruthy();
    expect(json.ownerUserId).toBeNull();
    expect(json.tenantId).toBe(tenantId);
  });

  it('promote tenant_firm → global_firm requires confirmActionShapes (422)', async () => {
    await setupFirmContext('firm_admin');
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    const { status, json } = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/promote`,
      {},
      bookkeeperToken,
    );
    expect(status).toBe(422);
    expect(JSON.stringify(json)).toMatch(/confirmActionShapes/i);
  });

  it('promote tenant_firm → global_firm with confirmActionShapes succeeds for firm_admin', async () => {
    await setupFirmContext('firm_admin');
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    const { status, json } = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/promote`,
      { confirmActionShapes: true },
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.scope).toBe('global_firm');
    expect(json.tenantId).toBeNull();
    expect(json.ownerFirmId).toBeTruthy();
  });

  it('promote to global_firm denied for firm_staff (403)', async () => {
    await setupFirmContext('firm_staff');
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    const { status } = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/promote`,
      { confirmActionShapes: true },
      bookkeeperToken,
    );
    expect(status).toBe(403);
  });

  it('demote tenant_firm → tenant_user (ownership becomes caller)', async () => {
    await setupFirmContext('firm_staff');
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    const { status, json } = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/demote`,
      {},
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.scope).toBe('tenant_user');
    expect(json.ownerUserId).toBeTruthy();
    expect(json.ownerFirmId).toBeNull();
  });

  it('demote global_firm → tenant_firm requires tenantId in body', async () => {
    await setupFirmContext('firm_admin');
    // Build a global directly via promote chain.
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/promote`,
      { confirmActionShapes: true },
      bookkeeperToken,
    );
    const { status } = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/demote`,
      {},
      bookkeeperToken,
    );
    expect(status).toBe(400);
  });

  it('demote at the bottom tier returns 400 ALREADY_BOTTOM_TIER', async () => {
    await setupFirmContext('firm_staff');
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      { name: 'User rule', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS },
      bookkeeperToken,
    );
    const { status, json } = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/demote`,
      {},
      bookkeeperToken,
    );
    expect(status).toBe(400);
    expect(JSON.stringify(json)).toMatch(/lowest tier/i);
  });

  it('fork-to-tenant copies a global as tenant_firm with forked_from link', async () => {
    const firmId = await setupFirmContext('firm_admin');
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    const promoted = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/promote`,
      { confirmActionShapes: true },
      bookkeeperToken,
    );
    expect(promoted.json.scope).toBe('global_firm');
    // Provision a second tenant managed by the same firm to fork into.
    const [t2] = await db.insert(tenants).values({
      name: 'Fork Target',
      slug: `fork-target-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    otherTenantId = t2!.id;
    await db.insert(tenantFirmAssignments).values({ tenantId: t2!.id, firmId });
    const fork = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${promoted.json.id}/fork-to-tenant`,
      { tenantId: t2!.id },
      bookkeeperToken,
    );
    expect(fork.status).toBe(201);
    expect(fork.json.scope).toBe('tenant_firm');
    expect(fork.json.tenantId).toBe(t2!.id);
    expect(fork.json.forkedFromGlobalId).toBe(promoted.json.id);
  });

  it('fork rejected when target tenant is not managed by caller firm (403)', async () => {
    await setupFirmContext('firm_admin');
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    const promoted = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/promote`,
      { confirmActionShapes: true },
      bookkeeperToken,
    );
    // Provision an orphan tenant with no firm assignment.
    const [orphan] = await db.insert(tenants).values({
      name: 'Orphan',
      slug: `orphan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    otherTenantId = orphan!.id;
    const { status } = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${promoted.json.id}/fork-to-tenant`,
      { tenantId: orphan!.id },
      bookkeeperToken,
    );
    expect(status).toBe(403);
  });

  it('GET tenant-overrides lists forks of a global', async () => {
    const firmId = await setupFirmContext('firm_admin');
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      {
        name: 'Firm rule',
        scope: 'tenant_firm',
        conditions: SAMPLE_CONDITION,
        actions: SAMPLE_ACTIONS,
      },
      bookkeeperToken,
    );
    const promoted = await request(
      'POST',
      `/api/v1/practice/conditional-rules/${create.json.id}/promote`,
      { confirmActionShapes: true },
      bookkeeperToken,
    );
    const [t2] = await db.insert(tenants).values({
      name: 'Override Tenant',
      slug: `override-tenant-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    otherTenantId = t2!.id;
    await db.insert(tenantFirmAssignments).values({ tenantId: t2!.id, firmId });
    await request(
      'POST',
      `/api/v1/practice/conditional-rules/${promoted.json.id}/fork-to-tenant`,
      { tenantId: t2!.id },
      bookkeeperToken,
    );
    const { status, json } = await request(
      'GET',
      `/api/v1/practice/conditional-rules/${promoted.json.id}/tenant-overrides`,
      undefined,
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.overrides).toHaveLength(1);
    expect(json.overrides[0].tenantId).toBe(t2!.id);
  });

  it('flag-OFF returns 404 on every transition endpoint', async () => {
    // No setupFirmContext call — the flag is OFF for this tenant.
    const create = await request(
      'POST',
      '/api/v1/practice/conditional-rules',
      { name: 'User rule', conditions: SAMPLE_CONDITION, actions: SAMPLE_ACTIONS },
      bookkeeperToken,
    );
    for (const path of [
      `/${create.json.id}/promote`,
      `/${create.json.id}/demote`,
      `/${create.json.id}/fork-to-tenant`,
    ]) {
      const { status } = await request(
        'POST',
        `/api/v1/practice/conditional-rules${path}`,
        path.endsWith('fork-to-tenant') ? { tenantId: tenantId } : {},
        bookkeeperToken,
      );
      expect(status).toBe(404);
    }
    const ov = await request(
      'GET',
      `/api/v1/practice/conditional-rules/${create.json.id}/tenant-overrides`,
      undefined,
      bookkeeperToken,
    );
    expect(ov.status).toBe(404);
  });
});
