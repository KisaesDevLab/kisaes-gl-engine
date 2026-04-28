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
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants,
  users,
  companies,
  contacts,
  accounts,
  transactions,
  attachments,
  findings,
  checkRuns,
  checkSuppressions,
  checkParamsOverrides,
  tenantFeatureFlags,
  auditLog as auditLogTable,
} from '../db/schema/index.js';
import { reviewChecksRouter } from './review-checks.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let ownerToken = '';
let bookkeeperToken = '';
let readonlyToken = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/practice/checks', reviewChecksRouter);
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
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
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
        try {
          resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
        } catch {
          resolve({ status: res.statusCode ?? 0, json: raw });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedTenantWithFlagOn(): Promise<string> {
  const [t] = await db.insert(tenants).values({
    name: 'RC Test', slug: 'rc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  }).returning();
  await db.insert(tenantFeatureFlags).values({
    tenantId: t!.id, flagKey: 'CLOSE_REVIEW_V1', enabled: true,
  });
  return t!.id;
}

async function seedUser(tId: string, role: string) {
  const [u] = await db.insert(users).values({
    tenantId: tId,
    email: `${role}-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: await bcrypt.hash('secret-123-456', 12),
    role, displayName: role,
  }).returning();
  const token = jwt.sign(
    { userId: u!.id, tenantId: tId, role, isSuperAdmin: false },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );
  return { id: u!.id, token };
}

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
  await db.delete(findings).where(eq(findings.tenantId, tenantId));
  await db.delete(checkSuppressions).where(eq(checkSuppressions.tenantId, tenantId));
  await db.delete(checkParamsOverrides).where(eq(checkParamsOverrides.tenantId, tenantId));
  await db.delete(checkRuns).where(eq(checkRuns.tenantId, tenantId));
  await db.delete(attachments).where(eq(attachments.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

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
});

describe('review-checks routes — gates', () => {
  it('401 without token', async () => {
    const { status } = await request('GET', '/api/v1/practice/checks/registry');
    expect(status).toBe(401);
  });

  it('403 for readonly role', async () => {
    const { status } = await request('GET', '/api/v1/practice/checks/registry', undefined, readonlyToken);
    expect(status).toBe(403);
  });

  it('404 when CLOSE_REVIEW_V1 disabled', async () => {
    await db.update(tenantFeatureFlags).set({ enabled: false }).where(eq(tenantFeatureFlags.tenantId, tenantId));
    const { status } = await request('GET', '/api/v1/practice/checks/registry', undefined, bookkeeperToken);
    expect(status).toBe(404);
  });
});

describe('GET /registry', () => {
  it('lists the 15 stock checks (Phase 6 + receipt mismatch + AI judgment)', async () => {
    const { status, json } = await request('GET', '/api/v1/practice/checks/registry', undefined, bookkeeperToken);
    expect(status).toBe(200);
    // 13 from migration 0068 + receipt_amount_mismatch (0084) +
    // ai_personal_expense_review (0087).
    expect(json.checks.length).toBe(15);
    expect(json.checks.find((c: { checkKey: string }) => c.checkKey === 'transaction_above_materiality')).toBeDefined();
    expect(json.checks.find((c: { checkKey: string }) => c.checkKey === 'receipt_amount_mismatch')).toBeDefined();
    expect(json.checks.find((c: { checkKey: string }) => c.checkKey === 'ai_personal_expense_review')).toBeDefined();
  });
});

describe('POST /run', () => {
  it('runs and returns RunResult per company', async () => {
    const [c] = await db.insert(companies).values({ tenantId, businessName: 'Co1' }).returning();
    const { status, json } = await request('POST', '/api/v1/practice/checks/run', { companyId: c!.id }, bookkeeperToken);
    expect(status).toBe(200);
    expect(json.runs).toHaveLength(1);
    expect(json.runs[0]).toHaveProperty('runId');
  });

  it('runs across all companies when no companyId supplied', async () => {
    await db.insert(companies).values([
      { tenantId, businessName: 'Co1' },
      { tenantId, businessName: 'Co2' },
    ]);
    const { json } = await request('POST', '/api/v1/practice/checks/run', {}, bookkeeperToken);
    expect(json.runs).toHaveLength(2);
  });
});

describe('GET /findings', () => {
  it('returns empty when no findings exist', async () => {
    const { status, json } = await request('GET', '/api/v1/practice/checks/findings', undefined, bookkeeperToken);
    expect(status).toBe(200);
    expect(json.rows).toEqual([]);
  });

  it('filters by status', async () => {
    const [c] = await db.insert(companies).values({ tenantId, businessName: 'Co1' }).returning();
    // Seed a high-dollar txn so a finding gets created on run.
    await db.insert(transactions).values({
      tenantId, companyId: c!.id, txnType: 'expense', txnDate: '2026-04-15',
      total: '20000.0000', status: 'posted',
    });
    await request('POST', '/api/v1/practice/checks/run', { companyId: c!.id }, bookkeeperToken);
    const { json: open } = await request('GET', '/api/v1/practice/checks/findings?status=open', undefined, bookkeeperToken);
    expect(open.rows.length).toBeGreaterThanOrEqual(1);
    const { json: resolved } = await request('GET', '/api/v1/practice/checks/findings?status=resolved', undefined, bookkeeperToken);
    expect(resolved.rows).toEqual([]);
  });
});

describe('POST /suppressions + DELETE /suppressions/:id', () => {
  it('creates a suppression with a transactionId pattern', async () => {
    const { status, json } = await request('POST', '/api/v1/practice/checks/suppressions', {
      checkKey: 'transaction_above_materiality',
      matchPattern: { transactionId: '00000000-0000-0000-0000-000000000001' },
      reason: 'one-off CapEx review',
    }, bookkeeperToken);
    expect(status).toBe(201);
    expect(json.id).toBeDefined();
  });

  it('rejects empty matchPattern with 400', async () => {
    const { status } = await request('POST', '/api/v1/practice/checks/suppressions', {
      checkKey: 'transaction_above_materiality',
      matchPattern: {},
    }, bookkeeperToken);
    expect(status).toBe(400);
  });

  it('DELETE rejects bookkeeper, accepts owner', async () => {
    const create = await request('POST', '/api/v1/practice/checks/suppressions', {
      checkKey: 'transaction_above_materiality',
      matchPattern: { transactionId: '00000000-0000-0000-0000-000000000001' },
    }, bookkeeperToken);
    const id = create.json.id;
    const denied = await request('DELETE', `/api/v1/practice/checks/suppressions/${id}`, undefined, bookkeeperToken);
    expect(denied.status).toBe(403);
    const ok = await request('DELETE', `/api/v1/practice/checks/suppressions/${id}`, undefined, ownerToken);
    expect(ok.status).toBe(200);
  });
});

describe('PUT /overrides/:checkKey', () => {
  it('owner can set per-tenant override', async () => {
    const { status } = await request('PUT', '/api/v1/practice/checks/overrides/transaction_above_materiality', {
      params: { thresholdAmount: 5000 },
    }, ownerToken);
    expect(status).toBe(200);
  });

  it('rejects bookkeeper with 403', async () => {
    const { status } = await request('PUT', '/api/v1/practice/checks/overrides/transaction_above_materiality', {
      params: { thresholdAmount: 5000 },
    }, bookkeeperToken);
    expect(status).toBe(403);
  });
});

describe('POST /findings/:id/transition + bulk-transition', () => {
  async function seedFinding(): Promise<string> {
    const [c] = await db.insert(companies).values({ tenantId, businessName: 'Co1' }).returning();
    await db.insert(transactions).values({
      tenantId, companyId: c!.id, txnType: 'expense', txnDate: '2026-04-15',
      total: '20000.0000', status: 'posted',
    });
    await request('POST', '/api/v1/practice/checks/run', { companyId: c!.id }, bookkeeperToken);
    const list = await request('GET', '/api/v1/practice/checks/findings?status=open', undefined, bookkeeperToken);
    return list.json.rows[0].id;
  }

  it('transitions a finding to resolved with a resolution note', async () => {
    const id = await seedFinding();
    const { status, json } = await request(
      'POST',
      `/api/v1/practice/checks/findings/${id}/transition`,
      { status: 'resolved', resolutionNote: 'Confirmed legit equipment purchase' },
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.status).toBe('resolved');
    expect(json.resolutionNote).toContain('Confirmed legit');
  });

  it('records an event row that the events route returns', async () => {
    const id = await seedFinding();
    await request(
      'POST',
      `/api/v1/practice/checks/findings/${id}/transition`,
      { status: 'in_review', note: 'Investigating' },
      bookkeeperToken,
    );
    const { json } = await request(
      'GET',
      `/api/v1/practice/checks/findings/${id}/events`,
      undefined,
      bookkeeperToken,
    );
    expect(json.events.length).toBeGreaterThanOrEqual(1);
    expect(json.events[0].toStatus).toBe('in_review');
    expect(json.events[0].note).toBe('Investigating');
  });

  it('rejects assigned without assignedTo', async () => {
    const id = await seedFinding();
    const { status } = await request(
      'POST',
      `/api/v1/practice/checks/findings/${id}/transition`,
      { status: 'assigned' },
      bookkeeperToken,
    );
    expect(status).toBe(400);
  });

  it('bulk-transitions multiple findings in one call', async () => {
    const id1 = await seedFinding();
    // seedFinding adds a transaction + runs; running again won't
    // create new findings (dedupe). Add a second transaction to
    // create a second finding.
    const [c2] = await db.insert(companies).values({ tenantId, businessName: 'Co2' }).returning();
    await db.insert(transactions).values({
      tenantId, companyId: c2!.id, txnType: 'expense', txnDate: '2026-04-15',
      total: '11000.0000', status: 'posted',
    });
    await request('POST', '/api/v1/practice/checks/run', { companyId: c2!.id }, bookkeeperToken);
    const open = await request('GET', '/api/v1/practice/checks/findings?status=open', undefined, bookkeeperToken);
    const ids = open.json.rows.map((r: { id: string }) => r.id);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const { status, json } = await request(
      'POST',
      '/api/v1/practice/checks/findings/bulk-transition',
      { ids, status: 'ignored', note: 'reviewed in bulk' },
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.updated.length).toBe(ids.length);
    // Sanity: id1 should have been one of the updates.
    expect(json.updated).toContain(id1);
  });
});

describe('POST /run-ai-judgment', () => {
  it('returns 404 when AI_JUDGMENT_CHECKS_V1 is not enabled', async () => {
    // The default seed in beforeEach inserts the existing flags
    // disabled but does NOT include AI_JUDGMENT_CHECKS_V1, so
    // the route should reject with 404. (Even if migration 0083
    // ran, the gate uses isEnabled which defaults to FALSE for
    // the unseeded row.)
    const { status } = await request(
      'POST',
      '/api/v1/practice/checks/run-ai-judgment',
      {},
      bookkeeperToken,
    );
    expect(status).toBe(404);
  });

  it('runs and returns RunResult per company when flag is enabled', async () => {
    // Toggle AI_JUDGMENT_CHECKS_V1 on for this tenant. Use upsert
    // since the migration may have inserted the row already.
    await db
      .insert(tenantFeatureFlags)
      .values({ tenantId, flagKey: 'AI_JUDGMENT_CHECKS_V1', enabled: true })
      .onConflictDoUpdate({
        target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey],
        set: { enabled: true },
      });
    const [c] = await db.insert(companies).values({ tenantId, businessName: 'Co1' }).returning();
    const { status, json } = await request(
      'POST',
      '/api/v1/practice/checks/run-ai-judgment',
      { companyId: c!.id },
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.runs).toHaveLength(1);
    // No AI configured in tests, so judgment handler returns [];
    // the run completes cleanly with no findings created from
    // the AI check.
    expect(json.runs[0].error).toBeNull();
  });
});

describe('GET /findings-summary', () => {
  it('rolls up counts by status and severity', async () => {
    const [c] = await db.insert(companies).values({ tenantId, businessName: 'Co1' }).returning();
    await db.insert(transactions).values({
      tenantId, companyId: c!.id, txnType: 'expense', txnDate: '2026-04-15',
      total: '20000.0000', status: 'posted',
    });
    await request('POST', '/api/v1/practice/checks/run', { companyId: c!.id }, bookkeeperToken);
    const { status, json } = await request(
      'GET',
      '/api/v1/practice/checks/findings-summary',
      undefined,
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.total).toBeGreaterThanOrEqual(1);
    expect(json.byStatus.open).toBeGreaterThanOrEqual(1);
    expect(typeof json.bySeverity.high).toBe('number');
  });
});
