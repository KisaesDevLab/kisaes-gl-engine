// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, companies, contacts, accounts, transactions, journalLines,
  tenantFeatureFlags, accrualSchedules, accrualEntries, auditLog as auditLogTable,
} from '../db/schema/index.js';
import { practiceAccrualsRouter } from './practice-accruals.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let token = '';
const acct: Record<string, string> = {};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/practice/accruals', practiceAccrualsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server?.close(() => r())); });

function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/practice/accruals${path}`, method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(data ? { 'Content-Length': String(data.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'ACC', slug: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  tenantId = t!.id;
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'ACCRUALS_V1', enabled: true });
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Co' }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `acc-${Date.now()}-${Math.random()}@example.com`, passwordHash: await bcrypt.hash('secret-123-456', 4), role: 'owner', displayName: 'Owner',
  }).returning();
  token = jwt.sign({ userId: u!.id, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  const mk = async (name: string, accountType: string, accountNumber: string, detailType?: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber, detailType, balance: '0' }).returning();
    return a!.id;
  };
  acct['prepaid'] = await mk('Prepaid Insurance', 'asset', '1400', 'other_current_asset');
  acct['insurance'] = await mk('Insurance Expense', 'expense', '6300');
  acct['cash'] = await mk('Checking', 'asset', '1000', 'bank');
});

afterEach(async () => {
  await db.delete(accrualEntries).where(eq(accrualEntries.tenantId, tenantId));
  await db.delete(accrualSchedules).where(eq(accrualSchedules.tenantId, tenantId));
  const txns = (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, tenantId))).map((r) => r.id);
  if (txns.length) await db.delete(journalLines).where(inArray(journalLines.transactionId, txns));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

const annualPolicy = () => ({
  companyId, kind: 'prepaid', description: 'Annual liability policy',
  balanceAccountId: acct['prepaid'], recognitionAccountId: acct['insurance'],
  totalAmount: '1200.00', startDate: '2026-07-01', months: 12, method: 'full_month',
});

describe('accruals', () => {
  it('creates a schedule with one entry per month', async () => {
    const r = await request('POST', '/schedules', annualPolicy());
    expect(r.status).toBe(201);
    const e = await request('GET', `/schedules/${r.json.schedule.id}/entries`);
    expect(e.json.entries).toHaveLength(12);
    expect(e.json.entries[0]).toMatchObject({ periodStart: '2026-07-01', postPeriod: '2026-07-01', amount: '100.0000', status: 'draft' });
  });

  it('puts missed months into the post-from month as catch-up entries', async () => {
    await request('POST', '/schedules', { ...annualPolicy(), postFrom: '2026-09-01' });
    const sep = await request('GET', `/entries?companyId=${companyId}&periodStart=2026-09-01`);
    expect(sep.json.entries).toHaveLength(3); // Jul + Aug catch-up + Sep
    expect(sep.json.entries.filter((x: { is_catch_up: boolean }) => x.is_catch_up)).toHaveLength(2);
  });

  it('posts a month as a journal entry, unposts by voiding, and locks edits once posted', async () => {
    const s = (await request('POST', '/schedules', annualPolicy())).json.schedule;
    const jul = (await request('GET', `/entries?companyId=${companyId}&periodStart=2026-07-01`)).json.entries;
    const p = await request('POST', `/entries/${jul[0].id}/post`);
    expect(p.status).toBe(200);
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, p.json.transactionId));
    expect(txn!.txnType).toBe('journal_entry');
    expect(txn!.txnDate).toBe('2026-07-31');
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txn!.id));
    expect(lines.find((l) => l.accountId === acct['insurance'])!.debit).toBe('100.0000');
    expect(lines.find((l) => l.accountId === acct['prepaid'])!.credit).toBe('100.0000');

    // Terms can't change once anything posted.
    const edit = await request('PUT', `/schedules/${s.id}`, { ...annualPolicy(), totalAmount: '2400.00' });
    expect(edit.status).toBe(400);

    const u = await request('POST', `/entries/${jul[0].id}/unpost`);
    expect(u.status).toBe(200);
    const [voided] = await db.select().from(transactions).where(eq(transactions.id, p.json.transactionId));
    expect(voided!.status).toBe('void');
    const again = (await request('GET', `/entries?companyId=${companyId}&periodStart=2026-07-01`)).json.entries;
    expect(again[0].status).toBe('draft');
  });

  it('post-all posts the month; cancel stops future drafts', async () => {
    const s = (await request('POST', '/schedules', annualPolicy())).json.schedule;
    expect((await request('POST', '/post-all', { companyId, periodStart: '2026-07-01' })).json.posted).toBe(1);
    await request('POST', `/schedules/${s.id}/cancel`);
    const list = (await request('GET', `/schedules?companyId=${companyId}`)).json.schedules;
    expect(list[0].status).toBe('cancelled');
    expect(Number(list[0].posted_count)).toBe(1);
    expect(Number(list[0].draft_count)).toBe(0);
  });

  it('ties the prepaid account out against the schedule', async () => {
    // Pay the policy: Dr Prepaid 1200 / Cr Checking 1200, dated July.
    const [pay] = await db.insert(transactions).values({ tenantId, companyId, txnType: 'expense', txnDate: '2026-07-02', total: '1200.0000', status: 'posted' }).returning();
    await db.insert(journalLines).values([
      { tenantId, companyId, transactionId: pay!.id, accountId: acct['prepaid']!, debit: '1200.0000', credit: '0' },
      { tenantId, companyId, transactionId: pay!.id, accountId: acct['cash']!, debit: '0', credit: '1200.0000' },
    ]);
    await request('POST', '/schedules', { ...annualPolicy(), sourceTransactionId: pay!.id });
    await request('POST', '/post-all', { companyId, periodStart: '2026-07-01' });
    const t = (await request('GET', `/tie-out?companyId=${companyId}&periodEnd=2026-08-01`)).json.rows;
    expect(t[0]).toMatchObject({ accountName: 'Prepaid Insurance', ledgerBalance: '1100.00', scheduleBalance: '1100.00', difference: '0.00' });
    // The payment is scheduled, so it is no longer an unscheduled candidate.
    const c = (await request('GET', `/candidates?companyId=${companyId}&periodStart=2026-07-01&periodEnd=2026-08-01`)).json;
    expect(c.unscheduled).toHaveLength(0);
  });

  it('flags an unscheduled prepaid debit as a candidate', async () => {
    const [pay] = await db.insert(transactions).values({ tenantId, companyId, txnType: 'expense', txnDate: '2026-07-02', total: '600.0000', status: 'posted', memo: 'Policy' }).returning();
    await db.insert(journalLines).values([
      { tenantId, companyId, transactionId: pay!.id, accountId: acct['prepaid']!, debit: '600.0000', credit: '0' },
      { tenantId, companyId, transactionId: pay!.id, accountId: acct['cash']!, debit: '0', credit: '600.0000' },
    ]);
    const c = (await request('GET', `/candidates?companyId=${companyId}&periodStart=2026-07-01&periodEnd=2026-08-01`)).json;
    expect(c.unscheduled).toHaveLength(1);
    expect(c.unscheduled[0]).toMatchObject({ account_name: 'Prepaid Insurance', suggested_kind: 'prepaid' });
  });

  it('imports schedules from CSV and reports bad rows', async () => {
    const csv = [
      'kind,description,balance account,recognition account,start,amount,months,method',
      'prepaid,Software license,1400,6300,2026-07,600,6,full_month',
      'prepaid,Bad row,9999,6300,2026-07,600,6,full_month',
    ].join('\n');
    const r = await request('POST', '/import', { companyId, csv });
    expect(r.json.created).toBe(1);
    expect(r.json.errors).toEqual([{ row: 3, error: 'Account number not found' }]);
  });

  it('is hidden when ACCRUALS_V1 is off', async () => {
    await db.update(tenantFeatureFlags).set({ enabled: false }).where(eq(tenantFeatureFlags.tenantId, tenantId));
    expect((await request('GET', `/schedules?companyId=${companyId}`)).status).toBe(404);
  });
});
