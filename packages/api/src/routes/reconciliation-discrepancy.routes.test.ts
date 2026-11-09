// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// GET /reports/reconciliation-discrepancy (U-191, reconcile-discrepancy-v1):
// a recategorized reconciled entry gives a `changed` row with effect 0 and
// field names only; a backdated entry gives `added_after`; an undo gives a
// `reconciliation_undone` row; no memo text anywhere in the response.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import jwt from 'jsonwebtoken';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, transactions, journalLines, reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import * as reconciliation from '../services/reconciliation.service.js';
import { bankingRouter } from './banking.routes.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const SECRET_MEMO = 'Top secret memo text 7f3a';

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let bankId = '';
let expenseId = '';
let otherExpenseId = '';
let revenueId = '';
let token = '';
let userId = '';

function get(path: string): Promise<{ status: number; json: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1${path}`, method: path.includes('/undo') ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null, raw });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [t] = await db.insert(tenants).values({ name: 'Recon discrepancy', slug: `recon-disc-${stamp}` }).returning();
  tenantId = t!.id;
  const [co] = await db.insert(companies).values({ tenantId, businessName: 'Disc Co', setupComplete: true }).returning();
  companyId = co!.id;
  const mk = async (name: string, accountType: string, accountNumber: string) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber }).returning();
    return a!.id;
  };
  bankId = await mk('Checking', 'asset', '1010');
  expenseId = await mk('Supplies', 'expense', '6000');
  otherExpenseId = await mk('Office', 'expense', '6010');
  revenueId = await mk('Sales', 'revenue', '4000');
  const [u] = await db.insert(users).values({
    tenantId, email: `owner-${stamp}@example.com`, passwordHash: 'x', role: 'owner', displayName: 'Owner Person',
  }).returning();
  userId = u!.id;
  token = jwt.sign({ userId, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  const app = express();
  app.use(express.json());
  app.use('/api/v1/banking', bankingRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((r) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; r(); }); });
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  await db.delete(reconciliationLines).where(inArray(
    reconciliationLines.reconciliationId,
    db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId)),
  ));
  await db.execute(sql`DELETE FROM reconciliation_signoffs WHERE tenant_id = ${tenantId}`);
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

const expense = (amount: string, category: string, date = '2026-01-10') => ({
  txnType: 'expense' as const, txnDate: date, memo: SECRET_MEMO, total: amount,
  lines: [
    { accountId: category, debit: amount, credit: '0', description: SECRET_MEMO },
    { accountId: bankId, debit: '0', credit: amount },
  ],
});

/** January: deposit 100, expense 30 (secret memo); both cleared, statement 70. */
async function finishJanuary() {
  const dep = await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: '2026-01-05', memo: 'Deposit',
    lines: [{ accountId: bankId, debit: '100.0000', credit: '0' }, { accountId: revenueId, debit: '0', credit: '100.0000' }],
  }, userId, companyId);
  const exp = await ledger.postTransaction(tenantId, expense('30.0000', expenseId), userId, companyId);
  const recon = await reconciliation.start(tenantId, bankId, '2026-01-31', '70.00');
  const view = await reconciliation.getReconciliation(tenantId, recon.id);
  await reconciliation.updateLines(tenantId, recon.id, view.lines.map((l: any) => ({ journalLineId: l.journal_line_id, isCleared: true })));
  await reconciliation.complete(tenantId, recon.id, userId);
  return { reconId: recon.id, depId: dep.id, expId: exp.id };
}

describe('reconciliation discrepancy report (U-191)', () => {
  it('advertises the capabilities', () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(['reconcile-discrepancy-v1', 'line-identity-v1']));
  });

  it('is empty, with no drift, right after a finish', async () => {
    await finishJanuary();
    const res = await get(`/reports/reconciliation-discrepancy?account_id=${bankId}`);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ accountId: bankId, rows: [], drift: null });
  });

  it('recategorizing a reconciled entry gives a changed row with effect 0 and field names only', async () => {
    const { reconId, expId } = await finishJanuary();
    await ledger.updateTransaction(tenantId, expId, expense('30.0000', otherExpenseId), userId, companyId);
    const res = await get(`/reports/reconciliation-discrepancy?account_id=${bankId}`);
    expect(res.status).toBe(200);
    expect(res.json.rows).toHaveLength(1);
    expect(res.json.rows[0]).toMatchObject({
      kind: 'changed', reconciliationId: reconId, statementDate: '2026-01-31', transactionId: expId,
      txnDate: '2026-01-10', txnType: 'expense', reconciledAmount: '-30.0000', effect: '0.0000',
      changedBy: 'Owner Person', fields: ['category'],
    });
    expect(res.raw).not.toContain(SECRET_MEMO);
  });

  it('a backdated entry gives an added_after row', async () => {
    const { reconId } = await finishJanuary();
    const late = await ledger.postTransaction(tenantId, expense('12.5000', expenseId, '2026-01-20'), userId, companyId);
    const res = await get(`/reports/reconciliation-discrepancy?account_id=${bankId}`);
    expect(res.json.rows).toEqual([expect.objectContaining({
      kind: 'added_after', reconciliationId: reconId, transactionId: late.id, txnDate: '2026-01-20',
      reconciledAmount: null, effect: '-12.5000', fields: [],
    })]);
    expect(res.raw).not.toContain(SECRET_MEMO);
  });

  it('an undo gives a reconciliation_undone row with its mode', async () => {
    const { reconId } = await finishJanuary();
    const undo = await get(`/banking/reconciliations/${reconId}/undo`);
    expect(undo.status).toBe(200);
    const res = await get(`/reports/reconciliation-discrepancy?account_id=${bankId}`);
    expect(res.json.rows).toEqual([expect.objectContaining({
      kind: 'reconciliation_undone', reconciliationId: reconId, statementDate: '2026-01-31', transactionId: null,
      reconciledAmount: '70.0000', effect: '-70.0000', undoMode: 'clear_checks', changedBy: 'Owner Person',
    })]);
  });

  it('reports the latest drift and refuses an unknown account', async () => {
    const { expId } = await finishJanuary();
    const [line] = await db.select({ id: journalLines.id }).from(journalLines)
      .where(and(eq(journalLines.transactionId, expId), eq(journalLines.accountId, bankId)));
    await db.execute(sql`UPDATE reconciliation_lines SET journal_line_id = gen_random_uuid() WHERE journal_line_id = ${line!.id}`);
    const res = await get(`/reports/reconciliation-discrepancy?account_id=${bankId}`);
    expect(res.json.drift).toMatchObject({ expected: '70.0000', actual: '100.0000', difference: '30.0000' });
    expect((await get(`/reports/reconciliation-discrepancy?account_id=${crypto.randomUUID()}`)).status).toBe(404);
    expect((await get('/reports/reconciliation-discrepancy')).status).toBe(400);
  });
});
