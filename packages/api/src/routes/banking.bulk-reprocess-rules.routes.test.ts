// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// POST /banking/feed/bulk-reprocess-rules:
//   - Zod selector validation: both/neither of feedItemIds & allPending → 400
//   - happy path returns the reprocess counts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  bankConnections, bankFeedItems, bankRules,
  transactionClassificationState, transactions, journalLines,
  categorizationHistory,
} from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import { bankingRouter } from './banking.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let userId = '';
let token = '';
let connectionId = '';
let expenseAccountId = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/banking', bankingRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
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
          Authorization: `Bearer ${token}`,
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

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankRules).where(eq(bankRules.tenantId, tenantId));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  const { user } = await authService.register({
    email: `reprocess-route-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'Reprocess Route User',
    companyName: 'Reprocess Route Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  token = jwt.sign(
    { userId, tenantId, role: 'owner', isSuperAdmin: false },
    process.env['JWT_SECRET']!,
    { expiresIn: '5m' },
  );

  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  const expense = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')),
  });
  expenseAccountId = expense!.id;
  const [conn] = await db.insert(bankConnections).values({
    tenantId,
    accountId: bank!.id,
    provider: 'manual',
    institutionName: 'Route Test Bank',
  }).returning();
  connectionId = conn!.id;

  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

describe('POST /feed/bulk-reprocess-rules — validation', () => {
  it('returns 400 when both feedItemIds and allPending are given', async () => {
    const { status } = await request('POST', '/api/v1/banking/feed/bulk-reprocess-rules', {
      feedItemIds: [crypto.randomUUID()],
      allPending: true,
    });
    expect(status).toBe(400);
  });

  it('returns 400 when neither selector is given', async () => {
    const { status } = await request('POST', '/api/v1/banking/feed/bulk-reprocess-rules', {});
    expect(status).toBe(400);
  });

  it('returns 400 for an empty feedItemIds array', async () => {
    const { status } = await request('POST', '/api/v1/banking/feed/bulk-reprocess-rules', {
      feedItemIds: [],
    });
    expect(status).toBe(400);
  });
});

describe('POST /feed/bulk-reprocess-rules — happy path', () => {
  it('reprocesses selected pending items and returns counts', async () => {
    await db.insert(bankRules).values({
      tenantId,
      name: 'Suggest vendor',
      isActive: true,
      isGlobal: false,
      applyTo: 'both',
      descriptionContains: 'ZZQX ROUTE VENDOR',
      assignAccountId: expenseAccountId,
      autoConfirm: false,
      priority: 10,
    });
    const [matchedItem] = await db.insert(bankFeedItems).values({
      tenantId,
      bankConnectionId: connectionId,
      feedDate: '2026-06-20',
      description: 'ZZQX ROUTE VENDOR PAYMENT',
      originalDescription: 'ZZQX ROUTE VENDOR PAYMENT',
      amount: '12.5000',
      status: 'pending',
    }).returning();
    const [unmatchedItem] = await db.insert(bankFeedItems).values({
      tenantId,
      bankConnectionId: connectionId,
      feedDate: '2026-06-21',
      description: 'ZZQX NO RULE HERE',
      originalDescription: 'ZZQX NO RULE HERE',
      amount: '9.9900',
      status: 'pending',
    }).returning();

    const { status, json } = await request('POST', '/api/v1/banking/feed/bulk-reprocess-rules', {
      feedItemIds: [matchedItem!.id, unmatchedItem!.id],
    });
    expect(status).toBe(200);
    expect(json).toEqual({
      processed: 2,
      matched: 1,
      autoCategorized: 0,
      suggestionsUpdated: 1,
      untouched: 1,
    });
  });

  it('accepts allPending with a connection scope', async () => {
    await db.insert(bankFeedItems).values({
      tenantId,
      bankConnectionId: connectionId,
      feedDate: '2026-06-22',
      description: 'ZZQX PENDING THING',
      originalDescription: 'ZZQX PENDING THING',
      amount: '4.2000',
      status: 'pending',
    });

    const { status, json } = await request('POST', '/api/v1/banking/feed/bulk-reprocess-rules', {
      allPending: true,
      bankConnectionId: connectionId,
    });
    expect(status).toBe(200);
    expect(json.processed).toBe(1);
    // matched + untouched always partition processed.
    expect(json.matched + json.untouched).toBe(json.processed);
  });
});
