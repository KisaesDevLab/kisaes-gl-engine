// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Test-only harness for sensitive accounts (U-33): one tenant with an owner
// (sees everything) and a legacy bookkeeper with no permission row (full
// access except `sensitive_accounts`), served by the REAL app so the viewer
// store in `authenticate` and the reports refusal table run as in
// production. Not imported by any production module.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contacts, items, tags, tenants, users } from '../db/schema/index.js';
import { createCompanyForTenant } from '../services/company.service.js';
import * as accountsService from '../services/accounts.service.js';
import * as ledger from '../services/ledger.service.js';

export type Who = 'owner' | 'bk';

export interface CallResult {
  status: number;
  text: string;
  json: any;
}

export interface SensitiveHarness {
  tenantId: string;
  companyId: string;
  ownerId: string;
  bookkeeperId: string;
  /** Accounts every fixture has. `wages` is marked sensitive by `markWages`. */
  acct: { bank: string; wages: string; wagesSub: string; supplies: string; sales: string; ar: string; ap: string };
  call: (who: Who, method: string, path: string, body?: unknown) => Promise<CallResult>;
  markWages: () => Promise<void>;
  close: () => Promise<void>;
}

/** Deletes every row of `tenantId` from every tenant-scoped table, then the tenant. */
export async function deleteTenant(tenantId: string): Promise<void> {
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'`);
  const names = tables.rows.map((r) => r.table_name);
  for (let pass = 0; pass < 8 && names.length > 0; pass++) {
    for (const name of [...names]) {
      try {
        await db.execute(sql`DELETE FROM ${sql.identifier(name)} WHERE tenant_id = ${tenantId}`);
        names.splice(names.indexOf(name), 1);
      } catch { /* still referenced; next pass */ }
    }
  }
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
}

export async function startSensitiveHarness(slugPrefix: string): Promise<SensitiveHarness> {
  const slug = `${slugPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [t] = await db.insert(tenants).values({ name: 'Sensitive', slug }).returning();
  const tenantId = t!.id;
  const company = (await createCompanyForTenant(tenantId, 'Sensitive Co'))!;
  const [owner] = await db.insert(users).values({
    tenantId, email: `${slug}-owner@example.com`, passwordHash: 'x', displayName: 'Owner', role: 'owner',
  }).returning();
  const [bk] = await db.insert(users).values({
    tenantId, email: `${slug}-bk@example.com`, passwordHash: 'x', displayName: 'Bookkeeper', role: 'bookkeeper',
  }).returning();
  const tokens: Record<Who, string> = {
    owner: jwt.sign({ userId: owner!.id, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '10m' }),
    bk: jwt.sign({ userId: bk!.id, tenantId, role: 'bookkeeper', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '10m' }),
  };

  const mk = async (name: string, accountType: string, accountNumber: string, extra: Record<string, unknown> = {}) =>
    (await accountsService.create(tenantId, { name, accountType: accountType as never, accountNumber, ...extra })).id;
  const bank = await mk('Checking', 'asset', '1010', { detailType: 'bank' });
  const ar = await mk('Accounts Receivable', 'asset', '1200');
  const ap = await mk('Accounts Payable', 'liability', '2000');
  await db.execute(sql`UPDATE accounts SET system_tag = 'accounts_receivable', is_system = true WHERE id = ${ar}`);
  await db.execute(sql`UPDATE accounts SET system_tag = 'accounts_payable', is_system = true WHERE id = ${ap}`);
  const sales = await mk('Sales', 'revenue', '4000');
  const supplies = await mk('Supplies', 'expense', '6000');
  const wages = await mk('Canary Wages', 'expense', '6999');
  const wagesSub = await mk('Canary Wages Officers', 'expense', '6998', { parentId: wages });

  const { app } = await import('../app.js');
  const server = http.createServer(app as Express);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  const call = (who: Who, method: string, path: string, body?: unknown) => new Promise<CallResult>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        Authorization: `Bearer ${tokens[who]}`,
        'X-Company-Id': company.id,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  return {
    tenantId,
    companyId: company.id,
    ownerId: owner!.id,
    bookkeeperId: bk!.id,
    acct: { bank, wages, wagesSub, supplies, sales, ar, ap },
    call,
    markWages: async () => {
      const r = await call('owner', 'PUT', `/api/v1/accounts/${wages}/sensitive`, { isSensitive: true });
      if (r.status !== 200) throw new Error(`markWages: ${r.status} ${r.text}`);
    },
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await deleteTenant(tenantId);
    },
  };
}

/**
 * The wider canary seed (U-33 PR 2): one marked account of every account type
 * a report or builder source reads (besides Canary Wages and its
 * sub-account), each with activity on a line no visible account carries:
 *   - an invoice with an item line on Canary Revenue (sales, item sales,
 *     open invoices) next to a visible Sales line;
 *   - a bill with an item line on Canary COGS (purchases, item purchases,
 *     unpaid bills) next to a visible Supplies line;
 *   - a journal entry whose every line is hidden (other expense, asset,
 *     liability, equity, other revenue);
 *   - a 2025 entry tagged "Canary Tag Job" with prior-year income on Canary
 *     Revenue (Trial Balance tag mode, prior years' earnings), balanced by
 *     two visible lines so no visible line equals an owner-only sum.
 * Visible amounts are whole dollars. `amounts` are the hidden lines' own
 * amounts plus owner-only sums (Canary Wages rollup, the tagged entry's
 * prior-year income); none may reach the bookkeeper. Call after the base
 * activity of the test, before or after markWages (it marks only its own).
 */
export interface CanarySeed {
  hidden: { revenue: string; cogs: string; otherExpense: string; otherRevenue: string; asset: string; liability: string; equity: string };
  /** Every hidden account id, Canary Wages and its sub-account included. */
  hiddenIds: string[];
  amounts: string[];
  customer: string;
  vendor: string;
  item: string;
  tagId: string;
  loan: string;
  invoiceId: string;
  billId: string;
  allHiddenTxn: string;
}

export const CANARY_NAME = 'Canary';

export async function seedCanaries(h: SensitiveHarness): Promise<CanarySeed> {
  const { tenantId, companyId } = h;
  const mk = async (name: string, accountType: string, accountNumber: string, extra: Record<string, unknown> = {}) =>
    (await accountsService.create(tenantId, { name, accountType: accountType as never, accountNumber, ...extra })).id;
  const hidden = {
    revenue: await mk('Canary Revenue', 'revenue', '4999'),
    cogs: await mk('Canary COGS', 'cogs', '5999'),
    otherExpense: await mk('Canary Other Expense', 'other_expense', '8999'),
    otherRevenue: await mk('Canary Other Income', 'other_revenue', '7999'),
    asset: await mk('Canary Officer Loan', 'asset', '1999'),
    liability: await mk('Canary Payroll Liabilities', 'liability', '2999'),
    equity: await mk('Canary Owner Draws', 'equity', '3999'),
  };
  const loan = await mk('Loan Payable', 'liability', '2500');
  const [cust] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'Plain Customer' }).returning();
  const [vend] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'vendor', displayName: 'Plain Vendor' }).returning();
  const [it] = await db.insert(items).values({ tenantId, companyId, name: 'Plain Widget', incomeAccountId: h.acct.sales }).returning();
  const [tg] = await db.insert(tags).values({ tenantId, name: 'Plain Tag Job' }).returning();
  const post = (txnType: string, txnDate: string, memo: string, lines: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
    ledger.postTransaction(tenantId, { txnType: txnType as never, txnDate, memo, lines: lines as never, ...extra }, h.ownerId, companyId);
  const invoice = await post('invoice', '2026-04-01', 'inv', [
    { accountId: h.acct.ar, debit: '2211.13', credit: '0', contactId: cust!.id },
    { accountId: h.acct.sales, debit: '0', credit: '100.00', itemId: it!.id, quantity: '1', unitPrice: '100.00' },
    { accountId: hidden.revenue, debit: '0', credit: '2111.13', itemId: it!.id, quantity: '1', unitPrice: '2111.13' },
  ], { contactId: cust!.id, dueDate: '2026-05-01', total: '2211.13', balanceDue: '2211.13', amountPaid: '0', invoiceStatus: 'sent' });
  const bill = await post('bill', '2026-04-02', 'bill', [
    { accountId: hidden.cogs, debit: '3222.24', credit: '0', itemId: it!.id, quantity: '1', unitPrice: '3222.24' },
    { accountId: h.acct.supplies, debit: '20.00', credit: '0' },
    { accountId: h.acct.ap, debit: '0', credit: '3242.24', contactId: vend!.id },
  ], { contactId: vend!.id, dueDate: '2026-05-02', total: '3242.24', balanceDue: '3242.24', amountPaid: '0', billStatus: 'unpaid' });
  const all = await post('journal_entry', '2026-04-03', 'hidden only', [
    { accountId: hidden.otherExpense, debit: '4333.35', credit: '0' },
    { accountId: hidden.asset, debit: '6555.57', credit: '0' },
    { accountId: hidden.liability, debit: '0', credit: '7666.68' },
    { accountId: hidden.equity, debit: '0', credit: '1777.79' },
    { accountId: hidden.otherRevenue, debit: '0', credit: '1444.45' },
  ]);
  await post('journal_entry', '2025-06-01', 'tagged prior', [
    { accountId: loan, debit: '2000.00', credit: '0' },
    { accountId: h.acct.bank, debit: '1011.00', credit: '0' },
    { accountId: hidden.revenue, debit: '0', credit: '2999.31', tagId: tg!.id },
    { accountId: h.acct.sales, debit: '0', credit: '11.69', tagId: tg!.id },
  ]);
  for (const id of Object.values(hidden)) {
    const r = await h.call('owner', 'PUT', `/api/v1/accounts/${id}/sensitive`, { isSensitive: true });
    if (r.status !== 200) throw new Error(`seedCanaries mark: ${r.status} ${r.text}`);
  }
  return {
    hidden,
    hiddenIds: [h.acct.wages, h.acct.wagesSub, ...Object.values(hidden)],
    amounts: ['1234.57', '5555.66', '2111.13', '3222.24', '4333.35', '6555.57', '7666.68', '1777.79', '1444.45', '2999.31', '3011.00'],
    customer: cust!.id, vendor: vend!.id, item: it!.id, tagId: tg!.id, loan,
    invoiceId: invoice.id, billId: bill.id, allHiddenTxn: all.id,
  };
}
