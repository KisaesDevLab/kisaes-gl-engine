// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Closing-date password (U-15) over HTTP: setting and changing it, the
// password gate on a closing-date change through PUT /company/settings, the
// override of a closed-period create / update / void / check with
// `closingPassword`, the audit rows it leaves, the rate limit, and that the
// password and its hash never come back out (responses, audit trail).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, contacts, transactions, journalLines, transactionTags,
} from '../db/schema/index.js';
import { companyRouter } from './company.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { checksRouter } from './checks.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';
import * as closingPasswordService from '../services/closing-password.service.js';

const PASSWORD = 'closing-pass-123';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let ownerId = '';
let ownerToken = '';
let bankId = '';
let revenueId = '';
let expenseId = '';

function call(method: string, path: string, body?: unknown, token = ownerToken): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = raw ? JSON.parse(raw) : null; } catch { json = raw; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedUser(role: string) {
  const [u] = await db.insert(users).values({
    tenantId, email: `${role}-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'x', role, displayName: role,
  }).returning();
  const token = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  return { id: u!.id, token };
}

const deposit = (txnDate: string, amount = '100.00', extra: Record<string, unknown> = {}) => ({
  txnType: 'deposit', txnDate, depositToAccountId: bankId,
  lines: [{ accountId: revenueId, amount }], ...extra,
});

async function setPassword() {
  const r = await call('PUT', '/api/v1/company/closing-password', { newPassword: PASSWORD });
  expect(r.status).toBe(200);
  expect(r.json).toEqual({ closingPasswordSet: true });
}

async function auditText(): Promise<string> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId));
  return JSON.stringify(rows);
}

async function overrideRows() {
  const rows = await db.select().from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'closing_date_override')));
  return rows.map((r) => ({
    ...r,
    after: typeof r.afterData === 'string' ? JSON.parse(r.afterData) : r.afterData as any,
  }));
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Closing PW', slug: 'closing-pw-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({
    tenantId, businessName: 'Closing Co', setupComplete: true, lockDate: '2026-06-30',
  }).returning();
  companyId = c!.id;
  const owner = await seedUser('owner');
  ownerId = owner.id;
  ownerToken = owner.token;
  bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  revenueId = (await accountsService.create(tenantId, { name: 'Sales', accountType: 'revenue', accountNumber: '4000' })).id;
  expenseId = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/company', companyRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/checks', checksRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(inArray(users.tenantId, [tenantId]));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('closing-date password: set, change, clear', () => {
  it('the owner sets it; the hash is bcrypt and never leaves the engine', async () => {
    expect((await call('GET', '/api/v1/company/closing-password')).json).toMatchObject({
      closingDate: '2026-06-30', closingPasswordSet: false,
    });
    await setPassword();

    const [row] = await db.select({ hash: companies.closingPasswordHash }).from(companies).where(eq(companies.id, companyId));
    expect(row!.hash).toMatch(/^\$2[aby]\$/);
    expect(row!.hash).not.toContain(PASSWORD);

    const status = await call('GET', '/api/v1/company/closing-password');
    expect(status.json).toMatchObject({ closingPasswordSet: true });
    for (const path of ['/api/v1/company', '/api/v1/company/settings', '/api/v1/company/closing-password']) {
      const r = await call('GET', path);
      expect(r.status).toBe(200);
      const text = JSON.stringify(r.json);
      expect(text).not.toContain('closingPasswordHash');
      expect(text).not.toContain(row!.hash!);
    }
    const audits = await auditText();
    expect(audits).not.toContain(PASSWORD);
    expect(audits).not.toContain(row!.hash!);
    expect(audits).toContain('closing_password');
  });

  it('changing or clearing needs the current password', async () => {
    await setPassword();
    const missing = await call('PUT', '/api/v1/company/closing-password', { newPassword: 'another-pass' });
    expect(missing.status).toBe(403);
    expect(missing.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    const wrong = await call('PUT', '/api/v1/company/closing-password', { currentPassword: 'nope-nope', newPassword: 'another-pass' });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');

    const changed = await call('PUT', '/api/v1/company/closing-password', { currentPassword: PASSWORD, newPassword: 'another-pass' });
    expect(changed.json).toEqual({ closingPasswordSet: true });
    const cleared = await call('PUT', '/api/v1/company/closing-password', { currentPassword: 'another-pass', newPassword: null });
    expect(cleared.json).toEqual({ closingPasswordSet: false });
    expect((await call('GET', '/api/v1/company/closing-password')).json.closingPasswordSet).toBe(false);
  });

  it('only an owner (or super admin) sets the first password; short ones are refused', async () => {
    const short = await call('PUT', '/api/v1/company/closing-password', { newPassword: 'abc' });
    expect(short.status).toBe(400);
    const accountant = await seedUser('accountant');
    const r = await call('PUT', '/api/v1/company/closing-password', { newPassword: PASSWORD }, accountant.token);
    expect(r.status).toBe(403);
    expect(['CLOSING_PASSWORD_OWNER_REQUIRED', 'PERMISSION_DENIED']).toContain(r.json.error.code);
    expect((await call('GET', '/api/v1/company/closing-password')).json.closingPasswordSet).toBe(false);
  });

  it('the service refuses a first password from a non-owner', async () => {
    await expect(closingPasswordService.setClosingPassword(tenantId, companyId, { newPassword: PASSWORD }, { userRole: 'accountant' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'CLOSING_PASSWORD_OWNER_REQUIRED' });
    await expect(closingPasswordService.setClosingPassword(tenantId, companyId, { newPassword: PASSWORD }, { userRole: 'accountant', isSuperAdmin: true }))
      .resolves.toEqual({ closingPasswordSet: true });
  });
});

describe('closing date change through PUT /company/settings', () => {
  it('without a password it works as before and stamps who and when', async () => {
    const r = await call('PUT', '/api/v1/company/settings', { lockDate: '2026-03-31' });
    expect(r.status).toBe(200);
    expect(r.json.settings.lockDate).toBe('2026-03-31');
    const [row] = await db.select().from(companies).where(eq(companies.id, companyId));
    expect(row!.lockDateSetBy).toBe(ownerId);
    expect(row!.lockDateSetAt).toBeInstanceOf(Date);
    // An unchanged lockDate (the web settings form resends it) needs nothing.
    expect((await call('PUT', '/api/v1/company/settings', { lockDate: '2026-03-31', currency: 'USD' })).status).toBe(200);
  });

  it('with a password set, a change needs it (required / invalid / ok)', async () => {
    await setPassword();
    const none = await call('PUT', '/api/v1/company/settings', { lockDate: '2026-09-30' });
    expect(none.status).toBe(403);
    expect(none.json.error.code).toBe('CLOSING_PASSWORD_REQUIRED');
    const wrong = await call('PUT', '/api/v1/company/settings', { lockDate: '2026-09-30', closingPassword: 'wrong-one' });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    // Other settings still save without the password.
    expect((await call('PUT', '/api/v1/company/settings', { currency: 'USD' })).status).toBe(200);

    const ok = await call('PUT', '/api/v1/company/settings', { lockDate: null, closingPassword: PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.json.settings.lockDate).toBeNull();
    expect(JSON.stringify(ok.json)).not.toContain(PASSWORD);
    expect(await auditText()).not.toContain(PASSWORD);
  });

  it('a closingPassword given while none is set becomes the password (set or confirm)', async () => {
    const r = await call('PUT', '/api/v1/company/settings', { lockDate: '2025-12-31', closingPassword: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.json.settings.lockDate).toBe('2025-12-31');
    expect((await call('GET', '/api/v1/company/closing-password')).json.closingPasswordSet).toBe(true);
    const wrong = await call('PUT', '/api/v1/company/settings', { lockDate: null, closingPassword: 'not-the-password' });
    expect(wrong.status).toBe(403);
    expect((await call('PUT', '/api/v1/company/settings', { lockDate: null, closingPassword: PASSWORD })).status).toBe(200);
  });
});

describe('posting into the closed period with closingPassword', () => {
  it('without a password set, staff confirmation still overrides (unchanged)', async () => {
    const plain = await call('POST', '/api/v1/transactions', deposit('2026-05-01'));
    expect(plain.status).toBe(423);
    expect(plain.json.error.details).toMatchObject({ canOverride: true, closingPasswordRequired: false });
    const confirmed = await call('POST', '/api/v1/transactions', deposit('2026-05-01', '100.00', { overrideConfirmed: true }));
    expect(confirmed.status).toBe(201);
  });

  it('create: 423 without, 403 wrong, 201 right; confirmation alone no longer enough; audited once', async () => {
    await setPassword();
    const plain = await call('POST', '/api/v1/transactions', deposit('2026-05-01'));
    expect(plain.status).toBe(423);
    expect(plain.json.error.code).toBe('TB_PERIOD_LOCKED');
    expect(plain.json.error.details).toMatchObject({ lockDate: '2026-06-30', canOverride: false, closingPasswordRequired: true });
    const confirmed = await call('POST', '/api/v1/transactions', deposit('2026-05-01', '100.00', { overrideConfirmed: true }));
    expect(confirmed.status).toBe(423);
    const wrong = await call('POST', '/api/v1/transactions', deposit('2026-05-01', '100.00', { closingPassword: 'wrong-pass' }));
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).toHaveLength(0);

    const ok = await call('POST', '/api/v1/transactions', deposit('2026-05-01', '100.00', { closingPassword: PASSWORD }));
    expect(ok.status).toBe(201);
    const txnId = ok.json.transaction.id as string;
    const rows = await overrideRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entityId).toBe(txnId);
    expect(rows[0]!.userId).toBe(ownerId);
    expect(rows[0]!.after).toMatchObject({ method: 'password', transactionId: txnId, oldDate: null, newDate: '2026-05-01' });

    // An open date needs nothing and leaves no override row.
    expect((await call('POST', '/api/v1/transactions', deposit('2026-07-01'))).status).toBe(201);
    expect(await overrideRows()).toHaveLength(1);
    expect(await auditText()).not.toContain(PASSWORD);
  });

  it('update moving a date into the closed period and void are audited with old/new date', async () => {
    const open = await call('POST', '/api/v1/transactions', deposit('2026-07-15'));
    expect(open.status).toBe(201);
    const txnId = open.json.transaction.id as string;
    await setPassword();

    const move = { ...deposit('2026-06-15', '120.00') };
    expect((await call('PUT', `/api/v1/transactions/${txnId}`, move)).status).toBe(423);
    const moved = await call('PUT', `/api/v1/transactions/${txnId}`, { ...move, closingPassword: PASSWORD });
    expect(moved.status).toBe(200);
    let rows = await overrideRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ transactionId: txnId, oldDate: '2026-07-15', newDate: '2026-06-15', method: 'password' });

    expect((await call('POST', `/api/v1/transactions/${txnId}/void`, { reason: 'dup' })).status).toBe(423);
    const voided = await call('POST', `/api/v1/transactions/${txnId}/void`, { reason: 'dup', closingPassword: PASSWORD });
    expect(voided.status).toBe(200);
    rows = await overrideRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.after)).toContainEqual(expect.objectContaining({ transactionId: txnId, oldDate: '2026-06-15', newDate: null }));
    expect(await auditText()).not.toContain(PASSWORD);
  });

  it('a check dated in the closed period takes the password too', async () => {
    await setPassword();
    const check = {
      bankAccountId: bankId, payeeNameOnCheck: 'Paper Co', txnDate: '2026-04-01', amount: '25.00',
      lines: [{ accountId: expenseId, amount: '25.00' }],
    };
    expect((await call('POST', '/api/v1/checks', check)).status).toBe(423);
    expect((await call('POST', '/api/v1/checks', { ...check, closingPassword: 'wrong-pass' })).status).toBe(403);
    const ok = await call('POST', '/api/v1/checks', { ...check, closingPassword: PASSWORD });
    expect(ok.status).toBe(201);
    expect((await overrideRows())[0]!.after).toMatchObject({ method: 'password', newDate: '2026-04-01' });
  });

  it('wrong passwords are rate limited per user (429 after 10 failures)', async () => {
    await setPassword();
    for (let i = 0; i < 10; i++) {
      const r = await call('POST', '/api/v1/transactions', deposit('2026-05-01', '1.00', { closingPassword: `wrong-${i}` }));
      expect(r.status).toBe(403);
    }
    const limited = await call('POST', '/api/v1/transactions', deposit('2026-05-01', '1.00', { closingPassword: PASSWORD }));
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('CLOSING_PASSWORD_RATE_LIMIT');
    // Requests without a password are not limited.
    expect((await call('POST', '/api/v1/transactions', deposit('2026-07-02'))).status).toBe(201);
  });
});

describe('owner reset of a forgotten closing-date password (Q-239)', () => {
  const SIGN_IN = 'owner-sign-in-pass';

  async function giveOwnerSignInPassword() {
    await db.update(users).set({ passwordHash: await bcrypt.hash(SIGN_IN, 4) }).where(eq(users.id, ownerId));
  }

  it('the owner replaces it with their sign-in password; the old one stops working', async () => {
    await giveOwnerSignInPassword();
    await setPassword();
    const r = await call('POST', '/api/v1/company/closing-password/reset', { accountPassword: SIGN_IN, newPassword: 'fresh-pass' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ closingPasswordSet: true });

    expect((await call('POST', '/api/v1/transactions', deposit('2026-05-01', '5.00', { closingPassword: PASSWORD }))).status).toBe(403);
    expect((await call('POST', '/api/v1/transactions', deposit('2026-05-01', '5.00', { closingPassword: 'fresh-pass' }))).status).toBe(201);

    const rows = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'closing_password_reset')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(ownerId);
    const after = typeof rows[0]!.afterData === 'string' ? JSON.parse(rows[0]!.afterData) : rows[0]!.afterData;
    expect(after).toMatchObject({ closingDateProtected: true, method: 'account_password' });
    const [company] = await db.select({ hash: companies.closingPasswordHash }).from(companies).where(eq(companies.id, companyId));
    const audits = await auditText();
    for (const secret of [SIGN_IN, 'fresh-pass', PASSWORD, company!.hash!]) expect(audits).not.toContain(secret);
  });

  it('newPassword null clears it', async () => {
    await giveOwnerSignInPassword();
    await setPassword();
    const r = await call('POST', '/api/v1/company/closing-password/reset', { accountPassword: SIGN_IN, newPassword: null });
    expect(r.json).toEqual({ closingPasswordSet: false });
    expect((await call('GET', '/api/v1/company/closing-password')).json.closingPasswordSet).toBe(false);
  });

  it('a wrong sign-in password is 403 ACCOUNT_PASSWORD_INVALID and changes nothing', async () => {
    await giveOwnerSignInPassword();
    await setPassword();
    const r = await call('POST', '/api/v1/company/closing-password/reset', { accountPassword: 'not-my-password', newPassword: null });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('ACCOUNT_PASSWORD_INVALID');
    expect((await call('GET', '/api/v1/company/closing-password')).json.closingPasswordSet).toBe(true);
    const failed = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'closing_password_reset_failed')));
    expect(failed).toHaveLength(1);
    expect(await auditText()).not.toContain('not-my-password');
    // A short new password is refused before anything is checked.
    const short = await call('POST', '/api/v1/company/closing-password/reset', { accountPassword: SIGN_IN, newPassword: 'abc' });
    expect(short.status).toBe(400);
  });

  it('only the owner or a super admin may reset', async () => {
    await setPassword();
    const accountant = await seedUser('accountant');
    await db.update(users).set({ passwordHash: await bcrypt.hash('acct-pass', 4) }).where(eq(users.id, accountant.id));
    const r = await call('POST', '/api/v1/company/closing-password/reset', { accountPassword: 'acct-pass', newPassword: null }, accountant.token);
    expect(r.status).toBe(403);
    expect(['CLOSING_PASSWORD_OWNER_REQUIRED', 'PERMISSION_DENIED']).toContain(r.json.error.code);
    expect((await call('GET', '/api/v1/company/closing-password')).json.closingPasswordSet).toBe(true);

    await expect(closingPasswordService.resetClosingPassword(tenantId, companyId, { accountPassword: 'acct-pass', newPassword: null }, { userId: accountant.id, userRole: 'accountant' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'CLOSING_PASSWORD_OWNER_REQUIRED' });
    await expect(closingPasswordService.resetClosingPassword(tenantId, companyId, { accountPassword: 'acct-pass', newPassword: null }, { userId: accountant.id, userRole: 'accountant', isSuperAdmin: true }))
      .resolves.toEqual({ closingPasswordSet: false });
  });

  it('wrong sign-in passwords are rate limited with the other closing password routes', async () => {
    await giveOwnerSignInPassword();
    for (let i = 0; i < 10; i++) {
      const r = await call('POST', '/api/v1/company/closing-password/reset', { accountPassword: `wrong-${i}`, newPassword: null });
      expect(r.status).toBe(403);
    }
    const limited = await call('POST', '/api/v1/company/closing-password/reset', { accountPassword: SIGN_IN, newPassword: null });
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('CLOSING_PASSWORD_RATE_LIMIT');
  });
});
