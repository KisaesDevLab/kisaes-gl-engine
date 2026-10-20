// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Daily sales and the closing date (U-57, daily-sales-lock-v1):
//   - posting or voiding an entry dated on or before the closing date is
//     423 TB_PERIOD_LOCKED; with a closing-date password set, a wrong
//     `closingPassword` is 403 CLOSING_PASSWORD_INVALID and the right one
//     posts / voids (one closing_date_override audit row, no password in it);
//   - templates and entries are company-scoped;
//   - entry amounts are decimal strings only: a JSON number is a 400.

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
  dailySalesTemplates, dailySalesTemplateLines, dailySalesEntries, dailySalesEntryValues, transactionTags,
} from '../db/schema/index.js';
import { dailySalesRouter } from './daily-sales.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as dailySales from '../services/daily-sales.service.js';

const CLOSING_PHRASE = ['ds', 'closing', 'phrase', '7'].join('-');
const WRONG_PHRASE = ['not', 'it', '42'].join('-');

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

function request(method: string, pathname: string, token: string, body?: unknown, companyId?: string) {
  return new Promise<{ status: number; json: any }>((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(companyId ? { 'X-Company-Id': companyId } : {}),
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
  await db.delete(dailySalesEntryValues).where(eq(dailySalesEntryValues.tenantId, tid));
  await db.delete(dailySalesEntries).where(eq(dailySalesEntries.tenantId, tid));
  await db.delete(dailySalesTemplateLines).where(eq(dailySalesTemplateLines.tenantId, tid));
  await db.delete(dailySalesTemplates).where(eq(dailySalesTemplates.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
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

interface Setup {
  tenantId: string; userId: string; token: string; companyId: string; companyB: string;
  templateId: string; salesLineId: string; cashLineId: string;
}

async function setup(): Promise<Setup> {
  const reg = await authService.register({
    email: `ds-lock-${suffix()}@example.com`, password: 'password123',
    displayName: 'Owner', companyName: `DS Lock ${suffix()}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [companyB] = await db.insert(companies).values({ tenantId, businessName: 'DS Lock B', setupComplete: true }).returning();
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const revenue = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const tpl = await dailySales.createTemplate(tenantId, { name: 'Register A' }, reg.user.id, company!.id);
  const withLines = await dailySales.replaceTemplateLines(tenantId, tpl.id, [
    { section: 'sales', label: 'Sales', accountId: revenue!.id, normalSide: 'credit', sortOrder: 0, isRequired: false, allowTag: false, isActive: true },
    { section: 'payment', label: 'Cash', accountId: bank!.id, normalSide: 'debit', sortOrder: 1, isRequired: false, allowTag: false, isActive: true },
  ]);
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: company!.id, companyB: companyB!.id,
    templateId: tpl.id,
    salesLineId: withLines.lines.find((l) => l.label === 'Sales')!.id,
    cashLineId: withLines.lines.find((l) => l.label === 'Cash')!.id,
  };
}

let s: Setup;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/daily-sales', dailySalesRouter);
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

const draft = (date: string, amount: unknown = '250.00') => ({
  templateId: s.templateId, businessDate: date,
  values: [
    { templateLineId: s.salesLineId, amount },
    { templateLineId: s.cashLineId, amount },
  ],
});

describe('daily sales closing date (U-57)', () => {
  it('locks posting and voiding in a closed period; the closing-date password opens it', async () => {
    const created = await request('POST', '/api/v1/daily-sales/entries', s.token, draft('2026-06-15'));
    expect(created.status).toBe(201);
    const id = created.json.entry.id;

    await db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, s.companyId));
    const locked = await request('POST', `/api/v1/daily-sales/entries/${id}/post`, s.token, {});
    expect(locked.status).toBe(423);
    expect(locked.json.error.code).toBe('TB_PERIOD_LOCKED');

    await db.update(companies).set({ closingPasswordHash: await bcrypt.hash(CLOSING_PHRASE, 4) }).where(eq(companies.id, s.companyId));
    const noPassword = await request('POST', `/api/v1/daily-sales/entries/${id}/post`, s.token, { overrideConfirmed: true });
    expect(noPassword.status).toBe(423);
    expect(noPassword.json.error.details.closingPasswordRequired).toBe(true);
    const wrong = await request('POST', `/api/v1/daily-sales/entries/${id}/post`, s.token, { closingPassword: WRONG_PHRASE });
    expect(wrong.status).toBe(403);
    expect(wrong.json.error.code).toBe('CLOSING_PASSWORD_INVALID');
    const stillDraft = await db.query.dailySalesEntries.findFirst({ where: eq(dailySalesEntries.id, id) });
    expect(stillDraft!.status).toBe('draft');

    const posted = await request('POST', `/api/v1/daily-sales/entries/${id}/post`, s.token, { closingPassword: CLOSING_PHRASE });
    expect(posted.status).toBe(200);
    expect(posted.json.entry.status).toBe('posted');

    const voidLocked = await request('POST', `/api/v1/daily-sales/entries/${id}/void`, s.token, {});
    expect(voidLocked.status).toBe(423);
    const voided = await request('POST', `/api/v1/daily-sales/entries/${id}/void`, s.token, { closingPassword: CLOSING_PHRASE });
    expect(voided.status).toBe(200);
    expect(voided.json.entry.status).toBe('void');

    const overrides = await db.select().from(auditLog).where(and(
      eq(auditLog.tenantId, s.tenantId), eq(auditLog.entityType, 'closing_date_override'),
    ));
    expect(overrides.length).toBe(2);
    expect(JSON.stringify(overrides)).not.toContain(CLOSING_PHRASE);
  });

  it('posts an open-period entry without a password', async () => {
    await db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, s.companyId));
    const created = await request('POST', '/api/v1/daily-sales/entries', s.token, draft('2026-07-02'));
    const posted = await request('POST', `/api/v1/daily-sales/entries/${created.json.entry.id}/post`, s.token);
    expect(posted.status).toBe(200);
    expect(posted.json.entry.status).toBe('posted');
  });

  it('accepts string amounts only', async () => {
    const asNumber = await request('POST', '/api/v1/daily-sales/entries', s.token, draft('2026-07-02', 250));
    expect(asNumber.status).toBe(400);
    const fivePlaces = await request('POST', '/api/v1/daily-sales/entries', s.token, draft('2026-07-02', '1.00001'));
    expect(fivePlaces.status).toBe(400);
    const preview = await request('POST', '/api/v1/daily-sales/entries/preview', s.token, {
      templateId: s.templateId, values: [{ templateLineId: s.salesLineId, amount: 10.5 }],
    });
    expect(preview.status).toBe(400);
    const ok = await request('POST', '/api/v1/daily-sales/entries', s.token, draft('2026-07-02', '-0.0001'));
    expect(ok.status).toBe(201);
  });

  it('keeps templates and entries inside their company', async () => {
    const entry = await request('POST', '/api/v1/daily-sales/entries', s.token, draft('2026-07-02'), s.companyId);
    expect(entry.status).toBe(201);

    const listA = await request('GET', '/api/v1/daily-sales/templates', s.token, undefined, s.companyId);
    expect(listA.json.templates.map((t: any) => t.id)).toContain(s.templateId);
    const listB = await request('GET', '/api/v1/daily-sales/templates', s.token, undefined, s.companyB);
    expect(listB.json.templates.map((t: any) => t.id)).not.toContain(s.templateId);

    const tplB = await request('GET', `/api/v1/daily-sales/templates/${s.templateId}`, s.token, undefined, s.companyB);
    expect(tplB.status).toBe(404);
    const entriesB = await request('GET', '/api/v1/daily-sales/entries', s.token, undefined, s.companyB);
    expect(entriesB.json.entries).toEqual([]);
    const entryB = await request('GET', `/api/v1/daily-sales/entries/${entry.json.entry.id}`, s.token, undefined, s.companyB);
    expect(entryB.status).toBe(404);
    const postB = await request('POST', `/api/v1/daily-sales/entries/${entry.json.entry.id}/post`, s.token, {}, s.companyB);
    expect(postB.status).toBe(404);
    const draftB = await request('POST', '/api/v1/daily-sales/entries', s.token, draft('2026-07-02'), s.companyB);
    expect(draftB.status).toBe(404);
    const entriesA = await request('GET', '/api/v1/daily-sales/entries', s.token, undefined, s.companyId);
    expect(entriesA.json.entries.map((e: any) => e.id)).toContain(entry.json.entry.id);
  });
});
