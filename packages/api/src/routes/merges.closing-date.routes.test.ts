// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Contact and tag merges and the closing date (U-47, merge-closing-date-v1):
//   - a merge that only moves open-period transactions needs no password;
//   - one that would move a transaction dated on or before the closing date
//     is 423 TB_PERIOD_LOCKED without `closingPassword`, 403
//     CLOSING_PASSWORD_INVALID with a wrong one, and changes nothing;
//   - with the right one it merges, and the audit row (written in the same
//     transaction) lists the transaction ids and marks the override.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  transactionTags, contacts, tags,
} from '../db/schema/index.js';
import { contactsRouter } from './contacts.routes.js';
import { tagsRouter } from './tags.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';

const CLOSING_PHRASE = ['merge', 'closing', 'phrase', '9'].join('-');
const WRONG_PHRASE = ['not', 'it', '17'].join('-');

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

function request(method: string, pathname: string, token: string, body?: unknown) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
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
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(tags).where(eq(tags.tenantId, tid));
  await db.delete(contacts).where(eq(contacts.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

interface Setup {
  tenantId: string; userId: string; token: string; companyId: string;
  bankId: string; expenseId: string;
}

async function setup(): Promise<Setup> {
  const reg = await authService.register({
    email: `merge-lock-${suffix()}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: `Merge Lock ${suffix()}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const expense = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) });
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: company!.id,
    bankId: bank!.id, expenseId: expense!.id,
  };
}

/** A balanced two-line expense; header and lines carry the contact, lines the tag. */
async function seedTxn(date: string, opts: { contactId?: string; tagId?: string }) {
  const [txn] = await db.insert(transactions).values({
    tenantId: s.tenantId, companyId: s.companyId, txnType: 'expense', txnDate: date,
    contactId: opts.contactId ?? null, total: '10.0000',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId: s.tenantId, companyId: s.companyId, transactionId: txn!.id, accountId: s.expenseId, debit: '10.0000', credit: '0', contactId: opts.contactId ?? null, tagId: opts.tagId ?? null },
    { tenantId: s.tenantId, companyId: s.companyId, transactionId: txn!.id, accountId: s.bankId, debit: '0', credit: '10.0000', tagId: opts.tagId ?? null },
  ]);
  if (opts.tagId) {
    await db.insert(transactionTags).values({ tenantId: s.tenantId, companyId: s.companyId, transactionId: txn!.id, tagId: opts.tagId });
  }
  return txn!.id;
}

async function newContact(name: string) {
  const [c] = await db.insert(contacts).values({ tenantId: s.tenantId, contactType: 'vendor', displayName: `${name} ${suffix()}` }).returning();
  return c!.id;
}

async function newTag(name: string) {
  const [t] = await db.insert(tags).values({ tenantId: s.tenantId, name: `${name} ${suffix()}` }).returning();
  return t!.id;
}

async function closeBooks(withPassword: boolean) {
  await db.update(companies).set({
    lockDate: '2026-06-30',
    ...(withPassword ? { closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) } : {}),
  }).where(eq(companies.id, s.companyId));
}

async function auditRows(entityType: string) {
  return db.select().from(auditLog).where(and(eq(auditLog.tenantId, s.tenantId), eq(auditLog.entityType, entityType)));
}

/** after_data as an object (jsonb comes back parsed; a string is parsed). */
function afterOf(row: { afterData: unknown }): any {
  return typeof row.afterData === 'string' ? JSON.parse(row.afterData) : row.afterData;
}

let s: Setup;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/contacts', contactsRouter);
  app.use('/api/v1/tags', tagsRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  s = await setup();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('contact merge and the closing date (U-47)', () => {
  it('merges open-period transactions without a password and audits their ids', async () => {
    await closeBooks(true);
    const source = await newContact('Dup');
    const target = await newContact('Keep');
    const txnId = await seedTxn('2026-07-15', { contactId: source });

    const res = await request('POST', '/api/v1/contacts/merge', s.token, { sourceId: source, targetId: target });
    expect(res.status).toBe(200);

    const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, txnId) });
    expect(txn!.contactId).toBe(target);
    const rows = await auditRows('contact');
    expect(rows.length).toBe(1);
    const after = afterOf(rows[0]!);
    expect(after.merged_into).toBe(target);
    expect(after.transactions).toEqual({ count: 1, ids: [txnId], truncated: false });
    expect(after.closedPeriodOverride).toBeNull();
    expect(await auditRows('closing_date_override')).toEqual([]);
  });

  it('refuses a closed-period merge without the password and changes nothing', async () => {
    await closeBooks(false);
    const source = await newContact('Dup');
    const target = await newContact('Keep');
    const closedId = await seedTxn('2026-06-10', { contactId: source });
    const openId = await seedTxn('2026-07-10', { contactId: source });

    const locked = await request('POST', '/api/v1/contacts/merge', s.token, { sourceId: source, targetId: target });
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe('TB_PERIOD_LOCKED');
    expect(locked.json.error.details.lockDate).toBe('2026-06-30');

    await closeBooks(true);
    const confirmedOnly = await request('POST', '/api/v1/contacts/merge', s.token, { sourceId: source, targetId: target, overrideConfirmed: true });
    expect(confirmedOnly.status).toBe(423);
    expect(confirmedOnly.json.error.details.closingPasswordRequired).toBe(true);

    const wrong = await request('POST', '/api/v1/contacts/merge', s.token, { sourceId: source, targetId: target, closingPassword: WRONG_PHRASE });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');

    for (const id of [closedId, openId]) {
      const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, id) });
      expect(txn!.contactId).toBe(source);
    }
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, closedId));
    expect(lines.find((l) => l.contactId !== null)!.contactId).toBe(source);
    const src = await db.query.contacts.findFirst({ where: eq(contacts.id, source) });
    expect(src!.isActive).toBe(true);
    expect(await auditRows('contact')).toEqual([]);
    expect(await auditRows('closing_date_override')).toEqual([]);
  });

  it('merges a closed period with the password; the audit lists the ids and marks the override', async () => {
    await closeBooks(true);
    const source = await newContact('Dup');
    const target = await newContact('Keep');
    const closedId = await seedTxn('2026-06-10', { contactId: source });
    const openId = await seedTxn('2026-07-10', { contactId: source });

    const res = await request('POST', '/api/v1/contacts/merge', s.token, { sourceId: source, targetId: target, closingPassword: CLOSING_PHRASE });
    expect(res.status).toBe(200);
    expect(res.json.contact.id).toBe(target);

    for (const id of [closedId, openId]) {
      const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, id) });
      expect(txn!.contactId).toBe(target);
    }
    const rows = await auditRows('contact');
    expect(rows.length).toBe(1);
    expect(rows[0]!.userId).toBe(s.userId);
    const after = afterOf(rows[0]!);
    expect(after.transactions.count).toBe(2);
    expect([...after.transactions.ids].sort()).toEqual([closedId, openId].sort());
    expect(after.closedPeriodOverride).toMatchObject({
      method: 'password', count: 1, ids: [closedId], truncated: false,
      lockDates: [{ companyId: s.companyId, lockDate: '2026-06-30' }],
    });
    const overrides = await auditRows('closing_date_override');
    expect(overrides.length).toBe(1);
    expect(afterOf(overrides[0]!)).toMatchObject({ method: 'password', context: 'contact_merge', mergeSourceId: source, transactionCount: 1 });
    expect(JSON.stringify([...rows, ...overrides])).not.toContain(CLOSING_PHRASE);
  });
});

describe('tag merge and the closing date (U-47)', () => {
  it('merges open-period header and line tags without a password', async () => {
    await closeBooks(true);
    const source = await newTag('Old');
    const target = await newTag('New');
    const txnId = await seedTxn('2026-07-15', { tagId: source });

    const res = await request('POST', '/api/v1/tags/merge', s.token, { sourceTagId: source, targetTagId: target });
    expect(res.status).toBe(200);

    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, txnId));
    expect(lines.every((l) => l.tagId === target)).toBe(true);
    const junction = await db.select().from(transactionTags).where(eq(transactionTags.transactionId, txnId));
    expect(junction.map((j) => j.tagId)).toEqual([target]);
    expect(await db.query.tags.findFirst({ where: eq(tags.id, source) })).toBeUndefined();
    const rows = await auditRows('tag');
    expect(rows.length).toBe(1);
    const after = afterOf(rows[0]!);
    expect(after.transactions).toEqual({ count: 1, ids: [txnId], truncated: false });
    expect(after.moved.journalLines).toBe(2);
    expect(after.closedPeriodOverride).toBeNull();
  });

  it('refuses a closed-period tag merge without the password and changes nothing', async () => {
    await closeBooks(true);
    const source = await newTag('Old');
    const target = await newTag('New');
    const closedId = await seedTxn('2026-05-31', { tagId: source });

    const locked = await request('POST', '/api/v1/tags/merge', s.token, { sourceTagId: source, targetTagId: target });
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe('TB_PERIOD_LOCKED');
    const wrong = await request('POST', '/api/v1/tags/merge', s.token, { sourceTagId: source, targetTagId: target, closingPassword: WRONG_PHRASE });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');

    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, closedId));
    expect(lines.every((l) => l.tagId === source)).toBe(true);
    const junction = await db.select().from(transactionTags).where(eq(transactionTags.transactionId, closedId));
    expect(junction.map((j) => j.tagId)).toEqual([source]);
    expect(await db.query.tags.findFirst({ where: eq(tags.id, source) })).toBeDefined();
    expect(await auditRows('tag')).toEqual([]);
  });

  it('merges a closed-period tag with the password; the audit lists the ids', async () => {
    await closeBooks(true);
    const source = await newTag('Old');
    const target = await newTag('New');
    const closedId = await seedTxn('2026-05-31', { tagId: source });

    const res = await request('POST', '/api/v1/tags/merge', s.token, { sourceTagId: source, targetTagId: target, closingPassword: CLOSING_PHRASE });
    expect(res.status).toBe(200);
    expect(res.json.tag.id).toBe(target);

    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, closedId));
    expect(lines.every((l) => l.tagId === target)).toBe(true);
    const rows = await auditRows('tag');
    expect(rows.length).toBe(1);
    expect(rows[0]!.action).toBe('delete');
    expect(rows[0]!.userId).toBe(s.userId);
    const after = afterOf(rows[0]!);
    expect(after.transactions).toEqual({ count: 1, ids: [closedId], truncated: false });
    expect(after.closedPeriodOverride).toMatchObject({ method: 'password', count: 1, ids: [closedId] });
    const overrides = await auditRows('closing_date_override');
    expect(overrides.length).toBe(1);
    expect(afterOf(overrides[0]!)).toMatchObject({ context: 'tag_merge', mergeTargetId: target });
    expect(JSON.stringify([...rows, ...overrides])).not.toContain(CLOSING_PHRASE);
  });

  it('refuses to merge a tag into itself', async () => {
    const tag = await newTag('Self');
    const res = await request('POST', '/api/v1/tags/merge', s.token, { sourceTagId: tag, targetTagId: tag });
    expect(res.status).toBe(400);
    expect(await db.query.tags.findFirst({ where: eq(tags.id, tag) })).toBeDefined();
  });
});
