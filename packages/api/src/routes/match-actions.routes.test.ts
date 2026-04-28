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
import type { MatchCandidate } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  tenants,
  users,
  bankConnections,
  bankFeedItems,
  contacts,
  transactions,
  transactionClassificationState,
  tenantFeatureFlags,
  auditLog as auditLogTable,
} from '../db/schema/index.js';
import { matchActionsRouter } from './match-actions.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let bookkeeperToken = '';
let readonlyToken = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/practice/classification', matchActionsRouter);
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
    name: 'Match Actions Test',
    slug: 'mat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
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

async function seedFeedItemAndState(opts: {
  amount: string;
  candidates: MatchCandidate[];
}): Promise<{ feedItemId: string; stateId: string }> {
  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: crypto.randomUUID(), institutionName: 'Test Bank',
  }).returning();
  const [item] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: conn!.id,
    feedDate: '2026-04-15',
    amount: opts.amount,
    description: 'Test',
    status: 'pending',
  }).returning();
  const [state] = await db.insert(transactionClassificationState).values({
    tenantId,
    bankFeedItemId: item!.id,
    bucket: 'potential_match',
    confidenceScore: '0.95',
    matchCandidates: opts.candidates,
  }).returning();
  return { feedItemId: item!.id, stateId: state!.id };
}

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  tenantId = await seedTenantWithFlagOn();
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

describe('match-actions routes — auth + role gates', () => {
  it('returns 401 without token', async () => {
    const { status } = await request('POST', '/api/v1/practice/classification/00000000-0000-0000-0000-000000000000/apply', { candidateIndex: 0 });
    expect(status).toBe(401);
  });

  it('returns 403 for readonly role', async () => {
    const { status } = await request(
      'POST',
      '/api/v1/practice/classification/00000000-0000-0000-0000-000000000000/apply',
      { candidateIndex: 0 },
      readonlyToken,
    );
    expect(status).toBe(403);
  });

  it('returns 404 when AI_BUCKET_WORKFLOW_V1 is disabled', async () => {
    await db.update(tenantFeatureFlags).set({ enabled: false }).where(eq(tenantFeatureFlags.tenantId, tenantId));
    const { status } = await request(
      'POST',
      '/api/v1/practice/classification/00000000-0000-0000-0000-000000000000/apply',
      { candidateIndex: 0 },
      bookkeeperToken,
    );
    expect(status).toBe(404);
  });
});

describe('POST /:stateId/apply — journal entry path', () => {
  it('applies a JE candidate and returns the JE id', async () => {
    // Create a real journal-entry transaction so the apply succeeds.
    const [je] = await db.insert(transactions).values({
      tenantId,
      txnType: 'journal_entry',
      txnDate: '2026-04-15',
      total: '1000.0000',
      status: 'posted',
    }).returning();

    const { stateId } = await seedFeedItemAndState({
      amount: '1000.00',
      candidates: [
        {
          kind: 'journal_entry',
          targetId: je!.id,
          amount: '1000.0000',
          date: '2026-04-15',
          contactName: null,
          score: 0.95,
          amountScore: 1,
          dateScore: 1,
          nameScore: 0.7,
          reason: 'JE match',
        },
      ],
    });

    const { status, json } = await request(
      'POST',
      `/api/v1/practice/classification/${stateId}/apply`,
      { candidateIndex: 0 },
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.appliedTransactionId).toBe(je!.id);
    expect(json.kind).toBe('journal_entry');
  });

  it('returns 400 for an out-of-range candidate index', async () => {
    const { stateId } = await seedFeedItemAndState({
      amount: '100.00',
      candidates: [],
    });
    const { status, json } = await request(
      'POST',
      `/api/v1/practice/classification/${stateId}/apply`,
      { candidateIndex: 0 },
      bookkeeperToken,
    );
    expect(status).toBe(400);
    expect(json.error.code).toBe('INVALID_CANDIDATE_INDEX');
  });
});

describe('POST /:stateId/not-a-match', () => {
  it('drops a candidate and reports remaining count', async () => {
    const { stateId } = await seedFeedItemAndState({
      amount: '100.00',
      candidates: [
        {
          kind: 'journal_entry',
          targetId: '00000000-0000-0000-0000-000000000001',
          amount: '100',
          date: '2026-04-15',
          contactName: null,
          score: 0.9,
          amountScore: 1, dateScore: 1, nameScore: 0.5,
          reason: 'first',
        },
        {
          kind: 'journal_entry',
          targetId: '00000000-0000-0000-0000-000000000002',
          amount: '100',
          date: '2026-04-15',
          contactName: null,
          score: 0.85,
          amountScore: 1, dateScore: 1, nameScore: 0.25,
          reason: 'second',
        },
      ],
    });

    const { status, json } = await request(
      'POST',
      `/api/v1/practice/classification/${stateId}/not-a-match`,
      { candidateIndex: 0 },
      bookkeeperToken,
    );
    expect(status).toBe(200);
    expect(json.remaining).toBe(1);
  });

  it('returns 400 for an out-of-range candidate index', async () => {
    const { stateId } = await seedFeedItemAndState({ amount: '100.00', candidates: [] });
    const { status } = await request(
      'POST',
      `/api/v1/practice/classification/${stateId}/not-a-match`,
      { candidateIndex: 5 },
      bookkeeperToken,
    );
    expect(status).toBe(400);
  });
});

describe('POST /:stateId/rematch', () => {
  it('refreshes candidates for a state row', async () => {
    const { stateId } = await seedFeedItemAndState({
      amount: '100.00',
      candidates: [],
    });
    const { status, json } = await request(
      'POST',
      `/api/v1/practice/classification/${stateId}/rematch`,
      undefined,
      bookkeeperToken,
    );
    expect(status).toBe(200);
    // No matching ledger items → empty candidate set, but the
    // endpoint still succeeds.
    expect(json.candidateCount).toBe(0);
    expect(Array.isArray(json.candidates)).toBe(true);
  });
});
