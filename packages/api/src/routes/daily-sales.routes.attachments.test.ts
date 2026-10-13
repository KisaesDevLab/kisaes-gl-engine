// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Attachments on Daily Sales entries and on journal entries entered from a
// JE template.
//   - POST /daily-sales/entries moves the new-entry screen's draft
//     attachments onto the entry (attachable_type 'daily_sales_entry').
//   - POST /daily-sales/entries/:id/post moves them onto the posted journal
//     entry under its own txn_type ('daily_sales'), which is what the
//     transaction detail page, Transaction Report and library query.
//   - The entries list carries an attachment count.
//   - Deleting a draft returns its files to the unfiled pool.
//   - All of it is tenant-scoped and behind the daily_sales permission.
//   - The JE-template entry screen posts through POST /transactions as a
//     journal_entry; its draftAttachmentId links files to the new entry.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines, attachments,
  dailySalesTemplates, dailySalesTemplateLines, dailySalesEntries, dailySalesEntryValues,
} from '../db/schema/index.js';
import { dailySalesRouter } from './daily-sales.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as dailySales from '../services/daily-sales.service.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

function request(method: string, pathname: string, token: string, body?: unknown) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
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
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); }
        catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanTenant(tid: string) {
  await db.delete(attachments).where(eq(attachments.tenantId, tid));
  await db.delete(dailySalesEntryValues).where(eq(dailySalesEntryValues.tenantId, tid));
  await db.delete(dailySalesEntries).where(eq(dailySalesEntries.tenantId, tid));
  await db.delete(dailySalesTemplateLines).where(eq(dailySalesTemplateLines.tenantId, tid));
  await db.delete(dailySalesTemplates).where(eq(dailySalesTemplates.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/daily-sales', dailySalesRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

async function makeTenant(label: string) {
  const reg = await authService.register({
    email: `ds-att-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `DS Attach ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  const revenue = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')),
  });
  if (!bank || !revenue) throw new Error('COA seed missing bank/revenue account');

  const tpl = await dailySales.createTemplate(tenantId, { name: 'Register 1' });
  const withLines = await dailySales.replaceTemplateLines(tenantId, tpl.id, [
    { section: 'sales', label: 'Sales', accountId: revenue.id, normalSide: 'credit', sortOrder: 0, isRequired: false, allowTag: false, isActive: true },
    { section: 'payment', label: 'Cash', accountId: bank.id, normalSide: 'debit', sortOrder: 1, isRequired: false, allowTag: false, isActive: true },
  ]);
  const salesLine = withLines.lines.find((l) => l.label === 'Sales')!;
  const cashLine = withLines.lines.find((l) => l.label === 'Cash')!;
  return { tenantId, token: reg.tokens.accessToken, tpl, salesLine, cashLine, bank, revenue };
}

async function insertAttachment(tenantId: string, attachableType: string, attachableId: string, fileName = 'z-report.pdf') {
  const [a] = await db.insert(attachments).values({
    tenantId, attachableType, attachableId, fileName,
    filePath: `/data/uploads/${fileName}`, fileSize: 1024, mimeType: 'application/pdf',
  }).returning();
  return a!;
}

async function getAttachment(id: string) {
  const [a] = await db.select().from(attachments).where(eq(attachments.id, id));
  return a!;
}

describe('Daily Sales entry attachments', () => {
  it('links draft attachments to the new entry, then to the journal entry on post', async () => {
    const t = await makeTenant('a');
    const draftId = crypto.randomUUID();
    const file = await insertAttachment(t.tenantId, 'draft', draftId);

    const created = await request('POST', '/api/v1/daily-sales/entries', t.token, {
      templateId: t.tpl.id, businessDate: '2026-10-01', draftAttachmentId: draftId,
      values: [{ templateLineId: t.salesLine.id, amount: '125.00' }, { templateLineId: t.cashLine.id, amount: '125.00' }],
    });
    expect(created.status).toBe(201);
    const entryId = created.json.entry.id as string;

    let a = await getAttachment(file.id);
    expect(a.attachableType).toBe('daily_sales_entry');
    expect(a.attachableId).toBe(entryId);

    // Draft entries show the count in the list.
    let list = await request('GET', '/api/v1/daily-sales/entries', t.token);
    expect(list.json.entries.find((e: any) => e.id === entryId).attachmentCount).toBe(1);

    const posted = await request('POST', `/api/v1/daily-sales/entries/${entryId}/post`, t.token);
    expect(posted.status).toBe(200);
    const txnId = posted.json.entry.transactionId as string;
    expect(txnId).toBeTruthy();

    a = await getAttachment(file.id);
    expect(a.attachableType).toBe('daily_sales');
    expect(a.attachableId).toBe(txnId);
    const [txn] = await db.select().from(transactions).where(eq(transactions.id, txnId));
    expect(txn!.txnType).toBe('daily_sales'); // what TransactionDetail queries by

    // Posted entries count the journal entry's files (including ones added
    // later on the transaction detail page).
    await insertAttachment(t.tenantId, 'daily_sales', txnId, 'deposit-slip.pdf');
    list = await request('GET', '/api/v1/daily-sales/entries', t.token);
    expect(list.json.entries.find((e: any) => e.id === entryId).attachmentCount).toBe(2);

    const audits = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, t.tenantId), eq(auditLog.entityType, 'daily_sales_entry_post'), eq(auditLog.entityId, entryId),
    ));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.afterData).toMatchObject({ transactionId: txnId, attachmentsMoved: 1 });
  });

  it('files attached to a saved draft move to the journal entry on post', async () => {
    const t = await makeTenant('b');
    const created = await request('POST', '/api/v1/daily-sales/entries', t.token, {
      templateId: t.tpl.id, businessDate: '2026-10-02',
      values: [{ templateLineId: t.salesLine.id, amount: '10' }, { templateLineId: t.cashLine.id, amount: '10' }],
    });
    const entryId = created.json.entry.id as string;
    const file = await insertAttachment(t.tenantId, 'daily_sales_entry', entryId);
    const posted = await request('POST', `/api/v1/daily-sales/entries/${entryId}/post`, t.token);
    expect(posted.status).toBe(200);
    const a = await getAttachment(file.id);
    expect(a).toMatchObject({ attachableType: 'daily_sales', attachableId: posted.json.entry.transactionId });
  });

  it('a failed post leaves the files on the draft', async () => {
    const t = await makeTenant('c');
    const created = await request('POST', '/api/v1/daily-sales/entries', t.token, {
      templateId: t.tpl.id, businessDate: '2026-10-03', values: [],
    });
    const entryId = created.json.entry.id as string;
    const file = await insertAttachment(t.tenantId, 'daily_sales_entry', entryId);
    const posted = await request('POST', `/api/v1/daily-sales/entries/${entryId}/post`, t.token);
    expect(posted.status).toBe(400); // no amounts
    expect(await getAttachment(file.id)).toMatchObject({ attachableType: 'daily_sales_entry', attachableId: entryId });
  });

  it('deleting a draft returns its files to the unfiled pool', async () => {
    const t = await makeTenant('d');
    const created = await request('POST', '/api/v1/daily-sales/entries', t.token, {
      templateId: t.tpl.id, businessDate: '2026-10-04', values: [],
    });
    const entryId = created.json.entry.id as string;
    const file = await insertAttachment(t.tenantId, 'daily_sales_entry', entryId);
    const del = await request('DELETE', `/api/v1/daily-sales/entries/${entryId}`, t.token);
    expect(del.status).toBe(200);
    expect(await getAttachment(file.id)).toMatchObject({ attachableType: 'draft' });
  });

  it('is tenant-isolated: another tenant\'s draft files are never claimed or counted', async () => {
    const a = await makeTenant('iso-a');
    const b = await makeTenant('iso-b');
    const draftId = crypto.randomUUID();
    // Tenant B has a draft file under the same draft id A will send.
    const bFile = await insertAttachment(b.tenantId, 'draft', draftId);

    const created = await request('POST', '/api/v1/daily-sales/entries', a.token, {
      templateId: a.tpl.id, businessDate: '2026-10-05', draftAttachmentId: draftId, values: [],
    });
    expect(created.status).toBe(201);
    const entryId = created.json.entry.id as string;
    expect(await getAttachment(bFile.id)).toMatchObject({ tenantId: b.tenantId, attachableType: 'draft', attachableId: draftId });

    // A B-tenant row pointed at A's entry id doesn't inflate A's count.
    await insertAttachment(b.tenantId, 'daily_sales_entry', entryId);
    const list = await request('GET', '/api/v1/daily-sales/entries', a.token);
    expect(list.json.entries.find((e: any) => e.id === entryId).attachmentCount).toBe(0);

    // And B cannot post (or see) A's entry.
    const crossPost = await request('POST', `/api/v1/daily-sales/entries/${entryId}/post`, b.token);
    expect(crossPost.status).toBe(404);
  });

  it('refuses a readonly user before any attachment is moved', async () => {
    const t = await makeTenant('perm');
    const [ro] = await db.insert(users).values({
      tenantId: t.tenantId, email: `ds-ro-${suffix()}@example.com`, passwordHash: 'x',
      displayName: 'Readonly', role: 'readonly',
    }).returning();
    await db.insert(userTenantAccess).values({ userId: ro!.id, tenantId: t.tenantId, role: 'readonly' });
    const roToken = (await authService.issueSession({
      userId: ro!.id, tenantId: t.tenantId, role: 'readonly', email: ro!.email,
    } as never)).accessToken;

    const draftId = crypto.randomUUID();
    const file = await insertAttachment(t.tenantId, 'draft', draftId);
    const res = await request('POST', '/api/v1/daily-sales/entries', roToken, {
      templateId: t.tpl.id, businessDate: '2026-10-06', draftAttachmentId: draftId, values: [],
    });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('PERMISSION_DENIED');
    expect(await getAttachment(file.id)).toMatchObject({ attachableType: 'draft', attachableId: draftId });
  });

  it('rejects a malformed draftAttachmentId', async () => {
    const t = await makeTenant('bad');
    const res = await request('POST', '/api/v1/daily-sales/entries', t.token, {
      templateId: t.tpl.id, businessDate: '2026-10-07', draftAttachmentId: 'not-a-uuid', values: [],
    });
    expect(res.status).toBe(400);
  });
});

describe('Journal entry from a JE template — attachments', () => {
  it('links the screen\'s draft attachments to the created journal entry', async () => {
    const t = await makeTenant('je');
    const draftId = crypto.randomUUID();
    const file = await insertAttachment(t.tenantId, 'draft', draftId, 'payroll-register.pdf');

    // Exactly what JournalTemplateEntryPage sends.
    const res = await request('POST', '/api/v1/transactions', t.token, {
      txnType: 'journal_entry', txnDate: '2026-10-01', memo: 'Payroll accrual', basis: 'both',
      draftAttachmentId: draftId,
      lines: [
        { accountId: t.bank.id, debit: '500.0000', credit: '0', description: 'Gross wages', tagId: null },
        { accountId: t.revenue.id, debit: '0', credit: '500.0000', description: 'Accrued payroll', tagId: null },
      ],
    });
    expect(res.status).toBe(201);
    const txnId = res.json.transaction.id as string;
    expect(await getAttachment(file.id)).toMatchObject({ attachableType: 'journal_entry', attachableId: txnId });
  });
});
