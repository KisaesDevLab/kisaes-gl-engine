// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Reconcile hardening (U-193, ClientLedger P27 review) through the HTTP
// routes and the ledger:
//   voided     GET of an in-progress worksheet and complete leave out rows
//              whose entry was voided after it was ticked (E1).
//   race       an edit / void of an entry on a worksheet waits for a Finish
//              in flight and then meets the completed-reconciliation guard
//              (E2, header lock).
//   order      start / PATCH refuse a statement date on or before the latest
//              completed reconciliation's (409 RECONCILE_STATEMENT_DATE_ORDER);
//              same-date tie broken by the later finish (E3).
//   charge     a posted charge whose entry was voided can be entered again
//              and is posted once more by the next finish (m2).

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
  bankConnections, bankFeedItems, bankStatements,
} from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import { bankingRouter } from './banking.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;

interface Ctx {
  tenantId: string;
  companyId: string;
  checkingId: string;
  revenueId: string;
  expenseId: string;
  feeId: string;
  ownerToken: string;
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
  return jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
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
  const [t] = await db.insert(tenants).values({ name: 'Recon hardening', slug: `recon-hard-${stamp}` }).returning();
  const [co] = await db.insert(companies).values({ tenantId: t!.id, businessName: 'Recon Hardening Co', setupComplete: true }).returning();
  const mk = async (name: string, accountType: string, detailType: string | null, accountNumber: string) => {
    const [a] = await db.insert(accounts).values({ tenantId: t!.id, companyId: co!.id, name, accountType, detailType, accountNumber }).returning();
    return a!.id;
  };
  ctx = {
    tenantId: t!.id,
    companyId: co!.id,
    checkingId: await mk('Operating Checking', 'asset', 'bank', '1010'),
    revenueId: await mk('Sales', 'revenue', null, '4000'),
    expenseId: await mk('Supplies', 'expense', null, '6000'),
    feeId: await mk('Bank Fees', 'expense', null, '6100'),
    ownerToken: await seedUser(t!.id, 'owner'),
  };
  const app = express();
  app.use(express.json({ limit: '10mb' }));
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

type Line = { accountId: string; debit?: string; credit?: string };
const entry = (date: string, lines: Line[], memo = 'entry') => ({
  txnType: 'journal_entry' as const, txnDate: date, memo,
  lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit ?? '0', credit: l.credit ?? '0' })),
});
async function post(date: string, lines: Line[], memo?: string) {
  return (await ledger.postTransaction(ctx.tenantId, entry(date, lines, memo), undefined, ctx.companyId)).id;
}
const depositLines = (amt: string): Line[] => [{ accountId: ctx.checkingId, debit: amt }, { accountId: ctx.revenueId, credit: amt }];
const deposit = (date: string, amt: string) => post(date, depositLines(amt), `Deposit ${amt}`);
const check = (date: string, amt: string) =>
  post(date, [{ accountId: ctx.expenseId, debit: amt }, { accountId: ctx.checkingId, credit: amt }], `Check ${amt}`);

async function lineOf(txnId: string, accountId = ctx.checkingId): Promise<string> {
  const [l] = await db.select({ id: journalLines.id }).from(journalLines)
    .where(and(eq(journalLines.transactionId, txnId), eq(journalLines.accountId, accountId)));
  return l!.id;
}

const begin = (body: Record<string, unknown>) =>
  request('POST', '/banking/reconciliations', ctx.ownerToken, { accountId: ctx.checkingId, statementDate: '2026-01-31', ...body });
const tick = (id: string, lines: Array<[string, boolean]>) =>
  request('PUT', `/banking/reconciliations/${id}/lines`, ctx.ownerToken, {
    lines: lines.map(([journalLineId, isCleared]) => ({ journalLineId, isCleared })),
  });
const getRecon = (id: string) => request('GET', `/banking/reconciliations/${id}`, ctx.ownerToken);
const patch = (id: string, body: Record<string, unknown>) => request('PATCH', `/banking/reconciliations/${id}`, ctx.ownerToken, body);
const complete = (id: string) => request('POST', `/banking/reconciliations/${id}/complete`, ctx.ownerToken, {});
const undo = (id: string, mode?: string) => request('POST', `/banking/reconciliations/${id}/undo`, ctx.ownerToken, mode ? { mode } : {});

async function worksheetRows(reconId: string) {
  return db.select({ jl: reconciliationLines.journalLineId, cleared: reconciliationLines.isCleared })
    .from(reconciliationLines).where(eq(reconciliationLines.reconciliationId, reconId));
}

/**
 * Holds the reconciliation header lock in its own transaction and flips it to
 * complete, as complete() does, until `release()` — a Finish in flight.
 */
async function finishInFlight(reconId: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let locked!: () => void;
  const isLocked = new Promise<void>((r) => { locked = r; });
  const done = db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM reconciliations WHERE id = ${reconId} FOR UPDATE`);
    await tx.execute(sql`UPDATE reconciliations SET status = 'complete', completed_at = now() WHERE id = ${reconId}`);
    locked();
    await gate;
  });
  await isLocked;
  return { release, done };
}

/** Settles within `ms`? (false while it is still waiting on a lock). */
async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, ms));
  return settled;
}

describe('reconcile hardening (U-193)', () => {
  it('advertises the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('reconcile-hardening-v1');
  });

  // ─── E1 ──────────────────────────────────────────────────────────
  it('voided after ticking: GET and Finish leave the row out; Finish drops it and audits it', async () => {
    const d = await deposit('2026-01-05', '100.00');
    const c = await check('2026-01-10', '25.00');
    const r = await begin({ statementEndingBalance: '75.00' });
    const id = r.json.reconciliation.id;
    const cLine = await lineOf(c);
    await tick(id, [[await lineOf(d), true], [cLine, true]]);
    expect((await getRecon(id)).json.reconciliation.differenceExact).toBe('0.0000');

    await ledger.voidTransaction(ctx.tenantId, c, 'keyed twice');
    const g = await getRecon(id);
    expect(g.json.reconciliation.lines.map((l: any) => l.journal_line_id)).not.toContain(cLine);
    expect(g.json.reconciliation.clearedBalanceExact).toBe('100.0000');
    expect(g.json.reconciliation.differenceExact).toBe('-25.0000');
    const refused = await complete(id);
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('RECONCILE_DIFFERENCE_NOT_ZERO');
    expect(refused.json.error.details.difference).toBe('-25.0000');
    // The refused finish rolled its clean-up back with it.
    expect((await worksheetRows(id)).map((w) => w.jl)).toContain(cLine);

    expect((await patch(id, { statementEndingBalance: '100.00' })).status).toBe(200);
    const f = await complete(id);
    expect(f.status).toBe(200);
    expect(f.json.reconciliation.clearedBalanceExact).toBe('100.0000');
    expect((await worksheetRows(id)).map((w) => w.jl)).not.toContain(cLine);
    const [row] = await db.select().from(reconciliations).where(eq(reconciliations.id, id));
    expect(row!.clearedBalance).toBe('100.0000');
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, ctx.tenantId), eq(auditLog.entityId, id)));
    const finish = audits.map((a) => (typeof a.afterData === 'string' ? JSON.parse(a.afterData) : a.afterData) as any)
      .find((a) => a?.status === 'complete');
    expect(finish.droppedLineIds).toEqual([cLine]);
    expect(finish.clearedLineIds).not.toContain(cLine);
  });

  // ─── E2 ──────────────────────────────────────────────────────────
  it('an edit that changes the ticked line waits for a Finish in flight, then is refused', async () => {
    const d = await deposit('2026-01-05', '100.00');
    const dLine = await lineOf(d);
    const r = await begin({ statementEndingBalance: '100.00' });
    const id = r.json.reconciliation.id;
    await tick(id, [[dLine, true]]);

    const finish = await finishInFlight(id);
    const edit = ledger.updateTransaction(ctx.tenantId, d, entry('2026-01-05', depositLines('120.00'), 'Deposit 120'), undefined, ctx.companyId);
    edit.catch(() => undefined);
    let waited: boolean;
    try {
      // Waits on the header lock instead of reading the in-progress state.
      waited = !(await settlesWithin(edit, 400));
    } finally {
      finish.release();
      await finish.done;
    }
    expect(waited).toBe(true);
    await expect(edit).rejects.toThrow(/completed bank reconciliation/);
    // The completed reconciliation still holds the line it cleared.
    expect(await worksheetRows(id)).toEqual([{ jl: dLine, cleared: true }]);
    const [line] = await db.select({ debit: journalLines.debit }).from(journalLines).where(eq(journalLines.id, dLine));
    expect(line!.debit).toBe('100.0000');
  });

  it('a void waits for a Finish in flight, then is refused', async () => {
    const d = await deposit('2026-01-05', '100.00');
    const r = await begin({ statementEndingBalance: '100.00' });
    const id = r.json.reconciliation.id;
    await tick(id, [[await lineOf(d), true]]);

    const finish = await finishInFlight(id);
    const voiding = ledger.voidTransaction(ctx.tenantId, d, 'oops');
    voiding.catch(() => undefined);
    let waited: boolean;
    try {
      waited = !(await settlesWithin(voiding, 400));
    } finally {
      finish.release();
      await finish.done;
    }
    expect(waited).toBe(true);
    await expect(voiding).rejects.toThrow(/completed bank reconciliation/);
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, d));
    expect(txn!.status).toBe('posted');
  });

  it('an edit of an entry on no worksheet does not wait', async () => {
    const d = await deposit('2026-01-05', '100.00');
    const r = await begin({ statementEndingBalance: '100.00' });
    const id = r.json.reconciliation.id;
    await tick(id, [[await lineOf(d), true]]);
    // Dated after the statement: on no worksheet.
    const later = await deposit('2026-02-10', '10.00');
    const finish = await finishInFlight(id);
    try {
      const edit = ledger.updateTransaction(ctx.tenantId, later, entry('2026-02-10', depositLines('11.00')), undefined, ctx.companyId);
      expect(await settlesWithin(edit, 2000)).toBe(true);
      await edit;
    } finally {
      finish.release();
      await finish.done;
    }
  });

  // ─── E3 ──────────────────────────────────────────────────────────
  it('refuses a statement date on or before the latest completed one, on start and on PATCH', async () => {
    const jan = await begin({ statementEndingBalance: '0' });
    expect((await complete(jan.json.reconciliation.id)).status).toBe(200);
    const janId = jan.json.reconciliation.id;

    for (const statementDate of ['2026-01-31', '2026-01-15']) {
      const res = await begin({ statementDate, statementEndingBalance: '0' });
      expect(res.status).toBe(409);
      expect(res.json.error.code).toBe('RECONCILE_STATEMENT_DATE_ORDER');
      expect(res.json.error.details).toEqual({ latestReconciliationId: janId, latestStatementDate: '2026-01-31' });
    }
    expect(await db.select().from(reconciliations).where(eq(reconciliations.tenantId, ctx.tenantId))).toHaveLength(1);

    const feb = await begin({ statementDate: '2026-02-01', statementEndingBalance: '0' });
    expect(feb.status).toBe(201);
    const febId = feb.json.reconciliation.id;
    const back = await patch(febId, { statementDate: '2026-01-20' });
    expect(back.status).toBe(409);
    expect(back.json.error.code).toBe('RECONCILE_STATEMENT_DATE_ORDER');
    const fwd = await patch(febId, { statementDate: '2026-02-28' });
    expect(fwd.status).toBe(200);
    expect(String(fwd.json.reconciliation.statementDate).slice(0, 10)).toBe('2026-02-28');
  });

  it('same statement date: the later finish is the latest (beginning balance and undo)', async () => {
    const base = {
      tenantId: ctx.tenantId, accountId: ctx.checkingId, statementDate: '2026-01-31', beginningBalance: '0', status: 'complete',
    };
    // Rows from before the order rule: two finished on the same statement date.
    const [first] = await db.insert(reconciliations).values({
      ...base, statementEndingBalance: '10.0000', completedAt: new Date('2026-02-01T10:00:00Z'),
    }).returning();
    const [second] = await db.insert(reconciliations).values({
      ...base, statementEndingBalance: '20.0000', completedAt: new Date('2026-02-02T10:00:00Z'),
    }).returning();

    const feb = await begin({ statementDate: '2026-02-28', statementEndingBalance: '20.00' });
    expect(feb.status).toBe(201);
    expect(feb.json.reconciliation.beginningBalance).toBe('20.0000');
    await request('POST', `/banking/reconciliations/${feb.json.reconciliation.id}/cancel`, ctx.ownerToken, {});

    const older = await undo(first!.id);
    expect(older.status).toBe(409);
    expect(older.json.error.code).toBe('RECONCILIATION_NOT_LATEST');
    expect(older.json.error.details.latestReconciliationId).toBe(second!.id);
    expect((await undo(second!.id)).status).toBe(200);
  });

  it('PATCH resending the current date of an older, out-of-order worksheet is accepted', async () => {
    const [feb] = await db.insert(reconciliations).values({
      tenantId: ctx.tenantId, accountId: ctx.checkingId, statementDate: '2026-02-28', beginningBalance: '0',
      statementEndingBalance: '0', status: 'complete', completedAt: new Date(),
    }).returning();
    // Started before the order rule, on a date before the completed one.
    const [legacy] = await db.insert(reconciliations).values({
      tenantId: ctx.tenantId, accountId: ctx.checkingId, statementDate: '2026-01-31', beginningBalance: '0',
      statementEndingBalance: '0', status: 'in_progress',
    }).returning();
    expect((await patch(legacy!.id, { statementDate: '2026-01-31', statementEndingBalance: '0' })).status).toBe(200);
    const moved = await patch(legacy!.id, { statementDate: '2026-02-15' });
    expect(moved.status).toBe(409);
    expect(moved.json.error.details.latestReconciliationId).toBe(feb!.id);
  });

  // ─── m2 ──────────────────────────────────────────────────────────
  it('a posted charge whose entry was voided is pending again and posted once more by the next finish', async () => {
    const r = await begin({
      statementEndingBalance: '-15.00',
      serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.feeId },
    });
    const id = r.json.reconciliation.id;
    expect((await complete(id)).status).toBe(200);
    expect((await undo(id, 'keep_checks')).status).toBe(200);
    const [reopened] = await db.select().from(reconciliations).where(eq(reconciliations.id, id));
    const firstCharge = reopened!.serviceChargeTxnId!;

    // Still posted: a change is refused as before.
    const refused = await patch(id, { serviceCharge: { amount: '16.00', date: '2026-01-31', accountId: ctx.feeId } });
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe('RECONCILE_CHARGE_POSTED');

    await ledger.voidTransaction(ctx.tenantId, firstCharge, 'charge reversed by the bank');
    const g = await getRecon(id);
    expect(g.json.reconciliation.pending.serviceCharge).toBeNull();
    expect(g.json.reconciliation.differenceExact).toBe('-15.0000');

    const again = await patch(id, { serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.feeId } });
    expect(again.status).toBe(200);
    expect(again.json.reconciliation.serviceChargeTxnId).toBeNull();
    expect(again.json.reconciliation.pending.serviceCharge).toEqual({ amount: '15.0000', date: '2026-01-31', accountId: ctx.feeId });
    expect(again.json.reconciliation.differenceExact).toBe('0.0000');

    expect((await complete(id)).status).toBe(200);
    const charges = await db.select({ id: transactions.id, status: transactions.status }).from(transactions)
      .where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.source, 'reconciliation'), eq(transactions.sourceId, id)));
    expect(charges.filter((t) => t.status === 'posted')).toHaveLength(1);
    expect(charges.filter((t) => t.status === 'void')).toHaveLength(1);
    const [done] = await db.select().from(reconciliations).where(eq(reconciliations.id, id));
    expect(done!.serviceChargeTxnId).not.toBe(firstCharge);
    expect(done!.status).toBe('complete');
  });

  it('a voided posted charge can also be changed or removed', async () => {
    const r = await begin({
      statementEndingBalance: '-15.00',
      serviceCharge: { amount: '15.00', date: '2026-01-31', accountId: ctx.feeId },
    });
    const id = r.json.reconciliation.id;
    expect((await complete(id)).status).toBe(200);
    expect((await undo(id, 'clear_checks')).status).toBe(200);
    const [reopened] = await db.select().from(reconciliations).where(eq(reconciliations.id, id));
    await ledger.voidTransaction(ctx.tenantId, reopened!.serviceChargeTxnId!, 'reversed');
    const changed = await patch(id, { serviceCharge: { amount: '12.50', date: '2026-01-31', accountId: ctx.feeId } });
    expect(changed.status).toBe(200);
    expect(changed.json.reconciliation.pending.serviceCharge.amount).toBe('12.5000');
    const removed = await patch(id, { serviceCharge: null });
    expect(removed.status).toBe(200);
    expect(removed.json.reconciliation.pending.serviceCharge).toBeNull();
    expect(removed.json.reconciliation.serviceChargeAmount).toBeNull();
  });
});
