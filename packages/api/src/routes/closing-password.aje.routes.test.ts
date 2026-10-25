// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Adjusting journal entries and the closing-date password (U-15). AJEs are
// exempt from the closing date (TB5) only while the company has no closing
// password; with one set, creating, editing, voiding or reversing an AJE
// dated in the closed period needs it like any other posting. And with
// TRIAL_BALANCE_V1 off, POST /transactions/:id/void refuses an AJE.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, transactions, journalLines, tenantFeatureFlags,
} from '../db/schema/index.js';
import { transactionsRouter } from './transactions.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';
import * as closingPasswordService from '../services/closing-password.service.js';

const { tbRouter } = await import('./tb.routes.js');

const PASSWORD = 'closing-pass-123';
const CLOSED = '2026-05-01';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let ownerId = '';
let ownerToken = '';
let cashId = '';
let expenseId = '';

function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ownerToken}`,
        'X-Company-Id': companyId,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
        ...extra,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const line = (accountId: string, debit: number, credit: number) => ({
  accountId, debit: String(debit), credit: String(credit),
  isTaxable: false, taxRate: '0', taxAmount: '0',
});

const aje = (txnDate: string, extra: Record<string, unknown> = {}) => ({
  txnDate, memo: 'adjustment', basis: 'both',
  lines: [line(expenseId, 40, 0), line(cashId, 0, 40)], ...extra,
});

async function setPassword() {
  await closingPasswordService.setClosingPassword(tenantId, companyId, { newPassword: PASSWORD }, { userId: ownerId, userRole: 'owner' });
}

async function overrideCount() {
  const rows = await db.select().from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'closing_date_override')));
  return rows.length;
}

async function setTbFlag(enabled: boolean) {
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'TRIAL_BALANCE_V1', enabled });
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'AJE Lock', slug: 'aje-lock-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  await setTbFlag(true);
  const [c] = await db.insert(companies).values({
    tenantId, businessName: 'AJE Co', setupComplete: true, lockDate: '2026-06-30',
  }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `owner-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x', role: 'owner', displayName: 'Owner',
  }).returning();
  ownerId = u!.id;
  ownerToken = jwt.sign({ userId: ownerId, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  cashId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  expenseId = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/tb', tbRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.execute(sql`DELETE FROM tb_aje_sequences WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('AJEs and the closing-date password', () => {
  it('without a closing password an AJE still posts into the closed period (TB5 unchanged)', async () => {
    const r = await call('POST', '/api/v1/tb/ajes', aje(CLOSED));
    expect(r.status).toBe(201);
    const id = r.json.aje.id as string;
    expect((await call('POST', `/api/v1/tb/ajes/${id}/void`, { reason: 'dup' })).status).toBe(200);
    expect(await overrideCount()).toBe(0);
  });

  it('with a password set, create needs it: 423 without, 403 wrong, 201 right and audited', async () => {
    await setPassword();
    const none = await call('POST', '/api/v1/tb/ajes', aje(CLOSED));
    expect(none.status).toBe(423);
    expect(none.json.error.details).toMatchObject({ closingPasswordRequired: true, canOverride: false });
    expect((await call('POST', '/api/v1/tb/ajes', aje(CLOSED, { overrideConfirmed: true }))).status).toBe(423);
    const wrong = await call('POST', '/api/v1/tb/ajes', aje(CLOSED, { closingPassword: 'wrong-pass' }));
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).toHaveLength(0);

    const ok = await call('POST', '/api/v1/tb/ajes', aje(CLOSED, { closingPassword: PASSWORD }));
    expect(ok.status).toBe(201);
    expect(await overrideCount()).toBe(1);
    // An open date needs nothing.
    expect((await call('POST', '/api/v1/tb/ajes', aje('2026-07-15'))).status).toBe(201);
    expect(await overrideCount()).toBe(1);
  });

  it('edit, void and reverse of a closed-period AJE need the password too', async () => {
    const created = await call('POST', '/api/v1/tb/ajes', aje(CLOSED));
    expect(created.status).toBe(201);
    const id = created.json.aje.id as string;
    await setPassword();

    expect((await call('PUT', `/api/v1/tb/ajes/${id}`, aje(CLOSED, { memo: 'edited' }))).status).toBe(423);
    expect((await call('PUT', `/api/v1/tb/ajes/${id}`, aje(CLOSED, { memo: 'edited', closingPassword: PASSWORD }))).status).toBe(200);

    // Moving an open AJE into the closed period is refused as well.
    const open = await call('POST', '/api/v1/tb/ajes', aje('2026-07-15'));
    expect((await call('PUT', `/api/v1/tb/ajes/${open.json.aje.id}`, aje(CLOSED))).status).toBe(423);

    // The reversal is dated 2026-06-01 and the duplicate keeps 2026-05-01:
    // both still in the closed period.
    expect((await call('POST', `/api/v1/tb/ajes/${id}/reverse`, {})).status).toBe(423);
    expect((await call('POST', `/api/v1/tb/ajes/${id}/reverse`, { closingPassword: PASSWORD })).status).toBe(201);
    expect((await call('POST', `/api/v1/tb/ajes/${id}/duplicate`, {})).status).toBe(423);
    expect((await call('POST', `/api/v1/tb/ajes/${id}/void`, { reason: 'dup' })).status).toBe(423);
    expect((await call('POST', `/api/v1/transactions/${id}/void`, { reason: 'dup' })).status).toBe(423);
    expect((await call('POST', `/api/v1/tb/ajes/${id}/void`, { reason: 'dup', closingPassword: PASSWORD })).status).toBe(200);
  });
});

describe('PUT /tb/closing-date with a wrong password', () => {
  it('is 403, changes nothing and is audited as closing_password_failed', async () => {
    await setPassword();
    const r = await call('PUT', '/api/v1/tb/closing-date', { closingDate: '2026-09-30', closingPassword: 'wrong-pass' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    const [company] = await db.select({ lockDate: companies.lockDate }).from(companies).where(eq(companies.id, companyId));
    expect(company!.lockDate).toBe('2026-06-30');
    const rows = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'closing_password_failed')));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).toContain('closing_date');
    expect(JSON.stringify(rows)).not.toContain('wrong-pass');
    // The right one goes through, in the same transaction as its audit row.
    expect((await call('PUT', '/api/v1/tb/closing-date', { closingDate: '2026-09-30', closingPassword: PASSWORD })).status).toBe(200);
  });
});

describe('POST /transactions/:id/void and the TRIAL_BALANCE_V1 flag', () => {
  it('refuses an AJE when the trial balance module is off', async () => {
    const created = await call('POST', '/api/v1/tb/ajes', aje('2026-07-15'));
    expect(created.status).toBe(201);
    const id = created.json.aje.id as string;
    await setTbFlag(false);
    const r = await call('POST', `/api/v1/transactions/${id}/void`, { reason: 'dup' });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('TB_AJE_ROUTE');
    const [row] = await db.select({ status: transactions.status }).from(transactions).where(eq(transactions.id, id));
    expect(row!.status).toBe('posted');
  });

  it('a keyed void replay is refused like a first attempt once the module is off (U-18 L1)', async () => {
    const created = await call('POST', '/api/v1/tb/ajes', aje('2026-07-15'));
    expect(created.status).toBe(201);
    const id = created.json.aje.id as string;
    const key = crypto.randomUUID();
    const first = await call('POST', `/api/v1/transactions/${id}/void`, { reason: 'dup' }, { 'Idempotency-Key': key });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    // While the module is on, the retry is a replay.
    const replay = await call('POST', `/api/v1/transactions/${id}/void`, { reason: 'dup' }, { 'Idempotency-Key': key });
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    // The AJE rule runs ahead of idempotent(): no replay once it refuses.
    await setTbFlag(false);
    const refused = await call('POST', `/api/v1/transactions/${id}/void`, { reason: 'dup' }, { 'Idempotency-Key': key });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('TB_AJE_ROUTE');
    expect(refused.headers['idempotent-replayed']).toBeUndefined();
  });
});
