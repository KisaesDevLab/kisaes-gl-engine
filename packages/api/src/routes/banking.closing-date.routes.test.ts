// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-165 (feed-closing-date-v1): the Bank Feed routes that post an item
// (categorize, approve, bulk-categorize, bulk-approve, bulk-post-to-suspense)
// take the closing-date password like POST /transactions:
//   - a closed-period item without it is 423 TB_PERIOD_LOCKED (bulk: a
//     failure with code TB_PERIOD_LOCKED), nothing posts;
//   - a wrong password is 403 CLOSING_PASSWORD_INVALID (bulk: before any
//     item posts), audited as closing_password_failed;
//   - the right one posts and writes a closing_date_override audit row;
//   - the password never reaches the audit trail.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, transactions, journalLines, bankConnections, bankFeedItems,
  categorizationHistory, transactionClassificationState,
} from '../db/schema/index.js';
import { bankingRouter } from './banking.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const PASSWORD = 'feed-closing-pass-1';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let userId = '';
let token = '';
let connectionId = '';
let expenseId = '';

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function feedItem(feedDate: string, amount = '25.0000', extra: Partial<typeof bankFeedItems.$inferInsert> = {}) {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId, companyId, bankConnectionId: connectionId, feedDate, amount,
    description: 'OFFICE DEPOT', originalDescription: 'OFFICE DEPOT', status: 'pending', ...extra,
  }).returning();
  return row!.id;
}

async function status(id: string) {
  const row = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) });
  return row!.status;
}

async function auditRows(entityType: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, entityType)));
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Feed Closing', slug: 'feed-closing-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({
    tenantId, businessName: 'Feed Closing Co', setupComplete: true, lockDate: '2026-06-30',
    closingPasswordHash: await bcrypt.hash(PASSWORD, 4),
  }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `feed-closing-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x', role: 'owner', displayName: 'Owner',
  }).returning();
  userId = u!.id;
  token = jwt.sign({ userId, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  const bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  expenseId = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;
  const [conn] = await db.insert(bankConnections).values({ tenantId, companyId, accountId: bankId, provider: 'manual' }).returning();
  connectionId = conn!.id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/banking', bankingRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
  // updateLearning runs fire-and-forget after a posting; let it land first.
  await new Promise((r) => setTimeout(r, 50));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('Bank Feed closed period (U-165)', () => {
  it('advertises feed-closing-date-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('feed-closing-date-v1');
  });

  it('categorize: 423 without the password, 403 with a wrong one, posts and audits with the right one', async () => {
    const id = await feedItem('2026-06-15');
    const locked = await call('PUT', `/api/v1/banking/feed/${id}/categorize`, { accountId: expenseId });
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe('TB_PERIOD_LOCKED');
    expect(locked.json.error.details).toMatchObject({ closingPasswordRequired: true });
    expect(await status(id)).toBe('pending');

    const wrong = await call('PUT', `/api/v1/banking/feed/${id}/categorize`, { accountId: expenseId, closingPassword: 'nope-nope-nope' });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect(await status(id)).toBe('pending');
    expect(await auditRows('closing_password_failed')).toHaveLength(1);

    const ok = await call('PUT', `/api/v1/banking/feed/${id}/categorize`, { accountId: expenseId, closingPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.json.transaction.id).toBeTruthy();
    expect(await status(id)).toBe('categorized');
    expect(await auditRows('closing_date_override')).toHaveLength(1);
    const all = JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId)));
    expect(all).not.toContain(PASSWORD);
  });

  it('an open-period item needs no password', async () => {
    const id = await feedItem('2026-07-15');
    const ok = await call('PUT', `/api/v1/banking/feed/${id}/categorize`, { accountId: expenseId });
    expect(ok.status).toBe(200);
  });

  it('approve: 423 without the password, posts with it', async () => {
    const id = await feedItem('2026-06-20');
    expect((await call('PUT', `/api/v1/banking/feed/${id}/assign`, { accountId: expenseId })).status).toBe(200);
    const locked = await call('POST', `/api/v1/banking/feed/${id}/approve`, {});
    expect(locked.status).toBe(423);
    expect(await status(id)).toBe('assigned');
    const ok = await call('POST', `/api/v1/banking/feed/${id}/approve`, { closingPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect(await status(id)).toBe('categorized');
  });

  it('bulk-categorize: a closed item fails with its code; a wrong password posts nothing; the right one posts all', async () => {
    const closed = await feedItem('2026-06-10');
    const open = await feedItem('2026-07-10');
    const first = await call('POST', '/api/v1/banking/feed/bulk-categorize', { feedItemIds: [closed, open], accountId: expenseId });
    expect(first.status).toBe(200);
    expect(first.json.categorized).toBe(1);
    expect(first.json.failures).toEqual([expect.objectContaining({ id: closed, code: 'TB_PERIOD_LOCKED' })]);

    const open2 = await feedItem('2026-07-11', '30.0000');
    const wrong = await call('POST', '/api/v1/banking/feed/bulk-categorize', {
      feedItemIds: [open2, closed], accountId: expenseId, closingPassword: 'wrong-wrong-wrong',
    });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect(await status(open2)).toBe('pending');

    const ok = await call('POST', '/api/v1/banking/feed/bulk-categorize', {
      feedItemIds: [open2, closed], accountId: expenseId, closingPassword: PASSWORD,
    });
    expect(ok.status).toBe(200);
    expect(ok.json.categorized).toBe(2);
    expect(ok.json.failures).toEqual([]);
    expect(await auditRows('closing_date_override')).toHaveLength(1);
  });

  it('bulk-approve and bulk-post-to-suspense take the password too', async () => {
    const a = await feedItem('2026-06-11', '11.0000', { suggestedAccountId: expenseId });
    const locked = await call('POST', '/api/v1/banking/feed/bulk-approve', { feedItemIds: [a] });
    expect(locked.status).toBe(200);
    expect(locked.json.failures).toEqual([expect.objectContaining({ id: a, code: 'TB_PERIOD_LOCKED' })]);
    const ok = await call('POST', '/api/v1/banking/feed/bulk-approve', { feedItemIds: [a], closingPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.json.approved).toBe(1);

    const s = await feedItem('2026-06-12', '12.0000');
    const sLocked = await call('POST', '/api/v1/banking/feed/bulk-post-to-suspense', { feedItemIds: [s] });
    expect(sLocked.status).toBe(200);
    expect(sLocked.json.failures).toEqual([expect.objectContaining({ id: s, code: 'TB_PERIOD_LOCKED' })]);
    const sWrong = await call('POST', '/api/v1/banking/feed/bulk-post-to-suspense', { feedItemIds: [s], closingPassword: 'x-wrong-x-wrong' });
    expect(sWrong.status).toBe(403);
    const sOk = await call('POST', '/api/v1/banking/feed/bulk-post-to-suspense', { feedItemIds: [s], closingPassword: PASSWORD });
    expect(sOk.status).toBe(200);
    expect(sOk.json.posted).toBe(1);
  });
});
