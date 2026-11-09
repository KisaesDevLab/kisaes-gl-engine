// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Reconciliation v2 (ClientLedger P27, E1) through the HTTP routes:
//   exact      U-188 reconcile-exact-v1: string totals, strict finish, 409
//              status conflicts, batch ticks + view=summary, one in progress
//              per account (migration 0272), audit rows.
//   begin      U-189 reconcile-begin-v1: service charge / interest at Begin
//              (counted at once, posted once by Finish, closing date), card
//              orientation on PATCH, later lines, bank-file pre-check, drift.
//   undo       U-190 reconcile-undo-v2: owner only, latest only, in-progress
//              conflict, keep_checks / discard restore exact states, closed
//              period, charges kept.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, auditLog, transactions, journalLines, reconciliations, reconciliationLines,
  bankConnections, bankFeedItems, bankStatements,
} from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import { bankingRouter } from './banking.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

const PASSWORD = 'close-the-books-2026';

let server: Server | null = null;
let port = 0;

interface Ctx {
  tenantId: string;
  companyId: string;
  checkingId: string;
  cardId: string;
  revenueId: string;
  expenseId: string;
  feeId: string;
  interestIncomeId: string;
  ownerToken: string;
  accountantToken: string;
}
let ctx: Ctx;

function request(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolvePromise, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1${path}`, method,
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
        resolvePromise({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedUser(tenantId: string, role: string) {
  const [u] = await db.insert(users).values({
    tenantId,
    email: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
    passwordHash: 'not-a-real-hash',
    role,
    displayName: role,
  }).returning();
  const token = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  return token;
}

async function wipeTenant(tenantId: string) {
  await db.delete(reconciliationLines).where(inArray(
    reconciliationLines.reconciliationId,
    db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId)),
  ));
  await db.execute(sql`DELETE FROM reconciliation_signoffs WHERE tenant_id = ${tenantId}`);
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankStatements).where(eq(bankStatements.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
}

beforeEach(async () => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [t] = await db.insert(tenants).values({ name: 'Recon v2', slug: `recon-v2-${stamp}` }).returning();
  const [co] = await db.insert(companies).values({ tenantId: t!.id, businessName: 'Recon v2 Co', setupComplete: true }).returning();
  const mk = async (name: string, accountType: string, detailType: string | null, accountNumber: string) => {
    const [a] = await db.insert(accounts).values({ tenantId: t!.id, companyId: co!.id, name, accountType, detailType, accountNumber }).returning();
    return a!.id;
  };
  ctx = {
    tenantId: t!.id,
    companyId: co!.id,
    checkingId: await mk('Operating Checking', 'asset', 'bank', '1010'),
    cardId: await mk('Business Card', 'liability', 'credit_card', '2100'),
    revenueId: await mk('Sales', 'revenue', null, '4000'),
    expenseId: await mk('Supplies', 'expense', null, '6000'),
    feeId: await mk('Bank Fees', 'expense', null, '6100'),
    interestIncomeId: await mk('Interest Income', 'revenue', null, '4100'),
    ownerToken: await seedUser(t!.id, 'owner'),
    accountantToken: await seedUser(t!.id, 'accountant'),
  };
  const app = express();
  app.use(express.json({ limit: '10mb' })); // as app.ts
  app.use('/api/v1/banking', bankingRouter);
  app.use(errorHandler);
  await new Promise<void>((r) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; r(); }); });
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  await wipeTenant(ctx.tenantId);
});

// ─── Helpers ─────────────────────────────────────────────────────

async function post(date: string, lines: Array<{ accountId: string; debit?: string; credit?: string }>, memo = 'entry') {
  const txn = await ledger.postTransaction(ctx.tenantId, {
    txnType: 'journal_entry', txnDate: date, memo,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit ?? '0', credit: l.credit ?? '0' })),
  }, undefined, ctx.companyId);
  return txn.id;
}
const deposit = (date: string, amt: string, account = ctx.checkingId) =>
  post(date, [{ accountId: account, debit: amt }, { accountId: ctx.revenueId, credit: amt }], `Deposit ${amt}`);
const check = (date: string, amt: string, account = ctx.checkingId) =>
  post(date, [{ accountId: ctx.expenseId, debit: amt }, { accountId: account, credit: amt }], `Check ${amt}`);

async function lineOf(txnId: string, accountId = ctx.checkingId): Promise<string> {
  const [l] = await db.select({ id: journalLines.id }).from(journalLines)
    .where(and(eq(journalLines.transactionId, txnId), eq(journalLines.accountId, accountId)));
  return l!.id;
}

async function begin(body: Record<string, unknown>, token = ctx.ownerToken) {
  return request('POST', '/banking/reconciliations', token, { accountId: ctx.checkingId, statementDate: '2026-01-31', ...body });
}

async function tick(id: string, lines: Array<[string, boolean]>, view?: string) {
  return request('PUT', `/banking/reconciliations/${id}/lines${view ? `?view=${view}` : ''}`, ctx.ownerToken, {
    lines: lines.map(([journalLineId, isCleared]) => ({ journalLineId, isCleared })),
  });
}

const getRecon = (id: string, view?: string) =>
  request('GET', `/banking/reconciliations/${id}${view ? `?view=${view}` : ''}`, ctx.ownerToken);

async function clearedSet(reconId: string): Promise<string[]> {
  const rows = await db.select({ jl: reconciliationLines.journalLineId }).from(reconciliationLines)
    .where(and(eq(reconciliationLines.reconciliationId, reconId), eq(reconciliationLines.isCleared, true)));
  return rows.map((r) => r.jl).sort();
}

/** Every journal line of the account that is cleared in a completed reconciliation (the register's R state). */
async function reconciledLines(accountId = ctx.checkingId): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT rl.journal_line_id FROM reconciliation_lines rl
    JOIN reconciliations r ON r.id = rl.reconciliation_id
    WHERE r.tenant_id = ${ctx.tenantId} AND r.account_id = ${accountId} AND r.status = 'complete' AND rl.is_cleared
    ORDER BY 1
  `);
  return (res.rows as Array<{ journal_line_id: string }>).map((r) => r.journal_line_id);
}

async function auditRows(entityId: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.tenantId, ctx.tenantId), eq(auditLog.entityId, entityId)));
}

async function closeBooks(lockDate: string) {
  await db.update(companies).set({ lockDate, closingPasswordHash: await bcrypt.hash(PASSWORD, 4) })
    .where(eq(companies.id, ctx.companyId));
}

// ─── U-188 reconcile-exact-v1 ───────────────────────────────────

describe('reconciliation exact (U-188)', () => {
  it('advertises the capabilities', () => {
    expect(DESKTOP_CAPABILITIES).toEqual(expect.arrayContaining(['reconcile-exact-v1', 'reconcile-begin-v1', 'reconcile-undo-v2']));
  });

  it('returns string totals, pane totals and per-line amounts', async () => {
    const d = await deposit('2026-01-05', '1000.00');
    const c = await check('2026-01-10', '200.10');
    const r = await begin({ statementEndingBalance: '799.90' });
    expect(r.status).toBe(201);
    const id = r.json.reconciliation.id;
    expect(r.json.reconciliation.lines).toBeUndefined();
    expect(r.json.reconciliation.differenceExact).toBe('799.9000');

    const t = await tick(id, [[await lineOf(d), true]]);
    expect(t.status).toBe(200);
    const rec = t.json.reconciliation;
    expect(rec.clearedBalanceExact).toBe('1000.0000');
    expect(rec.differenceExact).toBe('-200.1000');
    expect(rec.clearedDeposits).toEqual({ count: 1, total: '1000.0000' });
    expect(rec.clearedPayments).toEqual({ count: 0, total: '0.0000' });
    expect(rec.pending).toEqual({ serviceCharge: null, interest: null });
    expect(rec.beginningBalanceDrift).toBeNull();
    expect(rec.postingLocked).toBe(false);
    // Legacy numbers stay for older clients.
    expect(rec.clearedBalance).toBe(1000);
    expect(rec.difference).toBe(-200.1);
    const checkLine = rec.lines.find((l: any) => l.transaction_id === c);
    expect(checkLine.amount).toBe('-200.1000');
    expect(checkLine.afterStatementDate).toBe(false);
    expect(checkLine.fromBankFeed).toBe(false);
    expect(checkLine.source ?? null).toBeNull();
  });

  it('refuses to finish at 0.0100 and at -0.0001, finishes at exactly 0 and stores the real difference', async () => {
    const d = await deposit('2026-01-05', '1000.00');
    const r = await begin({ statementEndingBalance: '1000.01' });
    const id = r.json.reconciliation.id;
    await tick(id, [[await lineOf(d), true]]);
    let f = await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {});
    expect(f.status).toBe(400);
    expect(f.json.error.code).toBe('RECONCILE_DIFFERENCE_NOT_ZERO');
    expect(f.json.error.details).toEqual({ difference: '0.0100' });

    await request('PATCH', `/banking/reconciliations/${id}`, ctx.ownerToken, { statementEndingBalance: '999.9999' });
    f = await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {});
    expect(f.status).toBe(400);
    expect(f.json.error.details).toEqual({ difference: '-0.0001' });

    await request('PATCH', `/banking/reconciliations/${id}`, ctx.ownerToken, { statementEndingBalance: '1000.00' });
    f = await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {});
    expect(f.status).toBe(200);
    expect(f.json.reconciliation.status).toBe('complete');
    const [row] = await db.select().from(reconciliations).where(eq(reconciliations.id, id));
    expect(row!.difference).toBe('0.0000');
    expect(row!.clearedBalance).toBe('1000.0000');

    const audit = (await auditRows(id)).find((a) => (a.afterData as any)?.status === 'complete' || String(a.afterData).includes('"complete"'));
    expect(audit).toBeTruthy();
    const after = typeof audit!.afterData === 'string' ? JSON.parse(audit!.afterData) : audit!.afterData;
    expect(after.clearedLineIds).toEqual([await lineOf(d)]);
  });

  it('answers 409 RECONCILIATION_NOT_IN_PROGRESS on a completed reconciliation', async () => {
    const r = await begin({ statementEndingBalance: '0' });
    const id = r.json.reconciliation.id;
    expect((await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {})).status).toBe(200);
    for (const [method, path, body] of [
      ['PUT', `/banking/reconciliations/${id}/lines`, { lines: [] }],
      ['PATCH', `/banking/reconciliations/${id}`, { statementEndingBalance: '1.00' }],
      ['POST', `/banking/reconciliations/${id}/refresh`, {}],
      ['POST', `/banking/reconciliations/${id}/complete`, {}],
      ['POST', `/banking/reconciliations/${id}/cancel`, {}],
    ] as const) {
      const res = await request(method, path, ctx.ownerToken, body);
      expect(res.status, `${method} ${path}`).toBe(409);
      expect(res.json.error.code).toBe('RECONCILIATION_NOT_IN_PROGRESS');
      expect(res.json.error.details).toEqual({ status: 'complete' });
    }
  });

  it('ticks 10,000 lines in one batch and answers view=summary without lines', async () => {
    const txn = await deposit('2026-01-05', '1.00');
    const r = await begin({ statementEndingBalance: '1.00' });
    const id = r.json.reconciliation.id;
    const real = await lineOf(txn);
    // 9,999 ids that are not on the worksheet (ignored) plus the real one.
    const ids: Array<[string, boolean]> = Array.from({ length: 9999 }, () => [crypto.randomUUID(), true]);
    ids.push([real, true]);
    const t = await tick(id, ids, 'summary');
    expect(t.status).toBe(200);
    expect(t.json.reconciliation.lines).toBeUndefined();
    expect(t.json.reconciliation.differenceExact).toBe('0.0000');
    expect(t.json.reconciliation.clearedDeposits).toEqual({ count: 1, total: '1.0000' });
    const tooMany = await tick(id, [...ids, [crypto.randomUUID(), true]]);
    expect(tooMany.status).toBe(400);
    const g = await getRecon(id, 'summary');
    expect(g.json.reconciliation.lines).toBeUndefined();
    expect((await getRecon(id)).json.reconciliation.lines).toHaveLength(1);
  });

  it('lets one of two parallel starts win; the other gets 409 RECONCILIATION_IN_PROGRESS', async () => {
    await deposit('2026-01-05', '10.00');
    const [a, b] = await Promise.all([
      begin({ statementEndingBalance: '10.00' }),
      begin({ statementEndingBalance: '10.00' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    const winner = a.status === 201 ? a : b;
    expect(loser.json.error.code).toBe('RECONCILIATION_IN_PROGRESS');
    expect(loser.json.error.details.reconciliationId).toBe(winner.json.reconciliation.id);
    const rows = await db.select().from(reconciliations).where(eq(reconciliations.tenantId, ctx.tenantId));
    expect(rows).toHaveLength(1);
  });

  it('migration 0272 keeps the newest duplicate in-progress row and tears the others down', async () => {
    const d = await deposit('2026-01-05', '10.00');
    const jl = await lineOf(d);
    await db.execute(sql`DROP INDEX IF EXISTS uq_reconciliations_one_in_progress`);
    try {
      const mk = async (updatedAt: string) => {
        const [r] = await db.insert(reconciliations).values({
          tenantId: ctx.tenantId, accountId: ctx.checkingId, statementDate: '2026-01-31',
          statementEndingBalance: '10', beginningBalance: '0', status: 'in_progress', updatedAt: new Date(updatedAt),
        }).returning();
        await db.insert(reconciliationLines).values({ reconciliationId: r!.id, journalLineId: jl, isCleared: true });
        return r!.id;
      };
      const older = await mk('2026-02-01T00:00:00Z');
      const newest = await mk('2026-02-03T00:00:00Z');
      const middle = await mk('2026-02-02T00:00:00Z');
      const [stmt] = await db.insert(bankStatements).values({
        tenantId: ctx.tenantId, accountId: ctx.checkingId, periodStart: '2026-01-01', periodEnd: '2026-01-31',
        openingBalance: '0', closingBalance: '10', reconciliationId: older,
      } as any).returning();

      const here = dirname(fileURLToPath(import.meta.url));
      const file = readFileSync(resolve(here, '../db/migrations/0272_reconciliations_one_in_progress.sql'), 'utf8');
      for (const stmtSql of file.split('--> statement-breakpoint')) {
        if (stmtSql.replace(/--.*$/gm, '').trim()) await db.execute(sql.raw(stmtSql));
      }

      const left = await db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, ctx.tenantId));
      expect(left.map((r) => r.id)).toEqual([newest]);
      const lines = await db.select().from(reconciliationLines).where(inArray(reconciliationLines.reconciliationId, [older, middle]));
      expect(lines).toHaveLength(0);
      const [s] = await db.select().from(bankStatements).where(eq(bankStatements.id, stmt!.id));
      expect(s!.reconciliationId).toBeNull();
    } finally {
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliations_one_in_progress
        ON reconciliations (tenant_id, account_id) WHERE status = 'in_progress'`);
    }
  });

  it('cancel writes its audit row in the same transaction', async () => {
    const r = await begin({ statementEndingBalance: '0' });
    const id = r.json.reconciliation.id;
    expect((await request('POST', `/banking/reconciliations/${id}/cancel`, ctx.ownerToken, {})).status).toBe(200);
    const rows = await auditRows(id);
    expect(rows.filter((a) => a.action === 'delete')).toHaveLength(1);
  });
});

// ─── U-189 reconcile-begin-v1 ───────────────────────────────────

describe('reconciliation begin charges, later lines, pre-check, drift (U-189)', () => {
  it('counts pending charges before the finish and posts them once, cleared, on finish', async () => {
    const d = await deposit('2026-01-05', '1000.00');
    // 1000 + 2.50 interest − 15 service charge = 987.50
    const r = await begin({
      statementEndingBalance: '987.50',
      serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.feeId },
      interest: { amount: '2.50', date: '2026-01-31', accountId: ctx.interestIncomeId },
    });
    expect(r.status).toBe(201);
    const id = r.json.reconciliation.id;
    expect(r.json.reconciliation.pending).toEqual({
      serviceCharge: { amount: '15.0000', date: '2026-01-31', accountId: ctx.feeId },
      interest: { amount: '2.5000', date: '2026-01-31', accountId: ctx.interestIncomeId },
    });
    expect(r.json.reconciliation.clearedBalanceExact).toBe('-12.5000');
    expect(r.json.reconciliation.clearedDeposits).toEqual({ count: 1, total: '2.5000' });
    expect(r.json.reconciliation.clearedPayments).toEqual({ count: 1, total: '-15.0000' });
    // Nothing in the books yet.
    const before = await db.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.source, 'reconciliation')));
    expect(before).toHaveLength(0);

    const t = await tick(id, [[await lineOf(d), true]]);
    expect(t.json.reconciliation.differenceExact).toBe('0.0000');
    const f = await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {});
    expect(f.status).toBe(200);

    const posted = await db.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.source, 'reconciliation')));
    expect(posted.map((p) => p.txnType).sort()).toEqual(['deposit', 'expense']);
    const [row] = await db.select().from(reconciliations).where(eq(reconciliations.id, id));
    expect(row!.serviceChargeTxnId).toBe(posted.find((p) => p.txnType === 'expense')!.id);
    expect(row!.interestTxnId).toBe(posted.find((p) => p.txnType === 'deposit')!.id);
    expect(row!.clearedBalance).toBe('987.5000');
    const reconciled = await reconciledLines();
    expect(reconciled).toContain(await lineOf(row!.serviceChargeTxnId!));
    expect(reconciled).toContain(await lineOf(row!.interestTxnId!));
    // The expense debits the fee account, credits the bank.
    const feeLines = await db.select().from(journalLines).where(eq(journalLines.transactionId, row!.serviceChargeTxnId!));
    expect(feeLines.find((l) => l.accountId === ctx.feeId)!.debit).toBe('15.0000');
    expect(feeLines.find((l) => l.accountId === ctx.checkingId)!.credit).toBe('15.0000');
    expect(f.json.reconciliation.pending).toEqual({ serviceCharge: null, interest: null });
  });

  it('rolls the posting back with the finish when the finish fails', async () => {
    const r = await begin({
      statementEndingBalance: '-12.50',
      serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.feeId },
      interest: { amount: '2.50', date: '2026-01-31', accountId: ctx.interestIncomeId },
    });
    const id = r.json.reconciliation.id;
    // The service charge posts first; the interest account was deactivated
    // after Begin, so the finish fails after that posting.
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, ctx.interestIncomeId));
    const f = await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {});
    expect(f.status).toBe(400);
    expect(f.json.error.code).toBe('RECONCILE_CHARGE_ACCOUNT_INVALID');
    expect(f.json.error.details).toEqual({ kind: 'interest', reason: 'account is inactive' });
    const posted = await db.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.source, 'reconciliation')));
    expect(posted).toHaveLength(0);
    const [row] = await db.select().from(reconciliations).where(eq(reconciliations.id, id));
    expect(row!.status).toBe('in_progress');
    expect(row!.serviceChargeTxnId).toBeNull();
    expect(await db.select().from(reconciliationLines).where(eq(reconciliationLines.reconciliationId, id))).toHaveLength(0);
  });

  it('closed period: refuses a charge dated on or before the closing date, then posts it with the password and one override row', async () => {
    await closeBooks('2026-01-31');
    const r = await begin({
      statementEndingBalance: '-15.00',
      serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.feeId },
    });
    const id = r.json.reconciliation.id;
    expect(r.json.reconciliation.postingLocked).toBe(true);
    let f = await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {});
    expect(f.status).toBe(423);
    expect(f.json.error.code).toBe('TB_PERIOD_LOCKED');
    expect((await db.select().from(reconciliations).where(eq(reconciliations.id, id)))[0]!.status).toBe('in_progress');
    f = await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, { closingPassword: 'wrong-password-123' });
    expect(f.status).toBe(403);
    f = await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, { closingPassword: PASSWORD });
    expect(f.status).toBe(200);
    const overrides = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, ctx.tenantId), eq(auditLog.entityType, 'closing_date_override')));
    expect(overrides).toHaveLength(1);
  });

  it('orients a card statement balance on start and on PATCH', async () => {
    // A 300 charge on the card: books −300; the statement prints 300 owed.
    const charge = await post('2026-01-10', [{ accountId: ctx.expenseId, debit: '300.00' }, { accountId: ctx.cardId, credit: '300.00' }]);
    const r = await request('POST', '/banking/reconciliations', ctx.ownerToken, {
      accountId: ctx.cardId, statementDate: '2026-01-31', statementEndingBalance: '250.00',
    });
    const id = r.json.reconciliation.id;
    expect(r.json.reconciliation.statementEndingBalance).toBe('-250.0000');
    const p = await request('PATCH', `/banking/reconciliations/${id}`, ctx.ownerToken, { statementEndingBalance: '300.00' });
    expect(p.json.reconciliation.statementEndingBalance).toBe('-300.0000');
    const t = await tick(id, [[await lineOf(charge, ctx.cardId), true]]);
    expect(t.json.reconciliation.differenceExact).toBe('0.0000');
    expect(t.json.reconciliation.clearedPayments).toEqual({ count: 1, total: '-300.0000' });
  });

  it('refuses PATCH of a posted charge with 409 RECONCILE_CHARGE_POSTED and accepts the same value', async () => {
    const r = await begin({
      statementEndingBalance: '-15.00',
      serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.feeId },
    });
    const id = r.json.reconciliation.id;
    expect((await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {})).status).toBe(200);
    expect((await request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, { mode: 'keep_checks' })).status).toBe(200);
    const same = await request('PATCH', `/banking/reconciliations/${id}`, ctx.ownerToken, {
      serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.feeId },
    });
    expect(same.status).toBe(200);
    const changed = await request('PATCH', `/banking/reconciliations/${id}`, ctx.ownerToken, {
      serviceCharge: { amount: '16.00', date: '2026-01-31', accountId: ctx.feeId },
    });
    expect(changed.status).toBe(409);
    expect(changed.json.error.code).toBe('RECONCILE_CHARGE_POSTED');
    expect(changed.json.error.details.kind).toBe('serviceCharge');
  });

  it('validates the charge account and amount', async () => {
    let r = await begin({ statementEndingBalance: '0', serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.checkingId } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('RECONCILE_CHARGE_ACCOUNT_INVALID');
    r = await begin({ statementEndingBalance: '0', serviceCharge: { amount: '0.00', date: '2026-01-31', accountId: ctx.feeId } });
    expect(r.status).toBe(400);
    r = await begin({ statementEndingBalance: '0', serviceCharge: { amount: '1.234', date: '2026-01-31', accountId: ctx.feeId } });
    expect(r.status).toBe(400);
  });

  it('holds lines after the statement date only with includeLaterLines, flagged and tickable', async () => {
    await deposit('2026-01-05', '100.00');
    const later = await deposit('2026-02-03', '40.00');
    let r = await begin({ statementEndingBalance: '100.00' });
    let g = await getRecon(r.json.reconciliation.id);
    expect(g.json.reconciliation.lines).toHaveLength(1);
    await request('POST', `/banking/reconciliations/${r.json.reconciliation.id}/cancel`, ctx.ownerToken, {});

    r = await begin({ statementEndingBalance: '140.00', includeLaterLines: true });
    const id = r.json.reconciliation.id;
    g = await getRecon(id);
    expect(g.json.reconciliation.lines).toHaveLength(2);
    const laterLine = g.json.reconciliation.lines.find((l: any) => l.transaction_id === later);
    expect(laterLine.afterStatementDate).toBe(true);
    const t = await tick(id, [[laterLine.journal_line_id, true]]);
    expect(t.json.reconciliation.clearedBalanceExact).toBe('40.0000');
    // Turning later lines off drops the unticked later ones only.
    const ref = await request('POST', `/banking/reconciliations/${id}/refresh`, ctx.ownerToken, { includeLaterLines: false });
    expect(ref.json.removed).toBe(0);
  });

  it('pre-checks accepted bank-file lines dated by the bank on or before the statement date', async () => {
    const [conn] = await db.insert(bankConnections).values({
      tenantId: ctx.tenantId, companyId: ctx.companyId, accountId: ctx.checkingId, provider: 'manual',
    }).returning();
    const feedRow = async (txnId: string, jlId: string | null, feedDate: string, extra: Record<string, unknown> = {}) => {
      await db.insert(bankFeedItems).values({
        tenantId: ctx.tenantId, companyId: ctx.companyId, bankConnectionId: conn!.id, feedDate, description: 'BANK',
        amount: '1.00', status: 'categorized', matchedTransactionId: txnId, matchedJournalLineId: jlId, ...extra,
      } as any);
    };
    const accepted = await deposit('2026-01-05', '100.00');
    await feedRow(accepted, await lineOf(accepted), '2026-01-05');
    const matched = await check('2026-01-12', '30.00');
    await feedRow(matched, await lineOf(matched), '2026-01-13', { status: 'matched' });
    const legacy = await check('2026-01-14', '5.00');
    await feedRow(legacy, null, '2026-01-14'); // before 0265: entry only
    await check('2026-01-15', '20.00'); // manual, no bank-file row
    const voidedEntry = await check('2026-01-16', '7.00');
    await feedRow(voidedEntry, await lineOf(voidedEntry), '2026-01-16', { entryVoidedAt: new Date() });
    const lateBank = await check('2026-01-28', '11.00'); // dated 01/28, cleared the bank 02/02
    await feedRow(lateBank, await lineOf(lateBank), '2026-02-02');

    const r = await begin({ statementEndingBalance: '65.00', precheck: 'bank_feed' });
    const g = await getRecon(r.json.reconciliation.id);
    const byTxn = new Map(g.json.reconciliation.lines.map((l: any) => [l.transaction_id, l]));
    const ticked = (id: string) => (byTxn.get(id) as any).is_cleared;
    expect(ticked(accepted)).toBe(true);
    expect(ticked(matched)).toBe(true);
    expect(ticked(legacy)).toBe(true);
    expect(ticked(lateBank)).toBe(false);
    expect(ticked(voidedEntry)).toBe(false);
    expect(g.json.reconciliation.lines.filter((l: any) => !l.fromBankFeed)).toHaveLength(1);
    expect((byTxn.get(lateBank) as any).fromBankFeed).toBe(true);
    expect(g.json.reconciliation.differenceExact).toBe('0.0000');
  });

  it('reports beginning-balance drift: none normally, the gap after a reconciled line goes missing', async () => {
    const d = await deposit('2026-01-05', '100.00');
    const c = await check('2026-01-10', '25.00');
    const r = await begin({ statementEndingBalance: '75.00' });
    const id = r.json.reconciliation.id;
    await tick(id, [[await lineOf(d), true], [await lineOf(c), true]]);
    expect((await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {})).status).toBe(200);

    const next = await request('POST', '/banking/reconciliations', ctx.ownerToken, {
      accountId: ctx.checkingId, statementDate: '2026-02-28', statementEndingBalance: '75.00',
    });
    expect(next.json.reconciliation.beginningBalanceDrift).toBeNull();
    await request('POST', `/banking/reconciliations/${next.json.reconciliation.id}/cancel`, ctx.ownerToken, {});

    // Seed an orphan: the reconciled check's line row disappears.
    await db.execute(sql`UPDATE reconciliation_lines SET journal_line_id = gen_random_uuid() WHERE journal_line_id = ${await lineOf(c)}`);
    const again = await request('POST', '/banking/reconciliations', ctx.ownerToken, {
      accountId: ctx.checkingId, statementDate: '2026-02-28', statementEndingBalance: '75.00',
    });
    expect(again.json.reconciliation.beginningBalanceDrift).toEqual({
      reconciliationId: id, expected: '75.0000', actual: '100.0000', difference: '25.0000',
    });
  });

  it('refresh removes worksheet rows whose journal line is gone', async () => {
    const d = await deposit('2026-01-05', '100.00');
    const r = await begin({ statementEndingBalance: '100.00' });
    const id = r.json.reconciliation.id;
    await db.execute(sql`UPDATE reconciliation_lines SET journal_line_id = gen_random_uuid() WHERE journal_line_id = ${await lineOf(d)}`);
    const ref = await request('POST', `/banking/reconciliations/${id}/refresh`, ctx.ownerToken, {});
    expect(ref.json).toEqual({ added: 1, removed: 1, prechecked: 0 });
  });
});

// ─── U-190 reconcile-undo-v2 ────────────────────────────────────

describe('reconciliation undo v2 (U-190)', () => {
  async function finishJanuary() {
    const d = await deposit('2026-01-05', '100.00');
    const c = await check('2026-01-10', '25.00');
    const out = await check('2026-01-20', '9.00');
    const r = await begin({ statementEndingBalance: '75.00' });
    const id = r.json.reconciliation.id;
    await tick(id, [[await lineOf(d), true], [await lineOf(c), true]]);
    expect((await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {})).status).toBe(200);
    return { id, d, c, out };
  }

  it('is owner only: an accountant with banking write gets 403 RECONCILE_ADMIN_REQUIRED', async () => {
    const { id } = await finishJanuary();
    const res = await request('POST', `/banking/reconciliations/${id}/undo`, ctx.accountantToken, {});
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('RECONCILE_ADMIN_REQUIRED');
  });

  it('only the latest: 409 RECONCILIATION_NOT_LATEST', async () => {
    const { id } = await finishJanuary();
    const feb = await request('POST', '/banking/reconciliations', ctx.ownerToken, {
      accountId: ctx.checkingId, statementDate: '2026-02-28', statementEndingBalance: '75.00',
    });
    expect((await request('POST', `/banking/reconciliations/${feb.json.reconciliation.id}/complete`, ctx.ownerToken, {})).status).toBe(200);
    const res = await request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, {});
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('RECONCILIATION_NOT_LATEST');
  });

  it('409 RECONCILIATION_IN_PROGRESS while another reconciliation is in progress', async () => {
    const { id } = await finishJanuary();
    const feb = await request('POST', '/banking/reconciliations', ctx.ownerToken, {
      accountId: ctx.checkingId, statementDate: '2026-02-28', statementEndingBalance: '75.00',
    });
    const res = await request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, { mode: 'discard' });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe('RECONCILIATION_IN_PROGRESS');
    expect(res.json.error.details.reconciliationId).toBe(feb.json.reconciliation.id);
  });

  it('keep_checks reopens with exactly the ticks at finish; audited with the cleared line ids', async () => {
    const { id } = await finishJanuary();
    const atFinish = await clearedSet(id);
    const res = await request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, { mode: 'keep_checks' });
    expect(res.status).toBe(200);
    expect(res.json.mode).toBe('keep_checks');
    const [row] = await db.select().from(reconciliations).where(eq(reconciliations.id, id));
    expect(row!.status).toBe('in_progress');
    expect(await clearedSet(id)).toEqual(atFinish);
    expect(await reconciledLines()).toEqual([]);
    const undoRow = (await auditRows(id)).find((a) => JSON.stringify(a.afterData).includes('undo'));
    const after = typeof undoRow!.afterData === 'string' ? JSON.parse(undoRow!.afterData) : undoRow!.afterData;
    const beforeImg = typeof undoRow!.beforeData === 'string' ? JSON.parse(undoRow!.beforeData) : undoRow!.beforeData;
    expect(after).toEqual({ undo: { mode: 'keep_checks' } });
    expect(beforeImg.clearedLineIds).toEqual(atFinish);
    // It can be finished again as it was.
    expect((await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {})).status).toBe(200);
  });

  it('clear_checks (default) reopens with every line unticked', async () => {
    const { id } = await finishJanuary();
    const res = await request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, {});
    expect(res.status).toBe(200);
    expect(res.json.mode).toBe('clear_checks');
    expect(await clearedSet(id)).toEqual([]);
  });

  it('discard gives back exactly the cleared state before Begin; earlier reconciliations untouched', async () => {
    const { id: jan } = await finishJanuary();
    const janReconciled = await reconciledLines();
    const feb = await request('POST', '/banking/reconciliations', ctx.ownerToken, {
      accountId: ctx.checkingId, statementDate: '2026-02-28', statementEndingBalance: '66.00',
    });
    const febId = feb.json.reconciliation.id;
    const g = await getRecon(febId);
    await tick(febId, g.json.reconciliation.lines.map((l: any) => [l.journal_line_id, true]));
    expect((await request('POST', `/banking/reconciliations/${febId}/complete`, ctx.ownerToken, {})).status).toBe(200);
    expect((await reconciledLines()).length).toBeGreaterThan(janReconciled.length);

    const res = await request('POST', `/banking/reconciliations/${febId}/undo`, ctx.ownerToken, { mode: 'discard' });
    expect(res.status).toBe(200);
    expect(await reconciledLines()).toEqual(janReconciled);
    expect(await db.select().from(reconciliations).where(eq(reconciliations.id, febId))).toHaveLength(0);
    const [janRow] = await db.select().from(reconciliations).where(eq(reconciliations.id, jan));
    expect(janRow!.status).toBe('complete');
  });

  it('closed period: refused without the password, accepted with it and audited', async () => {
    const { id } = await finishJanuary();
    await closeBooks('2026-01-31');
    let res = await request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, { mode: 'keep_checks' });
    expect(res.status).toBe(423);
    expect(res.json.error.code).toBe('TB_PERIOD_LOCKED');
    res = await request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, { mode: 'keep_checks', closingPassword: PASSWORD });
    expect(res.status).toBe(200);
    const overrides = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, ctx.tenantId), eq(auditLog.entityType, 'closing_date_override')));
    expect(overrides).toHaveLength(1);
  });

  it('keeps posted charges in the books and never posts them again on the next finish', async () => {
    const r = await begin({
      statementEndingBalance: '-15.00',
      serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.feeId },
    });
    const id = r.json.reconciliation.id;
    expect((await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {})).status).toBe(200);
    for (const mode of ['keep_checks', 'clear_checks'] as const) {
      expect((await request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, { mode })).status).toBe(200);
      const g = await getRecon(id);
      expect(g.json.reconciliation.pending).toEqual({ serviceCharge: null, interest: null });
      if (mode === 'clear_checks') {
        await tick(id, g.json.reconciliation.lines.map((l: any) => [l.journal_line_id, true]));
      }
      expect((await request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {})).status).toBe(200);
    }
    const posted = await db.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.source, 'reconciliation')));
    expect(posted).toHaveLength(1);
    // discard: the reconciliation goes, the charge stays.
    expect((await request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, { mode: 'discard' })).status).toBe(200);
    const still = await db.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.source, 'reconciliation')));
    expect(still).toHaveLength(1);
    expect(still[0]!.status).toBe('posted');
  });
});
