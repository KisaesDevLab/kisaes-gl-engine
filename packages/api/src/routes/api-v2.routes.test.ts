// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import {
  auditLog, accounts, contacts, transactions, journalLines, companies, users,
  tenants, sessions, apiKeys, tags, tagGroups, transactionTags,
  budgets, budgetLines, recurringSchedules, bankFeedItems, bankConnections,
  reconciliations, reconciliationLines, plaidItems, plaidAccounts,
  plaidAccountMappings, paymentApplications, depositLines,
} from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import { apiV2Router } from './api-v2.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let token = '';
let tenantId = '';
let companyId = '';
let bankAccountId = '';
let expenseAccountId = '';
let revenueAccountId = '';

const testEmail = `v2-test-${Date.now()}@example.com`;

async function cleanDb() {
  // Order matters due to FK constraints
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    recurring_schedules, budget_lines, budgets,
    bank_feed_items, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    transactions, contacts, tags, tag_groups, api_keys, sessions,
    accounts, companies, users, tenants
    CASCADE`);
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v2', apiV2Router);
  app.use(errorHandler);
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function req(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({
      method, hostname: '127.0.0.1', port, path: `/api/v2${path}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...extraHeaders,
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

describe('api-v2 integration (new endpoints)', () => {
  beforeAll(async () => {
    await cleanDb();
    await startApp();

    // Register creates tenant + user + default company + seeded COA
    const result = await authService.register({
      email: testEmail,
      password: 'password123456',
      displayName: 'V2 Test',
      companyName: 'V2 Test Co',
    });
    token = result.tokens.accessToken;
    tenantId = result.user.tenantId;

    // Find the default company
    const comp = await db.query.companies.findFirst({ where: (c, { eq }) => eq(c.tenantId, tenantId) });
    companyId = comp!.id;

    // Find a bank account, expense account, revenue account from the seeded COA
    const allAccounts = await db.query.accounts.findMany({ where: (a, { eq }) => eq(a.tenantId, tenantId) });
    bankAccountId = allAccounts.find((a) => a.accountType === 'asset' && (a.detailType === 'bank' || a.name.toLowerCase().includes('check')))!.id;
    expenseAccountId = allAccounts.find((a) => a.accountType === 'expense')!.id;
    revenueAccountId = allAccounts.find((a) => a.accountType === 'revenue')!.id;
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await cleanDb();
    await pool.end();
  });

  it('GET /me returns user + tenant + companies', async () => {
    const r = await req('GET', '/me');
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(testEmail);
    expect(r.json.activeTenantId).toBe(tenantId);
    expect(r.json.companies.length).toBeGreaterThan(0);
  });

  it('GET /dashboard/snapshot returns figures', async () => {
    const r = await req('GET', '/dashboard/snapshot');
    expect(r.status).toBe(200);
  });

  it('GET /dashboard/cash-position', async () => {
    const r = await req('GET', '/dashboard/cash-position');
    expect(r.status).toBe(200);
  });

  it('GET /dashboard/receivables + payables + action-items', async () => {
    for (const path of ['/dashboard/receivables', '/dashboard/payables', '/dashboard/action-items']) {
      const r = await req('GET', path);
      expect(r.status).toBe(200);
    }
  });

  it('GET /tags (empty initially)', async () => {
    const r = await req('GET', '/tags');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.tags)).toBe(true);
  });

  it('POST /tags validates with Zod (400 on missing name)', async () => {
    const r = await req('POST', '/tags', { color: '#fff' });
    expect(r.status).toBe(400);
  });

  it('POST /tags creates a tag', async () => {
    const r = await req('POST', '/tags', { name: 'TestTag', color: '#abc' });
    expect(r.status).toBe(201);
    expect(r.json.tag.name).toBe('TestTag');
  });

  it('GET /bills (empty)', async () => {
    const r = await req('GET', '/bills');
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual([]);
    expect(r.json.total).toBe(0);
  });

  it('GET /bills/payable', async () => {
    const r = await req('GET', '/bills/payable');
    expect(r.status).toBe(200);
  });

  it('POST /bills creates a bill', async () => {
    // Need a vendor contact
    const [vendor] = await db.insert(contacts).values({
      tenantId, companyId, displayName: 'Test Vendor', contactType: 'vendor',
    }).returning();

    const r = await req('POST', '/bills', {
      contactId: vendor!.id,
      txnDate: '2026-04-10',
      dueDate: '2026-05-10',
      lines: [{ accountId: expenseAccountId, amount: '100.00', description: 'Test' }],
      memo: 'Test bill',
    });
    expect(r.status).toBe(201);
    expect(r.json.bill.txnType).toBe('bill');
    expect(r.json.bill.balanceDue).toMatch(/100/);
  });

  it('GET /bills now returns the bill', async () => {
    const r = await req('GET', '/bills');
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(1);
  });

  it('POST /bills validates (400 on empty lines)', async () => {
    const r = await req('POST', '/bills', { contactId: '00000000-0000-0000-0000-000000000000', txnDate: '2026-04-10', lines: [] });
    expect(r.status).toBe(400);
  });

  it('GET /vendor-credits (empty)', async () => {
    const r = await req('GET', '/vendor-credits');
    expect(r.status).toBe(200);
  });

  it('GET /bill-payments (empty)', async () => {
    const r = await req('GET', '/bill-payments');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.data)).toBe(true);
  });

  it('GET /recurring (empty)', async () => {
    const r = await req('GET', '/recurring');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.schedules)).toBe(true);
  });

  it('POST /recurring 400 without templateTransactionId', async () => {
    const r = await req('POST', '/recurring', { frequency: 'monthly' });
    expect(r.status).toBe(400);
  });

  it('GET /budgets (empty)', async () => {
    const r = await req('GET', '/budgets');
    expect(r.status).toBe(200);
  });

  it('GET /checks', async () => {
    const r = await req('GET', '/checks');
    expect(r.status).toBe(200);
  });

  it('GET /checks/print-queue', async () => {
    const r = await req('GET', '/checks/print-queue');
    expect(r.status).toBe(200);
  });

  it('GET /banking/connections', async () => {
    const r = await req('GET', '/banking/connections');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.connections)).toBe(true);
  });

  it('GET /banking/feed', async () => {
    const r = await req('GET', '/banking/feed');
    expect(r.status).toBe(200);
  });

  it('GET /banking/reconciliations', async () => {
    const r = await req('GET', '/banking/reconciliations?account_id=' + bankAccountId);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.reconciliations)).toBe(true);
  });

  it('GET /attachments', async () => {
    const r = await req('GET', '/attachments');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.data)).toBe(true);
  });

  it('GET /reports/ar-aging', async () => {
    const r = await req('GET', '/reports/ar-aging');
    expect(r.status).toBe(200);
  });

  it('GET /reports/expense-by-vendor', async () => {
    const r = await req('GET', '/reports/expense-by-vendor');
    expect(r.status).toBe(200);
  });

  it('GET /reports/expense-by-category', async () => {
    const r = await req('GET', '/reports/expense-by-category');
    expect(r.status).toBe(200);
  });

  it('GET /reports/vendor-balance', async () => {
    const r = await req('GET', '/reports/vendor-balance');
    expect(r.status).toBe(200);
  });

  it('GET /reports/customer-balance', async () => {
    const r = await req('GET', '/reports/customer-balance');
    expect(r.status).toBe(200);
  });

  it('GET /reports/1099-vendor-summary', async () => {
    const r = await req('GET', '/reports/1099-vendor-summary?year=2026');
    expect(r.status).toBe(200);
  });

  it('GET /reports/sales-tax-liability', async () => {
    const r = await req('GET', '/reports/sales-tax-liability');
    expect(r.status).toBe(200);
  });

  it('GET /reports/check-register requires account_id', async () => {
    const r = await req('GET', '/reports/check-register');
    expect(r.status).toBe(400);
  });

  it('GET /reports/check-register with account_id', async () => {
    const r = await req('GET', '/reports/check-register?account_id=' + bankAccountId);
    expect(r.status).toBe(200);
  });

  it('GET /docs describes all new endpoint groups', async () => {
    const r = await req('GET', '/docs');
    expect(r.status).toBe(200);
    expect(r.json.endpoints.bills).toBeDefined();
    expect(r.json.endpoints.billPayments).toBeDefined();
    expect(r.json.endpoints.vendorCredits).toBeDefined();
    expect(r.json.endpoints.customerPayments).toBeDefined();
    expect(r.json.endpoints.checks).toBeDefined();
    expect(r.json.endpoints.recurring).toBeDefined();
    expect(r.json.endpoints.budgets).toBeDefined();
    expect(r.json.endpoints.dashboard).toBeDefined();
    expect(r.json.endpoints.tags).toBeDefined();
    expect(r.json.endpoints.banking).toBeDefined();
    expect(r.json.endpoints.attachments).toBeDefined();
  });

  it('POST /transactions/:id/void voids a transaction', async () => {
    // Create a simple expense first
    const create = await req('POST', '/transactions', {
      txnType: 'expense',
      txnDate: '2026-04-10',
      payFromAccountId: bankAccountId,
      lines: [{ expenseAccountId, amount: '25.00', description: 'Test' }],
      memo: 'to void',
    });
    expect(create.status).toBe(201);
    const txnId = create.json.transaction.id;

    const v = await req('POST', `/transactions/${txnId}/void`, { reason: 'test void' });
    expect(v.status).toBe(200);
    expect(v.json.transaction.status).toBe('void');
  });

  it('POST /transactions/:id/tags applies tags', async () => {
    // Create an expense and a tag
    const create = await req('POST', '/transactions', {
      txnType: 'expense',
      txnDate: '2026-04-10',
      payFromAccountId: bankAccountId,
      lines: [{ expenseAccountId, amount: '10.00' }],
    });
    const txnId = create.json.transaction.id;
    const tag = await req('POST', '/tags', { name: `TagForTxn-${Date.now()}` });
    expect(tag.status).toBe(201);
    const tagId = tag.json.tag.id;

    const r = await req('POST', `/transactions/${txnId}/tags`, { tagIds: [tagId] });
    expect(r.status).toBe(200);
    expect(r.json.count).toBe(1);
  });

  it('POST /transactions/:id/tags rejects invalid body', async () => {
    const r = await req('POST', '/transactions/00000000-0000-0000-0000-000000000000/tags', { tagIds: 'not-an-array' });
    expect(r.status).toBe(400);
  });
});
