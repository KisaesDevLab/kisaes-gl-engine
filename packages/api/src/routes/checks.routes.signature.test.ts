// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Signature enforcement on the print flow (/api/v1/checks):
//   - /render with signatureId but no step-up token → 403 STEP_UP_REQUIRED
//   - expired step-up token → 403 STEP_UP_REQUIRED
//   - unauthorized signatureId → 403 even with a valid token
//   - valid token → signed PDF (image XObject painted)
//   - /print records print_signature_id per check: set when under the cap,
//     NULL when over; audit payload carries signed/unsigned counts
//   - unsigned render/print never require step-up

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import zlib from 'zlib';
import jwt from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { inArray, and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, transactions, journalLines, checkSignatures, checkSignatureUsers } from '../db/schema/index.js';
import { checksRouter } from './checks.routes.js';
import * as authService from '../services/auth.service.js';
import * as checkService from '../services/check.service.js';
import * as signatureService from '../services/check-signature.service.js';
import { env } from '../config/env.js';

let server: Server | null = null;
let port = 0;

const OWNER_EMAIL = 'checks-sig-flow-owner@example.com';

// 1×1 transparent PNG — small but fully valid (embedPng parses it).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function cleanDb() {
  const owned = await db.select({ id: users.tenantId }).from(users).where(inArray(users.email, [OWNER_EMAIL]));
  const tenantIds = [...new Set(owned.map((r) => r.id))];
  if (tenantIds.length === 0) return;
  await db.delete(checkSignatureUsers).where(inArray(checkSignatureUsers.tenantId, tenantIds));
  await db.delete(checkSignatures).where(inArray(checkSignatures.tenantId, tenantIds));
  await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
  await db.delete(journalLines).where(inArray(journalLines.tenantId, tenantIds));
  await db.delete(transactions).where(inArray(transactions.tenantId, tenantIds));
  await db.delete(accounts).where(inArray(accounts.tenantId, tenantIds));
  await db.delete(companies).where(inArray(companies.tenantId, tenantIds));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(inArray(users.tenantId, tenantIds))),
  );
  await db.delete(users).where(inArray(users.tenantId, tenantIds));
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
}

async function startApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/checks', checksRouter);
  app.use((err: Error & { statusCode?: number; code?: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err.name === 'ZodError' ? 400 : (err.statusCode ?? 500);
    res.status(status).json({ error: { message: err.message, code: err.code } });
  });
  return new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      port = (server!.address() as AddressInfo).port;
      resolve();
    });
  });
}

function request(method: string, pathname: string, body: unknown, token: string): Promise<{ status: number; body: Buffer; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: '127.0.0.1', port, path: pathname, method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'Content-Length': String(data.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          let json: Record<string, any> = {};
          try { json = JSON.parse(raw.toString('utf8')); } catch { /* pdf */ }
          resolve({ status: res.statusCode ?? 0, body: raw, json });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function hasImagePaint(pdf: Buffer): boolean {
  let idx = 0;
  while (true) {
    const s = pdf.indexOf('stream', idx);
    if (s === -1) break;
    const ds = pdf.indexOf('\n', s) + 1;
    const e = pdf.indexOf('endstream', ds);
    if (e === -1) break;
    try {
      if (/ Do\b/.test(zlib.inflateSync(pdf.subarray(ds, e)).toString('latin1'))) return true;
    } catch { /* not flate */ }
    idx = e + 9;
  }
  return false;
}

beforeEach(async () => {
  await cleanDb();
  await startApp();
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await cleanDb();
});

async function setup() {
  const owner = await authService.register({
    email: OWNER_EMAIL, password: 'password123',
    displayName: 'Flow Owner', companyName: 'Flow Co',
  });
  const tenantId = owner.user.tenantId;

  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  const expense = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')),
  });
  if (!bank || !expense) throw new Error('COA seed missing bank/expense account');

  const mkCheck = (amount: string, payee: string) => checkService.createCheck(tenantId, {
    bankAccountId: bank.id, payeeNameOnCheck: payee, txnDate: '2026-08-12',
    amount, printLater: true,
    lines: [{ accountId: expense.id, amount }],
  }, owner.user.id);

  const under = await mkCheck('100.00', 'UNDER CAP LLC');
  const over = await mkCheck('9000.00', 'OVER CAP LLC');

  const signature = await signatureService.createSignature(tenantId, owner.user.id,
    { label: 'Flow Signer', maxAmount: '5000.0000' },
    { buffer: TINY_PNG, mimetype: 'image/png' });
  const { stepUpToken } = signatureService.issueStepUpToken(owner.user.id, tenantId);

  return { owner, tenantId, bank, under, over, signature, stepUpToken };
}

describe('signature enforcement on /render and /print', () => {
  it('403s a signed render without (or with an expired) step-up token', async () => {
    const { owner, tenantId, under, signature } = await setup();
    const noToken = await request('POST', '/api/v1/checks/render', {
      checkIds: [under.id], format: 'voucher', signatureId: signature.id,
    }, owner.tokens.accessToken);
    expect(noToken.status).toBe(403);
    expect(noToken.json['error'].code).toBe('STEP_UP_REQUIRED');

    const expired = jwt.sign({ userId: owner.user.id, tenantId, checks_stepup: true }, env.JWT_SECRET, { expiresIn: -1 });
    const stale = await request('POST', '/api/v1/checks/render', {
      checkIds: [under.id], format: 'voucher', signatureId: signature.id, stepUpToken: expired,
    }, owner.tokens.accessToken);
    expect(stale.status).toBe(403);
    expect(stale.json['error'].code).toBe('STEP_UP_REQUIRED');
  });

  it('renders a signed PDF with a valid token; unsigned render needs none', async () => {
    const { owner, under, signature, stepUpToken } = await setup();
    const signed = await request('POST', '/api/v1/checks/render', {
      checkIds: [under.id], format: 'voucher', signatureId: signature.id, stepUpToken,
    }, owner.tokens.accessToken);
    expect(signed.status).toBe(200);
    expect(signed.body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(hasImagePaint(signed.body)).toBe(true);

    const unsigned = await request('POST', '/api/v1/checks/render', {
      checkIds: [under.id], format: 'voucher',
    }, owner.tokens.accessToken);
    expect(unsigned.status).toBe(200);
    expect(hasImagePaint(unsigned.body)).toBe(false);
  });

  it('records print_signature_id only on under-cap checks and counts both in the audit row', async () => {
    const { owner, tenantId, bank, under, over, signature, stepUpToken } = await setup();
    const res = await request('POST', '/api/v1/checks/print', {
      bankAccountId: bank.id, checkIds: [under.id, over.id], startingCheckNumber: 5001,
      format: 'voucher', signatureId: signature.id, stepUpToken,
    }, owner.tokens.accessToken);
    expect(res.status).toBe(200);

    const underRow = await db.query.transactions.findFirst({ where: eq(transactions.id, under.id) });
    const overRow = await db.query.transactions.findFirst({ where: eq(transactions.id, over.id) });
    expect(underRow!.printSignatureId).toBe(signature.id);
    expect(overRow!.printSignatureId).toBeNull();

    const audits = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'check_print'),
    ));
    expect(audits).toHaveLength(1);
    const after = audits[0]!.afterData as any;
    const payload = typeof after === 'string' ? JSON.parse(after) : after;
    expect(payload).toMatchObject({ signatureId: signature.id, signedCount: 1, unsignedCount: 1 });
  });

  it('403s printing with a signature the user is not authorized for', async () => {
    const { owner, tenantId, bank, under, signature, stepUpToken } = await setup();
    // Demote the caller: make a bookkeeper who has no assignment.
    const staff = await authService.inviteUser(tenantId, {
      email: 'checks-sig-flow-staff@example.com', displayName: 'Staff', role: 'bookkeeper',
    }, owner.user.id);
    const staffLogin = await authService.login({ email: staff.user.email, password: staff.temporaryPassword! });
    const staffToken = signatureService.issueStepUpToken(staff.user.id, tenantId);
    const res = await request('POST', '/api/v1/checks/print', {
      bankAccountId: bank.id, checkIds: [under.id], startingCheckNumber: 6001,
      format: 'voucher', signatureId: signature.id, stepUpToken: staffToken.stepUpToken,
    }, staffLogin.tokens.accessToken);
    expect(res.status).toBe(403);
    expect(res.json['error'].code).not.toBe('STEP_UP_REQUIRED'); // authz failure, not step-up
    // cleanup the extra user's session rows via cleanDb (same tenant)
  });

  it('unsigned print stays untouched by step-up and records no signature', async () => {
    const { owner, bank, under } = await setup();
    const res = await request('POST', '/api/v1/checks/print', {
      bankAccountId: bank.id, checkIds: [under.id], startingCheckNumber: 7001, format: 'voucher',
    }, owner.tokens.accessToken);
    expect(res.status).toBe(200);
    const row = await db.query.transactions.findFirst({ where: eq(transactions.id, under.id) });
    expect(row!.printSignatureId).toBeNull();
    expect(row!.checkNumber).toBe(7001);
  });
});
