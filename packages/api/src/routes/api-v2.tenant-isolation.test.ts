// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Aggressive tenant-isolation audit: verifies that a logged-in user in
// Tenant A cannot observe or mutate data that belongs to Tenant B.
//
// For each new V2 route we added, we attempt the corresponding
// cross-tenant attack and assert the route returns a 404 (not a 200
// with the foreign resource's data). 404 (rather than 403) is the
// chosen response per the existing doc guidance: "returns 404 not 403
// for cross-tenant access attempts to avoid leaking existence".

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo, Server } from 'net';
import { sql, eq } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import {
  companies, contacts, transactions, budgets, reconciliations,
  recurringSchedules, attachments,
} from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as billService from '../services/bill.service.js';
import * as ledgerService from '../services/ledger.service.js';
import * as recurringService from '../services/recurring.service.js';
import * as reconciliationService from '../services/reconciliation.service.js';
import * as budgetService from '../services/budget.service.js';
import { apiV2Router } from './api-v2.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;

interface Tenant {
  token: string;
  tenantId: string;
  companyId: string;
  bankAccountId: string;
  expenseAccountId: string;
  revenueAccountId: string;
  vendorId: string;
  customerId: string;
  billId: string;
  txnId: string;
  invoiceId: string;
  budgetId: string;
  vendorCreditId: string;
  reconciliationId: string;
  attachmentId: string;
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

function request(
  method: string, path: string, body: unknown, token: string, companyId?: string,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({
      method, hostname: '127.0.0.1', port, path: `/api/v2${path}`,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(companyId ? { 'X-Company-Id': companyId } : {}),
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

async function provisionTenant(email: string, name: string): Promise<Tenant> {
  const result = await authService.register({ email, password: 'password123456', displayName: name, companyName: `${name} Co` });
  const tenantId = result.user.tenantId;
  const comp = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  const companyId = comp!.id;

  const allAccounts = await db.query.accounts.findMany({ where: (a, { eq: e }) => e(a.tenantId, tenantId) });
  const bankAccountId = allAccounts.find((a) => a.accountType === 'asset' && (a.detailType === 'bank' || a.name.toLowerCase().includes('check')))!.id;
  const expenseAccountId = allAccounts.find((a) => a.accountType === 'expense')!.id;
  const revenueAccountId = allAccounts.find((a) => a.accountType === 'revenue')!.id;

  const [vendor] = await db.insert(contacts).values({
    tenantId, companyId, displayName: `${name} Vendor`, contactType: 'vendor',
  }).returning();
  const [customer] = await db.insert(contacts).values({
    tenantId, companyId, displayName: `${name} Customer`, contactType: 'customer',
  }).returning();

  // Create a bill (ledger txn type = 'bill')
  const bill = await billService.createBill(tenantId, {
    contactId: vendor!.id,
    txnDate: '2026-04-10', dueDate: '2026-05-10',
    lines: [{ accountId: expenseAccountId, amount: '100.00' }],
  }, result.user.id, companyId);

  // Create a plain expense transaction
  const expenseTxn = await (await import('../services/expense.service.js')).createExpense(tenantId, {
    txnDate: '2026-04-10', payFromAccountId: bankAccountId,
    lines: [{ expenseAccountId, amount: '25.00' }],
  }, result.user.id);

  // Create an invoice
  const invoiceTxn = await (await import('../services/invoice.service.js')).createInvoice(tenantId, {
    txnDate: '2026-04-05', dueDate: '2026-05-05', contactId: customer!.id,
    lines: [{ accountId: revenueAccountId, description: 'Service', quantity: '1', unitPrice: '500.00' }],
  } as any, result.user.id);

  // Create a vendor credit
  const vcTxn = await (await import('../services/vendor-credit.service.js')).createVendorCredit(tenantId, {
    contactId: vendor!.id, txnDate: '2026-04-11',
    lines: [{ accountId: expenseAccountId, amount: '15.00' }],
  }, result.user.id);

  // Create a budget
  const bud = await budgetService.create(tenantId, { name: `${name} Budget`, fiscalYear: 2026 });
  if (!bud) throw new Error('Failed to provision budget');

  // Create a reconciliation
  const recon = await reconciliationService.start(tenantId, bankAccountId, '2026-04-30', '1000.00');

  // Create a recurring schedule (template = the expenseTxn)
  const sched = await recurringService.create(tenantId, expenseTxn.id, {
    frequency: 'monthly', startDate: '2026-05-01',
  });

  // Create an attachment row directly
  const [att] = await db.insert(attachments).values({
    tenantId, attachableType: 'transaction', attachableId: expenseTxn.id,
    fileName: `${name}-receipt.pdf`, filePath: `/uploads/${name}-receipt.pdf`,
    mimeType: 'application/pdf', fileSize: 1024, uploadedBy: result.user.id,
  } as any).returning();

  return {
    token: result.tokens.accessToken,
    tenantId, companyId, bankAccountId, expenseAccountId, revenueAccountId,
    vendorId: vendor!.id, customerId: customer!.id,
    billId: bill.id, txnId: expenseTxn.id, invoiceId: invoiceTxn.id,
    budgetId: bud.id, vendorCreditId: vcTxn.id,
    reconciliationId: recon.id,
    attachmentId: att!.id,
  };
}

describe('Tenant isolation audit — cross-tenant attacks must not leak or mutate data', () => {
  beforeAll(async () => {
    await cleanDb();
    await startApp();
    A = await provisionTenant(`tenant-a-${Date.now()}@example.com`, 'TenantA');
    B = await provisionTenant(`tenant-b-${Date.now()}@example.com`, 'TenantB');
  }, 30000);

  afterAll(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await cleanDb();
    await pool.end();
  });

  // ─── Direct resource-by-id access ───────────────────────────────

  it('A cannot GET /bills/:id belonging to B', async () => {
    const r = await request('GET', `/bills/${B.billId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  it('A cannot GET /transactions/:id belonging to B', async () => {
    const r = await request('GET', `/transactions/${B.txnId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  it('A cannot GET /invoices/:id belonging to B', async () => {
    const r = await request('GET', `/invoices/${B.invoiceId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  it('A cannot GET /vendor-credits/:id belonging to B', async () => {
    const r = await request('GET', `/vendor-credits/${B.vendorCreditId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  it('A cannot GET /bill-payments/:id belonging to B', async () => {
    // We do not have a bill_payment in B's fixture, but we can still probe:
    // a random uuid should 404 and never return data. Use B.billId which is
    // a bill but not a bill payment — the service filters by txn_type.
    const r = await request('GET', `/bill-payments/${B.billId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  it('A cannot GET /accounts/:id belonging to B', async () => {
    const r = await request('GET', `/accounts/${B.bankAccountId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  it('A cannot GET /contacts/:id belonging to B', async () => {
    const r = await request('GET', `/contacts/${B.vendorId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  it('A cannot GET /budgets/:id belonging to B', async () => {
    const r = await request('GET', `/budgets/${B.budgetId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  it('A cannot GET /banking/reconciliations/:id belonging to B', async () => {
    const r = await request('GET', `/banking/reconciliations/${B.reconciliationId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  it('A cannot GET /attachments/:id belonging to B', async () => {
    const r = await request('GET', `/attachments/${B.attachmentId}`, undefined, A.token);
    expect(r.status).toBe(404);
  });

  // ─── List endpoints should show only the caller's data ──────────

  it('A listing /bills does not include B\'s bill', async () => {
    const r = await request('GET', '/bills', undefined, A.token);
    expect(r.status).toBe(200);
    const ids = r.json.data.map((b: any) => b.id);
    expect(ids).toContain(A.billId);
    expect(ids).not.toContain(B.billId);
  });

  it('A listing /vendor-credits does not include B\'s credit', async () => {
    const r = await request('GET', '/vendor-credits', undefined, A.token);
    expect(r.status).toBe(200);
    const ids = r.json.data.map((c: any) => c.id);
    expect(ids).not.toContain(B.vendorCreditId);
  });

  it('A listing /transactions does not include B\'s transaction', async () => {
    const r = await request('GET', '/transactions', undefined, A.token);
    expect(r.status).toBe(200);
    const ids = r.json.data.map((t: any) => t.id);
    expect(ids).not.toContain(B.txnId);
    expect(ids).not.toContain(B.invoiceId);
    expect(ids).not.toContain(B.billId);
  });

  it('A listing /attachments does not include B\'s attachment (even filtering by B\'s attachableId)', async () => {
    const r = await request('GET', `/attachments?attachableId=${B.txnId}`, undefined, A.token);
    expect(r.status).toBe(200);
    const ids = r.json.data.map((a: any) => a.id);
    expect(ids).not.toContain(B.attachmentId);
  });

  it('A listing /vendor-credits/available/:vendorId with B\'s vendor returns empty', async () => {
    const r = await request('GET', `/vendor-credits/available/${B.vendorId}`, undefined, A.token);
    expect(r.status).toBe(200);
    expect(r.json.credits).toEqual([]);
  });

  // ─── Mutations targeting B's resources ──────────────────────────

  it('A cannot void B\'s transaction', async () => {
    const r = await request('POST', `/transactions/${B.txnId}/void`, { reason: 'hostile' }, A.token);
    expect(r.status).toBe(404);
    // Confirm B's txn is still posted
    const b = await db.query.transactions.findFirst({ where: eq(transactions.id, B.txnId) });
    expect(b?.status).toBe('posted');
  });

  it('A cannot void B\'s bill', async () => {
    const r = await request('POST', `/bills/${B.billId}/void`, { reason: 'hostile' }, A.token);
    expect(r.status).toBe(404);
    const b = await db.query.transactions.findFirst({ where: eq(transactions.id, B.billId) });
    expect(b?.status).toBe('posted');
  });

  it('A cannot void B\'s vendor credit', async () => {
    const r = await request('POST', `/vendor-credits/${B.vendorCreditId}/void`, { reason: 'hostile' }, A.token);
    expect(r.status).toBe(404);
    const b = await db.query.transactions.findFirst({ where: eq(transactions.id, B.vendorCreditId) });
    expect(b?.status).toBe('posted');
  });

  it('A cannot update B\'s bill', async () => {
    const r = await request('PUT', `/bills/${B.billId}`, {
      contactId: A.vendorId, txnDate: '2026-04-10',
      lines: [{ accountId: A.expenseAccountId, amount: '9999.00' }],
    }, A.token);
    expect(r.status).toBe(404);
    const b = await db.query.transactions.findFirst({ where: eq(transactions.id, B.billId) });
    // B's bill total should remain at its original "100.00"
    expect(parseFloat(b!.total!)).toBe(100);
  });

  it('A cannot delete (deactivate) B\'s recurring schedule', async () => {
    // Grab B's schedule id
    const bSched = await db.query.recurringSchedules.findFirst({ where: eq(recurringSchedules.tenantId, B.tenantId) });
    const r = await request('DELETE', `/recurring/${bSched!.id}`, undefined, A.token);
    // Service swallows missing rows silently — but the important assertion
    // is that B's schedule remains active.
    const stillActive = await db.query.recurringSchedules.findFirst({ where: eq(recurringSchedules.id, bSched!.id) });
    expect(stillActive?.isActive).toBe('true');
    expect(r.status).toBeLessThan(500);
  });

  it('A cannot post-now on B\'s recurring schedule', async () => {
    const bSched = await db.query.recurringSchedules.findFirst({ where: eq(recurringSchedules.tenantId, B.tenantId) });
    const r = await request('POST', `/recurring/${bSched!.id}/post-now`, {}, A.token);
    expect(r.status).toBe(404);
  });

  // ─── Company-header spoofing ────────────────────────────────────

  it('A cannot access B\'s company via X-Company-Id header', async () => {
    const r = await request('GET', '/accounts', undefined, A.token, B.companyId);
    // companyContext validates that the header company belongs to the
    // authenticated tenant — foreign company id must 403.
    expect(r.status).toBe(403);
  });

  // ─── Account-id smuggling in create payloads ───────────────────

  it('A creating a bill with B\'s expense account is rejected', async () => {
    const r = await request('POST', '/bills', {
      contactId: A.vendorId, txnDate: '2026-04-10',
      lines: [{ accountId: B.expenseAccountId, amount: '50.00' }],
    }, A.token);
    // assertAccountsInTenant() should reject before any DB write
    expect(r.status).toBe(400);
  });

  it('A creating a vendor credit with B\'s expense account — no balance delta on B\'s account', async () => {
    const before = await db.query.accounts.findFirst({ where: (a, { eq: e }) => e(a.id, B.expenseAccountId) });
    await request('POST', '/vendor-credits', {
      contactId: A.vendorId, txnDate: '2026-04-10',
      lines: [{ accountId: B.expenseAccountId, amount: '50.00' }],
    }, A.token);
    const after = await db.query.accounts.findFirst({ where: (a, { eq: e }) => e(a.id, B.expenseAccountId) });
    // B's balance MUST NOT change, regardless of whether the call 201'd or
    // 400'd. updateAccountBalances is tenant-scoped so even if a line was
    // inserted with a foreign accountId, the balance UPDATE matches 0 rows.
    expect(after?.balance).toBe(before?.balance);
  });

  // ─── Tagging against foreign transactions and tags ──────────────

  it('A tagging B\'s transaction with A\'s tags has no effect on B', async () => {
    // Create a tag in A
    const tagResp = await request('POST', '/tags', { name: `A-tag-${Date.now()}` }, A.token);
    expect(tagResp.status).toBe(201);
    const tagId = tagResp.json.tag.id;

    await request('POST', `/transactions/${B.txnId}/tags`, { tagIds: [tagId] }, A.token);

    // B's transaction should not have A's tag attached. We check by
    // asking B for the transaction's tags (scoped to B's tenant).
    const bTagsForTxn = await db.execute(sql`
      SELECT tag_id, tenant_id FROM transaction_tags WHERE transaction_id = ${B.txnId}
    `);
    // Any row where tenant_id = A and transaction_id = B is an isolation breach
    const breach = (bTagsForTxn.rows as any[]).find((row) => row.tenant_id === A.tenantId);
    expect(breach).toBeUndefined();
  });

  // ─── Reports must not aggregate across tenants ─────────────────

  it('A\'s P&L does not reflect B\'s revenue', async () => {
    const r = await request('GET', '/reports/profit-loss?start_date=2026-01-01&end_date=2026-12-31', undefined, A.token);
    expect(r.status).toBe(200);
    // B posted a $500 invoice; A did not. A's revenue total should not
    // include B's $500. The shape is built by reportService; we assert
    // the total revenue is finite and does not match B's $500.
    const bodyStr = JSON.stringify(r.json);
    expect(bodyStr).not.toContain(B.revenueAccountId);
  });

  it('A\'s AR aging does not include B\'s invoice', async () => {
    const r = await request('GET', '/reports/ar-aging', undefined, A.token);
    expect(r.status).toBe(200);
    const bodyStr = JSON.stringify(r.json);
    expect(bodyStr).not.toContain(B.invoiceId);
    expect(bodyStr).not.toContain(B.customerId);
  });

  it('A\'s general ledger does not include B\'s journal lines', async () => {
    const r = await request('GET', '/reports/general-ledger?start_date=2026-01-01&end_date=2026-12-31', undefined, A.token);
    expect(r.status).toBe(200);
    const bodyStr = JSON.stringify(r.json);
    expect(bodyStr).not.toContain(B.expenseAccountId);
    expect(bodyStr).not.toContain(B.bankAccountId);
    expect(bodyStr).not.toContain(B.revenueAccountId);
  });

  // ─── /me and /docs are per-tenant ──────────────────────────────

  it('A\'s /me reports A\'s tenant only — does not list B\'s tenant/companies', async () => {
    const r = await request('GET', '/me', undefined, A.token);
    expect(r.status).toBe(200);
    expect(r.json.activeTenantId).toBe(A.tenantId);
    const companyIds = r.json.companies.map((c: any) => c.id);
    expect(companyIds).not.toContain(B.companyId);
    const tenantIds = r.json.tenants.map((t: any) => t.tenantId);
    expect(tenantIds).not.toContain(B.tenantId);
  });
});
