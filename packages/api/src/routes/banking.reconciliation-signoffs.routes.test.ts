// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Electronic sign-off on bank reconciliations (migration 0214):
//   GET/POST/DELETE /banking/reconciliations/:id/signoffs
// Rules: completed recs only; preparer = any banking writer; reviewer = a
// DIFFERENT user who is firm staff (or super admin), only after a live
// preparer; signers remove their own; removing the preparer invalidates the
// reviewer. Staleness: the stored fingerprint vs the current one (cleared
// item edited / voided / deleted / re-dated, book balance or outstanding set
// at D changed) plus eager invalidation on undo. Also: tenant isolation, audit
// rows, history badges, Report Pack HTML and the Detail PDF Section E.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { existsSync } from 'fs';
import jwt from 'jsonwebtoken';
import { and, eq, inArray } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { db } from '../db/index.js';
import {
  tenants, users, accounts, companies, firms, firmUsers, tenantFirmAssignments, auditLog,
  transactions, journalLines, reconciliations, reconciliationLines, reconciliationSignoffs,
} from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import * as reconciliation from '../services/reconciliation.service.js';
import { REPORT_PACK_DOCUMENT_RENDERERS, type DocumentSectionContext } from '../services/report-pack-documents.js';
import { extractTextLayer } from '../services/extraction/pdf-detect.service.js';
import { bankingRouter } from './banking.routes.js';
import { reportsRouter } from './reports.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let server: Server | null = null;
let port = 0;

interface Ctx {
  tenantId: string;
  companyId: string;
  firmId: string;
  checkingId: string;
  revenueId: string;
  expenseId: string;
}
let ctx: Ctx;
let other: { tenantId: string; token: string } | null = null;

async function chromeAvailable(): Promise<boolean> {
  try {
    const exe: string = process.env['PUPPETEER_EXECUTABLE_PATH'] || await (await import('puppeteer')).default.executablePath();
    return !!exe && existsSync(exe);
  } catch { return false; }
}
const HAS_CHROME = await chromeAvailable();

function request(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: any; raw: Buffer; contentType: string }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
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
        const raw = Buffer.concat(chunks);
        const contentType = String(res.headers['content-type'] || '');
        let json: any = null;
        if (contentType.includes('json')) json = raw.length ? JSON.parse(raw.toString('utf8')) : null;
        resolve({ status: res.statusCode ?? 0, json, raw, contentType });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function seedUser(tenantId: string, role: string, displayName: string, opts: { superAdmin?: boolean } = {}) {
  const [u] = await db.insert(users).values({
    tenantId,
    email: `${displayName.replace(/\s+/g, '.').toLowerCase()}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    passwordHash: 'not-a-real-hash',
    role,
    displayName,
    isSuperAdmin: !!opts.superAdmin,
  }).returning();
  const token = jwt.sign({ userId: u!.id, tenantId, role, isSuperAdmin: !!opts.superAdmin }, process.env['JWT_SECRET']!, { expiresIn: '5m' });
  return { id: u!.id, token };
}

async function makeFirmStaff(userId: string, firmRole = 'firm_staff') {
  await db.insert(firmUsers).values({ firmId: ctx.firmId, userId, firmRole });
}

async function newTenant(label: string) {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [t] = await db.insert(tenants).values({ name: label, slug: `rec-signoff-${stamp}` }).returning();
  const [co] = await db.insert(companies).values({ tenantId: t!.id, businessName: `${label} Co` }).returning();
  return { tenantId: t!.id, companyId: co!.id };
}

async function wipeTenant(tenantId: string) {
  await db.delete(reconciliationSignoffs).where(eq(reconciliationSignoffs.tenantId, tenantId));
  await db.delete(reconciliationLines).where(inArray(
    reconciliationLines.reconciliationId,
    db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tenantId)),
  ));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
}

beforeEach(async () => {
  const t = await newTenant('Rec Signoff');
  const [f] = await db.insert(firms).values({ name: 'Signoff Firm', slug: `signoff-firm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  await db.insert(tenantFirmAssignments).values({ tenantId: t.tenantId, firmId: f!.id });
  const mk = async (name: string, accountType: string, detailType: string | null, accountNumber: string) => {
    const [a] = await db.insert(accounts).values({ tenantId: t.tenantId, companyId: t.companyId, name, accountType, detailType, accountNumber }).returning();
    return a!.id;
  };
  ctx = {
    ...t,
    firmId: f!.id,
    checkingId: await mk('Operating Checking', 'asset', 'bank', '1010'),
    revenueId: await mk('Sales', 'revenue', null, '4000'),
    expenseId: await mk('Supplies', 'expense', null, '6000'),
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/banking', bankingRouter);
  app.use('/api/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await db.delete(firmUsers).where(eq(firmUsers.firmId, ctx.firmId));
  await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, ctx.firmId));
  await db.delete(firms).where(eq(firms.id, ctx.firmId));
  await wipeTenant(ctx.tenantId);
  if (other) { await wipeTenant(other.tenantId); other = null; }
});

// ─── Scenario ────────────────────────────────────────────────────
// January on Operating Checking: deposit 1,000 (01/05) and check #101 for
// 200 (01/10) cleared; check #102 for 50 (01/20) outstanding. Statement
// 01/31 = 800; books at D = 750; adjusted bank = 800 − 50 = 750.

async function post(date: string, lines: Array<{ accountId: string; debit?: string; credit?: string }>, memo: string) {
  const txn = await ledger.postTransaction(ctx.tenantId, {
    txnType: 'journal_entry', txnDate: date, memo,
    lines: lines.map((l) => ({ accountId: l.accountId, debit: l.debit ?? '0', credit: l.credit ?? '0' })),
  });
  return txn.id;
}
const deposit = (date: string, amt: string) =>
  post(date, [{ accountId: ctx.checkingId, debit: amt }, { accountId: ctx.revenueId, credit: amt }], `Deposit ${amt}`);
const check = (date: string, amt: string, no: number) =>
  post(date, [{ accountId: ctx.expenseId, debit: amt }, { accountId: ctx.checkingId, credit: amt }], `Check ${no}`);

async function bankLine(txnId: string) {
  const [l] = await db.select().from(journalLines)
    .where(and(eq(journalLines.transactionId, txnId), eq(journalLines.accountId, ctx.checkingId)));
  return l!;
}

interface Seed { recId: string; dep: string; chk101: string; chk102: string }
async function seedCompletedRec(): Promise<Seed> {
  const dep = await deposit('2026-01-05', '1000.00');
  const chk101 = await check('2026-01-10', '200.00', 101);
  const chk102 = await check('2026-01-20', '50.00', 102);
  const rec = await reconciliation.start(ctx.tenantId, ctx.checkingId, '2026-01-31', '800.00');
  await reconciliation.updateLines(ctx.tenantId, rec.id, [
    { journalLineId: (await bankLine(dep)).id, isCleared: true },
    { journalLineId: (await bankLine(chk101)).id, isCleared: true },
  ]);
  await reconciliation.complete(ctx.tenantId, rec.id);
  return { recId: rec.id, dep, chk101, chk102 };
}

const signoffsUrl = (recId: string) => `/banking/reconciliations/${recId}/signoffs`;

async function signBoth(recId: string) {
  const prep = await seedUser(ctx.tenantId, 'owner', 'Pat Preparer');
  const rev = await seedUser(ctx.tenantId, 'accountant', 'Riley Reviewer');
  await makeFirmStaff(rev.id);
  expect((await request('POST', signoffsUrl(recId), prep.token, { role: 'preparer' })).status).toBe(201);
  expect((await request('POST', signoffsUrl(recId), rev.token, { role: 'reviewer' })).status).toBe(201);
  return { prep, rev };
}

async function auditRows(action: string) {
  return db.select().from(auditLog).where(and(
    eq(auditLog.tenantId, ctx.tenantId), eq(auditLog.entityType, 'reconciliation_signoff'), eq(auditLog.action, action),
  ));
}

async function expectStale(recId: string, token: string, detailContains?: string) {
  const g = await request('GET', signoffsUrl(recId), token);
  expect(g.status).toBe(200);
  for (const role of ['preparer', 'reviewer'] as const) {
    const e = g.json.signoffs[role];
    expect(e.state, role).toBe('stale');
    expect(e.invalidatedReason).toBe('data_changed');
    if (detailContains) expect(e.invalidatedDetail).toContain(detailContains);
  }
  // The sign buttons come back (the preparer can re-sign).
  expect(g.json.viewer.canSignPreparer).toBe(true);
  return g.json;
}

// ─── Signing rules ───────────────────────────────────────────────

describe('reconciliation sign-off: signing rules', () => {
  it('signs as preparer, stamps the name + time, audits, and shows on the proof', async () => {
    const s = await seedCompletedRec();
    const prep = await seedUser(ctx.tenantId, 'owner', 'Pat Preparer');
    const r = await request('POST', signoffsUrl(s.recId), prep.token, { role: 'preparer' });
    expect(r.status).toBe(201);
    expect(r.json.signoffs.preparer).toMatchObject({ state: 'signed', signerName: 'Pat Preparer', userId: prep.id });
    expect(r.json.signoffs.reviewer.state).toBe('unsigned');

    const g = await request('GET', signoffsUrl(s.recId), prep.token);
    expect(g.json.viewer).toMatchObject({ canSignPreparer: false, canRemovePreparer: true, canSignReviewer: false });
    expect(g.json.viewer.reviewerBlockedReason).toMatch(/different person/);

    const audits = await auditRows('signoff');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.userId).toBe(prep.id);

    const proof = await request('GET', `/banking/reconciliations/${s.recId}/proof`, prep.token);
    expect(proof.json.proof.signOff.preparedBy).toBe('Pat Preparer');
    expect(proof.json.proof.signOff.reviewedBy).toBeNull();

    // A second preparer signature is a conflict.
    const again = await request('POST', signoffsUrl(s.recId), prep.token, { role: 'preparer' });
    expect(again.status).toBe(409);
  });

  it('refuses the same person as reviewer (422 RECON_SIGNOFF_SAME_USER), even when firm staff', async () => {
    const s = await seedCompletedRec();
    const prep = await seedUser(ctx.tenantId, 'owner', 'Pat Preparer');
    await makeFirmStaff(prep.id);
    await request('POST', signoffsUrl(s.recId), prep.token, { role: 'preparer' });
    const r = await request('POST', signoffsUrl(s.recId), prep.token, { role: 'reviewer' });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('RECON_SIGNOFF_SAME_USER');
  });

  it('refuses a reviewer before a live preparer (422 RECON_SIGNOFF_ORDER)', async () => {
    const s = await seedCompletedRec();
    const rev = await seedUser(ctx.tenantId, 'accountant', 'Riley Reviewer');
    await makeFirmStaff(rev.id);
    const r = await request('POST', signoffsUrl(s.recId), rev.token, { role: 'reviewer' });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('RECON_SIGNOFF_ORDER');
  });

  it('refuses a non-firm reviewer (403), accepts firm staff and a super admin', async () => {
    const s = await seedCompletedRec();
    const prep = await seedUser(ctx.tenantId, 'owner', 'Pat Preparer');
    await request('POST', signoffsUrl(s.recId), prep.token, { role: 'preparer' });

    const clientOwner = await seedUser(ctx.tenantId, 'owner', 'Client Owner');
    const r1 = await request('POST', signoffsUrl(s.recId), clientOwner.token, { role: 'reviewer' });
    expect(r1.status).toBe(403);
    expect(r1.json.error.code).toBe('RECON_SIGNOFF_REVIEWER_NOT_FIRM');
    const v = await request('GET', signoffsUrl(s.recId), clientOwner.token);
    expect(v.json.viewer.canSignReviewer).toBe(false);
    expect(v.json.viewer.reviewerBlockedReason).toMatch(/firm staff/);

    // A firm_readonly member is not "staff" for review.
    const ro = await seedUser(ctx.tenantId, 'accountant', 'Read Only Firm');
    await makeFirmStaff(ro.id, 'firm_readonly');
    expect((await request('POST', signoffsUrl(s.recId), ro.token, { role: 'reviewer' })).status).toBe(403);

    const sa = await seedUser(ctx.tenantId, 'owner', 'Super Admin', { superAdmin: true });
    const r2 = await request('POST', signoffsUrl(s.recId), sa.token, { role: 'reviewer' });
    expect(r2.status).toBe(201);
    expect(r2.json.signoffs.reviewer).toMatchObject({ state: 'signed', signerName: 'Super Admin' });
  });

  it('refuses users without banking write access (403 PERMISSION_DENIED)', async () => {
    const s = await seedCompletedRec();
    const ro = await seedUser(ctx.tenantId, 'readonly', 'Read Only');
    const r = await request('POST', signoffsUrl(s.recId), ro.token, { role: 'preparer' });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('PERMISSION_DENIED');
    const g = await request('GET', signoffsUrl(s.recId), ro.token);
    expect(g.status).toBe(200);
    expect(g.json.viewer.canSignPreparer).toBe(false);
  });

  it('refuses an in-progress reconciliation (422 RECON_SIGNOFF_NOT_COMPLETE)', async () => {
    await deposit('2026-01-05', '1000.00');
    const rec = await reconciliation.start(ctx.tenantId, ctx.checkingId, '2026-01-31', '1000.00');
    const prep = await seedUser(ctx.tenantId, 'owner', 'Pat Preparer');
    const r = await request('POST', signoffsUrl(rec.id), prep.token, { role: 'preparer' });
    expect(r.status).toBe(422);
    expect(r.json.error.code).toBe('RECON_SIGNOFF_NOT_COMPLETE');
    const g = await request('GET', signoffsUrl(rec.id), prep.token);
    expect(g.json.signoffs.signable).toBe(false);
    expect(g.json.viewer.preparerBlockedReason).toMatch(/completed/);
  });

  it('lets a signer remove only their own sign-off; removing the preparer invalidates the reviewer', async () => {
    const s = await seedCompletedRec();
    const { prep, rev } = await signBoth(s.recId);

    const notMine = await request('DELETE', `${signoffsUrl(s.recId)}/preparer`, rev.token);
    expect(notMine.status).toBe(403);
    expect(notMine.json.error.code).toBe('RECON_SIGNOFF_NOT_SIGNER');

    const d = await request('DELETE', `${signoffsUrl(s.recId)}/preparer`, prep.token);
    expect(d.status).toBe(200);
    expect(d.json.signoffs.preparer.state).toBe('unsigned');
    expect(d.json.signoffs.reviewer).toMatchObject({ state: 'stale', invalidatedReason: 'preparer_removed', signerName: 'Riley Reviewer' });
    expect(await auditRows('unsign')).toHaveLength(1);
    expect(await auditRows('invalidate')).toHaveLength(1);

    // Re-sign the preparer; the reviewer stays stale until re-signed.
    expect((await request('POST', signoffsUrl(s.recId), prep.token, { role: 'preparer' })).status).toBe(201);
    const g = await request('GET', signoffsUrl(s.recId), rev.token);
    expect(g.json.signoffs.preparer.state).toBe('signed');
    expect(g.json.signoffs.reviewer.state).toBe('stale');
    expect(g.json.viewer.canSignReviewer).toBe(true);
    expect((await request('POST', signoffsUrl(s.recId), rev.token, { role: 'reviewer' })).status).toBe(201);

    // Reviewer withdraws their own: the preparer stays.
    const dr = await request('DELETE', `${signoffsUrl(s.recId)}/reviewer`, rev.token);
    expect(dr.json.signoffs.preparer.state).toBe('signed');
    expect(dr.json.signoffs.reviewer.state).toBe('unsigned');
    expect((await request('DELETE', `${signoffsUrl(s.recId)}/reviewer`, rev.token)).status).toBe(404);
  });

  it('isolates tenants: another tenant gets 404 on read, sign and remove', async () => {
    const s = await seedCompletedRec();
    await signBoth(s.recId);
    const o = await newTenant('Other Tenant');
    const outsider = await seedUser(o.tenantId, 'owner', 'Other Owner');
    other = { tenantId: o.tenantId, token: outsider.token };
    expect((await request('GET', signoffsUrl(s.recId), outsider.token)).status).toBe(404);
    expect((await request('POST', signoffsUrl(s.recId), outsider.token, { role: 'preparer' })).status).toBe(404);
    expect((await request('DELETE', `${signoffsUrl(s.recId)}/preparer`, outsider.token)).status).toBe(404);
    const rows = await db.select().from(reconciliationSignoffs).where(eq(reconciliationSignoffs.reconciliationId, s.recId));
    expect(rows.every((r) => r.invalidatedAt === null)).toBe(true);
  });

  it('shows sign-off badges on the reconciliation history list', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);
    const h = await request('GET', `/banking/reconciliations?account_id=${ctx.checkingId}`, prep.token);
    expect(h.status).toBe(200);
    const row = h.json.reconciliations.find((r: any) => r.id === s.recId);
    expect(row.signoffs.preparer.state).toBe('signed');
    expect(row.signoffs.reviewer.state).toBe('signed');

    // A change detected via the history list invalidates too.
    await db.update(transactions).set({ status: 'void' }).where(eq(transactions.id, s.chk101));
    const h2 = await request('GET', `/banking/reconciliations?account_id=${ctx.checkingId}`, prep.token);
    const row2 = h2.json.reconciliations.find((r: any) => r.id === s.recId);
    expect(row2.signoffs.preparer.state).toBe('stale');
    expect(row2.signoffs.reviewer.state).toBe('stale');
  });
});

// ─── Invalidation ────────────────────────────────────────────────

describe('reconciliation sign-off: invalidation', () => {
  it('(a) a cleared transaction amount edited after signing', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);
    // The app blocks this edit on a reconciled line; a repair / import that
    // bypasses the guard must still flag the signature.
    await db.update(journalLines).set({ credit: '210.0000' })
      .where(and(eq(journalLines.transactionId, s.chk101), eq(journalLines.accountId, ctx.checkingId)));
    await db.update(journalLines).set({ debit: '210.0000' })
      .where(and(eq(journalLines.transactionId, s.chk101), eq(journalLines.accountId, ctx.expenseId)));
    const v = await expectStale(s.recId, prep.token, 'cleared items');
    expect(v.signoffs.preparer.invalidatedDetail).toContain('book balance');
    expect(await auditRows('invalidate')).toHaveLength(2);
    // Lazy invalidation is persisted once: a second read audits nothing new.
    await request('GET', signoffsUrl(s.recId), prep.token);
    expect(await auditRows('invalidate')).toHaveLength(2);
  });

  it('(b) a cleared transaction voided', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);
    await db.update(transactions).set({ status: 'void' }).where(eq(transactions.id, s.chk101));
    await expectStale(s.recId, prep.token, 'cleared items');
  });

  it('(b) a cleared transaction deleted', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);
    await db.delete(journalLines).where(eq(journalLines.transactionId, s.chk101));
    await db.delete(transactions).where(eq(transactions.id, s.chk101));
    await expectStale(s.recId, prep.token, 'cleared items');
  });

  it('(c) a cleared transaction re-dated past the statement date', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);
    await db.update(transactions).set({ txnDate: '2026-02-03' }).where(eq(transactions.id, s.chk101));
    await expectStale(s.recId, prep.token, 'cleared items');
  });

  it('(d) undoing (reopening) the reconciliation invalidates eagerly', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);
    const u = await request('POST', `/banking/reconciliations/${s.recId}/undo`, prep.token);
    expect(u.status).toBe(200);
    const rows = await db.select().from(reconciliationSignoffs).where(eq(reconciliationSignoffs.reconciliationId, s.recId));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.invalidatedReason === 'reconciliation_reopened' && r.invalidatedBy === prep.id)).toBe(true);
    const audits = await auditRows('invalidate');
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.userId === prep.id)).toBe(true);
    const g = await request('GET', signoffsUrl(s.recId), prep.token);
    expect(g.json.signoffs.signable).toBe(false);
    expect(g.json.signoffs.preparer).toMatchObject({ state: 'stale', invalidatedReason: 'reconciliation_reopened' });

    // Re-completing does not revive the old signatures.
    await reconciliation.updateLines(ctx.tenantId, s.recId, [
      { journalLineId: (await bankLine(s.dep)).id, isCleared: true },
      { journalLineId: (await bankLine(s.chk101)).id, isCleared: true },
    ]);
    await reconciliation.complete(ctx.tenantId, s.recId);
    const g2 = await request('GET', signoffsUrl(s.recId), prep.token);
    expect(g2.json.signoffs.preparer.state).toBe('stale');
    expect(g2.json.viewer.canSignPreparer).toBe(true);
  });

  it('(e) a new backdated transaction changes the book balance at D; later-dated activity and recategorizing do not', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);

    // Activity after D: still signed.
    await check('2026-02-05', '25.00', 103);
    // Recategorize the expense side of the cleared check: the bank line is untouched.
    const [newExp] = await db.insert(accounts).values({ tenantId: ctx.tenantId, companyId: ctx.companyId, name: 'Repairs', accountType: 'expense', accountNumber: '6100' }).returning();
    await db.update(journalLines).set({ accountId: newExp!.id })
      .where(and(eq(journalLines.transactionId, s.chk101), eq(journalLines.accountId, ctx.expenseId)));
    let g = await request('GET', signoffsUrl(s.recId), prep.token);
    expect(g.json.signoffs.preparer.state).toBe('signed');
    expect(g.json.signoffs.reviewer.state).toBe('signed');

    // A deposit backdated into January.
    await deposit('2026-01-28', '15.00');
    const v = await expectStale(s.recId, prep.token, 'book balance at the statement date');
    expect(v.signoffs.preparer.invalidatedDetail).toContain('outstanding items');
  });

  it('an outstanding item edited (same book balance via offsetting edit) still flags the outstanding set', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);
    await db.update(transactions).set({ txnDate: '2026-01-21' }).where(eq(transactions.id, s.chk102));
    await expectStale(s.recId, prep.token, 'outstanding items');
  });
});

// ─── Reports ─────────────────────────────────────────────────────

async function makePdf(pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

function packCtx(html: string[]): DocumentSectionContext {
  return {
    tenantId: ctx.tenantId,
    companyId: ctx.companyId,
    companyName: 'Rec Signoff Co',
    rangeStart: '2026-01-01',
    rangeEnd: '2026-01-31',
    options: { omitStatements: true },
    allowAttachments: false,
    allowTransactions: true,
    renderHtml: async (h: string) => { html.push(h); return new Uint8Array(await makePdf(1)); },
  };
}

describe('reconciliation sign-off: reports', () => {
  it('Report Pack bank-rec pages show the sign-offs, then the stale flag', async () => {
    const s = await seedCompletedRec();
    await signBoth(s.recId);
    const html: string[] = [];
    await REPORT_PACK_DOCUMENT_RENDERERS['bank-reconciliations']!(packCtx(html));
    const summary = html[0]!;
    expect(summary).toContain('<th>Signed off</th>');
    expect(summary).toContain('Prepared: /s/ Pat Preparer,');
    expect(summary).toContain('Reviewed: /s/ Riley Reviewer,');
    const page = html[1]!;
    expect(page).toContain('/s/ Pat Preparer');
    expect(page).toContain('/s/ Riley Reviewer');
    expect(page).toMatch(/Signed electronically: Prepared \/s\/ Pat Preparer, \d\d\/\d\d\/\d{4} \d{1,2}:\d\d (AM|PM) UTC/);

    await db.update(transactions).set({ status: 'void' }).where(eq(transactions.id, s.chk101));
    const html2: string[] = [];
    await REPORT_PACK_DOCUMENT_RENDERERS['bank-reconciliations']!(packCtx(html2));
    expect(html2[0]).toContain('Prepared: Stale — data changed after sign-off');
    expect(html2[0]).toContain('Reviewed: Stale — data changed after sign-off');
    expect(html2[1]).toContain('Preparer: Signed off by Pat Preparer on');
    expect(html2[1]).toContain('re-sign required');
  });

  it('Report Pack summary says "Not signed" when nobody signed', async () => {
    await seedCompletedRec();
    const html: string[] = [];
    await REPORT_PACK_DOCUMENT_RENDERERS['bank-reconciliations']!(packCtx(html));
    expect(html[0]).toContain('Prepared: Not signed');
    expect(html[0]).toContain('Reviewed: Not signed');
  });

  it('Reconciliation Detail CSV carries the stamps in the browser time zone', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);
    const r = await request('GET', `/reports/reconciliation-detail?reconciliation_id=${s.recId}&format=csv&tz=America/Chicago`, prep.token);
    expect(r.status).toBe(200);
    const body = r.raw.toString('utf8');
    expect(body).toContain('"Prepared by"');
    expect(body).toContain('/s/ Pat Preparer');
    expect(body).toContain('/s/ Riley Reviewer');
    expect(body).toMatch(/C[DS]T/);
  });

  it.skipIf(!HAS_CHROME)('Reconciliation Detail PDF prints Section E from the stored sign-offs', async () => {
    const s = await seedCompletedRec();
    const { prep } = await signBoth(s.recId);
    const r = await request('GET', `/reports/reconciliation-detail?reconciliation_id=${s.recId}&format=pdf&tz=UTC`, prep.token);
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/pdf');
    const text = (await extractTextLayer(r.raw)).map((p) => p.text).join('\n').replace(/\s+/g, ' ');
    const order = ['Sign-off', '/s/ Pat Preparer', 'Prepared by', '/s/ Riley Reviewer', 'Reviewed by', 'Signed electronically'];
    let at = -1;
    for (const needle of order) {
      const i = text.indexOf(needle, at + 1);
      expect(i, `missing/out of order: ${needle}`).toBeGreaterThan(at);
      at = i;
    }

    await db.update(transactions).set({ status: 'void' }).where(eq(transactions.id, s.chk101));
    const r2 = await request('GET', `/reports/reconciliation-detail?reconciliation_id=${s.recId}&format=pdf&tz=UTC`, prep.token);
    const text2 = (await extractTextLayer(r2.raw)).map((p) => p.text).join('\n').replace(/\s+/g, ' ');
    expect(text2).toContain('Stale — data changed after sign-off');
    expect(text2).toContain('re-sign required');
  }, 90_000);
});
