// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Recurring fixes (U-64, U-66 — capability recurring-guard-v1):
//   - the generic copy path keeps each line's name and billable mark (a new
//     occurrence's billable line is 'unbilled'), the journal entry's basis
//     and adjusting flag, and records the schedule (recurringScheduleId,
//     source 'recurring');
//   - the bill path copies the template amounts exactly (4 places);
//   - PUT /recurring/:id with expectedUpdatedAt is 409 STALE_SCHEDULE when
//     the schedule changed since it was read.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, transactions, journalLines, contacts,
  recurringSchedules, userTenantAccess, userPermissions, transactionTags,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';
import * as billService from './bill.service.js';
import * as recurring from './recurring.service.js';
import { recurringRouter } from '../routes/recurring.routes.js';
import { errorHandler } from '../middleware/error-handler.js';

let tenantId = '', userId = '', token = '', companyId = '', bankId = '', expId = '', customerId = '', vendorId = '';
let server: Server | null = null;
let port = 0;

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(recurringSchedules).where(eq(recurringSchedules.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tenantId));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

function call(method: string, pathname: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

beforeEach(async () => {
  await cleanDb();
  const reg = await authService.register({
    email: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Rec', companyName: 'Rec Co',
  });
  tenantId = reg.user.tenantId; userId = reg.user.id; token = reg.tokens.accessToken;
  companyId = (await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1))[0]!.id;
  bankId = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  expId = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1))[0]!.id;
  customerId = (await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera' }).returning())[0]!.id;
  vendorId = (await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Landlord' }).returning())[0]!.id;

  const app = express();
  app.use(express.json());
  app.use('/api/v1/recurring', recurringRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  await cleanDb();
});

describe('recurring copy path (U-64)', () => {
  it('keeps line names, billable marks, basis, adjusting flag and records the schedule', async () => {
    const template = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-01-05', contactId: vendorId, total: '80.0000',
      lines: [
        { accountId: expId, debit: '80.0000', credit: '0', contactId: customerId, isBillable: true },
        { accountId: bankId, debit: '0', credit: '80.0000' },
      ],
    }, userId, companyId);
    // The template's own billable line was billed meanwhile: a new
    // occurrence still starts unbilled.
    await db.update(journalLines).set({ billedStatus: 'billed' })
      .where(and(eq(journalLines.transactionId, template.id), eq(journalLines.isBillable, true)));
    const sched = await recurring.create(tenantId, template.id, { frequency: 'monthly', startDate: '2026-02-05' }, userId);
    const txn = await recurring.postNext(tenantId, sched!.id) as { id: string };

    const [header] = await db.select().from(transactions).where(eq(transactions.id, txn.id));
    // Since 0225 every recurring posting names its template (U-62 provenance).
    expect(header).toMatchObject({ recurringScheduleId: sched!.id, source: 'recurring', sourceId: sched!.templateId, txnDate: '2026-02-05', companyId });
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txn.id)).orderBy(journalLines.lineOrder);
    expect(lines.map((l) => [l.contactId, l.isBillable, l.billedStatus])).toEqual([
      [customerId, true, 'unbilled'],
      [null, false, null],
    ]);

    const je = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-01-31', basis: 'accrual', isAdjusting: true,
      lines: [
        { accountId: expId, debit: '12.3456', credit: '0' },
        { accountId: bankId, debit: '0', credit: '12.3456' },
      ],
    }, userId, companyId);
    const jeSched = await recurring.create(tenantId, je.id, { frequency: 'monthly', startDate: '2026-02-28' }, userId);
    const jeTxn = await recurring.postNext(tenantId, jeSched!.id) as { id: string };
    const [jeHeader] = await db.select().from(transactions).where(eq(transactions.id, jeTxn.id));
    expect(jeHeader).toMatchObject({ basis: 'accrual', isAdjusting: true, recurringScheduleId: jeSched!.id });
  });

  it('a recurring bill copies the template amounts exactly', async () => {
    const bill = await billService.createBill(tenantId, {
      contactId: vendorId, txnDate: '2026-01-10', termsDays: 30,
      lines: [{ accountId: expId, amount: '10.1234' }, { accountId: expId, amount: '0.0001' }],
    }, userId, companyId);
    const sched = await recurring.create(tenantId, bill.id, { frequency: 'monthly', startDate: '2026-02-10' }, userId);
    const next = await recurring.postNext(tenantId, sched!.id) as { id: string; total: string | null };
    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.transactionId, next.id), eq(journalLines.accountId, expId)));
    expect(lines.map((l) => l.debit).sort()).toEqual(['0.0001', '10.1234']);
    expect(next.total).toBe('10.1235');
  });
});

describe('recurring PUT version guard (U-66)', () => {
  it('expectedUpdatedAt must match; omitted keeps the old behavior', async () => {
    const template = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-01-31',
      lines: [{ accountId: expId, debit: '5', credit: '0' }, { accountId: bankId, debit: '0', credit: '5' }],
    }, userId, companyId);
    const created = await call('POST', '/api/v1/recurring', { templateTransactionId: template.id, frequency: 'monthly', startDate: '2026-02-28' });
    expect(created.status).toBe(201);
    const id = created.json.schedule.id;
    const readAt = created.json.schedule.updatedAt as string;

    const first = await call('PUT', `/api/v1/recurring/${id}`, { name: 'Rent', expectedUpdatedAt: readAt });
    expect(first.status).toBe(200);
    expect(first.json.schedule.name).toBe('Rent');

    const stale = await call('PUT', `/api/v1/recurring/${id}`, { name: 'Overwrite', expectedUpdatedAt: readAt });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE_SCHEDULE');
    expect((await recurring.getById(tenantId, id)).name).toBe('Rent');

    const fresh = await call('PUT', `/api/v1/recurring/${id}`, { name: 'Rent 2', expectedUpdatedAt: first.json.schedule.updatedAt });
    expect(fresh.status).toBe(200);
    const unguarded = await call('PUT', `/api/v1/recurring/${id}`, { name: 'Rent 3' });
    expect(unguarded.status).toBe(200);
    expect((await call('PUT', `/api/v1/recurring/${id}`, { expectedUpdatedAt: 'yesterday' })).status).toBe(400);
  });

  it('concurrent edits: one guarded edit wins, and each audit row shows the row it replaced (L7)', async () => {
    const template = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry', txnDate: '2026-01-31',
      lines: [{ accountId: expId, debit: '5', credit: '0' }, { accountId: bankId, debit: '0', credit: '5' }],
    }, userId, companyId);
    const sched = await recurring.create(tenantId, template.id, { frequency: 'monthly', startDate: '2026-02-28' }, userId);
    const readAt = sched!.updatedAt!.toISOString();

    const guarded = await Promise.allSettled([
      recurring.update(tenantId, sched!.id, { name: 'One', expectedUpdatedAt: readAt }, userId),
      recurring.update(tenantId, sched!.id, { name: 'Two', expectedUpdatedAt: readAt }, userId),
    ]);
    expect(guarded.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = guarded.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason.code).toBe('STALE_SCHEDULE');

    await Promise.all(['A', 'B', 'C'].map((name) => recurring.update(tenantId, sched!.id, { name }, userId)));
    const rows = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'recurring_schedule'),
      eq(auditLog.entityId, sched!.id), eq(auditLog.action, 'update'),
    )).orderBy(auditLog.id);
    expect(rows).toHaveLength(4);
    for (let i = 1; i < rows.length; i++) {
      expect((rows[i]!.beforeData as any).name).toBe((rows[i - 1]!.afterData as any).name);
    }
  });
});
