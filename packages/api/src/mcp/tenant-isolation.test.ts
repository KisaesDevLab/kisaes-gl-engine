// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Aggressive MCP tenant-isolation audit. Each test creates two tenants
// with an API key each, then tries to use Tenant A's key to observe or
// mutate Tenant B's data via MCP tools or resources.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import crypto from 'crypto';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { apiKeys, companies, contacts, transactions } from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as billService from '../services/bill.service.js';
import * as expenseService from '../services/expense.service.js';
import { handleMcpRequest } from './server.js';

interface Tenant {
  apiKey: string;
  userId: string;
  tenantId: string;
  companyId: string;
  billId: string;
  txnId: string;
  vendorId: string;
}

let A: Tenant;
let B: Tenant;

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    bill_payment_applications, vendor_credit_applications,
    recurring_schedules, budget_lines, budgets,
    bank_feed_items, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    attachments,
    transactions, contacts, tags, tag_groups, api_keys, mcp_request_log, sessions,
    accounts, companies, users, tenants
    CASCADE`);
}

function mockReq(body: any, apiKey: string) {
  const captured: any = { status: 0, body: null };
  const req: any = {
    headers: { authorization: `Bearer ${apiKey}` },
    body, ip: '127.0.0.1',
  };
  const res: any = {
    status(s: number) { captured.status = s; return this; },
    json(b: any) { captured.body = b; return this; },
  };
  return { req, res, captured };
}

async function rpc(apiKey: string, method: string, params?: any): Promise<any> {
  const { req, res, captured } = mockReq({ method, params, id: 1 }, apiKey);
  await handleMcpRequest(req, res);
  return captured.body;
}

async function provisionTenant(email: string, name: string): Promise<Tenant> {
  const result = await authService.register({ email, password: 'password123456', displayName: name, companyName: `${name} Co` });
  const tenantId = result.user.tenantId;
  const userId = result.user.id;
  const comp = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  const companyId = comp!.id;

  // Enable MCP for this company (defaults to false)
  await db.update(companies).set({ mcpEnabled: true }).where(eq(companies.id, companyId));

  // Create an API key with all scopes
  const apiKey = 'sk_live_' + crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
  await db.insert(apiKeys).values({
    tenantId, userId, name: `${name} key`,
    keyPrefix: apiKey.slice(0, 12),
    keyHash, role: 'owner',
    scopes: 'all',
  });

  const allAccounts = await db.query.accounts.findMany({ where: (a, { eq: e }) => e(a.tenantId, tenantId) });
  const bankAccountId = allAccounts.find((a) => a.accountType === 'asset' && (a.detailType === 'bank' || a.name.toLowerCase().includes('check')))!.id;
  const expenseAccountId = allAccounts.find((a) => a.accountType === 'expense')!.id;

  const [vendor] = await db.insert(contacts).values({
    tenantId, companyId, displayName: `${name} Vendor`, contactType: 'vendor',
  }).returning();

  const bill = await billService.createBill(tenantId, {
    contactId: vendor!.id, txnDate: '2026-04-10', dueDate: '2026-05-10',
    lines: [{ accountId: expenseAccountId, amount: '100.00' }],
  }, userId, companyId);

  const expTxn = await expenseService.createExpense(tenantId, {
    txnDate: '2026-04-10', payFromAccountId: bankAccountId,
    lines: [{ expenseAccountId, amount: '25.00' }],
  }, userId);

  return { apiKey, userId, tenantId, companyId, billId: bill.id, txnId: expTxn.id, vendorId: vendor!.id };
}

describe('MCP tenant isolation — A\'s key cannot observe or mutate B\'s data', () => {
  beforeAll(async () => {
    await cleanDb();
    A = await provisionTenant(`mcp-iso-a-${Date.now()}@example.com`, 'McpA');
    B = await provisionTenant(`mcp-iso-b-${Date.now()}@example.com`, 'McpB');
  }, 30000);

  afterAll(async () => {
    await cleanDb();
    await pool.end();
  });

  it('A\'s list_companies does not include B\'s company', async () => {
    const resp = await rpc(A.apiKey, 'tools/call', { name: 'list_companies', arguments: {} });
    const companies = JSON.parse(resp.result.content[0].text);
    const ids = companies.map((c: any) => c.id);
    expect(ids).toContain(A.companyId);
    expect(ids).not.toContain(B.companyId);
  });

  it('A passing company_id = B\'s company fails with ACCESS_DENIED', async () => {
    const resp = await rpc(A.apiKey, 'tools/call', {
      name: 'list_bills', arguments: { company_id: B.companyId },
    });
    expect(resp.error).toBeDefined();
    // Specific code from context.ts validateCompanyAccess
    expect(resp.error.message).toMatch(/ACCESS_DENIED/);
  });

  it('A\'s list_bills never returns B\'s bill id', async () => {
    const resp = await rpc(A.apiKey, 'tools/call', { name: 'list_bills', arguments: {} });
    const data = JSON.parse(resp.result.content[0].text);
    const ids = data.data.map((b: any) => b.id);
    expect(ids).not.toContain(B.billId);
  });

  it('A cannot get_bill for B\'s bill (NOT_FOUND)', async () => {
    const resp = await rpc(A.apiKey, 'tools/call', {
      name: 'get_bill', arguments: { bill_id: B.billId },
    });
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toMatch(/NOT_FOUND|not found/i);
  });

  it('A cannot get_transaction for B\'s transaction', async () => {
    const resp = await rpc(A.apiKey, 'tools/call', {
      name: 'get_transaction', arguments: { transaction_id: B.txnId },
    });
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toMatch(/NOT_FOUND|not found/i);
  });

  it('A cannot void_transaction B\'s transaction', async () => {
    const resp = await rpc(A.apiKey, 'tools/call', {
      name: 'void_transaction', arguments: { transaction_id: B.txnId, reason: 'hostile' },
    });
    expect(resp.error).toBeDefined();
    // Confirm B's txn is still posted
    const b = await db.query.transactions.findFirst({ where: eq(transactions.id, B.txnId) });
    expect(b?.status).toBe('posted');
  });

  it('A cannot void_bill B\'s bill', async () => {
    const resp = await rpc(A.apiKey, 'tools/call', {
      name: 'void_bill', arguments: { bill_id: B.billId, reason: 'hostile' },
    });
    expect(resp.error).toBeDefined();
    const b = await db.query.transactions.findFirst({ where: eq(transactions.id, B.billId) });
    expect(b?.status).toBe('posted');
  });

  it('A tag_transaction on B\'s txn is rejected', async () => {
    // Create a tag in A first via the MCP? There's no create_tag tool, but
    // we can insert one directly with a scoped tenant.
    const { tags } = await import('../db/schema/index.js');
    const [atag] = await db.insert(tags).values({
      tenantId: A.tenantId, name: 'A-isolation-tag',
    }).returning();

    const resp = await rpc(A.apiKey, 'tools/call', {
      name: 'tag_transaction',
      arguments: { transaction_id: B.txnId, tag_ids: JSON.stringify([atag!.id]) },
    });
    expect(resp.error).toBeDefined();

    // No transaction_tags row should reference B's txn with A's tenant_id
    const rows = await db.execute(sql`
      SELECT tenant_id FROM transaction_tags WHERE transaction_id = ${B.txnId}
    `);
    const breach = (rows.rows as any[]).find((r) => r.tenant_id === A.tenantId);
    expect(breach).toBeUndefined();
  });

  it('A\'s get_contact for B\'s vendor fails', async () => {
    const resp = await rpc(A.apiKey, 'tools/call', {
      name: 'get_contact', arguments: { contact_id: B.vendorId },
    });
    expect(resp.error).toBeDefined();
  });

  it('A\'s run_profit_loss never references B\'s ids', async () => {
    const resp = await rpc(A.apiKey, 'tools/call', {
      name: 'run_profit_loss', arguments: { start_date: '2026-01-01', end_date: '2026-12-31' },
    });
    const text = resp.result.content[0].text;
    expect(text).not.toContain(B.vendorId);
    expect(text).not.toContain(B.txnId);
    expect(text).not.toContain(B.billId);
  });

  it('A\'s resources/read bills/payable with B\'s company_id is denied', async () => {
    const resp = await rpc(A.apiKey, 'resources/read', {
      uri: `kisbooks://company/${B.companyId}/bills/payable`,
    });
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toMatch(/ACCESS_DENIED|SCOPE_DENIED/);
  });

  it('A\'s resources/read recent-transactions with B\'s company_id is denied', async () => {
    const resp = await rpc(A.apiKey, 'resources/read', {
      uri: `kisbooks://company/${B.companyId}/recent-transactions`,
    });
    expect(resp.error).toBeDefined();
  });

  it('A\'s resources/list is not filtered by B (just the URI templates)', async () => {
    const resp = await rpc(A.apiKey, 'resources/list');
    expect(resp.result).toBeDefined();
    // Templates contain {id} placeholder — they are not per-tenant
    const uris = resp.result.resources.map((r: any) => r.uri);
    expect(uris.every((u: string) => u.includes('{id}') || u === 'kisbooks://companies')).toBe(true);
  });

  it('B\'s key cannot see A\'s data either (symmetry check)', async () => {
    const resp = await rpc(B.apiKey, 'tools/call', {
      name: 'get_bill', arguments: { bill_id: A.billId },
    });
    expect(resp.error).toBeDefined();
  });
});
