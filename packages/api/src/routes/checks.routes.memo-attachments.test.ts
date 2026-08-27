// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Two Write-Check/print-queue affordances that live in the route layer:
//   - POST /checks relinks the form's draft attachments to the saved check,
//     under attachable_type 'expense' (a check posts as txn_type 'expense',
//     and that is what the transaction detail page queries).
//   - PATCH /checks/:id/memo retypes the memo that will print, and refuses
//     once the check has printed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { inArray, and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, transactions, journalLines, attachments } from '../db/schema/index.js';
import { checksRouter } from './checks.routes.js';
import * as authService from '../services/auth.service.js';
import * as checkService from '../services/check.service.js';

let server: Server | null = null;
let port = 0;

const OWNER_EMAIL = 'checks-memo-attach-owner@example.com';

async function cleanDb() {
  const owned = await db.select({ id: users.tenantId }).from(users).where(inArray(users.email, [OWNER_EMAIL]));
  const tenantIds = [...new Set(owned.map((r) => r.id))];
  if (tenantIds.length === 0) return;
  await db.delete(attachments).where(inArray(attachments.tenantId, tenantIds));
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

function request(method: string, pathname: string, body: unknown, token: string): Promise<{ status: number; json: Record<string, any> }> {
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
          let json: Record<string, any> = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-json */ }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
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
    displayName: 'Memo Owner', companyName: 'Memo Co',
  });
  const tenantId = owner.user.tenantId;

  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  const expense = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')),
  });
  if (!bank || !expense) throw new Error('COA seed missing bank/expense account');

  const checkBody = (over: Record<string, unknown> = {}) => ({
    bankAccountId: bank.id,
    payeeNameOnCheck: 'Acme Plumbing',
    txnDate: '2026-08-27',
    amount: '150.00',
    printLater: true,
    lines: [{ accountId: expense.id, amount: '150.00' }],
    ...over,
  });

  return { owner, tenantId, bank, checkBody, token: owner.tokens.accessToken };
}

describe('POST /checks draft attachments', () => {
  it('relinks the draft attachments to the saved check', async () => {
    const { tenantId, checkBody, token } = await setup();
    const draftId = crypto.randomUUID();

    await db.insert(attachments).values({
      tenantId,
      attachableType: 'draft',
      attachableId: draftId,
      fileName: 'invoice.pdf',
      filePath: '/data/uploads/invoice.pdf',
      fileSize: 1024,
      mimeType: 'application/pdf',
    });

    const res = await request('POST', '/api/v1/checks', checkBody({ draftAttachmentId: draftId }), token);
    expect(res.status).toBe(201);
    const checkId = res.json['check'].id;

    const linked = await db.select().from(attachments)
      .where(and(eq(attachments.tenantId, tenantId), eq(attachments.attachableId, checkId)));
    expect(linked.length).toBe(1);
    // 'expense', not 'check' — TransactionDetail queries by txn_type.
    expect(linked[0]!.attachableType).toBe('expense');
  });

  it('saves the check normally when nothing was attached', async () => {
    const { checkBody, token } = await setup();
    const res = await request('POST', '/api/v1/checks', checkBody(), token);
    expect(res.status).toBe(201);
    expect(res.json['check'].id).toBeTruthy();
  });

  it('stores the payee mailing address the form sends', async () => {
    const { tenantId, checkBody, token } = await setup();
    const res = await request('POST', '/api/v1/checks',
      checkBody({ payeeAddress: '500 Warehouse Rd\nSpringfield, IL 62704' }), token);
    expect(res.status).toBe(201);

    const [txn] = await db.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, res.json['check'].id)));
    expect(txn!.payeeAddress).toBe('500 Warehouse Rd\nSpringfield, IL 62704');
  });
});

describe('PATCH /checks/:id/memo', () => {
  it('retypes the memo on a queued check', async () => {
    const { tenantId, checkBody, token } = await setup();
    const created = await request('POST', '/api/v1/checks', checkBody({ printedMemo: 'Invoice 12' }), token);
    const checkId = created.json['check'].id;

    const res = await request('PATCH', `/api/v1/checks/${checkId}/memo`, { printedMemo: 'Invoice 12 and 13' }, token);
    expect(res.status).toBe(200);
    expect(res.json['printedMemo']).toBe('Invoice 12 and 13');

    const [txn] = await db.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)));
    expect(txn!.printedMemo).toBe('Invoice 12 and 13');
  });

  it('refuses a memo longer than the column', async () => {
    const { checkBody, token } = await setup();
    const created = await request('POST', '/api/v1/checks', checkBody(), token);

    const res = await request('PATCH', `/api/v1/checks/${created.json['check'].id}/memo`,
      { printedMemo: 'x'.repeat(256) }, token);
    expect(res.status).toBe(400);
  });

  it('refuses to edit a check that has already printed', async () => {
    const { tenantId, bank, checkBody, token } = await setup();
    const created = await request('POST', '/api/v1/checks', checkBody(), token);
    const checkId = created.json['check'].id;
    await checkService.printChecks(tenantId, bank!.id, [checkId], 3001, 'voucher');

    const res = await request('PATCH', `/api/v1/checks/${checkId}/memo`, { printedMemo: 'too late' }, token);
    expect(res.status).toBe(400);
    expect(res.json['error'].message).toMatch(/already printed/);
  });

  it('404s an id that is not a check', async () => {
    const { token } = await setup();
    const res = await request('PATCH', `/api/v1/checks/${crypto.randomUUID()}/memo`, { printedMemo: 'nope' }, token);
    expect(res.status).toBe(404);
  });
});
