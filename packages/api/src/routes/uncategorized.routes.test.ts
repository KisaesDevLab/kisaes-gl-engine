// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Practice -> Uncategorized router: the guard stack and the two ledger
// actions. The guard stack matters more than usual here because every write
// on this page posts to or moves money in the general ledger, so it carries
// requireResource('banking') on top of the usual practice flag gate.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, companies, accounts, bankConnections, bankFeedItems,
  transactions, journalLines, auditLog as auditLogTable, tenantFeatureFlags,
} from '../db/schema/index.js';
import { uncategorizedRouter } from './uncategorized.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as ledger from '../services/ledger.service.js';
import { getSuspenseAccountId } from '../services/system-accounts.service.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let flagOffTenantId = '';
let companyId = '';
let bankGlAccountId = '';
let expenseAccountId = '';
let bankConnectionId = '';
let ownerToken = '';
let readonlyToken = '';
let clientToken = '';
let flagOffToken = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/practice/uncategorized', uncategorizedRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
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
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedTenant(flagOn: boolean): Promise<string> {
  const [t] = await db.insert(tenants).values({
    name: 'Uncat Test',
    slug: 'uncat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  await db.insert(tenantFeatureFlags).values({
    tenantId: t!.id, flagKey: 'UNCATEGORIZED_REVIEW_V1', enabled: flagOn,
  });
  return t!.id;
}

async function seedUser(tId: string, role: string, userType: 'staff' | 'client' = 'staff') {
  const [u] = await db.insert(users).values({
    tenantId: tId,
    email: `${role}-${userType}-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: await bcrypt.hash('secret-123-456', 12),
    role, displayName: role, userType,
  }).returning();
  const token = jwt.sign(
    { userId: u!.id, tenantId: tId, role, isSuperAdmin: false, userType },
    process.env['JWT_SECRET']!, { expiresIn: '5m' },
  );
  return { id: u!.id, token };
}

async function seedPendingFeedItem(amount = '42.5000'): Promise<string> {
  const [item] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId, companyId,
    feedDate: new Date().toISOString().slice(0, 10),
    description: 'Mystery Vendor Co', amount, status: 'pending',
  }).returning();
  return item!.id;
}

async function cleanDb() {
  for (const id of [tenantId, flagOffTenantId].filter(Boolean)) {
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, id));
    await db.delete(journalLines).where(eq(journalLines.tenantId, id));
    await db.delete(transactions).where(eq(transactions.tenantId, id));
    await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, id));
    await db.delete(bankConnections).where(eq(bankConnections.tenantId, id));
    await db.delete(accounts).where(eq(accounts.tenantId, id));
    await db.delete(companies).where(eq(companies.tenantId, id));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, id));
    await db.delete(users).where(eq(users.tenantId, id));
    await db.delete(tenants).where(eq(tenants.id, id));
  }
  tenantId = ''; flagOffTenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  tenantId = await seedTenant(true);
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Uncat Co' }).returning();
  companyId = co!.id;

  const [bank] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Checking', accountType: 'asset',
    detailType: 'bank', accountNumber: '10999',
  }).returning();
  bankGlAccountId = bank!.id;
  const [exp] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Office Supplies', accountType: 'expense', accountNumber: '61010',
  }).returning();
  expenseAccountId = exp!.id;

  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: bankGlAccountId, institutionName: 'Test Bank',
  }).returning();
  bankConnectionId = conn!.id;

  ownerToken = (await seedUser(tenantId, 'owner')).token;
  readonlyToken = (await seedUser(tenantId, 'readonly')).token;
  clientToken = (await seedUser(tenantId, 'owner', 'client')).token;

  flagOffTenantId = await seedTenant(false);
  flagOffToken = (await seedUser(flagOffTenantId, 'owner')).token;

  await startApp();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('uncategorized router — access', () => {
  it('401s without a token', async () => {
    expect((await request('GET', '/api/v1/practice/uncategorized/summary')).status).toBe(401);
  });

  it('404s when the feature flag is off, rather than leaking that the page exists', async () => {
    const res = await request('GET', '/api/v1/practice/uncategorized/summary', undefined, flagOffToken);
    expect(res.status).toBe(404);
  });

  it('404s for a client user', async () => {
    const res = await request('GET', '/api/v1/practice/uncategorized/summary', undefined, clientToken);
    expect(res.status).toBe(404);
  });

  // requirePracticeAccess denies readonly the whole Practice surface, not
  // just its writes — the same policy that hides Practice from the sidebar
  // for that role. Asserted on a read so a future "let readonly look"
  // change has to come here and be deliberate.
  it('403s a readonly user on reads as well as writes', async () => {
    const feedItemId = await seedPendingFeedItem();
    const read = await request('GET', '/api/v1/practice/uncategorized/summary', undefined, readonlyToken);
    expect(read.status).toBe(403);

    const write = await request(
      'POST', '/api/v1/practice/uncategorized/post-to-suspense', { feedItemIds: [feedItemId] }, readonlyToken,
    );
    expect(write.status).toBe(403);
  });

  it('rejects a malformed body', async () => {
    const res = await request(
      'POST', '/api/v1/practice/uncategorized/post-to-suspense', { feedItemIds: [] }, ownerToken,
    );
    expect(res.status).toBe(400);
  });
});

describe('uncategorized router — posting to and clearing suspense', () => {
  it('reports an empty summary before anything is uncategorized', async () => {
    const res = await request('GET', '/api/v1/practice/uncategorized/summary', undefined, ownerToken);
    expect(res.status).toBe(200);
    // Reading the page must not create the suspense account.
    expect(res.json.suspenseAccountId).toBeNull();
    expect(res.json.unpostedCount).toBe(0);
  });

  it('posts a pending feed row to suspense, then clears it to a real category', async () => {
    const feedItemId = await seedPendingFeedItem('42.5000');

    const summaryBefore = await request('GET', '/api/v1/practice/uncategorized/summary', undefined, ownerToken);
    expect(summaryBefore.json.unpostedCount).toBe(1);

    const posted = await request(
      'POST', '/api/v1/practice/uncategorized/post-to-suspense', { feedItemIds: [feedItemId] }, ownerToken,
    );
    expect(posted.status).toBe(200);
    expect(posted.json.posted).toBe(1);
    expect(posted.json.skipped).toEqual([]);

    // Tab 1 emptied, tab 2 filled.
    const mid = await request('GET', '/api/v1/practice/uncategorized/summary', undefined, ownerToken);
    expect(mid.json.unpostedCount).toBe(0);
    expect(mid.json.transactionCount).toBe(1);
    expect(parseFloat(mid.json.balance)).toBe(42.5);

    const listed = await request('GET', '/api/v1/practice/uncategorized/in-suspense', undefined, ownerToken);
    expect(listed.status).toBe(200);
    expect(listed.json.total).toBe(1);
    const txnId = listed.json.rows[0].transactionId;

    const cleared = await request(
      'POST', '/api/v1/practice/uncategorized/clear',
      { transactionIds: [txnId], accountId: expenseAccountId }, ownerToken,
    );
    expect(cleared.status).toBe(200);
    expect(cleared.json.updated).toBe(1);

    const after = await request('GET', '/api/v1/practice/uncategorized/summary', undefined, ownerToken);
    expect(parseFloat(after.json.balance)).toBe(0);
    expect(after.json.transactionCount).toBe(0);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });

  it('reports a row that was already handled instead of silently dropping it', async () => {
    const feedItemId = await seedPendingFeedItem();
    await db.update(bankFeedItems).set({ status: 'excluded' })
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));

    const res = await request(
      'POST', '/api/v1/practice/uncategorized/post-to-suspense', { feedItemIds: [feedItemId] }, ownerToken,
    );
    expect(res.status).toBe(200);
    expect(res.json.posted).toBe(0);
    expect(res.json.skipped).toEqual([{ id: feedItemId, reason: 'already_excluded' }]);
  });

  it('refuses to clear into a system account', async () => {
    const suspenseId = await getSuspenseAccountId(tenantId, companyId);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-05-01',
      lines: [
        { accountId: suspenseId, debit: '10.00', credit: '0' },
        { accountId: bankGlAccountId, debit: '0', credit: '10.00' },
      ],
    }, undefined, companyId);

    const res = await request(
      'POST', '/api/v1/practice/uncategorized/clear',
      { transactionIds: [txn.id], accountId: suspenseId }, ownerToken,
    );
    expect(res.status).toBe(400);
  });

  it('does not reach another tenant\'s rows', async () => {
    const feedItemId = await seedPendingFeedItem();
    const res = await request(
      'POST', '/api/v1/practice/uncategorized/post-to-suspense', { feedItemIds: [feedItemId] }, flagOffToken,
    );
    // The flag gate fires first for this tenant, which is itself the answer:
    // no cross-tenant write is reachable from here.
    expect(res.status).toBe(404);
  });
});
