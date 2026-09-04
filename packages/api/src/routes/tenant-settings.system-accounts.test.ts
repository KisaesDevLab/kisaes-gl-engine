// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tenant-side system-account designation
// (GET/PUT /tenant-settings/system-accounts). The point of this surface is
// that a firm's own admin can choose its suspense account without super-admin.
// What must NOT leak through it is every other ledger role: getting A/R or
// retained earnings wrong breaks posting and the year-end close, so those stay
// super-admin only.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { eq, and, sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { accounts, companies } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { getSuspenseAccountId, findSystemAccountId, SUSPENSE_TAG } from '../services/system-accounts.service.js';
import { tenantSettingsRouter } from './tenant-settings.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let userId = '';
let companyId = '';
let bankId = '';

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, transactions, contacts,
    tags, tag_groups, api_keys, sessions, tenant_detail_types,
    accounts, companies, users, tenants
    CASCADE`);
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/tenant-settings', tenantSettingsRouter);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
}

function req(method: string, path: string, body?: unknown, authToken?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({
      method, hostname: '127.0.0.1', port, path: `/api/v1/tenant-settings${path}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken ?? token}`,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode!, json: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode!, json: data }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

async function balanceOf(accountId: string): Promise<number> {
  const [a] = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)));
  return parseFloat(a!.balance ?? '0');
}

beforeAll(async () => {
  await cleanDb();
  await startApp();
  const result = await authService.register({
    email: `tsa-${Date.now()}@example.com`,
    password: 'password123456',
    displayName: 'System Accounts Test',
    companyName: 'TSA Co',
  });
  token = result.tokens.accessToken;
  tenantId = result.user.tenantId;
  userId = result.user.id;
  companyId = (await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) }))!.id;
  const [bank] = await db.insert(accounts).values({
    tenantId, companyId, name: 'Checking', accountType: 'asset',
    detailType: 'bank', accountNumber: '10999',
  }).returning();
  bankId = bank!.id;
}, 30000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await cleanDb();
  await pool.end();
});

describe('GET /system-accounts', () => {
  it('exposes suspense and nothing else', async () => {
    const r = await req('GET', '/system-accounts');
    expect(r.status).toBe(200);
    // The roles that break posting when wrong must not be reachable here.
    // Compare tags, not a stringified blob: 'accounts_receivable' legitimately
    // appears inside suspense's own forbiddenDetailTypes.
    const tags = r.json.roles.map((x: any) => x.tag);
    expect(tags).toEqual(['suspense']);
    for (const locked of ['accounts_receivable', 'accounts_payable', 'retained_earnings', 'sales_tax_payable']) {
      expect(tags).not.toContain(locked);
    }
  });

  it('offers only accounts the API would actually accept', async () => {
    await db.insert(accounts).values([
      { tenantId, companyId, name: 'Suspense (asset)', accountType: 'asset', detailType: 'other_current_asset', accountNumber: '19100' },
      { tenantId, companyId, name: 'Owner Equity', accountType: 'equity', accountNumber: '39100' },
    ]);
    const r = await req('GET', '/system-accounts');
    const names = r.json.candidates[0].accounts.map((a: any) => a.name);

    expect(names).toContain('Suspense (asset)');   // widened type, allowed
    expect(names).not.toContain('Checking');       // bank detail type, refused
    expect(names).not.toContain('Owner Equity');   // equity, refused
    expect(names).not.toContain('Accounts Receivable'); // holds another role
  });
});

describe('PUT /system-accounts/:tag', () => {
  it('404s for a role the tenant may not set, without confirming it exists', async () => {
    const r = await req('PUT', '/system-accounts/retained_earnings', { accountId: null });
    expect(r.status).toBe(404);
  });

  it('lets the firm move suspense onto a balance-sheet account', async () => {
    await getSuspenseAccountId(tenantId, companyId, userId);
    const [bs] = await db.select().from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, '19100')));

    const r = await req('PUT', '/system-accounts/suspense', { accountId: bs!.id });
    expect(r.status).toBe(200);
    expect(await findSystemAccountId(tenantId, SUSPENSE_TAG)).toBe(bs!.id);
    expect(r.json.roles[0].assigned.id).toBe(bs!.id);
  });

  it('refuses a bank account', async () => {
    const r = await req('PUT', '/system-accounts/suspense', { accountId: bankId });
    expect(r.status).toBe(400);
  });

  it('refuses to strand a balance, then moves it when told to', async () => {
    const current = await findSystemAccountId(tenantId, SUSPENSE_TAG);
    await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-05-01',
      lines: [
        { accountId: current!, debit: '55.00', credit: '0' },
        { accountId: bankId, debit: '0', credit: '55.00' },
      ],
    }, userId, companyId);

    const [next] = await db.insert(accounts).values({
      tenantId, companyId, name: 'Suspense v2', accountType: 'other_expense',
      detailType: 'other_expense', accountNumber: '89100',
    }).returning();

    const refused = await req('PUT', '/system-accounts/suspense', { accountId: next!.id });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('SYSTEM_ACCOUNT_BALANCE_STRANDED');
    expect(await balanceOf(current!)).toBe(55);

    const moved = await req('PUT', '/system-accounts/suspense', { accountId: next!.id, balanceAction: 'move' });
    expect(moved.status).toBe(200);
    expect(await balanceOf(current!)).toBe(0);
    expect(await balanceOf(next!.id)).toBe(55);
    expect((await ledger.validateBalance(tenantId)).valid).toBe(true);
  });
});
