// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Test support for the receivables suites (ClientLedger P22: credit memos,
// refunds, statements, finance charges): an HTTP harness over the real
// routers, a throwaway company per test and its cleanup, and the golden
// file packages/shared/fixtures/receivables-golden.json. Imported only by
// *.test.ts files.

import 'express-async-errors';
import express, { type Router } from 'express';
import http from 'http';
import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, items, tags, transactionTags, userPermissions, idempotencyKeys, paymentApplications, documentSendEvents,
  depositLines,
} from '../db/schema/index.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as invoiceService from '../services/invoice.service.js';

const Decimal = DecimalLib.default || DecimalLib;

/** Response bodies are checked field by field in the tests. */
type Body = Record<string, any>;
export interface Res { status: number; json: Body }

const here = path.dirname(fileURLToPath(import.meta.url));
export const golden = JSON.parse(
  readFileSync(path.resolve(here, '../../../shared/fixtures/receivables-golden.json'), 'utf8'),
) as Body;

export const m2 = (x: string | number | null | undefined) => new Decimal(String(x ?? '0')).toFixed(2);
export const key = () => crypto.randomBytes(12).toString('hex');
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);

export class Harness {
  server: Server | null = null;
  port = 0;
  tenantIds: string[] = [];
  /** Extra cleanup run before the standard tables (tables added by later rows). */
  extraCleanup: Array<(tenantId: string) => Promise<void>> = [];

  async start(mounts: Array<[string, Router]>) {
    const app = express();
    app.use(express.json({ limit: '12mb' }));
    for (const [p, r] of mounts) app.use(p, r);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      this.server = app.listen(0, () => { this.port = (this.server!.address() as AddressInfo).port; resolve(); });
    });
  }

  async stop() {
    if (this.server) { const s = this.server; await new Promise<void>((r) => s.close(() => r())); this.server = null; }
    while (this.tenantIds.length) await this.clean(this.tenantIds.pop()!);
  }

  request(method: string, pathname: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    return new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
      const req = http.request({
        hostname: '127.0.0.1', port: this.port, path: pathname, method,
        headers: {
          'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
          ...(data ? { 'Content-Length': String(data.length) } : {}), ...headers,
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (ch) => chunks.push(ch));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Body = {};
          try { json = text ? JSON.parse(text) : {}; } catch { json = { text }; }
          resolve({ status: res.statusCode ?? 0, json });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  async clean(tid: string) {
    for (const f of this.extraCleanup) await f(tid);
    const txnIds = (await db.select({ id: transactions.id }).from(transactions).where(eq(transactions.tenantId, tid))).map((r) => r.id);
    if (txnIds.length) await db.delete(depositLines).where(inArray(depositLines.depositId, txnIds));
    await db.delete(documentSendEvents).where(eq(documentSendEvents.tenantId, tid));
    await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tid));
    await db.delete(paymentApplications).where(eq(paymentApplications.tenantId, tid));
    await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
    await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
    await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
    await db.delete(transactions).where(eq(transactions.tenantId, tid));
    await db.delete(items).where(eq(items.tenantId, tid));
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

  /** A company with the golden roles and one client ("Bluestem Veterinary Clinic"). */
  async company(taxRate = '0'): Promise<Co> {
    const reg = await authService.register({
      email: `rcv-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Bluestem Books',
    });
    const tenantId = reg.user.tenantId;
    this.tenantIds.push(tenantId);
    const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
    await db.update(companies).set({ defaultSalesTaxRate: taxRate, defaultPaymentTerms: 'net_30' }).where(eq(companies.id, company!.id));
    const tag = async (t: string) => (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, t)) }))?.id;
    const bank = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
    const revenue = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) }))!.id;
    const expense = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) }))!.id;
    const [customer] = await db.insert(contacts).values({
      tenantId, companyId: company!.id, contactType: 'customer', displayName: 'Bluestem Veterinary Clinic',
    }).returning();
    const [other] = await db.insert(contacts).values({
      tenantId, companyId: company!.id, contactType: 'customer', displayName: 'Prairie Fork Kennels',
    }).returning();
    const roles: Record<string, string> = {
      accounts_receivable: (await tag('accounts_receivable'))!,
      payments_clearing: (await tag('payments_clearing'))!,
      operating: bank,
      sales: revenue,
      income: revenue,
      checking: bank,
      expense,
    };
    const stp = await tag('sales_tax_payable');
    if (stp) roles['sales_tax_payable'] = stp;
    return {
      tenantId, token: reg.tokens.accessToken, companyId: company!.id, userId: reg.user.id,
      customer: customer!.id, other: other!.id, roles, invoices: new Map(), docs: new Map(),
    };
  }

  async invoice(co: Co, inv: { name?: string; number?: string; date: string; dueDate?: string; total: string }, customer = co.customer) {
    const created = await invoiceService.createInvoice(co.tenantId, {
      contactId: customer, txnDate: inv.date, ...(inv.dueDate ? { dueDate: inv.dueDate } : {}), ...(inv.number ? { txnNumber: inv.number } : {}),
      lines: [{ accountId: co.roles['sales'], description: 'Work', quantity: '1', unitPrice: inv.total, isTaxable: false }],
    } as never, co.userId, co.companyId);
    await db.update(transactions).set({ invoiceStatus: 'sent', sentAt: new Date() }).where(eq(transactions.id, created.id));
    if (inv.name) { co.invoices.set(inv.name, created.id); co.docs.set(inv.name, created.id); }
    return created.id;
  }

  /** The bluestem seed of golden cases 1-5 and 7: invoices A and B for the client. */
  async seed(co: Co) {
    for (const inv of golden['seeds'].bluestem.invoices as Array<{ name: string; number: string; date: string; dueDate: string; total: string }>) {
      await this.invoice(co, inv);
    }
  }

  /** A credit memo through the legacy POST /transactions path: one account line. */
  async legacyMemo(co: Co, date: string, total: string, extra: Record<string, unknown> = {}, customer = co.customer) {
    const r = await this.request('POST', '/api/v1/transactions', co.token, {
      txnType: 'credit_memo', txnDate: date, contactId: customer,
      lines: [{ accountId: co.roles['sales'], description: 'Returned', quantity: '1', unitPrice: total }], ...extra,
    });
    if (r.status !== 201) throw new Error(`memo: ${r.status} ${JSON.stringify(r.json)}`);
    return String(r.json['transaction'].id);
  }

  async receive(co: Co, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    return this.request('POST', '/api/v1/payments/receive', co.token, {
      customerId: co.customer, depositTo: co.roles['payments_clearing'], applications: [], ...body,
    }, headers);
  }
}

export interface Co {
  tenantId: string; token: string; companyId: string; userId: string; customer: string; other: string;
  roles: Record<string, string>;
  /** Golden invoice key -> id. */
  invoices: Map<string, string>;
  /** Any golden document key -> id. */
  docs: Map<string, string>;
}

export async function txn(id: string) {
  return (await db.select().from(transactions).where(eq(transactions.id, id)))[0]!;
}

/** A client's A/R balance from posted lines (getBalances' definition), 2 places. */
export async function contactAR(co: Co, contactId = co.customer, asOf?: string) {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS b FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${co.tenantId} AND t.status = 'posted' AND a.system_tag = 'accounts_receivable'
      AND COALESCE(jl.contact_id, t.contact_id) = ${contactId}
      ${asOf ? sql`AND t.txn_date <= ${asOf}::date` : sql``}`);
  return m2((res.rows as Array<{ b: string }>)[0]!.b);
}

/** An account's balance from posted lines, debit positive, 2 places. */
export async function accountBalance(co: Co, accountId: string, asOf?: string) {
  const res = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS b FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${co.tenantId} AND jl.account_id = ${accountId} AND t.status = 'posted'
      ${asOf ? sql`AND t.txn_date <= ${asOf}::date` : sql``}`);
  return m2((res.rows as Array<{ b: string }>)[0]!.b);
}

/** A transaction's lines as role:side:amount strings, sorted. */
export async function lineSet(co: Co, txnId: string) {
  const rows = await db.select().from(journalLines).where(and(eq(journalLines.transactionId, txnId), eq(journalLines.isVoidReversal, false)));
  const roleOf = (id: string) => Object.entries(co.roles).find(([, v]) => v === id)?.[0] ?? id;
  return rows.map((l) => new Decimal(l.debit ?? '0').greaterThan(0)
    ? `${roleOf(l.accountId)}:debit:${m2(l.debit)}` : `${roleOf(l.accountId)}:credit:${m2(l.credit)}`).sort();
}

export const expectedLines = (lines: Array<{ account: string; debit?: string; credit?: string }>) =>
  lines.map((l) => (l.debit !== undefined ? `${l.account}:debit:${l.debit}` : `${l.account}:credit:${l.credit}`)).sort();
