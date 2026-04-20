// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { apiKeys, companies } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import * as authService from '../services/auth.service.js';
import { handleMcpRequest } from './server.js';

let apiKeyPlain = '';
let userId = '';
let tenantId = '';

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    recurring_schedules, budget_lines, budgets,
    bank_feed_items, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    transactions, contacts, tags, tag_groups, api_keys, mcp_request_log, sessions,
    accounts, companies, users, tenants
    CASCADE`);
}

function mockReq(body: any, authHeader?: string) {
  const captured: any = { status: 0, body: null };
  const req: any = {
    headers: { ...(authHeader ? { authorization: authHeader } : {}) },
    body, ip: '127.0.0.1',
  };
  const res: any = {
    status(s: number) { captured.status = s; return this; },
    json(b: any) { captured.body = b; return this; },
  };
  return { req, res, captured };
}

async function rpc(method: string, params?: any): Promise<any> {
  const { req, res, captured } = mockReq({ method, params, id: 1 }, `Bearer ${apiKeyPlain}`);
  await handleMcpRequest(req, res);
  return captured.body;
}

describe('MCP server integration', () => {
  beforeAll(async () => {
    await cleanDb();
    const result = await authService.register({
      email: `mcp-test-${Date.now()}@example.com`,
      password: 'password123456',
      displayName: 'MCP Test',
      companyName: 'MCP Test Co',
    });
    userId = result.user.id;
    tenantId = result.user.tenantId;

    // Create an API key directly (no service layer for this yet)
    apiKeyPlain = 'sk_live_' + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(apiKeyPlain).digest('hex');
    await db.insert(apiKeys).values({
      tenantId, userId, name: 'mcp-test-key',
      keyPrefix: apiKeyPlain.slice(0, 12),
      keyHash, role: 'owner',
      scopes: 'all',
    });

    // Enable MCP on the default company (defaults to false per 0032_mcp_integration)
    await db.update(companies).set({ mcpEnabled: true }).where(eq(companies.tenantId, tenantId));
  }, 30000);

  afterAll(async () => {
    await cleanDb();
    await pool.end();
  });

  it('tools/list returns all registered tools', async () => {
    const resp = await rpc('tools/list');
    expect(resp.result).toBeDefined();
    expect(Array.isArray(resp.result.tools)).toBe(true);
    // Verify key new tools are present
    const names = resp.result.tools.map((t: any) => t.name);
    expect(names).toContain('list_bills');
    expect(names).toContain('create_bill');
    expect(names).toContain('pay_bills');
    expect(names).toContain('list_vendor_credits');
    expect(names).toContain('create_vendor_credit');
    expect(names).toContain('record_payment');
    expect(names).toContain('get_open_invoices');
    expect(names).toContain('list_checks');
    expect(names).toContain('write_check');
    expect(names).toContain('list_recurring');
    expect(names).toContain('list_budgets');
    expect(names).toContain('get_dashboard_snapshot');
    expect(names).toContain('get_cash_position');
    expect(names).toContain('match_feed_item');
    expect(names).toContain('get_reconciliation_history');
    expect(names).toContain('list_attachments');
    expect(names).toContain('run_1099_vendor_summary');
    expect(names).toContain('run_sales_tax_liability');
    expect(names).toContain('run_check_register');
  });

  it('resources/list returns new resource URIs', async () => {
    const resp = await rpc('resources/list');
    expect(resp.result).toBeDefined();
    const uris = resp.result.resources.map((r: any) => r.uri);
    expect(uris).toContain('kisbooks://company/{id}/bills/payable');
    expect(uris).toContain('kisbooks://company/{id}/bill-payments');
    expect(uris).toContain('kisbooks://company/{id}/vendor-credits');
    expect(uris).toContain('kisbooks://company/{id}/recurring');
    expect(uris).toContain('kisbooks://company/{id}/budgets');
    expect(uris).toContain('kisbooks://company/{id}/checks/print-queue');
    expect(uris).toContain('kisbooks://company/{id}/reconciliations');
  });

  it('initialize reports protocol and capabilities', async () => {
    const resp = await rpc('initialize');
    expect(resp.result.protocolVersion).toBeDefined();
    expect(resp.result.capabilities).toBeDefined();
  });

  it('tools/call list_bills runs', async () => {
    const resp = await rpc('tools/call', { name: 'list_bills', arguments: {} });
    expect(resp.result).toBeDefined();
    const data = JSON.parse(resp.result.content[0].text);
    expect(data).toHaveProperty('data');
    expect(data).toHaveProperty('total');
  });

  it('tools/call get_dashboard_snapshot runs', async () => {
    const resp = await rpc('tools/call', { name: 'get_dashboard_snapshot', arguments: {} });
    expect(resp.result).toBeDefined();
  });

  it('tools/call list_recurring runs', async () => {
    const resp = await rpc('tools/call', { name: 'list_recurring', arguments: {} });
    expect(resp.result).toBeDefined();
  });

  it('tools/call list_budgets runs', async () => {
    const resp = await rpc('tools/call', { name: 'list_budgets', arguments: {} });
    expect(resp.result).toBeDefined();
  });

  it('tools/call list_checks runs', async () => {
    const resp = await rpc('tools/call', { name: 'list_checks', arguments: {} });
    expect(resp.result).toBeDefined();
  });

  it('tools/call run_1099_vendor_summary runs', async () => {
    const resp = await rpc('tools/call', { name: 'run_1099_vendor_summary', arguments: { year: '2026' } });
    expect(resp.result).toBeDefined();
  });

  it('tools/call run_expense_by_category runs', async () => {
    const resp = await rpc('tools/call', { name: 'run_expense_by_category', arguments: { start_date: '2026-01-01', end_date: '2026-04-30' } });
    expect(resp.result).toBeDefined();
  });

  it('resources/read bills/payable', async () => {
    // Get companyId first via list_companies
    const listCompanies = await rpc('tools/call', { name: 'list_companies', arguments: {} });
    const companies = JSON.parse(listCompanies.result.content[0].text);
    const companyId = companies[0].id;

    const resp = await rpc('resources/read', { uri: `kisbooks://company/${companyId}/bills/payable` });
    expect(resp.result).toBeDefined();
    expect(resp.result.contents[0].uri).toContain('/bills/payable');
  });

  it('resources/read recurring', async () => {
    const listCompanies = await rpc('tools/call', { name: 'list_companies', arguments: {} });
    const companies = JSON.parse(listCompanies.result.content[0].text);
    const companyId = companies[0].id;

    const resp = await rpc('resources/read', { uri: `kisbooks://company/${companyId}/recurring` });
    expect(resp.result).toBeDefined();
  });

  it('resources/read reconciliations', async () => {
    const listCompanies = await rpc('tools/call', { name: 'list_companies', arguments: {} });
    const companies = JSON.parse(listCompanies.result.content[0].text);
    const companyId = companies[0].id;

    const resp = await rpc('resources/read', { uri: `kisbooks://company/${companyId}/reconciliations` });
    expect(resp.result).toBeDefined();
  });

  it('tools/call unknown tool returns -32601', async () => {
    const resp = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32601);
  });

  it('tools/call pay_bills with invalid method is rejected', async () => {
    const resp = await rpc('tools/call', {
      name: 'pay_bills',
      arguments: {
        bank_account_id: '00000000-0000-0000-0000-000000000000',
        date: '2026-04-10',
        method: 'bitcoin',
        bills: JSON.stringify([{ billId: '00000000-0000-0000-0000-000000000000', amount: '1.00' }]),
      },
    });
    expect(resp.error).toBeDefined();
  });

  it('tools/call write_check without required payee_name is rejected', async () => {
    const resp = await rpc('tools/call', {
      name: 'write_check',
      arguments: {
        bank_account_id: '00000000-0000-0000-0000-000000000000',
        date: '2026-04-10',
        amount: '100.00',
        lines: JSON.stringify([{ accountId: '00000000-0000-0000-0000-000000000000', amount: '100.00' }]),
      },
    });
    expect(resp.error).toBeDefined();
  });

  // ─── ADR 0XX — split-level tags over MCP ─────────────────────────

  it('tools/list advertises split-level-tag tools', async () => {
    const resp = await rpc('tools/list');
    const names = resp.result.tools.map((t: any) => t.name);
    expect(names).toContain('set_transaction_tag');
    expect(names).toContain('tag_transaction');
    expect(names).toContain('bulk_set_bank_feed_tag');
    // Report tools advertise the tag_id argument in their schema.
    const pnlTool = resp.result.tools.find((t: any) => t.name === 'run_profit_loss');
    expect(pnlTool?.inputSchema?.properties?.tag_id).toBeDefined();
    const tbTool = resp.result.tools.find((t: any) => t.name === 'run_trial_balance');
    expect(tbTool?.inputSchema?.properties?.tag_id).toBeDefined();
  });

  it('tools/call set_transaction_tag stamps every journal line', async () => {
    // Set up: find accounts, create tag, post a journal entry.
    const { accounts } = await import('../db/schema/index.js');
    const { eq: eqOp, and: andOp } = await import('drizzle-orm');
    const allAccounts = await db.select().from(accounts).where(eqOp(accounts.tenantId, tenantId));
    const expense = allAccounts.find((a) => a.accountType === 'expense')!;
    const bank = allAccounts.find((a) =>
      a.accountType === 'asset' && (a.detailType === 'bank' || a.name.toLowerCase().includes('check')),
    )!;

    // Create a tag through MCP so the path exercises the same auth+tenant flow.
    const { tags: tagsTable } = await import('../db/schema/index.js');
    const [tag] = await db.insert(tagsTable).values({ tenantId, name: `MCPTag-${Date.now()}` }).returning();

    // Post a JE via the service (MCP create_journal_entry exercises the same path).
    const createResp = await rpc('tools/call', {
      name: 'create_journal_entry',
      arguments: {
        date: '2026-04-10',
        lines: JSON.stringify([
          { accountId: expense.id, debit: '20', credit: '0' },
          { accountId: bank.id, debit: '0', credit: '20' },
        ]),
      },
    });
    const createdTxn = JSON.parse(createResp.result.content[0].text);
    const txnId = createdTxn.id;

    // Apply the tag via the new single-tag MCP tool.
    const setResp = await rpc('tools/call', {
      name: 'set_transaction_tag',
      arguments: { transaction_id: txnId, tag_id: tag!.id },
    });
    expect(setResp.error).toBeUndefined();
    const setPayload = JSON.parse(setResp.result.content[0].text);
    expect(setPayload.tagged).toBe(true);
    expect(setPayload.tagId).toBe(tag!.id);

    // Confirm the stamp landed on every journal line.
    const { journalLines } = await import('../db/schema/index.js');
    const lines = await db.select().from(journalLines).where(andOp(
      eqOp(journalLines.tenantId, tenantId),
      eqOp(journalLines.transactionId, txnId),
    ));
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line.tagId).toBe(tag!.id);
    }
  });

  it('tools/call tag_transaction with a single tag still lands line-level', async () => {
    const { accounts, tags: tagsTable, journalLines } = await import('../db/schema/index.js');
    const { eq: eqOp, and: andOp } = await import('drizzle-orm');
    const allAccounts = await db.select().from(accounts).where(eqOp(accounts.tenantId, tenantId));
    const expense = allAccounts.find((a) => a.accountType === 'expense')!;
    const bank = allAccounts.find((a) =>
      a.accountType === 'asset' && (a.detailType === 'bank' || a.name.toLowerCase().includes('check')),
    )!;
    const [tag] = await db.insert(tagsTable).values({ tenantId, name: `MCPTagLegacy-${Date.now()}` }).returning();

    const createResp = await rpc('tools/call', {
      name: 'create_journal_entry',
      arguments: {
        date: '2026-04-10',
        lines: JSON.stringify([
          { accountId: expense.id, debit: '15', credit: '0' },
          { accountId: bank.id, debit: '0', credit: '15' },
        ]),
      },
    });
    const txnId = JSON.parse(createResp.result.content[0].text).id;

    const resp = await rpc('tools/call', {
      name: 'tag_transaction',
      arguments: { transaction_id: txnId, tag_ids: JSON.stringify([tag!.id]) },
    });
    expect(resp.error).toBeUndefined();
    const payload = JSON.parse(resp.result.content[0].text);
    expect(payload.lineLevel).toBe(true);

    const lines = await db.select().from(journalLines).where(andOp(
      eqOp(journalLines.tenantId, tenantId),
      eqOp(journalLines.transactionId, txnId),
    ));
    for (const l of lines) expect(l.tagId).toBe(tag!.id);
  });

  it('tools/call run_profit_loss accepts tag_id and scopes totals', async () => {
    const { accounts, tags: tagsTable } = await import('../db/schema/index.js');
    const { eq: eqOp } = await import('drizzle-orm');
    const allAccounts = await db.select().from(accounts).where(eqOp(accounts.tenantId, tenantId));
    const expense = allAccounts.find((a) => a.accountType === 'expense')!;
    const bank = allAccounts.find((a) =>
      a.accountType === 'asset' && (a.detailType === 'bank' || a.name.toLowerCase().includes('check')),
    )!;
    const [tag] = await db.insert(tagsTable).values({ tenantId, name: `PLScope-${Date.now()}` }).returning();

    // One tagged, one untagged.
    await rpc('tools/call', {
      name: 'create_journal_entry',
      arguments: {
        date: '2026-04-11',
        lines: JSON.stringify([
          { accountId: expense.id, debit: '40', credit: '0', tagId: tag!.id },
          { accountId: bank.id, debit: '0', credit: '40', tagId: tag!.id },
        ]),
      },
    });
    await rpc('tools/call', {
      name: 'create_journal_entry',
      arguments: {
        date: '2026-04-11',
        lines: JSON.stringify([
          { accountId: expense.id, debit: '10', credit: '0' },
          { accountId: bank.id, debit: '0', credit: '10' },
        ]),
      },
    });

    const filtered = await rpc('tools/call', {
      name: 'run_profit_loss',
      arguments: { start_date: '2026-01-01', end_date: '2026-12-31', tag_id: tag!.id },
    });
    expect(filtered.error).toBeUndefined();
    const filteredData = JSON.parse(filtered.result.content[0].text);
    // Filtered expenses include only the tag=40 line.
    expect(Number(filteredData.totalExpenses)).toBe(40);
  });
});
