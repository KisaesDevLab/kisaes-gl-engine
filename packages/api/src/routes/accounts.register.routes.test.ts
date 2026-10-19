// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// GET /accounts/:id/register and /register/summary over HTTP: the default
// JSON-number shape (MyBooks Online web) and the exact decimal-string shape
// behind ?exact=1 (capability register-exact-v1).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, contacts, transactions, journalLines,
  tags, transactionTags, reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import { accountsRouter } from './accounts.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';
import * as ledger from '../services/ledger.service.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let token = '';
let bankId = '';
let revenueId = '';
let expenseId = '';

function get(path: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function post(date: string, amount: string, kind: 'deposit' | 'expense', extra: Record<string, unknown> = {}) {
  const lines = kind === 'deposit'
    ? [{ accountId: bankId, debit: amount, credit: '0' }, { accountId: revenueId, debit: '0', credit: amount }]
    : [{ accountId: expenseId, debit: amount, credit: '0', ...extra }, { accountId: bankId, debit: '0', credit: amount }];
  return ledger.postTransaction(tenantId, { txnType: kind, txnDate: date, lines });
}

async function bankLineOf(txnId: string) {
  const rows = await db.select().from(journalLines).where(eq(journalLines.transactionId, txnId));
  return rows.find((l) => l.accountId === bankId)!.id;
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Reg Routes', slug: 'reg-routes-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `owner-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x', role: 'owner', displayName: 'Owner',
  }).returning();
  token = jwt.sign({ userId: u!.id, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  revenueId = (await accountsService.create(tenantId, { name: 'Sales', accountType: 'revenue', accountNumber: '4000' })).id;
  expenseId = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/accounts', accountsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await db.delete(reconciliationLines).where(
    inArray(reconciliationLines.reconciliationId, db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId))),
  );
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

const RANGE = 'start_date=2026-01-01&end_date=2026-12-31';

describe('GET /accounts/:id/register money shape', () => {
  it('keeps JSON numbers by default and sends exact decimal strings with ?exact=1', async () => {
    await post('2026-03-01', '0.1000', 'deposit');
    await post('2026-03-02', '0.2000', 'deposit');
    await post('2026-03-03', '12.3456', 'expense');

    const legacy = await get(`/api/v1/accounts/${bankId}/register?${RANGE}`);
    expect(legacy.status).toBe(200);
    expect(legacy.json.lines.map((l: any) => l.runningBalance)).toEqual([0.1, 0.3, -12.05]);
    expect(legacy.json.lines[2].payment).toBe(12.3456);
    expect(legacy.json.endingBalance).toBe(-12.05);
    expect(typeof legacy.json.balanceForward).toBe('number');

    const exact = await get(`/api/v1/accounts/${bankId}/register?${RANGE}&exact=1`);
    expect(exact.status).toBe(200);
    expect(exact.json.balanceForward).toBe('0.0000');
    expect(exact.json.lines.map((l: any) => l.runningBalance)).toEqual(['0.1000', '0.3000', '-12.0456']);
    expect(exact.json.lines.map((l: any) => [l.deposit, l.payment])).toEqual([
      ['0.1000', null], ['0.2000', null], [null, '12.3456'],
    ]);
    expect(exact.json.endingBalance).toBe('-12.0456');

    const exactTrue = await get(`/api/v1/accounts/${bankId}/register?${RANGE}&exact=true`);
    expect(exactTrue.json.endingBalance).toBe('-12.0456');
  });

  it('applies the reconciled filter (exact status) and the tag_id filter without changing balances', async () => {
    const [tag] = await db.insert(tags).values({ tenantId, name: 'Job 7' }).returning();
    await post('2026-03-01', '500.00', 'deposit');                                   // reconciled
    const cleared = await post('2026-03-02', '40.00', 'expense', { tagId: tag!.id }); // cleared, tagged
    await post('2026-03-03', '10.00', 'expense');                                    // uncleared
    const first = (await db.select().from(transactions).where(eq(transactions.tenantId, tenantId)))
      .find((t) => t.txnDate === '2026-03-01')!;
    const [done, open] = await db.insert(reconciliations).values([
      { tenantId, accountId: bankId, statementDate: '2026-03-01', statementEndingBalance: '500', beginningBalance: '0', status: 'complete' },
      { tenantId, accountId: bankId, statementDate: '2026-03-31', statementEndingBalance: '0', beginningBalance: '500', status: 'in_progress' },
    ]).returning();
    await db.insert(reconciliationLines).values([
      { reconciliationId: done!.id, journalLineId: await bankLineOf(first.id), isCleared: true },
      { reconciliationId: open!.id, journalLineId: await bankLineOf(cleared.id), isCleared: true },
    ]);

    const statusOf = async (filter: string) => {
      const r = await get(`/api/v1/accounts/${bankId}/register?${RANGE}&exact=1&${filter}`);
      expect(r.status).toBe(200);
      expect(r.json.endingBalance).toBe('450.0000');
      return r.json.lines.map((l: any) => [l.txnDate, l.reconciliationStatus, l.runningBalance]);
    };
    expect(await statusOf('reconciled=reconciled')).toEqual([['2026-03-01', 'reconciled', '500.0000']]);
    expect(await statusOf('reconciled=cleared')).toEqual([['2026-03-02', 'cleared', '460.0000']]);
    expect(await statusOf('reconciled=uncleared')).toEqual([['2026-03-03', 'uncleared', '450.0000']]);
    expect(await statusOf('reconciled=all')).toHaveLength(3);
    expect(await statusOf(`tag_id=${tag!.id}`)).toEqual([['2026-03-02', 'cleared', '460.0000']]);
    expect(await statusOf(`tag_id=${tag!.id}&reconciled=uncleared`)).toEqual([]);

    const bad = await get(`/api/v1/accounts/${bankId}/register?${RANGE}&tag_id=not-a-uuid`);
    expect(bad.status).toBe(400);
  });

  it('summary has unfiltered endingBalance and clearedBalance (through end_date when given)', async () => {
    const dep = await post('2026-03-01', '500.0000', 'deposit');
    const chk = await post('2026-03-02', '40.1234', 'expense');
    await post('2026-03-03', '10.0000', 'expense');
    await post('2026-04-01', '1.0000', 'deposit');
    // A draft never counts.
    await ledger.postTransaction(tenantId, {
      txnType: 'deposit', txnDate: '2026-03-04', status: 'draft',
      lines: [{ accountId: bankId, debit: '900', credit: '0' }, { accountId: revenueId, debit: '0', credit: '900' }],
    });
    const [done, open] = await db.insert(reconciliations).values([
      { tenantId, accountId: bankId, statementDate: '2026-03-01', statementEndingBalance: '500', beginningBalance: '0', status: 'complete' },
      { tenantId, accountId: bankId, statementDate: '2026-03-31', statementEndingBalance: '0', beginningBalance: '500', status: 'in_progress' },
    ]).returning();
    await db.insert(reconciliationLines).values([
      { reconciliationId: done!.id, journalLineId: await bankLineOf(dep.id), isCleared: true },
      { reconciliationId: open!.id, journalLineId: await bankLineOf(chk.id), isCleared: true },
    ]);

    const all = await get(`/api/v1/accounts/${bankId}/register/summary?exact=1`);
    expect(all.status).toBe(200);
    expect(all.json).toMatchObject({
      currentBalance: '450.8766', endingBalance: '450.8766', clearedBalance: '459.8766', asOfDate: null,
    });
    const march = await get(`/api/v1/accounts/${bankId}/register/summary?exact=1&end_date=2026-03-31`);
    expect(march.json).toMatchObject({ endingBalance: '449.8766', clearedBalance: '459.8766', asOfDate: '2026-03-31' });
    const legacy = await get(`/api/v1/accounts/${bankId}/register/summary?end_date=2026-03-31`);
    expect(legacy.json).toMatchObject({ endingBalance: 449.88, clearedBalance: 459.88 });
    // Matches the register's own unfiltered ending balance.
    const reg = await get(`/api/v1/accounts/${bankId}/register?start_date=2026-03-01&end_date=2026-03-31&exact=1&payee=nobody`);
    expect(reg.json.endingBalance).toBe('449.8766');

    expect((await get(`/api/v1/accounts/${bankId}/register/summary?end_date=31-03-2026`)).status).toBe(400);
  });

  it('summary currentBalance is a number by default and a decimal string under ?exact=1', async () => {
    await post('2026-03-01', '100.1234', 'deposit');
    const legacy = await get(`/api/v1/accounts/${bankId}/register/summary`);
    expect(legacy.status).toBe(200);
    expect(legacy.json.currentBalance).toBe(100.1234);
    const exact = await get(`/api/v1/accounts/${bankId}/register/summary?exact=1`);
    expect(exact.json.currentBalance).toBe('100.1234');
  });
});
