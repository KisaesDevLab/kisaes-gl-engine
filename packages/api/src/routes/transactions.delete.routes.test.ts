// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Soft delete over HTTP (P12 R7, capability txn-delete-v1):
// DELETE /transactions/:id reverses a posted transaction exactly, hides it
// from registers, lists and reports, audits the full before-image with every
// line, and goes through the same guards as void: the closing date (and its
// password) and completed reconciliations.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, contacts, transactions, journalLines, transactionTags,
  reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import { transactionsRouter } from './transactions.routes.js';
import { companyRouter } from './company.routes.js';
import { checksRouter } from './checks.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as accountsService from '../services/accounts.service.js';
import * as registerService from '../services/register.service.js';
import * as reportService from '../services/report.service.js';

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

async function balanceOf(accountId: string): Promise<string> {
  const [row] = await db.select({ balance: accounts.balance }).from(accounts).where(eq(accounts.id, accountId));
  return String(row!.balance);
}

async function createDeposit(txnDate: string, amount: string, extra: Record<string, unknown> = {}): Promise<string> {
  const r = await call('POST', '/api/v1/transactions', {
    txnType: 'deposit', txnDate, depositToAccountId: bankId,
    lines: [{ accountId: revenueId, amount }], ...extra,
  });
  expect(r.status).toBe(201);
  return r.json.transaction.id as string;
}

async function deleteAudits(txnId: string) {
  const rows = await db.select().from(auditLog)
    .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'transaction'), eq(auditLog.action, 'delete'), eq(auditLog.entityId, txnId)));
  return rows.map((r) => ({
    ...r,
    before: typeof r.beforeData === 'string' ? JSON.parse(r.beforeData) : r.beforeData as any,
    after: typeof r.afterData === 'string' ? JSON.parse(r.afterData) : r.afterData as any,
  }));
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'Txn Delete', slug: 'txn-delete-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Delete Co', setupComplete: true }).returning();
  companyId = c!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `owner-${Date.now()}-${Math.random()}@example.com`, passwordHash: 'x', role: 'owner', displayName: 'Owner',
  }).returning();
  ownerId = u!.id;
  ownerToken = jwt.sign({ userId: ownerId, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  bankId = (await accountsService.create(tenantId, { name: 'Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1010' })).id;
  revenueId = (await accountsService.create(tenantId, { name: 'Sales', accountType: 'revenue', accountNumber: '4000' })).id;
  expenseId = (await accountsService.create(tenantId, { name: 'Supplies', accountType: 'expense', accountNumber: '6000' })).id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/company', companyRouter);
  app.use('/api/v1/checks', checksRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  const recs = await db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  for (const r of recs) await db.delete(reconciliationLines).where(eq(reconciliationLines.reconciliationId, r.id));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
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

describe('DELETE /transactions/:id — balances and visibility', () => {
  it('moves every balance back exactly and keeps the lines with reversing lines', async () => {
    const keep = await createDeposit('2026-03-01', '1000.00');
    const bankBefore = await balanceOf(bankId);
    const revenueBefore = await balanceOf(revenueId);
    const summaryBefore = await registerService.getRegisterSummary(tenantId, bankId, { exact: true });

    const txnId = await createDeposit('2026-03-02', '123.4567');
    expect(await balanceOf(bankId)).not.toBe(bankBefore);

    const r = await call('DELETE', `/api/v1/transactions/${txnId}`, { reason: 'entered twice' });
    expect(r.status).toBe(200);
    expect(r.json.transaction).toMatchObject({ id: txnId, status: 'deleted' });

    expect(await balanceOf(bankId)).toBe(bankBefore);
    expect(await balanceOf(revenueId)).toBe(revenueBefore);
    const summaryAfter = await registerService.getRegisterSummary(tenantId, bankId, { exact: true });
    expect(summaryAfter.currentBalance).toBe(summaryBefore.currentBalance);
    expect(summaryAfter.endingBalance).toBe(summaryBefore.endingBalance);
    expect(summaryAfter.endingBalance).toBe('1000.0000');

    // Nothing physically removed: the original 2 lines plus 2 reversing lines.
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txnId));
    expect(lines).toHaveLength(4);
    expect(lines.filter((l) => l.isVoidReversal)).toHaveLength(2);
    expect(keep).toBeTruthy();
  });

  it('a deleted transaction leaves the register, the list and the reports', async () => {
    const keepId = await createDeposit('2026-03-01', '1000.00');
    const txnId = await createDeposit('2026-03-05', '250.00');
    const plBefore = await reportService.buildProfitAndLoss(tenantId, '2026-01-01', '2026-12-31', 'accrual', companyId);
    expect((await call('DELETE', `/api/v1/transactions/${txnId}`)).status).toBe(200);

    const reg = await registerService.getRegister(tenantId, bankId, {
      startDate: '2026-01-01', endDate: '2026-12-31', exact: true, includeVoid: true,
    });
    expect(reg.lines.map((l) => l.transactionId)).toEqual([keepId]);
    expect(reg.endingBalance).toBe('1000.0000');
    expect(reg.lines[0]!.runningBalance).toBe('1000.0000');

    const list = await call('GET', '/api/v1/transactions?limit=100');
    expect(list.json.data.map((t: any) => t.id)).toEqual([keepId]);
    expect(list.json.total).toBe(1);
    const withDeleted = await call('GET', '/api/v1/transactions?limit=100&includeDeleted=true');
    expect(withDeleted.json.data.map((t: any) => t.id).sort()).toEqual([keepId, txnId].sort());
    const onlyDeleted = await call('GET', '/api/v1/transactions?status=deleted');
    expect(onlyDeleted.json.data.map((t: any) => t.id)).toEqual([txnId]);

    const pl = await reportService.buildProfitAndLoss(tenantId, '2026-01-01', '2026-12-31', 'accrual', companyId);
    expect(JSON.stringify(pl)).not.toBe(JSON.stringify(plBefore));
    expect(JSON.stringify(pl)).toContain('1000');
    expect(JSON.stringify(pl)).not.toContain('1250');
    const gl = await reportService.buildGeneralLedger(tenantId, '2026-01-01', '2026-12-31', companyId);
    expect(JSON.stringify(gl)).toContain(keepId);
    expect(JSON.stringify(gl)).not.toContain(txnId);

    // The transaction itself can still be read (status deleted), but not
    // edited, voided or deleted again.
    const detail = await call('GET', `/api/v1/transactions/${txnId}`);
    expect(detail.json.transaction.status).toBe('deleted');
    expect((await call('POST', `/api/v1/transactions/${txnId}/void`, { reason: 'x' })).status).toBe(404);
    const edit = await call('PUT', `/api/v1/transactions/${txnId}`, {
      txnType: 'deposit', txnDate: '2026-03-05', depositToAccountId: bankId, lines: [{ accountId: revenueId, amount: '1.00' }],
    });
    expect(edit.status).toBe(404);
    const again = await call('DELETE', `/api/v1/transactions/${txnId}`);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe('TXN_ALREADY_DELETED');
  });

  it('a deleted check leaves the checks list and frees its number', async () => {
    const check = {
      bankAccountId: bankId, payeeNameOnCheck: 'Paper Co', txnDate: '2026-04-01', amount: '25.00',
      checkNumber: 1001, lines: [{ accountId: expenseId, amount: '25.00' }],
    };
    const made = await call('POST', '/api/v1/checks', check);
    expect(made.status).toBe(201);
    const checkId = made.json.check?.id ?? made.json.transaction?.id ?? made.json.id;
    expect(checkId).toBeTruthy();
    expect((await call('DELETE', `/api/v1/transactions/${checkId}`)).status).toBe(200);
    const list = await call('GET', '/api/v1/checks');
    expect(JSON.stringify(list.json)).not.toContain(checkId);
    expect((await call('POST', '/api/v1/checks', check)).status).toBe(201);
  });

  it('a void transaction can be deleted without moving any balance again', async () => {
    const txnId = await createDeposit('2026-03-02', '80.00');
    expect((await call('POST', `/api/v1/transactions/${txnId}/void`, { reason: 'dup' })).status).toBe(200);
    const bank = await balanceOf(bankId);
    expect((await call('DELETE', `/api/v1/transactions/${txnId}`)).status).toBe(200);
    expect(await balanceOf(bankId)).toBe(bank);
    // Void wrote 2 reversing lines; delete adds none.
    expect(await db.select().from(journalLines).where(eq(journalLines.transactionId, txnId))).toHaveLength(4);
  });
});

describe('DELETE /transactions/:id — audit', () => {
  it('audits action delete with the header and every original line', async () => {
    const txnId = await createDeposit('2026-03-02', '99.99', { memo: 'to delete' });
    expect((await call('DELETE', `/api/v1/transactions/${txnId}`, { reason: 'mistake' })).status).toBe(200);
    const rows = await deleteAudits(txnId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.userId).toBe(ownerId);
    expect(row.before).toMatchObject({ id: txnId, status: 'posted', txnType: 'deposit', memo: 'to delete' });
    expect(row.before.lines).toHaveLength(2);
    const byAccount = Object.fromEntries(row.before.lines.map((l: any) => [l.accountId, l]));
    expect(Number(byAccount[bankId].debit)).toBe(99.99);
    expect(Number(byAccount[revenueId].credit)).toBe(99.99);
    expect(row.after).toMatchObject({ status: 'deleted', reason: 'mistake' });
  });
});

describe('DELETE /transactions/:id — guards', () => {
  it('closed period: 423 without, 403 wrong, 200 with the closing-date password', async () => {
    const txnId = await createDeposit('2026-05-01', '40.00');
    await db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, companyId));
    const plain = await call('DELETE', `/api/v1/transactions/${txnId}`);
    expect(plain.status).toBe(423);
    expect(plain.json.error.code).toBe('TB_PERIOD_LOCKED');

    expect((await call('PUT', '/api/v1/company/closing-password', { newPassword: PASSWORD })).status).toBe(200);
    const none = await call('DELETE', `/api/v1/transactions/${txnId}`);
    expect(none.status).toBe(423);
    expect(none.json.error.details).toMatchObject({ lockDate: '2026-06-30', closingPasswordRequired: true });
    const confirmed = await call('DELETE', `/api/v1/transactions/${txnId}`, { overrideConfirmed: true });
    expect(confirmed.status).toBe(423);
    const wrong = await call('DELETE', `/api/v1/transactions/${txnId}`, { closingPassword: 'wrong-pass' });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    const [still] = await db.select().from(transactions).where(eq(transactions.id, txnId));
    expect(still!.status).toBe('posted');

    const ok = await call('DELETE', `/api/v1/transactions/${txnId}`, { closingPassword: PASSWORD, reason: 'cleanup' });
    expect(ok.status).toBe(200);
    const overrides = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'closing_date_override')));
    expect(overrides).toHaveLength(1);
    const after = typeof overrides[0]!.afterData === 'string' ? JSON.parse(overrides[0]!.afterData) : overrides[0]!.afterData as any;
    expect(after).toMatchObject({ method: 'password', transactionId: txnId, oldDate: '2026-05-01', newDate: null });
    expect(JSON.stringify(await db.select().from(auditLog).where(eq(auditLog.tenantId, tenantId)))).not.toContain(PASSWORD);
  });

  it('refuses a transaction cleared in a completed reconciliation (409 RECONCILED_TRANSACTION)', async () => {
    const txnId = await createDeposit('2026-03-02', '60.00');
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txnId));
    const bankLine = lines.find((l) => l.accountId === bankId)!;
    const [rec] = await db.insert(reconciliations).values({
      tenantId, companyId, accountId: bankId,
      statementDate: '2026-03-31', statementEndingBalance: '60.00', beginningBalance: '0.00', status: 'complete',
    }).returning();
    await db.insert(reconciliationLines).values({ reconciliationId: rec!.id, journalLineId: bankLine.id, isCleared: true });
    const bank = await balanceOf(bankId);

    const r = await call('DELETE', `/api/v1/transactions/${txnId}`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('RECONCILED_TRANSACTION');
    const [row] = await db.select().from(transactions).where(eq(transactions.id, txnId));
    expect(row!.status).toBe('posted');
    expect(await balanceOf(bankId)).toBe(bank);
    expect(await deleteAudits(txnId)).toHaveLength(0);
  });

  it('refuses document types with their own void path, and unknown ids', async () => {
    const [inv] = await db.insert(transactions).values({
      tenantId, companyId, txnType: 'invoice', txnDate: '2026-03-02', status: 'posted', total: '10.00',
    }).returning();
    const r = await call('DELETE', `/api/v1/transactions/${inv!.id}`);
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('TXN_DELETE_UNSUPPORTED');
    expect((await call('DELETE', '/api/v1/transactions/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await call('DELETE', '/api/v1/transactions/not-a-uuid')).status).toBe(400);
  });

  it('needs write permission on transactions (readonly user: 403)', async () => {
    const txnId = await createDeposit('2026-03-02', '15.00');
    const [ro] = await db.insert(users).values({
      tenantId, email: `ro-${Date.now()}@example.com`, passwordHash: 'x', role: 'readonly', displayName: 'RO',
    }).returning();
    const roToken = jwt.sign({ userId: ro!.id, tenantId, role: 'readonly', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
    const r = await call('DELETE', `/api/v1/transactions/${txnId}`, undefined, roToken);
    expect(r.status).toBe(403);
    const [row] = await db.select().from(transactions).where(eq(transactions.id, txnId));
    expect(row!.status).toBe('posted');
  });
});
