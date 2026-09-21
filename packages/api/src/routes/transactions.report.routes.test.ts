// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, userTenantAccess, transactions, journalLines,
} from '../db/schema/index.js';
import { transactionsRouter } from './transactions.routes.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;

const PFX = 'txn-report-routes';
const OWNER_A = `${PFX}-a@example.com`;
const OWNER_B = `${PFX}-b@example.com`;
const ALL_EMAILS = [OWNER_A, OWNER_B];
const PASSWORD = 'correct-horse-battery';

async function cleanDb() {
  const rows = await db.select({ id: users.id, tenantId: users.tenantId }).from(users).where(inArray(users.email, ALL_EMAILS));
  const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
  const userIds = rows.map((r) => r.id);
  if (userIds.length) {
    await db.delete(sessions).where(inArray(sessions.userId, userIds));
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, userIds));
  }
  for (const tenantId of tenantIds) {
    await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
    await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
}

function get(pathname: string, token: string): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Authorization: `Bearer ${token}` } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }); }
          catch { resolve({ status: res.statusCode ?? 0, json: { raw } }); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  await cleanDb();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', transactionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

async function journalEntry(tenantId: string) {
  const accts = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.tenantId, tenantId)).limit(2);
  return ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: '2026-09-01',
    lines: [{ accountId: accts[0]!.id, debit: '5.00', credit: '0' }, { accountId: accts[1]!.id, debit: '0', credit: '5.00' }],
  });
}

describe('transaction report routes', () => {
  it('rejects a malformed id with 400 instead of letting Postgres 500 on it', async () => {
    const a = await authService.register({ email: OWNER_A, password: PASSWORD, displayName: 'Owner A', companyName: 'Tenant A' });
    const token = a.tokens.accessToken;
    expect((await get('/api/v1/transactions/not-a-uuid/related', token)).status).toBe(400);
    expect((await get('/api/v1/transactions/not-a-uuid/report.pdf', token)).status).toBe(400);
  });

  it('serves related transactions and the enriched detail for the caller’s own transaction', async () => {
    const a = await authService.register({ email: OWNER_A, password: PASSWORD, displayName: 'Owner A', companyName: 'Tenant A' });
    const je = await journalEntry(a.user.tenantId);
    const related = await get(`/api/v1/transactions/${je.id}/related`, a.tokens.accessToken);
    expect(related.status).toBe(200);
    expect(related.json).toEqual({ related: [], truncated: false });

    const detail = await get(`/api/v1/transactions/${je.id}`, a.tokens.accessToken);
    expect(detail.status).toBe(200);
    const txn = detail.json['transaction'] as Record<string, unknown>;
    expect(txn['tags']).toEqual([]);
    expect(Array.isArray(txn['bankAccounts'])).toBe(true);
  });

  it('does not reach into another tenant', async () => {
    const a = await authService.register({ email: OWNER_A, password: PASSWORD, displayName: 'Owner A', companyName: 'Tenant A' });
    const b = await authService.register({ email: OWNER_B, password: PASSWORD, displayName: 'Owner B', companyName: 'Tenant B' });
    const je = await journalEntry(a.user.tenantId);
    expect((await get(`/api/v1/transactions/${je.id}/related`, b.tokens.accessToken)).status).toBe(404);
    expect((await get(`/api/v1/transactions/${je.id}/report.pdf`, b.tokens.accessToken)).status).toBe(404);
  });
});
