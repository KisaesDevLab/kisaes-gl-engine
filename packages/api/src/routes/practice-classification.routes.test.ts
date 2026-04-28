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
  bankConnections,
  bankFeedItems,
  transactionClassificationState,
  auditLog as auditLogTable,
  tenantFeatureFlags,
  findings,
  portalQuestions,
} from '../db/schema/index.js';
import { practiceClassificationRouter } from './practice-classification.routes.js';
import { practiceSettingsRouter } from './practice-settings.routes.js';
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
  app.use('/api/v1/practice/classification', practiceClassificationRouter);
  app.use('/api/v1/practice/settings', practiceSettingsRouter);
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
    name: 'PC Test',
    slug: 'pc-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  }).returning();
  await db.insert(tenantFeatureFlags).values({
    tenantId: t!.id,
    flagKey: 'AI_BUCKET_WORKFLOW_V1',
    enabled: true,
  });
  return t!.id;
}

async function seedUser(tId: string, role: string): Promise<{ id: string; token: string }> {
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

async function seedFeedItemWithState(tId: string, bucket: string, confidence: number): Promise<{ bankFeedItemId: string; stateId: string }> {
  const [conn] = await db.insert(bankConnections).values({
    tenantId: tId,
    accountId: crypto.randomUUID(),
    institutionName: 'Test Bank',
  }).returning();
  const [item] = await db.insert(bankFeedItems).values({
    tenantId: tId,
    bankConnectionId: conn!.id,
    feedDate: new Date().toISOString().slice(0, 10),
    description: 'Test Vendor Co',
    amount: '42.5000',
    status: 'pending',
  }).returning();
  const [state] = await db.insert(transactionClassificationState).values({
    tenantId: tId,
    bankFeedItemId: item!.id,
    bucket,
    confidenceScore: confidence.toFixed(3),
  }).returning();
  return { bankFeedItemId: item!.id, stateId: state!.id };
}

async function cleanDb() {
  for (const id of [tenantId, otherTenantId].filter(Boolean)) {
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, id));
    await db.delete(findings).where(eq(findings.tenantId, id));
    await db.delete(portalQuestions).where(eq(portalQuestions.tenantId, id));
    await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, id));
    await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, id));
    await db.delete(bankConnections).where(eq(bankConnections.tenantId, id));
    await db.delete(companies).where(eq(companies.tenantId, id));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, id));
    await db.delete(users).where(eq(users.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
  tenantId = '';
  otherTenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  tenantId = await seedTenantWithFlagOn();
  const owner = await seedUser(tenantId, 'owner');
  ownerToken = owner.token;
  const bookkeeper = await seedUser(tenantId, 'bookkeeper');
  bookkeeperToken = bookkeeper.token;
  const readonly_ = await seedUser(tenantId, 'readonly');
  readonlyToken = readonly_.token;
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

describe('practice-classification routes', () => {
  describe('feature-flag gate', () => {
    it('returns 404 when AI_BUCKET_WORKFLOW_V1 is disabled', async () => {
      await db
        .update(tenantFeatureFlags)
        .set({ enabled: false })
        .where(eq(tenantFeatureFlags.tenantId, tenantId));
      const { status } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(status).toBe(404);
    });

    it('allows requests when flag is enabled', async () => {
      const { status } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(status).toBe(200);
    });
  });

  describe('role gate', () => {
    it('rejects readonly role with 403', async () => {
      const { status } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        readonlyToken,
      );
      expect(status).toBe(403);
    });

    it('accepts bookkeeper role', async () => {
      const { status } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(status).toBe(200);
    });

    it('rejects requests without a token (401)', async () => {
      const { status } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
      );
      expect(status).toBe(401);
    });
  });

  describe('GET /summary', () => {
    it('returns zero counts for an empty tenant', async () => {
      const { status, json } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(status).toBe(200);
      expect(json.buckets.auto_high).toBe(0);
      expect(json.totalUncategorized).toBe(0);
    });

    it('counts rows per bucket', async () => {
      await seedFeedItemWithState(tenantId, 'auto_high', 0.96);
      await seedFeedItemWithState(tenantId, 'auto_high', 0.97);
      await seedFeedItemWithState(tenantId, 'needs_review', 0.4);
      const { json } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(json.buckets.auto_high).toBe(2);
      expect(json.buckets.needs_review).toBe(1);
      expect(json.totalUncategorized).toBe(3);
    });

    it('scopes counts to caller tenant', async () => {
      otherTenantId = await seedTenantWithFlagOn();
      await seedFeedItemWithState(otherTenantId, 'auto_high', 0.99);
      const { json } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(json.buckets.auto_high).toBe(0);
    });

    it('excludes already-approved rows from per-bucket counts and reports them as totalApproved', async () => {
      // Two unapproved + one approved row in auto_high. The
      // bucket count must drop the approved one but still
      // report it via totalApproved so the page-level progress
      // bar has a real denominator.
      const a = await seedFeedItemWithState(tenantId, 'auto_high', 0.96);
      await seedFeedItemWithState(tenantId, 'auto_high', 0.97);
      await db
        .update(transactionClassificationState)
        .set({ transactionId: crypto.randomUUID() })
        .where(eq(transactionClassificationState.id, a.stateId));
      const { json } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(json.buckets.auto_high).toBe(1);
      expect(json.totalUncategorized).toBe(1);
      expect(json.totalApproved).toBe(1);
    });

    it('reports the live findings count for the period', async () => {
      // Manual finding insert — Phase 6's orchestrator path is
      // covered separately; here we just confirm the summary
      // joins to findings correctly.
      await db.insert(findings).values({
        tenantId,
        companyId: null,
        checkKey: 'parent_account_posting',
        severity: 'med',
        status: 'open',
        payload: { detail: 'fixture' },
      });
      const { json } = await request(
        'GET',
        '/api/v1/practice/classification/summary?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(json.findingsCount).toBe(1);
    });
  });

  describe('GET /bucket/:bucket', () => {
    it('returns rows joined with feed item', async () => {
      await seedFeedItemWithState(tenantId, 'auto_high', 0.97);
      const { status, json } = await request(
        'GET',
        '/api/v1/practice/classification/bucket/auto_high?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(status).toBe(200);
      expect(json.rows).toHaveLength(1);
      expect(json.rows[0].description).toBe('Test Vendor Co');
      expect(json.rows[0].bucket).toBe('auto_high');
    });

    it('rejects an unknown bucket with 400', async () => {
      const { status } = await request(
        'GET',
        '/api/v1/practice/classification/bucket/not_a_bucket?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(status).toBe(400);
    });

    it('omits already-approved rows so the bucket list reflects remaining work', async () => {
      const open = await seedFeedItemWithState(tenantId, 'needs_review', 0.5);
      const closed = await seedFeedItemWithState(tenantId, 'needs_review', 0.5);
      await db
        .update(transactionClassificationState)
        .set({ transactionId: crypto.randomUUID() })
        .where(eq(transactionClassificationState.id, closed.stateId));
      const { json } = await request(
        'GET',
        '/api/v1/practice/classification/bucket/needs_review?periodStart=2026-01-01T00:00:00Z&periodEnd=2026-12-31T23:59:59Z',
        undefined,
        bookkeeperToken,
      );
      expect(json.rows).toHaveLength(1);
      expect(json.rows[0].stateId).toBe(open.stateId);
    });
  });

  describe('POST /approve', () => {
    it('fails approval for rows with no suggested account', async () => {
      // Rows seeded via seedFeedItemWithState have no suggestedAccountId,
      // so approval must fail cleanly with the canonical reason.
      const a = await seedFeedItemWithState(tenantId, 'auto_high', 0.96);
      const { status, json } = await request(
        'POST',
        '/api/v1/practice/classification/approve',
        { stateIds: [a.stateId] },
        bookkeeperToken,
      );
      expect(status).toBe(200);
      expect(json.approved).toHaveLength(0);
      expect(json.failed).toHaveLength(1);
      expect(json.failed[0].reason).toBe('missing_suggested_account');
    });

    it('rejects approval of another tenant state ids', async () => {
      otherTenantId = await seedTenantWithFlagOn();
      const other = await seedFeedItemWithState(otherTenantId, 'auto_high', 0.95);
      const { json } = await request(
        'POST',
        '/api/v1/practice/classification/approve',
        { stateIds: [other.stateId] },
        bookkeeperToken,
      );
      expect(json.approved).toHaveLength(0);
      expect(json.failed).toHaveLength(1);
      expect(json.failed[0].reason).toBe('not_found_or_wrong_tenant');
    });

    it('rejects empty stateIds with 400', async () => {
      const { status } = await request(
        'POST',
        '/api/v1/practice/classification/approve',
        { stateIds: [] },
        bookkeeperToken,
      );
      expect(status).toBe(400);
    });
  });

  describe('POST /approve-all', () => {
    it('requires confirm=true on auto_high bucket', async () => {
      const { status, json } = await request(
        'POST',
        '/api/v1/practice/classification/approve-all',
        { bucket: 'auto_high', periodStart: '2026-01-01T00:00:00Z', periodEnd: '2026-12-31T23:59:59Z' },
        bookkeeperToken,
      );
      expect(status).toBe(400);
      expect(json.error.code).toBe('CONFIRM_REQUIRED');
    });

    it('proceeds when confirm=true on auto_high (rows without suggested account fail cleanly)', async () => {
      await seedFeedItemWithState(tenantId, 'auto_high', 0.99);
      const { status, json } = await request(
        'POST',
        '/api/v1/practice/classification/approve-all',
        {
          bucket: 'auto_high',
          periodStart: '2026-01-01T00:00:00Z',
          periodEnd: '2026-12-31T23:59:59Z',
          confirm: true,
        },
        bookkeeperToken,
      );
      expect(status).toBe(200);
      // Test fixtures lack a suggestedAccountId, so every row in the
      // bucket fails with missing_suggested_account. The endpoint
      // itself returns 200 because it's a bulk-best-effort contract.
      expect(json.failed.length).toBeGreaterThan(0);
      expect(json.failed[0].reason).toBe('missing_suggested_account');
    });
  });

  describe('POST /:stateId/reclassify', () => {
    it('moves a row to a different bucket', async () => {
      const a = await seedFeedItemWithState(tenantId, 'needs_review', 0.4);
      const { status, json } = await request(
        'POST',
        `/api/v1/practice/classification/${a.stateId}/reclassify`,
        { bucket: 'auto_medium' },
        bookkeeperToken,
      );
      expect(status).toBe(200);
      expect(json.bucket).toBe('auto_medium');
    });

    it('404 for another tenant state id', async () => {
      otherTenantId = await seedTenantWithFlagOn();
      const other = await seedFeedItemWithState(otherTenantId, 'needs_review', 0.4);
      const { status } = await request(
        'POST',
        `/api/v1/practice/classification/${other.stateId}/reclassify`,
        { bucket: 'auto_medium' },
        bookkeeperToken,
      );
      expect(status).toBe(404);
    });
  });


  describe('GET /manual-queue', () => {
    it('returns items with no classification state row (orphans)', async () => {
      // Bank-feed item without a classification_state — simulates
      // worker not reaching it yet.
      const [conn] = await db.insert(bankConnections).values({
        tenantId, accountId: crypto.randomUUID(), institutionName: 'Bank',
      }).returning();
      await db.insert(bankFeedItems).values({
        tenantId, bankConnectionId: conn!.id, feedDate: '2026-04-15',
        description: 'Mystery vendor', amount: '99.9900', status: 'pending',
      });
      const { status, json } = await request(
        'GET',
        '/api/v1/practice/classification/manual-queue?periodStart=2026-04-01T00:00:00Z&periodEnd=2026-05-01T00:00:00Z',
        undefined,
        bookkeeperToken,
      );
      expect(status).toBe(200);
      expect(json.rows).toHaveLength(1);
      expect(json.rows[0].reason).toBe('orphan');
      expect(json.rows[0].description).toBe('Mystery vendor');
    });

    it('returns needs_review rows with no suggestion', async () => {
      // State row in needs_review with no suggestedAccountId and
      // no candidates — categorizer reached it but couldn't help.
      const a = await seedFeedItemWithState(tenantId, 'needs_review', 0.4);
      // Make sure the feed item's date is inside the period.
      await db
        .update(bankFeedItems)
        .set({ feedDate: '2026-04-15' })
        .where(eq(bankFeedItems.id, a.bankFeedItemId));
      const { json } = await request(
        'GET',
        '/api/v1/practice/classification/manual-queue?periodStart=2026-04-01T00:00:00Z&periodEnd=2026-05-01T00:00:00Z',
        undefined,
        bookkeeperToken,
      );
      const matching = json.rows.find((r: { stateId: string | null }) => r.stateId === a.stateId);
      expect(matching).toBeDefined();
      expect(matching.reason).toBe('no_suggestion');
    });
  });

  describe('POST /:stateId/ask-client', () => {
    it('creates a portal question and returns its id', async () => {
      // Need a company on the bank-feed item to satisfy the
      // ensureCompanyInTenant check in the question service.
      const [co] = await db.insert(companies).values({
        tenantId, businessName: 'Client Co',
      }).returning();
      const a = await seedFeedItemWithState(tenantId, 'needs_review', 0.4);
      await db
        .update(bankFeedItems)
        .set({ companyId: co!.id })
        .where(eq(bankFeedItems.id, a.bankFeedItemId));
      await db
        .update(transactionClassificationState)
        .set({ companyId: co!.id })
        .where(eq(transactionClassificationState.id, a.stateId));
      const { status, json } = await request(
        'POST',
        `/api/v1/practice/classification/${a.stateId}/ask-client`,
        { body: 'What was this charge for?' },
        bookkeeperToken,
      );
      expect(status).toBe(201);
      expect(json.questionId).toBeDefined();
    });

    it('returns 400 when body is empty', async () => {
      const a = await seedFeedItemWithState(tenantId, 'needs_review', 0.4);
      const { status } = await request(
        'POST',
        `/api/v1/practice/classification/${a.stateId}/ask-client`,
        { body: '' },
        bookkeeperToken,
      );
      expect(status).toBe(400);
    });

    it('returns 400 when bank feed item has no company', async () => {
      // seedFeedItemWithState sets state.companyId via item; force null
      // to simulate items not yet linked to a company.
      const a = await seedFeedItemWithState(tenantId, 'needs_review', 0.4);
      await db
        .update(transactionClassificationState)
        .set({ companyId: null })
        .where(eq(transactionClassificationState.id, a.stateId));
      const { status, json } = await request(
        'POST',
        `/api/v1/practice/classification/${a.stateId}/ask-client`,
        { body: 'follow-up' },
        bookkeeperToken,
      );
      expect(status).toBe(400);
      expect(json.error.code).toBe('COMPANY_REQUIRED');
    });
  });

  describe('GET /:stateId/vendor-enrichment', () => {
    it('returns source=none with null enrichment (stubbed AI)', async () => {
      const a = await seedFeedItemWithState(tenantId, 'needs_review', 0.4);
      const { status, json } = await request(
        'GET',
        `/api/v1/practice/classification/${a.stateId}/vendor-enrichment`,
        undefined,
        bookkeeperToken,
      );
      expect(status).toBe(200);
      expect(json.enrichment).toBeNull();
      expect(json.source).toBe('none');
    });
  });
});

describe('practice-settings routes', () => {
  describe('GET /', () => {
    it('returns defaults for a tenant with no overrides', async () => {
      const { status, json } = await request(
        'GET',
        '/api/v1/practice/settings',
        undefined,
        bookkeeperToken,
      );
      expect(status).toBe(200);
      expect(json.classificationThresholds.bucket3HighConfidence).toBe(0.95);
    });
  });

  describe('PUT /', () => {
    it('403 for bookkeeper', async () => {
      const { status } = await request(
        'PUT',
        '/api/v1/practice/settings',
        { bucket4Floor: 0.5 },
        bookkeeperToken,
      );
      expect(status).toBe(403);
    });

    it('owner can update', async () => {
      const { status, json } = await request(
        'PUT',
        '/api/v1/practice/settings',
        { bucket4Floor: 0.5 },
        ownerToken,
      );
      expect(status).toBe(200);
      expect(json.classificationThresholds.bucket4Floor).toBe(0.5);
    });

    it('rejects threshold ordering violation', async () => {
      const { status } = await request(
        'PUT',
        '/api/v1/practice/settings',
        { bucket4Floor: 0.9, bucket3HighConfidence: 0.5 },
        ownerToken,
      );
      expect(status).toBe(400);
    });
  });
});
