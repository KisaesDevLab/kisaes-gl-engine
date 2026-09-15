// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Banking → Uncategorized (team members) on the /practice/uncategorized router.
//   - a non-firm accountant on a FIRM-MANAGED tenant may suggest (201) but is
//     403 SUGGEST_ONLY_MODE on approve / clear / post-to-suspense / list
//   - on SELF-MANAGED books the owner reviews; accountants suggest
//   - staff of the managing firm review; members of another firm suggest
//   - team suggestions are transaction-only, honour note_required, never
//     silently overwrite someone else's answer, and can be withdrawn by
//     their author only
//   - /in-suspense?includeSuggestions=true and /suggestions carry the
//     submitter kind + name

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
  tenants, users, companies, accounts, bankConnections, bankFeedItems,
  transactions, journalLines, auditLog as auditLogTable, tenantFeatureFlags,
  clientCategorySuggestions, firms, firmUsers, tenantFirmAssignments, userTenantAccess,
} from '../db/schema/index.js';
import { uncategorizedRouter } from './uncategorized.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as ledger from '../services/ledger.service.js';
import { getSuspenseAccountId } from '../services/system-accounts.service.js';

let server: Server | null = null;
let port = 0;
const sfx = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
let tenantId = '', companyId = '', bankGlAccountId = '', expenseAccountId = '';
let firmId = '', otherFirmId = '';

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/practice/uncategorized', uncategorizedRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
}
function request(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Length': String(data.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: raw }); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const B = '/api/v1/practice/uncategorized';

async function seedUser(role: string, opts: { userType?: 'staff' | 'client'; isSuperAdmin?: boolean; displayName?: string } = {}) {
  const [u] = await db.insert(users).values({
    tenantId, email: `team-${sfx()}@example.com`, passwordHash: 'x'.repeat(60), role,
    displayName: opts.displayName ?? role, userType: opts.userType ?? 'staff', isSuperAdmin: opts.isSuperAdmin ?? false,
  }).returning();
  await db.insert(userTenantAccess).values({ userId: u!.id, tenantId, role });
  const token = jwt.sign(
    { userId: u!.id, tenantId, role, isSuperAdmin: opts.isSuperAdmin ?? false, userType: opts.userType ?? 'staff', auth_time: Math.floor(Date.now() / 1000) },
    process.env['JWT_SECRET']!, { expiresIn: '5m' },
  );
  return { id: u!.id, token };
}
async function seedSuspenseTxn(amount = '10.00', memo = 'Mystery charge') {
  const suspenseId = await getSuspenseAccountId(tenantId, companyId);
  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'expense', txnDate: '2026-05-01', memo,
    lines: [
      { accountId: suspenseId, debit: amount, credit: '0' },
      { accountId: bankGlAccountId, debit: '0', credit: amount },
    ],
  }, undefined, companyId);
  return txn.id;
}
async function assignFirm(fid: string) {
  await db.insert(tenantFirmAssignments).values({ firmId: fid, tenantId, isActive: true });
}

async function cleanDb() {
  const fids = [firmId, otherFirmId].filter(Boolean);
  if (tenantId) {
    await db.delete(clientCategorySuggestions).where(eq(clientCategorySuggestions.tenantId, tenantId));
    await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, tenantId));
    await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
    await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
    await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
    const uids = (await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))).map((r) => r.id);
    if (uids.length) {
      await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
      await db.delete(firmUsers).where(inArray(firmUsers.userId, uids));
    }
    await db.delete(users).where(eq(users.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
  }
  if (fids.length) {
    await db.delete(firmUsers).where(inArray(firmUsers.firmId, fids));
    await db.delete(firms).where(inArray(firms.id, fids));
  }
  tenantId = companyId = firmId = otherFirmId = '';
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'Team Uncat', slug: `team-uncat-${sfx()}` }).returning();
  tenantId = t!.id;
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'UNCATEGORIZED_REVIEW_V1', enabled: true });
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Team Co' }).returning();
  companyId = co!.id;
  const [bank] = await db.insert(accounts).values({ tenantId, companyId, name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '10999' }).returning();
  bankGlAccountId = bank!.id;
  const [exp] = await db.insert(accounts).values({ tenantId, companyId, name: 'Office Supplies', accountType: 'expense', accountNumber: '61010' }).returning();
  expenseAccountId = exp!.id;
  const [conn] = await db.insert(bankConnections).values({ tenantId, accountId: bankGlAccountId, institutionName: 'Test Bank' }).returning();
  void conn;
  const [f] = await db.insert(firms).values({ name: 'Managing Firm', slug: `mf-${sfx()}` }).returning();
  firmId = f!.id;
  const [of] = await db.insert(firms).values({ name: 'Other Firm', slug: `of-${sfx()}` }).returning();
  otherFirmId = of!.id;
  await startApp();
});
afterEach(async () => { if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; } await cleanDb(); });

describe('mode + reviewer gate on a FIRM-MANAGED tenant', () => {
  it('non-firm accountant: suggest-only; firm staff and super admin: review', async () => {
    await assignFirm(firmId);
    const acct = await seedUser('accountant');
    const owner = await seedUser('owner');
    const staff = await seedUser('accountant', { displayName: 'Firm Staffer' });
    await db.insert(firmUsers).values({ firmId, userId: staff.id, firmRole: 'firm_staff' });
    const other = await seedUser('accountant');
    await db.insert(firmUsers).values({ firmId: otherFirmId, userId: other.id, firmRole: 'firm_admin' });
    const inactive = await seedUser('accountant');
    await db.insert(firmUsers).values({ firmId, userId: inactive.id, firmRole: 'firm_admin', isActive: false });
    const sa = await seedUser('accountant', { isSuperAdmin: true });

    const m = await request('GET', `${B}/mode`, undefined, acct.token);
    expect(m.status).toBe(200);
    expect(m.json).toMatchObject({ mode: 'suggest', managedByFirm: true, firmName: 'Managing Firm', canReview: false });
    expect((await request('GET', `${B}/mode`, undefined, owner.token)).json.mode).toBe('suggest');
    expect((await request('GET', `${B}/mode`, undefined, staff.token)).json.mode).toBe('review');
    expect((await request('GET', `${B}/mode`, undefined, other.token)).json.mode).toBe('suggest');
    expect((await request('GET', `${B}/mode`, undefined, inactive.token)).json.mode).toBe('suggest');
    expect((await request('GET', `${B}/mode`, undefined, sa.token)).json.mode).toBe('review');

    const txnId = await seedSuspenseTxn();
    for (const [method, path, body] of [
      ['GET', '/suggestions', undefined],
      ['POST', '/suggestions/approve', { ids: ['00000000-0000-0000-0000-000000000000'] }],
      ['POST', '/clear', { transactionIds: [txnId], accountId: expenseAccountId }],
      ['POST', '/post-to-suspense', { feedItemIds: ['00000000-0000-0000-0000-000000000000'] }],
    ] as const) {
      const r = await request(method, `${B}${path}`, body, acct.token);
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.json.error.code).toBe('SUGGEST_ONLY_MODE');
      expect(r.json.error.message).toContain('Managing Firm');
    }
    // Reads stay open to the suggest-only audience.
    expect((await request('GET', `${B}/in-suspense`, undefined, acct.token)).status).toBe(200);
    expect((await request('GET', `${B}/summary`, undefined, acct.token)).status).toBe(200);
  });
});

describe('team suggestions', () => {
  it('accountant suggests on a managed tenant; firm staff see it with the Team member kind and approve it', async () => {
    await assignFirm(firmId);
    const acct = await seedUser('accountant', { displayName: 'Pat Bookkeeper' });
    const staff = await seedUser('accountant');
    await db.insert(firmUsers).values({ firmId, userId: staff.id, firmRole: 'firm_staff' });
    const txnId = await seedSuspenseTxn();

    const cats = await request('GET', `${B}/team/categories`, undefined, acct.token);
    expect(cats.status).toBe(200);
    expect(cats.json.categories.some((c: { id: string }) => c.id === expenseAccountId)).toBe(true);

    const s = await request('POST', `${B}/team/suggest`, { items: [{ targetId: txnId, categoryId: expenseAccountId, note: 'Printer paper' }] }, acct.token);
    expect(s.status).toBe(201);
    expect(s.json.accepted).toEqual([txnId]);
    const row = await db.query.clientCategorySuggestions.findFirst({ where: eq(clientCategorySuggestions.transactionId, txnId) });
    expect(row!.status).toBe('pending');
    expect(row!.submittedByUserId).toBe(acct.id);
    expect(row!.submittedByContactId).toBeNull();
    // Nothing posted: the suspense line is still there.
    const stillThere = await request('GET', `${B}/in-suspense?includeSuggestions=true`, undefined, acct.token);
    expect(stillThere.json.rows).toHaveLength(1);
    expect(stillThere.json.rows[0].pendingSuggestion).toMatchObject({ submittedBy: 'team_member', submittedByUserId: acct.id, submittedByName: 'Pat Bookkeeper', note: 'Printer paper' });

    const list = await request('GET', `${B}/suggestions`, undefined, staff.token);
    expect(list.status).toBe(200);
    expect(list.json.rows[0]).toMatchObject({ submittedBy: 'team_member', contactName: 'Pat Bookkeeper', suggestedAccountId: expenseAccountId });

    const approve = await request('POST', `${B}/suggestions/approve`, { ids: [row!.id] }, staff.token);
    expect(approve.status).toBe(200);
    expect((await request('GET', `${B}/in-suspense`, undefined, staff.token)).json.rows).toHaveLength(0);
  });

  it('self-managed books: the owner reviews, an accountant suggests', async () => {
    const owner = await seedUser('owner');
    const acct = await seedUser('accountant');
    expect((await request('GET', `${B}/mode`, undefined, owner.token)).json).toMatchObject({ mode: 'review', managedByFirm: false, canReview: true });
    expect((await request('GET', `${B}/mode`, undefined, acct.token)).json).toMatchObject({ mode: 'suggest', managedByFirm: false });
    const txnId = await seedSuspenseTxn();
    expect((await request('POST', `${B}/team/suggest`, { items: [{ targetId: txnId, categoryId: expenseAccountId }] }, acct.token)).status).toBe(201);
    const denied = await request('POST', `${B}/clear`, { transactionIds: [txnId], accountId: expenseAccountId }, acct.token);
    expect(denied.status).toBe(403);
    expect(denied.json.error.message).toContain('owner');
    const row = await db.query.clientCategorySuggestions.findFirst({ where: eq(clientCategorySuggestions.transactionId, txnId) });
    const approve = await request('POST', `${B}/suggestions/approve`, { ids: [row!.id] }, owner.token);
    expect(approve.status).toBe(200);
    expect((await request('GET', `${B}/in-suspense`, undefined, owner.token)).json.rows).toHaveLength(0);
  });

  it('is transaction-only, needs a note for not_sure, never overwrites someone else, withdraw is author-only', async () => {
    const a = await seedUser('accountant');
    const b = await seedUser('bookkeeper');
    const txnId = await seedSuspenseTxn();
    const [feed] = await db.insert(bankFeedItems).values({
      tenantId, bankConnectionId: (await db.query.bankConnections.findFirst({ where: eq(bankConnections.tenantId, tenantId) }))!.id,
      companyId, feedDate: '2026-05-02', description: 'Pending line', amount: '5.0000', status: 'pending',
    }).returning();

    const r1 = await request('POST', `${B}/team/suggest`, { items: [
      { targetId: feed!.id, categoryId: expenseAccountId },
      { targetId: txnId, categoryId: 'not_sure' },
    ] }, a.token);
    expect(r1.status).toBe(201);
    expect(r1.json.accepted).toEqual([]);
    expect(r1.json.failed).toEqual(expect.arrayContaining([
      { targetId: feed!.id, reason: 'not_found' },
      { targetId: txnId, reason: 'note_required' },
    ]));

    expect((await request('POST', `${B}/team/suggest`, { items: [{ targetId: txnId, categoryId: 'personal', note: 'Mine' }] }, a.token)).json.accepted).toEqual([txnId]);
    // A re-answer by the same author supersedes; another author is refused.
    expect((await request('POST', `${B}/team/suggest`, { items: [{ targetId: txnId, categoryId: expenseAccountId }] }, a.token)).json.accepted).toEqual([txnId]);
    const clash = await request('POST', `${B}/team/suggest`, { items: [{ targetId: txnId, categoryId: expenseAccountId }] }, b.token);
    expect(clash.json.failed).toEqual([{ targetId: txnId, reason: 'already_answered' }]);

    const live = await db.query.clientCategorySuggestions.findFirst({ where: eq(clientCategorySuggestions.transactionId, txnId) });
    const pending = (await db.select().from(clientCategorySuggestions).where(eq(clientCategorySuggestions.status, 'pending')))[0]!;
    void live;
    expect((await request('DELETE', `${B}/team/suggest/${pending.id}`, undefined, b.token)).status).toBe(409);
    expect((await request('DELETE', `${B}/team/suggest/${pending.id}`, undefined, a.token)).status).toBe(200);
    expect((await request('GET', `${B}/in-suspense?includeSuggestions=true`, undefined, a.token)).json.rows[0].pendingSuggestion).toBeNull();
  });

  it('readonly 403 and client user_type 404 on the team routes; a bad body is 400', async () => {
    const ro = await seedUser('readonly');
    const client = await seedUser('owner', { userType: 'client' });
    const acct = await seedUser('accountant');
    expect((await request('GET', `${B}/team/categories`, undefined, ro.token)).status).toBe(403);
    expect((await request('GET', `${B}/mode`, undefined, client.token)).status).toBe(404);
    expect((await request('POST', `${B}/team/suggest`, { items: [] }, acct.token)).status).toBe(400);
    expect((await request('POST', `${B}/team/suggest`, { items: [{ targetId: 'nope', categoryId: 'personal' }] }, acct.token)).status).toBe(400);
  });
});
