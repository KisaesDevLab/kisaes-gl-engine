// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Firm staff working on clients through MCP.
//
// One staff member, one key, several client tenants with different roles.
// What they can reach and do must be exactly what the app gives them:
// the clients they hold access to, with the role they hold in each.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import crypto from 'crypto';
import { sql, eq, and } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import {
  accounts, apiKeys, auditLog, companies, contacts, mcpConfig, mcpRequestLog, reconciliations, userTenantAccess, users,
} from '../db/schema/index.js';
import * as authService from '../services/auth.service.js';
import * as expenseService from '../services/expense.service.js';
import { handleMcpRequest } from './server.js';

interface Client {
  tenantId: string;
  companyId: string;
  ownerId: string;
  bankAccountId: string;
  expenseAccountId: string;
}

let staffId = '';
let staffKey = '';
let firm: Client;
let full: Client; // staff is an accountant here
let readOnly: Client; // staff is read-only here
let stranger: Client; // staff has no access
let mcpOff: Client; // staff has access, the company has MCP turned off

async function cleanDb() {
  await db.execute(sql`TRUNCATE
    audit_log, journal_lines, transaction_tags, payment_applications, deposit_lines,
    bill_payment_applications, vendor_credit_applications,
    recurring_schedules, budget_lines, budgets,
    bank_feed_items, reconciliation_lines, reconciliations,
    plaid_account_mappings, plaid_accounts, plaid_items, bank_connections,
    attachments, user_tenant_access, mcp_config,
    transactions, contacts, tags, tag_groups, api_keys, mcp_request_log, sessions,
    tenant_firm_assignments, firm_users, firms,
    accounts, companies, users, tenants
    CASCADE`);
}

interface Captured { status: number; body: any; headers: Record<string, string> }

async function post(key: string, body: unknown, headers: Record<string, string> = {}): Promise<Captured> {
  const captured: Captured = { status: 0, body: null, headers: {} };
  const req: any = { method: 'POST', headers: { authorization: `Bearer ${key}`, ...headers }, body, ip: '127.0.0.1' };
  const res: any = {
    status(s: number) { captured.status = s; return this; },
    json(b: any) { captured.body = b; if (!captured.status) captured.status = 200; return this; },
    setHeader(name: string, value: string) { captured.headers[name.toLowerCase()] = value; return this; },
    end() { return this; },
  };
  await handleMcpRequest(req, res);
  return captured;
}

async function call(name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}, key = staffKey) {
  return (await post(key, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers)).body;
}

const data = (resp: any) => JSON.parse(resp.result.content[0].text);
const failure = (resp: any): string | undefined => (resp?.result?.isError ? resp.result.content[0].text : resp?.error?.message);

async function provision(name: string, mcpEnabled = true): Promise<Client> {
  const result = await authService.register({
    email: `${name.toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123456', displayName: `${name} Owner`, companyName: `${name} Co`,
  });
  const tenantId = result.user.tenantId;
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  await db.update(companies).set({ mcpEnabled }).where(eq(companies.id, company!.id));
  const all = await db.query.accounts.findMany({ where: eq(accounts.tenantId, tenantId) });
  return {
    tenantId,
    companyId: company!.id,
    ownerId: result.user.id,
    bankAccountId: all.find((a) => a.accountType === 'asset' && (a.detailType === 'bank' || a.name.toLowerCase().includes('check')))!.id,
    expenseAccountId: all.find((a) => a.accountType === 'expense')!.id,
  };
}

async function grant(client: Client, role: string) {
  await db.insert(userTenantAccess).values({ userId: staffId, tenantId: client.tenantId, role, isActive: true });
}

beforeAll(async () => {
  await cleanDb();
  await db.insert(mcpConfig).values({ isEnabled: true });
  firm = await provision('Firm');
  full = await provision('Alpha');
  readOnly = await provision('Bravo');
  stranger = await provision('Charlie');
  mcpOff = await provision('Delta', false);

  // The staff member: a user of the firm's own tenant, given access to
  // three clients (Firm > Staff > Tenant access writes these rows).
  const [staff] = await db.insert(users).values({
    tenantId: firm.tenantId, email: `staff-${Date.now()}@example.com`, passwordHash: 'x',
    displayName: 'Staff Member', role: 'accountant',
  }).returning();
  staffId = staff!.id;
  await grant(full, 'accountant');
  await grant(readOnly, 'readonly');
  await grant(mcpOff, 'accountant');

  staffKey = 'sk_live_' + crypto.randomBytes(32).toString('hex');
  await db.insert(apiKeys).values({
    tenantId: firm.tenantId, userId: staffId, name: 'staff key', keyPrefix: staffKey.slice(0, 12),
    keyHash: crypto.createHash('sha256').update(staffKey).digest('hex'), role: 'accountant',
    scopes: 'read,write,reports,invoicing,banking',
  });
}, 60000);

afterAll(async () => {
  await cleanDb();
  await pool.end();
});

describe('MCP for firm staff: one sign-in, the clients they have access to', () => {
  it('list_companies shows every client the staff member can open, with their role in each', async () => {
    const list = data(await call('list_companies'));
    const byId = new Map<string, any>(list.map((c: any) => [c.id, c]));
    expect(byId.get(firm.companyId)?.role).toBe('accountant');
    expect(byId.get(full.companyId)).toMatchObject({ name: 'Alpha Co', role: 'accountant', mcpEnabled: true });
    expect(byId.get(readOnly.companyId)).toMatchObject({ role: 'readonly', mcpEnabled: true });
    expect(byId.get(mcpOff.companyId)).toMatchObject({ role: 'accountant', mcpEnabled: false });
    expect(byId.has(stranger.companyId)).toBe(false);
    expect(data(await call('list_companies', { search: 'alph' })).map((c: any) => c.id)).toEqual([full.companyId]);
  });

  it('asks which client when none was named, and never guesses', async () => {
    const resp = await call('list_accounts');
    expect(failure(resp)).toMatch(/^COMPANY_REQUIRED/);
    expect(failure(resp)).toContain(full.companyId);
    expect(failure(resp)).not.toContain(stranger.companyId);
  });

  it('works in a client the staff member has full access to, and names it in the result', async () => {
    const created = await call('create_contact', { company_id: full.companyId, display_name: 'Staff-made Vendor', type: 'vendor' });
    expect(failure(created)).toBeUndefined();
    expect(created.result.content[1].text).toBe(`Client: Alpha Co (company_id ${full.companyId})`);
    const row = await db.query.contacts.findFirst({ where: eq(contacts.id, data(created).id) });
    expect(row?.tenantId).toBe(full.tenantId);
    // The audit trail names the person, not "system".
    const audit = await db.query.auditLog.findFirst({ where: and(eq(auditLog.tenantId, full.tenantId), eq(auditLog.entityId, row!.id)) });
    expect(audit?.userId).toBe(staffId);
  });

  it('posts and voids a transaction in that client as the staff member', async () => {
    const posted = await call('create_expense', {
      company_id: full.companyId, date: '2026-04-10', bank_account_id: full.bankAccountId,
      lines: [{ expenseAccountId: full.expenseAccountId, amount: '42.00' }],
    });
    expect(failure(posted)).toBeUndefined();
    const voided = await call('void_transaction', { company_id: full.companyId, transaction_id: data(posted).id, reason: 'test' });
    expect(failure(voided)).toBeUndefined();
  });

  it('read-only in a client means read-only through MCP, whatever the key allows', async () => {
    expect(failure(await call('list_accounts', { company_id: readOnly.companyId }))).toBeUndefined();
    expect(failure(await call('run_trial_balance', { company_id: readOnly.companyId, start_date: '2026-01-01', end_date: '2026-12-31' }))).toBeUndefined();

    const before = await db.select().from(contacts).where(eq(contacts.tenantId, readOnly.tenantId));
    for (const [name, args] of [
      ['create_contact', { display_name: 'Nope', type: 'vendor' }],
      ['create_expense', { date: '2026-04-10', bank_account_id: readOnly.bankAccountId, lines: [{ expenseAccountId: readOnly.expenseAccountId, amount: '1.00' }] }],
      ['start_reconciliation', { account_id: readOnly.bankAccountId, statement_date: '2026-04-30', statement_ending_balance: '0.00' }],
    ] as const) {
      const resp = await call(name, { company_id: readOnly.companyId, ...args });
      expect(failure(resp), name).toMatch(/^PERMISSION_DENIED/);
    }
    expect(await db.select().from(contacts).where(eq(contacts.tenantId, readOnly.tenantId))).toHaveLength(before.length);
    expect(await db.select().from(reconciliations).where(eq(reconciliations.tenantId, readOnly.tenantId))).toHaveLength(0);
  });

  it('a client the staff member was not given is closed, by tool and by resource', async () => {
    expect(failure(await call('list_accounts', { company_id: stranger.companyId }))).toMatch(/^ACCESS_DENIED/);
    expect(failure(await call('set_active_company', { company_id: stranger.companyId }))).toMatch(/^ACCESS_DENIED/);
    const read = await post(staffKey, { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: `kisbooks://company/${stranger.companyId}/contacts` } });
    expect(read.body.error.message).toMatch(/^ACCESS_DENIED/);
  });

  it('a client whose company has MCP turned off stays closed, and says how to open it', async () => {
    const resp = await call('list_accounts', { company_id: mcpOff.companyId });
    expect(failure(resp)).toMatch(/^MCP_DISABLED/);
    expect(failure(resp)).toContain('Delta Co');
  });

  it('each connection keeps its own active client', async () => {
    const one = { 'mcp-session-id': 'chat-one' };
    const two = { 'mcp-session-id': 'chat-two' };
    expect(data(await call('set_active_company', { company_id: full.companyId }, one))).toMatchObject({ name: 'Alpha Co' });
    expect(data(await call('set_active_company', { company_id: readOnly.companyId }, two))).toMatchObject({ name: 'Bravo Co' });
    expect(data(await call('get_active_company', {}, one)).active_company_id).toBe(full.companyId);
    expect(data(await call('get_active_company', {}, two)).active_company_id).toBe(readOnly.companyId);
    // A write on chat one lands in chat one's client even after chat two chose another.
    const created = await call('create_contact', { display_name: 'From chat one', type: 'customer' }, one);
    expect(created.result.content[1].text).toContain('Alpha Co');
    expect(failure(await call('create_contact', { display_name: 'From chat two', type: 'customer' }, two))).toMatch(/^PERMISSION_DENIED/);
    // A connection that never chose still has to.
    expect(failure(await call('list_accounts', {}, { 'mcp-session-id': 'chat-three' }))).toMatch(/^COMPANY_REQUIRED/);
  });

  it('initialize hands the connection an id to keep its active client under', async () => {
    const init = await post(staffKey, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    expect(init.headers['mcp-session-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(init.body.result.instructions).toContain('list_companies');
  });

  it('the request log records the client every call ran in', async () => {
    await call('list_contacts', { company_id: full.companyId });
    const [row] = await db.select().from(mcpRequestLog)
      .where(and(eq(mcpRequestLog.userId, staffId), eq(mcpRequestLog.toolName, 'list_contacts')))
      .orderBy(sql`created_at DESC`).limit(1);
    expect(row?.companyId).toBe(full.companyId);
    // A refused call is logged with its tool and reason too.
    await call('create_contact', { company_id: readOnly.companyId, display_name: 'Nope', type: 'vendor' });
    const [refused] = await db.select().from(mcpRequestLog)
      .where(and(eq(mcpRequestLog.userId, staffId), eq(mcpRequestLog.status, 'error'), eq(mcpRequestLog.toolName, 'create_contact')))
      .orderBy(sql`created_at DESC`).limit(1);
    expect(refused).toMatchObject({ companyId: readOnly.companyId, errorCode: 'PERMISSION_DENIED' });
  });

  it('a client with accounts hidden from the caller cannot be opened through MCP', async () => {
    // Read-only users never hold the sensitive-accounts right.
    await db.update(accounts).set({ isSensitive: true }).where(eq(accounts.id, readOnly.expenseAccountId));
    try {
      expect(failure(await call('list_accounts', { company_id: readOnly.companyId }))).toMatch(/^SENSITIVE_HIDDEN/);
      // An accountant holds the right by default, so their client is unaffected.
      await db.update(accounts).set({ isSensitive: true }).where(eq(accounts.id, full.expenseAccountId));
      expect(failure(await call('list_accounts', { company_id: full.companyId }))).toBeUndefined();
    } finally {
      await db.update(accounts).set({ isSensitive: false }).where(eq(accounts.isSensitive, true));
    }
  });

  it('a key limited to some companies reaches only those', async () => {
    const limitedKey = 'sk_live_' + crypto.randomBytes(32).toString('hex');
    await db.insert(apiKeys).values({
      tenantId: firm.tenantId, userId: staffId, name: 'one client', keyPrefix: limitedKey.slice(0, 12),
      keyHash: crypto.createHash('sha256').update(limitedKey).digest('hex'), role: 'accountant',
      scopes: 'read', allowedCompanies: full.companyId,
    });
    expect(data(await call('list_companies', {}, {}, limitedKey)).map((c: any) => c.id)).toEqual([full.companyId]);
    expect(failure(await call('list_accounts', { company_id: readOnly.companyId }, {}, limitedKey))).toMatch(/^ACCESS_DENIED/);
    // And a read-only key cannot write even where the person could.
    expect(failure(await call('create_contact', { company_id: full.companyId, display_name: 'Nope', type: 'vendor' }, {}, limitedKey)))
      .toMatch(/^SCOPE_DENIED/);
  });

  it('taking a client away takes it away at once', async () => {
    const posted = await expenseService.createExpense(full.tenantId, {
      txnDate: '2026-04-11', payFromAccountId: full.bankAccountId, lines: [{ expenseAccountId: full.expenseAccountId, amount: '5.00' }],
    }, full.ownerId);
    await db.update(userTenantAccess).set({ isActive: false })
      .where(and(eq(userTenantAccess.userId, staffId), eq(userTenantAccess.tenantId, full.tenantId)));
    try {
      expect(failure(await call('get_transaction', { company_id: full.companyId, transaction_id: posted.id }))).toMatch(/^ACCESS_DENIED/);
      expect(failure(await call('void_transaction', { company_id: full.companyId, transaction_id: posted.id }))).toMatch(/^ACCESS_DENIED/);
      expect(data(await call('list_companies')).map((c: any) => c.id)).not.toContain(full.companyId);
    } finally {
      await db.update(userTenantAccess).set({ isActive: true })
        .where(and(eq(userTenantAccess.userId, staffId), eq(userTenantAccess.tenantId, full.tenantId)));
    }
  });

  it('a staff member who must choose a new password, or was turned off, is refused before anything runs', async () => {
    await db.update(users).set({ passwordChangeRequired: true }).where(eq(users.id, staffId));
    const waiting = await post(staffKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(waiting.status).toBe(403);
    expect(waiting.body.error.data.code).toBe('PASSWORD_CHANGE_REQUIRED');
    await db.update(users).set({ passwordChangeRequired: false, isActive: false }).where(eq(users.id, staffId));
    const off = await post(staffKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(off.status).toBe(401);
    expect(off.headers['www-authenticate']).toBe('Bearer');
    await db.update(users).set({ isActive: true }).where(eq(users.id, staffId));
    expect((await post(staffKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
  });
});

describe('MCP reconciliation, start to finish', () => {
  it('starts, reads the worksheet, ticks the lines and completes at a zero difference', async () => {
    const args = { company_id: full.companyId };
    for (const amount of ['30.00', '12.50']) {
      await expenseService.createExpense(full.tenantId, {
        txnDate: '2026-05-10', payFromAccountId: full.bankAccountId, lines: [{ expenseAccountId: full.expenseAccountId, amount }],
      }, full.ownerId);
    }

    // The statement shows everything in the account so far.
    const [{ balance }] = (await db.execute<{ balance: string }>(sql`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS balance
      FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
      WHERE jl.account_id = ${full.bankAccountId} AND t.status = 'posted' AND t.txn_date <= '2026-05-31'`)).rows as [{ balance: string }];

    const started = await call('start_reconciliation', {
      ...args, account_id: full.bankAccountId, statement_date: '2026-05-31', statement_ending_balance: Number(balance).toFixed(2),
    });
    expect(failure(started), failure(started)).toBeUndefined();
    const reconciliationId = data(started).id;

    // A second start on the same account is refused and points at the open one.
    expect(failure(await call('start_reconciliation', {
      ...args, account_id: full.bankAccountId, statement_date: '2026-05-31', statement_ending_balance: '0.00',
    }))).toContain(reconciliationId);

    const worksheet = data(await call('get_reconciliation', { ...args, reconciliation_id: reconciliationId }));
    expect(worksheet.lines.length).toBeGreaterThanOrEqual(2);

    // Not everything is ticked yet: completing is refused with the difference.
    expect(failure(await call('complete_reconciliation', { ...args, reconciliation_id: reconciliationId }))).toMatch(/^RECONCILE_DIFFERENCE_NOT_ZERO/);

    const ticked = await call('update_reconciliation_lines', {
      ...args, reconciliation_id: reconciliationId,
      lines: worksheet.lines.map((l: any) => ({ journal_line_id: l.journal_line_id, is_cleared: true })),
    });
    expect(failure(ticked), failure(ticked)).toBeUndefined();
    expect(Number(data(ticked).difference)).toBe(0);

    const done = await call('complete_reconciliation', { ...args, reconciliation_id: reconciliationId });
    expect(failure(done), failure(done)).toBeUndefined();
    expect(data(await call('get_reconciliation_status', { ...args, account_id: full.bankAccountId })).lastReconciliation)
      .toMatchObject({ id: reconciliationId, status: 'complete' });

    // Undo is an owner's act: the accountant is refused, as in the app.
    expect(failure(await call('undo_reconciliation', { ...args, reconciliation_id: reconciliationId }))).toMatch(/^RECONCILE_ADMIN_REQUIRED/);
  });

  it('a worksheet started by mistake can be discarded', async () => {
    const args = { company_id: firm.companyId };
    const started = await call('start_reconciliation', {
      ...args, account_id: firm.bankAccountId, statement_date: '2026-05-31', statement_ending_balance: '10.00',
    });
    expect(failure(started), failure(started)).toBeUndefined();
    expect(failure(await call('cancel_reconciliation', { ...args, reconciliation_id: data(started).id }))).toBeUndefined();
    expect(await db.select().from(reconciliations).where(eq(reconciliations.tenantId, firm.tenantId))).toHaveLength(0);
  });
});
