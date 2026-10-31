// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Billable costs (ClientLedger P20 E3, U-128 billable-costs-v1), through the
// HTTP routes and the ledger: the corrected design's blocking fixes B1-B4,
// the should-fix list and invariants I1-I7 (I8: tenant-portability/
// roundtrip-billable.test.ts; the money rules: invoice-golden.json
// billableCases). After every test the I1 check (link <-> billed status)
// and the trial balance hold for every tenant the test made.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, items, transactionTags, userPermissions, idempotencyKeys, documentSendEvents, billableCostLinks,
  reconciliations, reconciliationLines,
} from '../db/schema/index.js';
import { invoicesRouter } from './invoices.routes.js';
import { billableCostsRouter } from './billable-costs.routes.js';
import { transactionsRouter } from './transactions.routes.js';
import { apiV2Router } from './api-v2.routes.js';
import { contactsRouter } from './contacts.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as companyService from '../services/company.service.js';
import { postLegacyClone } from '../services/recurring.service.js';
import * as recurringService from '../services/recurring.service.js';
import * as templatesService from '../services/templates/templates.service.js';
import { checkBillableInvariant } from '../services/billable-links.js';
import { getInvoiceHtml } from '../services/pdf.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Res { status: number; json: any }

function request(method: string, pathname: string, token: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...headers,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (ch) => chunks.push(ch));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: any = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function cleanTenant(tid: string) {
  await db.delete(billableCostLinks).where(eq(billableCostLinks.tenantId, tid));
  await db.delete(documentSendEvents).where(eq(documentSendEvents.tenantId, tid));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tid));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  const recs = await db.select({ id: reconciliations.id }).from(reconciliations).where(eq(reconciliations.tenantId, tid));
  if (recs.length) await db.delete(reconciliationLines).where(inArray(reconciliationLines.reconciliationId, recs.map((r) => r.id)));
  await db.delete(reconciliations).where(eq(reconciliations.tenantId, tid));
  await db.execute(sql`DELETE FROM recurring_schedules WHERE tenant_id = ${tid}`).catch(() => undefined);
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
  await db.delete(items).where(eq(items.tenantId, tid));
  await db.delete(contacts).where(eq(contacts.tenantId, tid));
  await db.update(companies).set({ billableMarkupAccountId: null }).where(eq(companies.tenantId, tid));
  await db.delete(accounts).where(eq(accounts.tenantId, tid));
  await db.delete(companies).where(eq(companies.tenantId, tid));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tid));
  if (staff.length) await db.delete(sessions).where(inArray(sessions.userId, staff.map((u) => u.id)));
  await db.delete(userPermissions).where(eq(userPermissions.tenantId, tid));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tid));
  await db.delete(users).where(eq(users.tenantId, tid));
  await db.delete(tenants).where(eq(tenants.id, tid));
}

interface Co {
  tenantId: string; token: string; companyId: string; revenue: string; revenue2: string; expense: string; expense2: string;
  bank: string; markup: string; ar: string; customer: string; customer2: string;
}

async function bySystemTag(tenantId: string, tag: string) {
  return (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) }))!.id;
}

async function makeCompany(): Promise<Co> {
  const reg = await authService.register({
    email: `billable-${suffix()}@example.com`, password: 'password123', displayName: 'Owner', companyName: 'Monett Landscapes',
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const companyId = company!.id;
  await db.update(companies).set({ defaultSalesTaxRate: '0.0810' }).where(eq(companies.id, companyId));
  const acct = async (name: string, accountType: string, detailType?: string) =>
    (await db.insert(accounts).values({ tenantId, companyId: null, name: `${name} ${suffix()}`, accountType, detailType }).returning())[0]!.id;
  const markup = await acct('Markup income', 'revenue');
  await db.update(companies).set({ billableMarkupAccountId: markup }).where(eq(companies.id, companyId));
  const [customer] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'Hartley Residence' }).returning();
  const [customer2] = await db.insert(contacts).values({ tenantId, companyId, contactType: 'customer', displayName: 'Oakwood HOA' }).returning();
  return {
    tenantId, token: reg.tokens.accessToken, companyId,
    revenue: await acct('Landscaping income', 'revenue'), revenue2: await acct('Materials income', 'revenue'),
    expense: await acct('Job materials', 'expense'), expense2: await acct('Subcontractors', 'expense'),
    bank: await acct('Operating', 'asset', 'bank'), markup, ar: await bySystemTag(tenantId, 'accounts_receivable'),
    customer: customer!.id, customer2: customer2!.id,
  };
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/invoices', invoicesRouter);
  app.use('/api/v1/billable-costs', billableCostsRouter);
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/contacts', contactsRouter);
  app.use('/api/v2', apiV2Router);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany();
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  // I1 and a zero trial balance after every lifecycle (I2).
  for (const tid of tenantIds) {
    expect(await checkBillableInvariant(db, tid), 'I1').toEqual([]);
    expect((await ledger.validateBalance(tid)).valid, 'trial balance').toBe(true);
  }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

interface CostIn { amount: string; desc?: string; contactId?: string | null; qty?: string; unitPrice?: string; account?: string }

/** An expense (or `txnType`) whose lines are billable costs; returns the transaction and its billable line ids in order. */
async function postCosts(costs: CostIn[], opts: { date?: string; companyId?: string | null; co?: Co } = {}) {
  const co = opts.co ?? c;
  const total = costs.reduce((s, x) => s + Math.round(Number(x.amount) * 10000), 0) / 10000;
  const txn = await ledger.postTransaction(co.tenantId, {
    txnType: 'expense', txnDate: opts.date ?? '2026-10-01', total: total.toFixed(4), memo: 'job costs',
    lines: [
      ...costs.map((x, i) => ({
        accountId: x.account ?? co.expense,
        debit: Number(x.amount) >= 0 ? x.amount : '0', credit: Number(x.amount) < 0 ? x.amount.replace('-', '') : '0',
        description: x.desc ?? `cost ${i + 1}`, contactId: x.contactId === undefined ? co.customer : x.contactId,
        isBillable: true, quantity: x.qty, unitPrice: x.unitPrice,
      })),
      { accountId: co.bank, debit: total < 0 ? (-total).toFixed(4) : '0', credit: total >= 0 ? total.toFixed(4) : '0', description: 'paid' },
    ],
  }, undefined, opts.companyId === null ? undefined : (opts.companyId ?? co.companyId));
  const ids = txn.lines.filter((l) => l.isBillable).sort((a, b) => (a.lineOrder ?? 0) - (b.lineOrder ?? 0)).map((l) => l.id);
  return { txn, ids };
}

const billLine = (id: string, extra: Record<string, unknown> = {}) => ({ billableSourceLineId: id, accountId: c.revenue, isTaxable: false, ...extra });

async function postInvoice(lines: unknown[], extra: Record<string, unknown> = {}, headers: Record<string, string> = {}, co: Co = c) {
  return request('POST', '/api/v1/invoices', co.token, { contactId: co.customer, txnDate: '2026-10-10', lines, ...extra }, headers);
}

async function getInvoice(id: string) {
  const r = await request('GET', `/api/v1/invoices/${id}`, c.token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json.invoice;
}

async function putInvoice(inv: any, lines: unknown[], extra: Record<string, unknown> = {}) {
  return request('PUT', `/api/v1/invoices/${inv.id}`, c.token, {
    contactId: inv.contactId, txnDate: inv.txnDate, lines, expectedUpdatedAt: new Date(inv.updatedAt).toISOString(), ...extra,
  });
}

async function listCosts(query = `?contactId=${c.customer}`, co: Co = c) {
  const r = await request('GET', `/api/v1/billable-costs${query}`, co.token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return r.json;
}

async function lineRow(id: string) {
  const [row] = await db.select().from(journalLines).where(eq(journalLines.id, id));
  return row;
}

async function activeLinks(tid = c.tenantId) {
  return db.select().from(billableCostLinks).where(and(eq(billableCostLinks.tenantId, tid), sql`released_at IS NULL`));
}

it('advertises billable-costs-v1', () => {
  expect(DESKTOP_CAPABILITIES).toContain('billable-costs-v1');
});

describe('claim and list (rule 1, S7, B4)', () => {
  it('claim_then_listed_gone: 842.15 + 10 % = 926.37 on one line; two journal lines; listed before, gone after; I2 / I3', async () => {
    const { txn, ids } = await postCosts([{ amount: '842.15', desc: 'Pavers' }, { amount: '12.3456', desc: 'Sand' }]);
    let list = await listCosts();
    expect(list.totalCount).toBe(2);
    expect(list.totalAmount).toBe('854.50');
    expect(list.items.map((i: any) => [i.sourceLineId, i.costAmount, i.sourceAmount, i.sourceTxnType]))
      .toEqual([[ids[0], '842.15', '842.1500', 'expense'], [ids[1], '12.35', '12.3456', 'expense']]);
    const expenseBefore = await db.select().from(journalLines).where(eq(journalLines.transactionId, txn.id));
    const balanceBefore = (await db.select().from(accounts).where(eq(accounts.id, c.expense)))[0]!.balance;

    const body = [billLine(ids[0]!, { markupPercent: '10', isTaxable: true })];
    const preview = await request('POST', '/api/v1/invoices/preview', c.token, { contactId: c.customer, txnDate: '2026-10-10', lines: body });
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect(preview.json.lines[0]).toMatchObject({
      amount: '926.37', costAmount: '842.15', markupAmount: '84.22', markupPercent: '10.0000', unitPrice: '926.3700',
      unitPriceSource: 'billable_cost', taxAmount: '75.04', error: null,
    });
    const r = await postInvoice(body);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const inv = r.json.invoice;
    expect([inv.subtotal, inv.taxAmount, inv.total]).toEqual(['926.3700', '75.0400', '1001.4100']);
    expect(preview.json.total).toBe('1001.41');
    const cost = inv.lines.find((l: any) => l.lineRole === 'billable_cost');
    const markup = inv.lines.find((l: any) => l.lineRole === 'billable_markup');
    expect([cost.accountId, cost.credit, cost.taxAmount, cost.billableSourceLineId]).toEqual([c.revenue, '842.1500', '75.0400', ids[0]]);
    expect([markup.accountId, markup.credit, markup.taxAmount, markup.billableSourceLineId]).toEqual([c.markup, '84.2200', '0.0000', ids[0]]);
    expect(inv.billableCosts).toEqual([expect.objectContaining({
      sourceLineId: ids[0], sourceTransactionId: txn.id, sourceTxnType: 'expense', costAmount: '842.15', markupPercent: '10.0000',
      markupAmount: '84.22', amount: '926.37', displayRate: '926.3700', quantity: '1', incomeAccountId: c.revenue,
      markupAccountId: c.markup, costLineId: cost.id, markupLineId: markup.id, billed: true,
    })]);

    list = await listCosts();
    expect([list.totalCount, list.totalAmount, list.items[0].sourceLineId]).toEqual([1, '12.35', ids[1]]);
    // The source read names the invoice; the expense lines and balances are untouched (I3).
    const src = await request('GET', `/api/v1/transactions/${txn.id}`, c.token);
    const billedLine = src.json.transaction.lines.find((l: any) => l.id === ids[0]);
    expect([billedLine.billedStatus, billedLine.billedInvoiceId, billedLine.billedInvoiceNumber]).toEqual(['billed', inv.id, inv.txnNumber]);
    const expenseAfter = await db.select().from(journalLines).where(eq(journalLines.transactionId, txn.id));
    const strip = (rows: typeof expenseBefore) => rows.map((l) => [l.id, l.accountId, l.debit, l.credit]).sort();
    expect(strip(expenseAfter)).toEqual(strip(expenseBefore));
    expect((await db.select().from(accounts).where(eq(accounts.id, c.expense)))[0]!.balance).toBe(balanceBefore);
    // The PDF prints one line at 926.37 (S9).
    const html = await getInvoiceHtml(c.tenantId, inv.id);
    expect(html).toContain('926.37');
    expect(html).not.toContain('84.22');
  });

  it('hideZeroLines leaves a billed cost of 0.00 off the PDF (nit 11)', async () => {
    const { ids } = await postCosts([{ amount: '0.004', desc: 'Rounding crumbs' }, { amount: '50', desc: 'Gravel' }]);
    const r = await postInvoice([billLine(ids[0]!), billLine(ids[1]!)], { hideZeroLines: true });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const html = await getInvoiceHtml(c.tenantId, r.json.invoice.id);
    expect(html).toContain('Gravel');
    expect(html).not.toContain('Rounding crumbs');
  });

  it('a 4-place cost, a negative cost at cost (Q-P20z), quantity 3 (rule 5; price levels: golden billableCases)', async () => {
    const { ids } = await postCosts([
      { amount: '12.3456' }, { amount: '-20.00', desc: 'rebate' }, { amount: '842.1501', qty: '3', unitPrice: '280.7167' }, { amount: '100' },
    ]);
    const r = await postInvoice([
      billLine(ids[0]!, { markupPercent: '10' }), billLine(ids[1]!, { markupPercent: '10' }),
      billLine(ids[2]!), billLine(ids[3]!, { markupPercent: '0' }),
    ]);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const bc = r.json.invoice.billableCosts;
    expect(bc.map((b: any) => [b.costAmount, b.markupPercent, b.markupAmount, b.amount, b.quantity, b.displayRate])).toEqual([
      ['12.35', '10.0000', '1.24', '13.59', '1', '13.5900'],
      ['-20.00', '0.0000', '0.00', '-20.00', '1', '-20.0000'],
      ['842.15', '0.0000', '0.00', '842.15', '3', '280.7167'],
      ['100.00', '0.0000', '0.00', '100.00', '1', '100.0000'],
    ]);
    // Markup 0 is one journal line; the negative cost debits its income account.
    const roles = r.json.invoice.lines.filter((l: any) => l.billableSourceLineId).map((l: any) => [l.lineRole, l.debit, l.credit]);
    expect(roles).toEqual([
      ['billable_cost', '0.0000', '12.3500'], ['billable_markup', '0.0000', '1.2400'],
      ['billable_cost', '20.0000', '0.0000'], ['billable_cost', '0.0000', '842.1500'], ['billable_cost', '0.0000', '100.0000'],
    ]);
    // The rate shown is the invoice's own, as printed (S-6): a later change
    // of the source line's quantity doesn't move it.
    await db.update(journalLines).set({ quantity: '6' }).where(eq(journalLines.id, ids[2]!));
    const again = (await getInvoice(r.json.invoice.id)).billableCosts.find((b: any) => b.sourceLineId === ids[2]);
    expect([again.quantity, again.displayRate]).toEqual(['3', '280.7167']);
    expect(r.json.invoice.total).toBe('935.7400');
  });

  it('refuses: fields read-only, no income account, a cost twice, no markup account, another customer, a stale id', async () => {
    const { ids } = await postCosts([{ amount: '50' }, { amount: '60', contactId: c.customer2 }]);
    const code = async (lines: unknown[], status: number, expected: string, extra: Record<string, unknown> = {}) => {
      const r = await postInvoice(lines, extra);
      expect(r.status, JSON.stringify(r.json)).toBe(status);
      expect(r.json.error.code).toBe(expected);
      return r.json.error;
    };
    await code([billLine(ids[0]!, { quantity: '2' })], 400, 'BILLABLE_FIELDS_READONLY');
    await code([billLine(ids[0]!, { itemId: crypto.randomUUID() })], 400, 'BILLABLE_FIELDS_READONLY');
    await code([{ billableSourceLineId: ids[0] }], 400, 'BILLABLE_INCOME_ACCOUNT_REQUIRED');
    await code([billLine(ids[0]!), billLine(ids[0]!)], 400, 'BILLABLE_DUPLICATE_LINE');
    await code([billLine(ids[0]!, { markupPercent: '1000.5' })], 400, 'VALIDATION_ERROR');
    const err = await code([billLine(ids[1]!)], 400, 'BILLABLE_CONTACT_MISMATCH');
    expect(err.details.conflicts).toEqual([{ sourceLineId: ids[1] }]);
    await code([billLine(crypto.randomUUID())], 409, 'BILLABLE_COST_UNAVAILABLE');
    // The saved markup account is checked again when a new markup posts to
    // it (S-4): deactivated or retyped since, it is 400 MARKUP_ACCOUNT_INVALID.
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, c.markup));
    await code([billLine(ids[0]!, { markupPercent: '5' })], 400, 'MARKUP_ACCOUNT_INVALID');
    await db.update(accounts).set({ isActive: true, accountType: 'expense' }).where(eq(accounts.id, c.markup));
    await code([billLine(ids[0]!, { markupPercent: '5' })], 400, 'MARKUP_ACCOUNT_INVALID');
    await db.update(accounts).set({ accountType: 'other_revenue' }).where(eq(accounts.id, c.markup));
    // A kept link keeps its stored account, even one deactivated since.
    const kept = await postInvoice([billLine(ids[0]!, { markupPercent: '5' })]);
    expect(kept.status, JSON.stringify(kept.json)).toBe(201);
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, c.markup));
    const edit = await putInvoice(kept.json.invoice, [billLine(ids[0]!, { markupPercent: '5' })], { memo: 'kept' });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    await db.update(accounts).set({ isActive: true }).where(eq(accounts.id, c.markup));
    const freed = await putInvoice(edit.json.invoice, [{ accountId: c.revenue, quantity: '1', unitPrice: '1.00' }], { releaseBillableSourceLineIds: [ids[0]] });
    expect(freed.status, JSON.stringify(freed.json)).toBe(200);
    await db.update(companies).set({ billableMarkupAccountId: null }).where(eq(companies.id, c.companyId));
    await code([billLine(ids[0]!, { markupPercent: '5' })], 400, 'MARKUP_ACCOUNT_REQUIRED');
    // At cost needs no markup account.
    expect((await postInvoice([billLine(ids[0]!)])).status).toBe(201);
    expect(await activeLinks()).toHaveLength(1);
  });

  it('settings: client defaultMarkupPercent (listed with the costs) and the company markup account must be income (400 MARKUP_ACCOUNT_INVALID)', async () => {
    let r = await request('PUT', `/api/v1/contacts/${c.customer}`, c.token, { defaultMarkupPercent: '12.5' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((await listCosts()).defaultMarkupPercent).toBe('12.5000');
    r = await request('PUT', `/api/v1/contacts/${c.customer}`, c.token, { defaultMarkupPercent: '1001' });
    expect(r.status).toBe(400);
    await expect(companyService.updateCompany(c.tenantId, c.companyId, { billableMarkupAccountId: c.expense } as never))
      .rejects.toMatchObject({ code: 'MARKUP_ACCOUNT_INVALID' });
    await companyService.updateCompany(c.tenantId, c.companyId, { billableMarkupAccountId: c.revenue2 } as never);
    expect((await companyService.getSettings(c.tenantId, c.companyId)).billableMarkupAccountId).toBe(c.revenue2);
  });
});

describe('release on void, everywhere (B3, I6)', () => {
  const routes: Array<[string, (id: string) => Promise<Res>]> = [
    ['void_releases_via_invoice_route', (id) => request('POST', `/api/v1/invoices/${id}/void`, c.token, { reason: 'wrong client' })],
    ['void_releases_via_transactions_route', (id) => request('POST', `/api/v1/transactions/${id}/void`, c.token, { reason: 'wrong client' })],
    ['void_releases_via_api_v2', (id) => request('POST', `/api/v2/transactions/${id}/void`, c.token, { reason: 'wrong client' })],
  ];
  it.each(routes)('%s', async (_name, voidIt) => {
    const { txn, ids } = await postCosts([{ amount: '842.15' }]);
    const r = await postInvoice([billLine(ids[0]!, { markupPercent: '10' })]);
    expect(r.status).toBe(201);
    const v = await voidIt(r.json.invoice.id);
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect((await lineRow(ids[0]!))!.billedStatus).toBe('unbilled');
    expect((await listCosts()).totalCount).toBe(1);
    const [voidAudit] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, r.json.invoice.id), eq(auditLog.action, 'void')));
    expect((voidAudit!.afterData as any).releasedBillableCosts).toEqual([{ sourceLineId: ids[0], sourceTransactionId: txn.id }]);
    const [link] = await db.select().from(billableCostLinks).where(eq(billableCostLinks.sourceLineId, ids[0]!));
    expect([link!.releaseReason, link!.releasedAt !== null]).toEqual(['invoice_void', true]);
    // A released cost can be billed again.
    expect((await postInvoice([billLine(ids[0]!)])).status).toBe(201);
  });
});

describe('PUT (rules 2-3, S1, S2, S6)', () => {
  it('put_keeps_own_costs, put_change_markup (the markup account stays when the setting moves), put_release_one_of_two', async () => {
    const { ids } = await postCosts([{ amount: '200', desc: 'A' }, { amount: '100', desc: 'B' }]);
    const r = await postInvoice([billLine(ids[0]!, { markupPercent: '10' }), billLine(ids[1]!)]);
    expect(r.status).toBe(201);
    let inv = r.json.invoice;
    // A plain re-send keeps both (no 409), memo change only.
    let p = await putInvoice(inv, [billLine(ids[0]!, { markupPercent: '10' }), billLine(ids[1]!)], { memo: 'memo edit' });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(await activeLinks()).toHaveLength(2);
    // The company markup account moves; editing keeps the stored one and recomputes the markup.
    await db.update(companies).set({ billableMarkupAccountId: c.revenue2 }).where(eq(companies.id, c.companyId));
    inv = p.json.invoice;
    p = await putInvoice(inv, [billLine(ids[0]!, { markupPercent: '25' }), billLine(ids[1]!)]);
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const a = p.json.invoice.billableCosts.find((b: any) => b.sourceLineId === ids[0]);
    expect([a.markupPercent, a.markupAmount, a.amount, a.markupAccountId]).toEqual(['25.0000', '50.00', '250.00', c.markup]);
    // Release B only.
    inv = p.json.invoice;
    p = await putInvoice(inv, [billLine(ids[0]!, { markupPercent: '25' })], { releaseBillableSourceLineIds: [ids[1]] });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect((await lineRow(ids[1]!))!.billedStatus).toBe('unbilled');
    expect((await lineRow(ids[0]!))!.billedStatus).toBe('billed');
    expect(p.json.invoice.total).toBe('250.0000');
    const [released] = await db.select().from(billableCostLinks).where(eq(billableCostLinks.sourceLineId, ids[1]!));
    expect(released!.releaseReason).toBe('removed');
  });

  it('put_missing_without_release_409: an older client re-sending the journal lines unbills nothing', async () => {
    const { ids } = await postCosts([{ amount: '200' }]);
    const r = await postInvoice([billLine(ids[0]!, { markupPercent: '10' })]);
    const inv = r.json.invoice;
    // What MyBooks Online's web editor sends: the lines it read, as plain lines.
    const plain = inv.lines.filter((l: any) => l.accountId !== c.ar).map((l: any) => ({
      accountId: l.accountId, description: l.description ?? undefined, quantity: '1', unitPrice: l.credit, isTaxable: false,
    }));
    const p = await putInvoice(inv, plain, { memo: 'accountant memo' });
    expect(p.status).toBe(409);
    expect(p.json.error.code).toBe('BILLABLE_LINES_MISSING');
    expect(p.json.error.details.sourceLineIds).toEqual([ids[0]]);
    expect((await lineRow(ids[0]!))!.billedStatus).toBe('billed');
  });

  it('put_change_customer_400: costs stay with their own customer', async () => {
    const { ids } = await postCosts([{ amount: '200' }]);
    const inv = (await postInvoice([billLine(ids[0]!)])).json.invoice;
    const p = await putInvoice(inv, [billLine(ids[0]!)], { contactId: c.customer2 });
    expect(p.status).toBe(400);
    expect(p.json.error.code).toBe('BILLABLE_CONTACT_MISMATCH');
  });

  it('paid_invoice_keeps_costs and total_below_paid_409 (S6)', async () => {
    const { ids } = await postCosts([{ amount: '500', desc: 'A' }, { amount: '100', desc: 'B' }]);
    const inv = (await postInvoice([billLine(ids[0]!), billLine(ids[1]!)])).json.invoice;
    let pay = await request('POST', `/api/v1/invoices/${inv.id}/payment`, c.token, { amount: '550.00', txnDate: '2026-10-12', depositToAccountId: c.bank });
    expect(pay.status, JSON.stringify(pay.json)).toBe(201);
    let cur = await getInvoice(inv.id);
    const below = await putInvoice(cur, [billLine(ids[1]!)], { releaseBillableSourceLineIds: [ids[0]] });
    expect(below.status).toBe(409);
    expect(below.json.error.code).toBe('INVOICE_TOTAL_BELOW_PAID');
    pay = await request('POST', `/api/v1/invoices/${inv.id}/payment`, c.token, { amount: '50.00', txnDate: '2026-10-12', depositToAccountId: c.bank });
    expect(pay.status).toBe(201);
    cur = await getInvoice(inv.id);
    const edit = await putInvoice(cur, [billLine(ids[1]!)], { releaseBillableSourceLineIds: [ids[0]] });
    expect(edit.status).toBe(400);
    const v = await request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'x' });
    expect(v.status).toBe(409);
    expect(v.json.error.code).toBe('INVOICE_HAS_PAYMENTS');
    expect(await activeLinks()).toHaveLength(2);
  });

  it('preview with invoiceId validates the invoice\'s own costs and reports a cost held elsewhere on its line (S3)', async () => {
    const { ids } = await postCosts([{ amount: '200' }, { amount: '50' }]);
    const one = (await postInvoice([billLine(ids[0]!)])).json.invoice;
    const two = (await postInvoice([billLine(ids[1]!)])).json.invoice;
    const p = await request('POST', '/api/v1/invoices/preview', c.token, {
      invoiceId: two.id, contactId: c.customer, txnDate: '2026-10-10', lines: [billLine(ids[1]!), billLine(ids[0]!)],
    });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.lines[0].error).toBeNull();
    expect(p.json.lines[1].error).toEqual({ code: 'BILLABLE_ALREADY_BILLED', invoiceId: one.id, invoiceNumber: one.txnNumber });
    expect(await activeLinks()).toHaveLength(2);
  });
});

describe('source side (B1, rule 4, I5)', () => {
  it('source_memo_edit_keeps_link (full edit path), then voiding the invoice still unbills', async () => {
    const { txn, ids } = await postCosts([{ amount: '842.15' }, { amount: '10' }]);
    const inv = (await postInvoice([billLine(ids[0]!, { markupPercent: '10' })])).json.invoice;
    const full = await ledger.getTransaction(c.tenantId, txn.id);
    await ledger.updateTransaction(c.tenantId, txn.id, {
      txnType: 'expense', txnDate: '2026-10-02', memo: 'typo fixed', total: full.total ?? undefined,
      lines: full.lines.map((l) => ({
        accountId: l.accountId, debit: l.debit, credit: l.credit, description: `${l.description} (edited)`,
        contactId: l.contactId, isBillable: l.isBillable, tagId: l.tagId,
      })),
    }, undefined, c.companyId);
    const after = await lineRow(ids[0]!);
    expect([after!.id, after!.billedStatus, after!.description]).toEqual([ids[0], 'billed', 'cost 1 (edited)']);
    expect((await lineRow(ids[1]!))).toBeUndefined(); // an unbilled line may change id
    const v = await request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'x' });
    expect(v.status).toBe(200);
    expect((await lineRow(ids[0]!))!.billedStatus).toBe('unbilled');
  });

  it('source_recat_reconciled_keeps_link: the reconciled edit path re-inserts the billed line with its id', async () => {
    const { txn, ids } = await postCosts([{ amount: '300', desc: 'billed' }, { amount: '40', desc: 'other' }]);
    await postInvoice([billLine(ids[0]!)]);
    const bankLine = txn.lines.find((l) => l.accountId === c.bank)!;
    const [rec] = await db.insert(reconciliations).values({
      tenantId: c.tenantId, accountId: c.bank, statementDate: '2026-10-31', statementEndingBalance: '-340', beginningBalance: '0', status: 'complete',
    } as never).returning();
    await db.insert(reconciliationLines).values({ reconciliationId: rec!.id, journalLineId: bankLine.id, isCleared: true } as never);
    const full = await ledger.getTransaction(c.tenantId, txn.id);
    await ledger.updateTransaction(c.tenantId, txn.id, {
      txnType: 'expense', txnDate: full.txnDate, memo: 'recategorized', total: full.total ?? undefined,
      lines: full.lines.map((l) => ({
        accountId: l.description === 'other' ? c.expense2 : l.accountId, debit: l.debit, credit: l.credit,
        description: l.description ?? undefined, contactId: l.contactId, isBillable: l.isBillable,
      })),
    }, undefined, c.companyId);
    const after = await lineRow(ids[0]!);
    expect([after!.id, after!.billedStatus]).toEqual([ids[0], 'billed']);
    expect((await lineRow(bankLine.id))!.id).toBe(bankLine.id);
  });

  it('source_amount_edit_409_line_billed, source_void_409, source_delete_409; bulk recategorize skips it as billed (S11)', async () => {
    const { txn, ids } = await postCosts([{ amount: '300' }]);
    await postInvoice([billLine(ids[0]!)]);
    const full = await ledger.getTransaction(c.tenantId, txn.id);
    await expect(ledger.updateTransaction(c.tenantId, txn.id, {
      txnType: 'expense', txnDate: full.txnDate, total: '301.0000',
      lines: [
        { accountId: c.expense, debit: '301.0000', credit: '0', contactId: c.customer, isBillable: true },
        { accountId: c.bank, debit: '0', credit: '301.0000' },
      ],
    }, undefined, c.companyId)).rejects.toMatchObject({ code: 'LINE_BILLED' });
    const v = await request('POST', `/api/v1/transactions/${txn.id}/void`, c.token, { reason: 'x' });
    expect([v.status, v.json.error?.code]).toEqual([409, 'LINE_BILLED']);
    await expect(ledger.deleteTransaction(c.tenantId, txn.id, { companyId: c.companyId })).rejects.toMatchObject({ code: 'LINE_BILLED' });
    const bulk = await ledger.bulkUpdateTransactions(c.tenantId, { txnIds: [txn.id], setCategoryAccountId: c.expense2 } as never, undefined, c.companyId);
    expect(bulk.skipped).toEqual([{ id: txn.id, reason: 'billed' }]);
    expect((await lineRow(ids[0]!))!.accountId).toBe(c.expense);
  });
});

describe('races (B2, I4)', () => {
  it('concurrent_claim_one_wins', async () => {
    const { ids } = await postCosts([{ amount: '300' }]);
    const results = await Promise.all([1, 2, 3, 4].map(() => postInvoice([billLine(ids[0]!)])));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.json.error.code).toBe('BILLABLE_ALREADY_BILLED');
    expect(await activeLinks()).toHaveLength(1);
  });

  it('opposite_order_no_deadlock: overlapping sets claimed in opposite orders', async () => {
    for (let run = 0; run < 3; run++) {
      const x = await postCosts([{ amount: '10' }]);
      const y = await postCosts([{ amount: '20' }]);
      const [r1, r2] = await Promise.all([
        postInvoice([billLine(x.ids[0]!), billLine(y.ids[0]!)]),
        postInvoice([billLine(y.ids[0]!), billLine(x.ids[0]!)]),
      ]);
      expect([r1.status, r2.status].sort(), JSON.stringify([r1.json, r2.json])).toEqual([201, 409]);
    }
  });

  /** Holds the source row lock, starts `claim`, runs `inside` under the lock, commits; returns the claim's response. */
  async function underSourceLock(sourceId: string, claim: () => Promise<Res>, inside: (tx: any) => Promise<void>) {
    let pending: Promise<Res> | null = null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM transactions WHERE id = ${sourceId} FOR UPDATE`);
      pending = claim();
      await sleep(400); // the claim is now waiting on the source lock
      await inside(tx);
    });
    return pending!;
  }

  it('claim_vs_source_edit: the edit gives the unbilled line a new id; the claim reloads (409 UNAVAILABLE), never a dangling link', async () => {
    const { txn, ids } = await postCosts([{ amount: '300' }]);
    const r = await underSourceLock(txn.id, () => postInvoice([billLine(ids[0]!)]), async (tx) => {
      await ledger.updateTransaction(c.tenantId, txn.id, {
        txnType: 'expense', txnDate: '2026-10-01', total: '300.0000', memo: 'edited',
        lines: [
          { accountId: c.expense, debit: '300.0000', credit: '0', contactId: c.customer, isBillable: true },
          { accountId: c.bank, debit: '0', credit: '300.0000' },
        ],
      }, undefined, c.companyId, tx);
    });
    expect([r.status, r.json.error?.code]).toEqual([409, 'BILLABLE_COST_UNAVAILABLE']);
    expect(await activeLinks()).toHaveLength(0);
  });

  it('claim_vs_source_void: the void wins; the claim gets 409 UNAVAILABLE', async () => {
    const { txn, ids } = await postCosts([{ amount: '300' }]);
    const r = await underSourceLock(txn.id, () => postInvoice([billLine(ids[0]!)]), async (tx) => {
      await ledger.voidTransactionInTx(tx, c.tenantId, txn.id, 'dup', undefined, { companyId: c.companyId });
    });
    expect([r.status, r.json.error?.code]).toEqual([409, 'BILLABLE_COST_UNAVAILABLE']);
  });

  it('release_vs_source_edit: a memo edit under the lock keeps the billed line; the invoice void then unbills it', async () => {
    const { txn, ids } = await postCosts([{ amount: '300' }]);
    const inv = (await postInvoice([billLine(ids[0]!)])).json.invoice;
    const v = await underSourceLock(txn.id, () => request('POST', `/api/v1/invoices/${inv.id}/void`, c.token, { reason: 'x' }), async (tx) => {
      await ledger.updateTransaction(c.tenantId, txn.id, {
        txnType: 'expense', txnDate: '2026-10-01', total: '300.0000', memo: 'edited while voiding',
        lines: [
          { accountId: c.expense, debit: '300.0000', credit: '0', contactId: c.customer, isBillable: true },
          { accountId: c.bank, debit: '0', credit: '300.0000' },
        ],
      }, undefined, c.companyId, tx);
    });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect((await lineRow(ids[0]!))!.billedStatus).toBe('unbilled');
  });
});

describe('idempotency (rule 9)', () => {
  it('idempotent_replay_claims_once; new_key_after_commit_409_names_invoice', async () => {
    const { ids } = await postCosts([{ amount: '300' }]);
    const key = crypto.randomUUID();
    const a = await postInvoice([billLine(ids[0]!)], {}, { 'Idempotency-Key': key });
    const b = await postInvoice([billLine(ids[0]!)], {}, { 'Idempotency-Key': key });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.json.invoice.id).toBe(a.json.invoice.id);
    expect(await activeLinks()).toHaveLength(1);
    const n = await postInvoice([billLine(ids[0]!)], {}, { 'Idempotency-Key': crypto.randomUUID() });
    expect(n.status).toBe(409);
    expect(n.json.error.code).toBe('BILLABLE_ALREADY_BILLED');
    expect(n.json.error.details.conflicts).toEqual([{ sourceLineId: ids[0], invoiceId: a.json.invoice.id, invoiceNumber: a.json.invoice.txnNumber }]);
    expect(n.json.error.message).toContain(a.json.invoice.txnNumber);
  });
});

describe('company scope (rule 8, security)', () => {
  async function secondCompany() {
    const [co2] = await db.insert(companies).values({ tenantId: c.tenantId, businessName: 'Other Co', entityType: 'llc', setupComplete: true } as never).returning();
    return co2!.id;
  }

  it('other_company_cost_unavailable: another company\'s cost is neither listed nor billable', async () => {
    const co2 = await secondCompany();
    const { ids } = await postCosts([{ amount: '75' }], { companyId: co2 });
    expect((await listCosts()).totalCount).toBe(0);
    const r = await postInvoice([billLine(ids[0]!)]);
    expect([r.status, r.json.error.code]).toEqual([409, 'BILLABLE_COST_UNAVAILABLE']);
    // Another tenant's cost likewise.
    const other = await makeCompany();
    const { ids: theirs } = await postCosts([{ amount: '75' }], { co: other });
    const t = await postInvoice([billLine(theirs[0]!)]);
    expect([t.status, t.json.error.code]).toEqual([409, 'BILLABLE_COST_UNAVAILABLE']);
  });

  it('other_company_details_no_leak: a tenant-wide cost billed by another company is ALREADY_BILLED without that invoice', async () => {
    const co2 = await secondCompany();
    const [shared] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'customer', displayName: 'Shared client' }).returning();
    const { ids } = await postCosts([{ amount: '75', contactId: shared!.id }], { companyId: null });
    const theirs = await request('POST', '/api/v1/invoices', c.token, {
      contactId: shared!.id, txnDate: '2026-10-10', lines: [billLine(ids[0]!)], txnNumber: 'SECRET-77',
    }, { 'X-Company-Id': co2 });
    expect(theirs.status, JSON.stringify(theirs.json)).toBe(201);
    const ours = await request('POST', '/api/v1/invoices', c.token, { contactId: shared!.id, txnDate: '2026-10-10', lines: [billLine(ids[0]!)] });
    expect([ours.status, ours.json.error.code]).toEqual([409, 'BILLABLE_ALREADY_BILLED']);
    expect(ours.json.error.details.conflicts).toEqual([{ sourceLineId: ids[0] }]);
    expect(JSON.stringify(ours.json)).not.toContain('SECRET-77');
    expect(JSON.stringify(ours.json)).not.toContain(theirs.json.invoice.id);
  });

  it('source_read_no_leak (S-5): GET /transactions/:id of a tenant-wide cost names the billing invoice only to its own company', async () => {
    const co2 = await secondCompany();
    const [shared] = await db.insert(contacts).values({ tenantId: c.tenantId, contactType: 'customer', displayName: 'Shared client' }).returning();
    const { txn, ids } = await postCosts([{ amount: '75', contactId: shared!.id }], { companyId: null });
    const theirs = await request('POST', '/api/v1/invoices', c.token, {
      contactId: shared!.id, txnDate: '2026-10-10', lines: [billLine(ids[0]!)], txnNumber: 'SECRET-78',
    }, { 'X-Company-Id': co2 });
    expect(theirs.status, JSON.stringify(theirs.json)).toBe(201);
    // Read from this company: billed, but no invoice named.
    const mine = await request('GET', `/api/v1/transactions/${txn.id}`, c.token);
    expect(mine.status, JSON.stringify(mine.json)).toBe(200);
    const line = (mine.json.transaction.lines as any[]).find((l) => l.id === ids[0]);
    expect([line.billedStatus, line.billedInvoiceId, line.billedInvoiceNumber]).toEqual(['billed', null, null]);
    expect(JSON.stringify(mine.json)).not.toContain('SECRET-78');
    expect(JSON.stringify(mine.json)).not.toContain(theirs.json.invoice.id);
    // Read from the billing company: named.
    const owner = await request('GET', `/api/v1/transactions/${txn.id}`, c.token, undefined, { 'X-Company-Id': co2 });
    const ownLine = (owner.json.transaction.lines as any[]).find((l) => l.id === ids[0]);
    expect([ownLine.billedInvoiceId, ownLine.billedInvoiceNumber]).toEqual([theirs.json.invoice.id, 'SECRET-78']);
  });
});

describe('copies are plain lines (S4)', () => {
  it('duplicate_invoice_plain_lines and transactions_duplicate_plain_lines', async () => {
    const { ids } = await postCosts([{ amount: '842.15' }]);
    const inv = (await postInvoice([billLine(ids[0]!, { markupPercent: '10' })])).json.invoice;
    const d = await request('POST', `/api/v1/invoices/${inv.id}/duplicate`, c.token);
    expect(d.status, JSON.stringify(d.json)).toBe(201);
    expect(d.json.warnings).toEqual([expect.objectContaining({ code: 'BILLABLE_COPIED_AS_PLAIN', sourceLineIds: [ids[0]] })]);
    const t = await request('POST', `/api/v1/transactions/${inv.id}/duplicate`, c.token);
    expect(t.status, JSON.stringify(t.json)).toBe(201);
    expect(t.json.warnings[0].code).toBe('BILLABLE_COPIED_AS_PLAIN');
    for (const id of [d.json.invoice.id, t.json.transaction.id]) {
      const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, id));
      expect(lines.every((l) => l.billableSourceLineId === null && l.lineRole === null), id).toBe(true);
    }
    expect(await activeLinks()).toHaveLength(1);
  });

  it('recurring_invoice_refused_and_never_rebills (Q-P20ah)', async () => {
    const { ids } = await postCosts([{ amount: '842.15' }]);
    const [disc] = await db.insert(items).values({
      tenantId: c.tenantId, companyId: c.companyId, name: `disc-${suffix()}`, itemType: 'discount',
      discountPercent: '10', incomeAccountId: c.revenue, isTaxable: true,
    }).returning();
    const inv = (await postInvoice([
      { accountId: c.revenue, quantity: '1', unitPrice: '100.00', isTaxable: true },
      billLine(ids[0]!, { markupPercent: '10' }),
      { itemId: disc!.id },
    ])).json.invoice;

    // Scheduling it is refused, by either route into a schedule.
    await expect(recurringService.create(c.tenantId, inv.id, { frequency: 'monthly', startDate: '2026-11-10' }))
      .rejects.toMatchObject({ statusCode: 400, code: 'RECURRING_HAS_BILLABLE_COSTS' });
    await expect(templatesService.createFromTransaction(c.tenantId, c.companyId, undefined, {
      transactionId: inv.id, name: `t-${suffix()}`, schedule: { frequency: 'monthly', intervalValue: 1, mode: 'reminder', nextDate: '2026-11-10' } as any,
    })).rejects.toMatchObject({ code: 'RECURRING_HAS_BILLABLE_COSTS' });

    // A copy made anyway (a schedule from before) never bills the cost again
    // and keeps the discount, as a signed line with its item and percent.
    const occ = await postLegacyClone(c.tenantId, { id: crypto.randomUUID(), templateTransactionId: inv.id, nextOccurrence: '2026-11-10' });
    const occId = (occ as { id: string }).id;
    const lines = await db.select().from(journalLines).where(eq(journalLines.transactionId, occId));
    expect(lines.every((l) => l.billableSourceLineId === null && l.lineRole === null)).toBe(true);
    const discLine = lines.find((l) => l.itemId === disc!.id)!;
    expect([discLine.discountPercent, discLine.debit]).toEqual(['10.0000', '10.0000']);
    // 100.00 + 926.37 billed = 1,026.37; 10 % = -102.64. The copy: 100.00 - 10.00 + tax.
    const [occTxn] = await db.select().from(transactions).where(eq(transactions.id, occId));
    expect(occTxn!.subtotal).toBe('90.0000');
    expect(await activeLinks()).toHaveLength(1);
    expect(await checkBillableInvariant(db, c.tenantId)).toEqual([]);
  });

  it('recurring_invoice_keeps_discounts: a copy of a discounted invoice has the same total', async () => {
    const [disc] = await db.insert(items).values({
      tenantId: c.tenantId, companyId: c.companyId, name: `disc-${suffix()}`, itemType: 'discount',
      discountPercent: '10', incomeAccountId: c.revenue, isTaxable: true,
    }).returning();
    const [sub] = await db.insert(items).values({
      tenantId: c.tenantId, companyId: c.companyId, name: `sub-${suffix()}`, itemType: 'subtotal', incomeAccountId: c.revenue,
    }).returning();
    const [amt] = await db.insert(items).values({
      tenantId: c.tenantId, companyId: c.companyId, name: `amt-${suffix()}`, itemType: 'discount',
      unitPrice: '5.00', incomeAccountId: c.revenue, isTaxable: true,
    }).returning();
    const r = await postInvoice([
      { accountId: c.revenue, quantity: '3', unitPrice: '356.00', isTaxable: true },
      { accountId: c.revenue, quantity: '-1', unitPrice: '20.00', isTaxable: true },
      { itemId: sub!.id }, { itemId: disc!.id }, { itemId: amt!.id },
    ]);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const inv = r.json.invoice;
    const occ = await postLegacyClone(c.tenantId, { id: crypto.randomUUID(), templateTransactionId: inv.id, nextOccurrence: '2026-11-10' });
    const [occTxn] = await db.select().from(transactions).where(eq(transactions.id, (occ as { id: string }).id));
    expect([occTxn!.subtotal, occTxn!.taxAmount, occTxn!.total]).toEqual([inv.subtotal, inv.taxAmount, inv.total]);
  });
});

describe('closed periods and audit (S5, I7)', () => {
  it('closed_period_source_billable_no_password; closed_period_invoice_edit_needs_password; audit_rows_claim_release', async () => {
    const { txn, ids } = await postCosts([{ amount: '300' }, { amount: '50' }], { date: '2026-05-15' });
    await db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, c.companyId));
    const srcBefore = (await db.select().from(transactions).where(eq(transactions.id, txn.id)))[0]!;
    const r = await postInvoice([billLine(ids[0]!), billLine(ids[1]!)]);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // Claim and release don't touch the source's updated_at (rule 1).
    expect((await db.select().from(transactions).where(eq(transactions.id, txn.id)))[0]!.updatedAt).toEqual(srcBefore.updatedAt);
    // Releasing one on an open invoice needs no password either.
    const p = await putInvoice(r.json.invoice, [billLine(ids[0]!)], { releaseBillableSourceLineIds: [ids[1]] });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, c.tenantId), eq(auditLog.entityId, txn.id)));
    const vias = audits.map((a) => (a.afterData as any)?.via).filter(Boolean).sort();
    expect(vias).toEqual(['billable_claim', 'billable_claim', 'billable_release']);
    const claimRow = audits.find((a) => (a.afterData as any)?.via === 'billable_claim' && (a.afterData as any).lineId === ids[0])!;
    expect(claimRow.beforeData).toEqual({ lineId: ids[0], billedStatus: 'unbilled' });
    expect(claimRow.afterData).toMatchObject({ billedStatus: 'billed', invoiceId: r.json.invoice.id });
    const invAudit = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'invoice'), eq(auditLog.entityId, r.json.invoice.id)));
    expect(invAudit.map((a) => a.afterData)).toEqual(expect.arrayContaining([
      { billableClaimed: [ids[0], ids[1]] }, { billableClaimed: [], billableReleased: [ids[1]] },
    ]));
    // The invoice's own date still follows the closing date.
    await db.update(companies).set({ lockDate: '2026-10-31' }).where(eq(companies.id, c.companyId));
    const locked = await putInvoice(p.json.invoice, [billLine(ids[0]!)], { memo: 'late' });
    expect([locked.status, locked.json.error.code]).toEqual([423, 'TB_PERIOD_LOCKED']);
  });
});
