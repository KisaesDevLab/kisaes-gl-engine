// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Firm staff working on clients through MCP.
//
// One staff member, one key, several client tenants with different roles.
// What they can reach and do must be exactly what the app gives them:
// the clients they hold access to, with the role they hold in each.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// This file makes far more calls on one key than the per-key limit allows in a minute.
vi.mock('./rate-limiter.js', () => ({ checkRateLimit: () => ({ allowed: true }) }));
import 'express-async-errors';
import crypto from 'crypto';
import { sql, eq, and } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import {
  accounts, apiKeys, auditLog, bankConnections, bankFeedItems, companies, contacts, mcpConfig, mcpRequestLog, reconciliations, transactions,
  userTenantAccess, users,
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

  /** A connection as a real client makes one: initialize, then send the id back. */
  async function openSession(key = staffKey): Promise<Record<string, string>> {
    const init = await post(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    return { 'mcp-session-id': init.headers['mcp-session-id']! };
  }

  it('each connection keeps its own active client', async () => {
    const one = await openSession();
    const two = await openSession();
    expect(one['mcp-session-id']).not.toBe(two['mcp-session-id']);
    expect(data(await call('set_active_company', { company_id: full.companyId }, one))).toMatchObject({ name: 'Alpha Co', used_for_changes: true });
    expect(data(await call('set_active_company', { company_id: readOnly.companyId }, two))).toMatchObject({ name: 'Bravo Co' });
    expect(data(await call('get_active_company', {}, one)).active_company_id).toBe(full.companyId);
    expect(data(await call('get_active_company', {}, two)).active_company_id).toBe(readOnly.companyId);
    // A write on chat one lands in chat one's client even after chat two chose another.
    const created = await call('create_contact', { display_name: 'From chat one', type: 'customer' }, one);
    expect(created.result.content[1].text).toContain('Alpha Co');
    const row = await db.query.contacts.findFirst({ where: eq(contacts.displayName, 'From chat one') });
    expect(row?.tenantId).toBe(full.tenantId);
    expect(failure(await call('create_contact', { display_name: 'From chat two', type: 'customer' }, two))).toMatch(/^PERMISSION_DENIED/);
    // A connection that never chose still has to.
    expect(failure(await call('list_accounts', {}, await openSession()))).toMatch(/^COMPANY_REQUIRED/);
  });

  it('without a session of its own, a remembered client is for reading only: a change must name the client', async () => {
    // No Mcp-Session-Id at all: every chat on this key shares one choice.
    const chosen = data(await call('set_active_company', { company_id: full.companyId }));
    expect(chosen).toMatchObject({ name: 'Alpha Co', used_for_changes: false });
    expect((await call('list_accounts')).result.isError).toBeFalsy();

    const refused = await call('create_contact', { display_name: 'No session, no client named', type: 'customer' });
    expect(failure(refused)).toMatch(/^COMPANY_REQUIRED/);
    expect(failure(refused)).toContain('pass company_id');
    expect(await db.query.contacts.findFirst({ where: eq(contacts.displayName, 'No session, no client named') })).toBeUndefined();

    // Naming the client works, and lands there.
    const named = await call('create_contact', { company_id: full.companyId, display_name: 'No session, client named', type: 'customer' });
    expect(named.result.isError).toBeFalsy();
    expect((await db.query.contacts.findFirst({ where: eq(contacts.displayName, 'No session, client named') }))?.tenantId).toBe(full.tenantId);
  });

  it('a session id this server did not issue to this caller does not count as a session', async () => {
    const madeUp = { 'mcp-session-id': 'chat-one' };
    expect(data(await call('set_active_company', { company_id: full.companyId }, madeUp)).used_for_changes).toBe(false);
    expect(failure(await call('create_contact', { display_name: 'Made-up session', type: 'customer' }, madeUp))).toMatch(/^COMPANY_REQUIRED/);

    // Another key's session id, replayed with this key.
    const otherKey = 'sk_live_' + crypto.randomBytes(32).toString('hex');
    await db.insert(apiKeys).values({
      tenantId: firm.tenantId, userId: staffId, name: 'second key', keyPrefix: otherKey.slice(0, 12),
      keyHash: crypto.createHash('sha256').update(otherKey).digest('hex'), role: 'accountant', scopes: 'read,write',
    });
    const theirs = await openSession(otherKey);
    expect(data(await call('set_active_company', { company_id: full.companyId }, theirs)).used_for_changes).toBe(false);
    expect(data(await call('set_active_company', { company_id: full.companyId }, theirs, otherKey)).used_for_changes).toBe(true);
  });

  it('a switch that fails leaves no client selected', async () => {
    const chat = await openSession();
    await call('set_active_company', { company_id: full.companyId }, chat);
    expect(failure(await call('set_active_company', { company_id: mcpOff.companyId }, chat))).toMatch(/^MCP_DISABLED/);
    expect(data(await call('get_active_company', {}, chat)).active_company_id).toBeNull();
    expect(failure(await call('create_contact', { display_name: 'After a failed switch', type: 'customer' }, chat))).toMatch(/^COMPANY_REQUIRED/);
  });

  it('every change is stamped with the client company it was made in', async () => {
    const expense = await call('create_expense', {
      company_id: full.companyId, date: '2026-02-03', bank_account_id: full.bankAccountId,
      lines: [{ expenseAccountId: full.expenseAccountId, amount: '12.50', description: 'stamped' }],
    });
    expect(expense.result.isError).toBeFalsy();
    const made = data(expense);
    const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, made.id ?? made.transaction?.id) });
    expect(txn?.tenantId).toBe(full.tenantId);
    expect(txn?.companyId).toBe(full.companyId);
  });

  it('an id from another client cannot be used in the selected one', async () => {
    const [foreignVendor] = await db.insert(contacts).values({
      tenantId: readOnly.tenantId, displayName: 'Bravo Vendor', contactType: 'vendor',
    }).returning();
    const before = await db.select({ id: transactions.id }).from(transactions);

    // Another client's account, and another client's contact as the payee.
    const wrongAccount = await call('create_expense', {
      company_id: full.companyId, date: '2026-02-04', bank_account_id: readOnly.bankAccountId,
      lines: [{ expenseAccountId: full.expenseAccountId, amount: '5.00' }],
    });
    expect(wrongAccount.result.isError).toBe(true);
    const wrongPayee = await call('create_expense', {
      company_id: full.companyId, date: '2026-02-04', bank_account_id: full.bankAccountId, payee_id: foreignVendor!.id,
      lines: [{ expenseAccountId: full.expenseAccountId, amount: '5.00' }],
    });
    expect(wrongPayee.result.isError).toBe(true);

    // Another client's transaction cannot be voided from here.
    const theirs = await expenseService.createExpense(readOnly.tenantId, {
      txnDate: '2026-02-05', payFromAccountId: readOnly.bankAccountId, memo: '',
      lines: [{ expenseAccountId: readOnly.expenseAccountId, amount: '9.00' }],
    } as Parameters<typeof expenseService.createExpense>[1], readOnly.ownerId, readOnly.companyId);
    const voided = await call('void_transaction', { company_id: full.companyId, transaction_id: theirs.id });
    expect(voided.result.isError).toBe(true);
    expect((await db.query.transactions.findFirst({ where: eq(transactions.id, theirs.id) }))?.status).toBe('posted');

    const after = await db.select({ id: transactions.id }).from(transactions);
    expect(after.length).toBe(before.length + 1); // only the one made directly in Bravo
  });

  it('get_company_info returns the profile and no credential', async () => {
    await db.update(companies).set({ ein: '12-3456789' }).where(eq(companies.id, full.companyId));
    const info = data(await call('get_company_info', { company_id: full.companyId }));
    expect(info.businessName).toBe('Alpha Co');
    for (const key of Object.keys(info)) expect(key).not.toMatch(/secret|password|token|encrypted|hash/i);
    expect(info.ein).toBeUndefined();
    expect(info.intakeSettings).toBeUndefined();
  });

  it('initialize hands the connection a signed id to keep its active client under', async () => {
    const init = await post(staffKey, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    expect(init.headers['mcp-session-id']).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/);
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
    // With one company allowed, that is the one it works in when none is named.
    const unnamed = await call('list_accounts', {}, {}, limitedKey);
    expect(failure(unnamed)).toBeUndefined();
    expect(unnamed.result.content[1].text).toContain('Alpha Co');

    // A key limited to two: asked which, it is told about those two and no others.
    const twoKey = 'sk_live_' + crypto.randomBytes(32).toString('hex');
    await db.insert(apiKeys).values({
      tenantId: firm.tenantId, userId: staffId, name: 'two clients', keyPrefix: twoKey.slice(0, 12),
      keyHash: crypto.createHash('sha256').update(twoKey).digest('hex'), role: 'accountant',
      scopes: 'read', allowedCompanies: `${full.companyId},${readOnly.companyId}`,
    });
    const which = failure(await call('list_accounts', {}, {}, twoKey))!;
    expect(which).toMatch(/^COMPANY_REQUIRED/);
    expect(which).toContain(full.companyId);
    expect(which).toContain(readOnly.companyId);
    expect(which).not.toContain(firm.companyId);
    expect(which).not.toContain('Firm Co');
    expect(which).not.toContain('Delta Co');
    expect(which).toContain('"total_companies":2');
    // Its remembered choice cannot be a company outside the key either.
    expect(failure(await call('set_active_company', { company_id: firm.companyId }, {}, twoKey))).toMatch(/^ACCESS_DENIED/);
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

// A client file (tenant) can hold more than one company. Naming one of them
// must mean that one: its figures, its lists, and no change to a sibling's
// records. Found by walking the released build with a two-company file.
describe('MCP in a client file with two companies', () => {
  let file: Client;
  let secondId = '';
  let revenueId = '';

  beforeAll(async () => {
    file = await provision('Echo');
    await grant(file, 'accountant');
    const first = await db.query.companies.findFirst({ where: eq(companies.id, file.companyId) });
    const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = first!;
    const [second] = await db.insert(companies).values({ ...rest, businessName: 'Echo Two Co', mcpEnabled: true }).returning();
    secondId = second!.id;
    const all = await db.query.accounts.findMany({ where: eq(accounts.tenantId, file.tenantId) });
    revenueId = all.find((a) => a.accountType === 'revenue')!.id;
  }, 60000);

  const sale = async (companyId: string, price: string) => data(await call('create_cash_sale', {
    company_id: companyId, date: '2026-03-01', payment_account_id: file.bankAccountId,
    lines: [{ accountId: revenueId, quantity: '1', unitPrice: price }],
  }));
  const revenue = async (companyId: string) => Number(
    data(await call('run_profit_loss', { company_id: companyId, start_date: '2026-01-01', end_date: '2026-12-31' })).totalRevenue,
  );

  it('a report and a list show the company asked for, not the whole file', async () => {
    const a = await sale(file.companyId, '100.00');
    const b = await sale(secondId, '900.00');
    expect((await db.query.transactions.findFirst({ where: eq(transactions.id, b.id) }))?.companyId).toBe(secondId);

    expect(await revenue(file.companyId)).toBe(100);
    expect(await revenue(secondId)).toBe(900);

    const listed = data(await call('list_transactions', { company_id: secondId })).map((t: any) => t.id);
    expect(listed).toContain(b.id);
    expect(listed).not.toContain(a.id);
    const viaResource = await post(staffKey, {
      jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: `kisbooks://company/${secondId}/recent-transactions` },
    });
    const rows = JSON.parse(viaResource.body.result.contents[0].text).map((t: any) => t.id);
    expect(rows).toContain(b.id);
    expect(rows).not.toContain(a.id);
  });

  it('refuses to read or change a record of the sibling company, and changes nothing', async () => {
    const a = await sale(file.companyId, '10.00');
    const attempts: Array<[string, Record<string, unknown>]> = [
      ['get_transaction', { transaction_id: a.id }],
      ['void_transaction', { transaction_id: a.id, reason: 'wrong company' }],
      ['tag_transaction', { transaction_id: a.id, tag_ids: [crypto.randomUUID()] }],
      ['set_transaction_tag', { transaction_id: a.id }],
    ];
    for (const [tool, args] of attempts) {
      expect(failure(await call(tool, { company_id: secondId, ...args })), tool).toMatch(/^WRONG_COMPANY/);
    }
    expect((await db.query.transactions.findFirst({ where: eq(transactions.id, a.id) }))?.status).toBe('posted');
    // The company it belongs to can.
    expect(failure(await call('void_transaction', { company_id: file.companyId, transaction_id: a.id, reason: 'right company' }))).toBeUndefined();
  });

  it('a bank feed item is listed and acted on only in its own company', async () => {
    const [connection] = await db.insert(bankConnections).values({
      tenantId: file.tenantId, companyId: file.companyId, accountId: file.bankAccountId,
    }).returning();
    // One stamped with the company, one that only its connection places.
    const [stamped] = await db.insert(bankFeedItems).values({
      tenantId: file.tenantId, companyId: file.companyId, bankConnectionId: connection!.id, feedDate: '2026-03-02', amount: '4.0000', description: 'stamped',
    }).returning();
    const [unstamped] = await db.insert(bankFeedItems).values({
      tenantId: file.tenantId, bankConnectionId: connection!.id, feedDate: '2026-03-02', amount: '5.0000', description: 'unstamped',
    }).returning();

    const idsIn = async (companyId: string) => data(await call('list_bank_feed_items', { company_id: companyId })).map((f: any) => f.id);
    expect(await idsIn(file.companyId)).toEqual(expect.arrayContaining([stamped!.id, unstamped!.id]));
    expect(await idsIn(secondId)).toEqual([]);

    for (const item of [stamped!, unstamped!]) {
      expect(failure(await call('exclude_feed_item', { company_id: secondId, feed_item_id: item.id }))).toMatch(/^WRONG_COMPANY/);
      expect(failure(await call('categorize_feed_item', { company_id: secondId, feed_item_id: item.id, account_id: file.expenseAccountId }))).toMatch(/^WRONG_COMPANY/);
      expect(failure(await call('bulk_set_bank_feed_tag', { company_id: secondId, feed_item_ids: [item.id] }))).toMatch(/^WRONG_COMPANY/);
    }
    const after = await db.query.bankFeedItems.findMany({ where: eq(bankFeedItems.tenantId, file.tenantId) });
    expect(after.map((f) => f.status)).toEqual(['pending', 'pending']);
    expect(failure(await call('exclude_feed_item', { company_id: file.companyId, feed_item_id: stamped!.id }))).toBeUndefined();
  });

  it('send_invoice marks an invoice sent, says no email went out, and leaves a paid invoice paid', async () => {
    const customer = data(await call('create_contact', { company_id: file.companyId, display_name: 'Echo Customer', type: 'customer' }));
    const invoice = data(await call('create_invoice', {
      company_id: file.companyId, customer_id: customer.id, date: '2026-03-03',
      lines: [{ accountId: revenueId, description: 'work', quantity: '1', unitPrice: '50.00' }],
    }));
    const sent = data(await call('send_invoice', { company_id: file.companyId, invoice_id: invoice.id }));
    expect(sent).toMatchObject({ marked_sent: true, emailed: false });
    const status = async () => (await db.query.transactions.findFirst({ where: eq(transactions.id, invoice.id) }))?.invoiceStatus;
    expect(await status()).toBe('sent');

    const paid = await call('record_payment', {
      company_id: file.companyId, customer_id: customer.id, amount: '50.00', date: '2026-03-04', deposit_to: file.bankAccountId,
      applications: [{ invoiceId: invoice.id, amount: '50.00' }],
    });
    expect(failure(paid)).toBeUndefined();
    expect(await status()).toBe('paid');
    expect(failure(await call('send_invoice', { company_id: file.companyId, invoice_id: invoice.id }))).toBeUndefined();
    expect(await status()).toBe('paid');
  });
});
