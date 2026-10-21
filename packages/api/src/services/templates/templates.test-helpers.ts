// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Shared fixtures for the template / run-due tests (U-62, U-63): a tenant
// with two companies, an owner token, the usual accounts, names and a tag,
// an HTTP server with the template, recurring, transactions and checks
// routers, and a full cleanup. Test-only; imported by *.test.ts files.

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, depositLines, transactionTags, userPermissions, tags, recurringSchedules,
  templateOccurrences, templateTransactionLines, templateTransactionTags, templateTransactions, templateGroups,
} from '../../db/schema/index.js';
import { templatesRouter } from '../../routes/templates.routes.js';
import { recurringRouter } from '../../routes/recurring.routes.js';
import { transactionsRouter } from '../../routes/transactions.routes.js';
import { checksRouter } from '../../routes/checks.routes.js';
import { errorHandler } from '../../middleware/error-handler.js';
import * as authService from '../auth.service.js';
import { __scheduleClock } from './templates.service.js';

// The fixtures use fixed 2026 dates; pin "today" for the auto-schedule
// backdate check (AUTO_BACKDATE_MAX_DAYS) so they stay valid as time passes.
export const PINNED_TODAY = '2026-07-01';
__scheduleClock.today = PINNED_TODAY;

/** Parsed JSON body (loosely typed on purpose, like JSON.parse). */
export interface Res { status: number; json: ReturnType<typeof JSON.parse> }

export interface Co {
  tenantId: string; userId: string; token: string; companyId: string; companyB: string;
  bank: string; savings: string; expense: string; expense2: string; income: string; ar: string; ap: string;
  customer: string; vendor: string; tag: string;
}

export const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

export class TestServer {
  server: Server | null = null;
  port = 0;

  async start() {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/templates', templatesRouter);
    app.use('/api/v1/recurring', recurringRouter);
    app.use('/api/v1/transactions', transactionsRouter);
    app.use('/api/v1/checks', checksRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, () => { this.port = (this.server!.address() as AddressInfo).port; resolve(); });
    });
  }

  async stop() {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  request(method: string, pathname: string, token: string, body?: unknown, companyId?: string): Promise<Res> {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
      const req = http.request({
        hostname: '127.0.0.1', port: this.port, path: pathname, method,
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
}

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

export async function makeCompany(label: string, tenantIds: string[]): Promise<Co> {
  const reg = await authService.register({
    email: `tpl-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `Templates ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [companyA] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [companyB] = await db.insert(companies).values({ tenantId, businessName: `Templates ${label} B`, setupComplete: true }).returning();
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const expenses = await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(2);
  const income = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const [savings] = await db.insert(accounts).values({ tenantId, name: `Savings ${label}`, accountType: 'asset', detailType: 'bank' }).returning();
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Cosmos Granite' }).returning();
  const [tag] = await db.insert(tags).values({ tenantId, name: `Crew ${label}` }).returning();
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: companyA!.id, companyB: companyB!.id,
    bank: bank!.id, savings: savings!.id, expense: expenses[0]!.id, expense2: expenses[1]!.id, income: income!.id,
    ar: await bySystemTag(tenantId, 'accounts_receivable'), ap: await bySystemTag(tenantId, 'accounts_payable'),
    customer: customer!.id, vendor: vendor!.id, tag: tag!.id,
  };
}

export async function cleanTenant(tid: string) {
  await db.delete(templateOccurrences).where(eq(templateOccurrences.tenantId, tid));
  await db.delete(recurringSchedules).where(eq(recurringSchedules.tenantId, tid));
  await db.delete(templateTransactionTags).where(eq(templateTransactionTags.tenantId, tid));
  await db.delete(templateTransactionLines).where(eq(templateTransactionLines.tenantId, tid));
  await db.delete(templateTransactions).where(eq(templateTransactions.tenantId, tid));
  await db.delete(templateGroups).where(eq(templateGroups.tenantId, tid));
  const txnIds = (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, tid))).map((r) => r.id);
  if (txnIds.length) await db.delete(depositLines).where(inArray(depositLines.depositId, txnIds));
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
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

/** A transfer draft (the simplest template). */
export const transferDraft = (c: Co, amount = '49.0000') => ({ fromAccountId: c.bank, toAccountId: c.savings, amount, memo: 'Monthly sweep' });

/** A monthly auto schedule from `nextDate`. */
export const monthlyAuto = (nextDate: string, extra: Record<string, unknown> = {}) =>
  ({ mode: 'auto', frequency: 'monthly', intervalValue: 1, nextDate, ...extra });
