// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-164 (feed-exact-v1): Bank Feed posting is decimal-exact.
//   - categorize / approve post the stored amount exactly (4 decimals kept);
//   - PUT /feed/:id/categorize and /assign take the owner's `splits`, which
//     must add up exactly to |amount| (400 SPLITS_DONT_BALANCE {difference});
//   - an amount with more than 2 decimals can't be split (400 AMOUNT_NOT_CENTS);
//   - the owner's account overrides a rule's staged split;
//   - bulk approve still posts a rule's staged split, percentages by largest
//     remainder; staged fixed splits that don't add up are refused.

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
  tenants, users, accounts, companies, auditLog, transactions, journalLines, bankConnections, bankFeedItems,
  categorizationHistory, transactionClassificationState, tags, transactionTags,
} from '../db/schema/index.js';
import { bankingRouter } from './banking.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let userId = '';
let token = '';
let connectionId = '';
let bankId = '';
let supplies = '';
let travel = '';
let meals = '';
let sales = '';

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

async function feedItem(amount: string, extra: Partial<typeof bankFeedItems.$inferInsert> = {}) {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId, companyId, bankConnectionId: connectionId, feedDate: '2026-08-14', amount,
    description: 'ZZQX SUPPLY CO', originalDescription: 'ZZQX SUPPLY CO', status: 'pending', ...extra,
  }).returning();
  return row!.id;
}

async function item(id: string) {
  return (await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) }))!;
}

/** The posted lines of the item's transaction: [{accountId, debit, credit}], user lines then cash. */
async function postedLines(id: string) {
  const it = await item(id);
  expect(it.matchedTransactionId).toBeTruthy();
  const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, it.matchedTransactionId!) });
  const lines = await db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, it.matchedTransactionId!)));
  return {
    total: txn!.total,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit, credit: l.credit }))
      .sort((a, b) => (a.accountId === bankId ? 1 : 0) - (b.accountId === bankId ? 1 : 0)),
  };
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Feed Exact', slug: 'feed-exact-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Feed Exact Co', setupComplete: true }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `feed-exact-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x', role: 'owner', displayName: 'Owner',
  }).returning();
  userId = u!.id;
  token = jwt.sign({ userId, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  supplies = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;
  travel = (await accountsService.create(tenantId, { name: 'Travel', accountType: 'expense', accountNumber: '6100' })).id;
  meals = (await accountsService.create(tenantId, { name: 'Meals', accountType: 'expense', accountNumber: '6200' })).id;
  sales = (await accountsService.create(tenantId, { name: 'Sales', accountType: 'revenue', accountNumber: '4000' })).id;
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
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

const cat = (id: string, body: unknown) => call('PUT', `/api/v1/banking/feed/${id}/categorize`, body);
const assign = (id: string, body: unknown) => call('PUT', `/api/v1/banking/feed/${id}/assign`, body);
const approve = (id: string) => call('POST', `/api/v1/banking/feed/${id}/approve`, {});

describe('exact Bank Feed posting (U-164)', () => {
  it('advertises feed-exact-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('feed-exact-v1');
  });

  it('an unsplit 4-decimal amount posts exactly as stored', async () => {
    const id = await feedItem('12.3456');
    const r = await cat(id, { accountId: supplies });
    expect(r.status).toBe(200);
    const { total, lines } = await postedLines(id);
    expect(total).toBe('12.3456');
    expect(lines).toEqual([
      { accountId: supplies, debit: '12.3456', credit: '0.0000' },
      { accountId: bankId, debit: '0.0000', credit: '12.3456' },
    ]);
  });

  it('a 12-digit deposit posts exactly', async () => {
    const id = await feedItem('-999999999999.9900');
    expect((await cat(id, { accountId: sales })).status).toBe(200);
    const { total, lines } = await postedLines(id);
    expect(total).toBe('999999999999.9900');
    expect(lines).toEqual([
      { accountId: sales, debit: '0.0000', credit: '999999999999.9900' },
      { accountId: bankId, debit: '999999999999.9900', credit: '0.0000' },
    ]);
  });

  it('categorize with the owner\'s split posts each line exactly', async () => {
    const id = await feedItem('100.0000');
    const r = await cat(id, {
      accountId: supplies,
      splits: [{ accountId: supplies, amount: '33.34' }, { accountId: travel, amount: '33.33', memo: 'Cab' }, { accountId: meals, amount: '33.33' }],
    });
    expect(r.status).toBe(200);
    const { lines } = await postedLines(id);
    expect(lines.slice(0, 3)).toEqual([
      { accountId: supplies, debit: '33.3400', credit: '0.0000' },
      { accountId: travel, debit: '33.3300', credit: '0.0000' },
      { accountId: meals, debit: '33.3300', credit: '0.0000' },
    ]);
    expect(lines[3]).toEqual({ accountId: bankId, debit: '0.0000', credit: '100.0000' });
  });

  it('a split deposit credits each line', async () => {
    const id = await feedItem('-0.0300');
    expect((await cat(id, { accountId: sales, splits: [{ accountId: sales, amount: '0.02' }, { accountId: supplies, amount: '0.01' }] })).status).toBe(200);
    const { lines } = await postedLines(id);
    expect(lines).toEqual([
      { accountId: sales, debit: '0.0000', credit: '0.0200' },
      { accountId: supplies, debit: '0.0000', credit: '0.0100' },
      { accountId: bankId, debit: '0.0300', credit: '0.0000' },
    ]);
  });

  it('a 12-digit split posts exactly', async () => {
    const id = await feedItem('999999999999.99');
    expect((await cat(id, { accountId: supplies, splits: [
      { accountId: supplies, amount: '999999999999.98' }, { accountId: travel, amount: '0.01' },
    ] })).status).toBe(200);
    const { lines } = await postedLines(id);
    expect(lines.map((l) => l.debit)).toEqual(['999999999999.9800', '0.0100', '0.0000']);
  });

  it('owner splits that don\'t add up are 400 SPLITS_DONT_BALANCE with the difference; nothing posts', async () => {
    const id = await feedItem('84.1700');
    const r = await cat(id, { accountId: supplies, splits: [{ accountId: supplies, amount: '50.00' }, { accountId: travel, amount: '30.00' }] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('SPLITS_DONT_BALANCE');
    expect(r.json.error.details).toMatchObject({ kind: 'fixed', difference: '4.17' });
    const it = await item(id);
    expect(it.status).toBe('pending');
    expect(it.matchedTransactionId).toBeNull();

    const a = await assign(id, { accountId: supplies, splits: [{ accountId: supplies, amount: '84.00' }, { accountId: travel, amount: '0.18' }] });
    expect(a.status).toBe(400);
    expect(a.json.error.details).toMatchObject({ kind: 'fixed', difference: '-0.01' });
    expect((await item(id)).status).toBe('pending');
  });

  it('a 4-decimal amount can\'t be split: 400 AMOUNT_NOT_CENTS', async () => {
    const id = await feedItem('12.3456');
    const r = await cat(id, { accountId: supplies, splits: [{ accountId: supplies, amount: '12.34' }, { accountId: travel, amount: '0.01' }] });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('AMOUNT_NOT_CENTS');
    expect((await item(id)).status).toBe('pending');
    expect((await assign(id, { accountId: supplies, splits: [{ accountId: supplies, amount: '12.34' }, { accountId: travel, amount: '0.01' }] })).json.error.code)
      .toBe('AMOUNT_NOT_CENTS');
  });

  it('split lines are validated: 2-50 lines, positive cents, accounts in the tenant', async () => {
    const id = await feedItem('10.00');
    expect((await cat(id, { accountId: supplies, splits: [{ accountId: supplies, amount: '10.00' }] })).status).toBe(400);
    expect((await cat(id, { accountId: supplies, splits: [{ accountId: supplies, amount: '10.00' }, { accountId: travel, amount: '0.00' }] })).status).toBe(400);
    expect((await cat(id, { accountId: supplies, splits: [{ accountId: supplies, amount: '9.995' }, { accountId: travel, amount: '0.005' }] })).status).toBe(400);
    expect((await cat(id, { accountId: supplies, splits: [{ accountId: supplies, amount: '-1.00' }, { accountId: travel, amount: '11.00' }] })).status).toBe(400);
    const tooMany = Array.from({ length: 51 }, () => ({ accountId: supplies, amount: '0.01' }));
    expect((await cat(id, { accountId: supplies, splits: tooMany })).status).toBe(400);
    const foreign = '00000000-0000-0000-0000-000000000099';
    expect((await cat(id, { accountId: supplies, splits: [{ accountId: supplies, amount: '5.00' }, { accountId: foreign, amount: '5.00' }] })).status).toBe(400);
    expect((await item(id)).status).toBe('pending');
  });

  it('assign stages the owner\'s split and approve posts it', async () => {
    const [tag] = await db.insert(tags).values({ tenantId, name: 'Job 7' }).returning();
    const id = await feedItem('25.0000');
    const a = await assign(id, { accountId: supplies, splits: [
      { accountId: supplies, amount: '20.00', tagId: tag!.id }, { accountId: travel, amount: '5.00', memo: 'Parking' },
    ] });
    expect(a.status).toBe(200);
    expect(a.json.item.status).toBe('assigned');
    expect(a.json.item.splitsConfig).toEqual({ kind: 'fixed', splits: [
      { accountId: supplies, amount: '20.00', tagId: tag!.id, memo: null }, { accountId: travel, amount: '5.00', tagId: null, memo: 'Parking' },
    ] });
    expect((await approve(id)).status).toBe(200);
    const { lines } = await postedLines(id);
    expect(lines.map((l) => [l.accountId, l.debit])).toEqual([[supplies, '20.0000'], [travel, '5.0000'], [bankId, '0.0000']]);
  });

  it('the owner\'s account overrides a rule\'s staged split (assign clears it; categorize ignores it)', async () => {
    const ruleSplit = { kind: 'fixed', splits: [
      { accountId: travel, amount: '50.00', tagId: null, memo: null }, { accountId: meals, amount: '30.00', tagId: null, memo: null },
    ] };
    // assign without splits clears the staged split; approve posts one line.
    const a = await feedItem('84.1700', { splitsConfig: ruleSplit, suggestedAccountId: travel });
    const staged = await assign(a, { accountId: supplies });
    expect(staged.status).toBe(200);
    expect(staged.json.item.splitsConfig).toBeNull();
    expect((await approve(a)).status).toBe(200);
    expect((await postedLines(a)).lines).toEqual([
      { accountId: supplies, debit: '84.1700', credit: '0.0000' },
      { accountId: bankId, debit: '0.0000', credit: '84.1700' },
    ]);
    // categorize without splits posts one line on the owner's account.
    const b = await feedItem('84.1700', { splitsConfig: ruleSplit, suggestedAccountId: travel });
    expect((await cat(b, { accountId: supplies })).status).toBe(200);
    expect((await postedLines(b)).lines.map((l) => l.accountId)).toEqual([supplies, bankId]);
  });

  it('bulk approve posts a staged percentage split by largest remainder', async () => {
    const pct = (p: number[]) => ({ kind: 'percentage', splits: [
      { accountId: supplies, percent: p[0], tagId: null, memo: null },
      { accountId: travel, percent: p[1], tagId: null, memo: null },
      { accountId: meals, percent: p[2], tagId: null, memo: null },
    ] });
    const a = await feedItem('100.0000', { splitsConfig: pct([33.334, 33.333, 33.333]), suggestedAccountId: supplies });
    const b = await feedItem('0.0200', { splitsConfig: pct([25, 25, 50]), suggestedAccountId: supplies });
    const r = await call('POST', '/api/v1/banking/feed/bulk-approve', { feedItemIds: [a, b] });
    expect(r.status).toBe(200);
    expect(r.json.approved).toBe(2);
    expect((await postedLines(a)).lines.map((l) => [l.accountId, l.debit])).toEqual([
      [supplies, '33.3400'], [travel, '33.3300'], [meals, '33.3300'], [bankId, '0.0000'],
    ]);
    // 0.02 at 25 / 25 / 50: the tied cent goes to the first line; the 0.00 line is left off.
    expect((await postedLines(b)).lines.map((l) => [l.accountId, l.debit])).toEqual([
      [supplies, '0.0100'], [meals, '0.0100'], [bankId, '0.0000'],
    ]);
  });

  it('bulk approve refuses a staged split that doesn\'t add up (fixed) or total 100 (percentage)', async () => {
    const fixed = await feedItem('84.1700', { suggestedAccountId: travel, splitsConfig: { kind: 'fixed', splits: [
      { accountId: travel, amount: '50.00', tagId: null, memo: null }, { accountId: meals, amount: '30.00', tagId: null, memo: null },
    ] } });
    const pct = await feedItem('100.0000', { suggestedAccountId: travel, splitsConfig: { kind: 'percentage', splits: [
      { accountId: travel, percent: 33.33, tagId: null, memo: null }, { accountId: meals, percent: 66.66, tagId: null, memo: null },
    ] } });
    const r = await call('POST', '/api/v1/banking/feed/bulk-approve', { feedItemIds: [fixed, pct] });
    expect(r.status).toBe(200);
    expect(r.json.approved).toBe(0);
    expect(r.json.failures).toEqual([
      expect.objectContaining({ id: fixed, code: 'SPLITS_DONT_BALANCE' }),
      expect.objectContaining({ id: pct, code: 'SPLITS_DONT_BALANCE' }),
    ]);
    expect((await item(fixed)).status).toBe('pending');
    expect((await item(pct)).status).toBe('pending');
  });
});
