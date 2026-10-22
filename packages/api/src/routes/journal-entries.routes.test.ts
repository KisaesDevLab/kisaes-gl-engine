// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Journal entries for ClientLedger (U-58..U-61, U-65 — capabilities
// je-names-v1, je-number-v1, je-adjusting-v1, je-reversing-v1,
// balance-exact-v1):
//   - line names: contactId per line, tenant + company scoped; an A/R or
//     A/P line needs one (JE_AR_AP_NAME_REQUIRED), any number per entry;
//     returned on GET;
//   - txnNumber (≤ 20) and GET /journal-entries/next-number, company-scoped;
//   - isAdjusting returned on GET and the list, list lens adjusting=;
//   - reverseOn: reversal posted in the same db transaction, voided /
//     deleted with the original; on edit omitted keeps it (re-posted on its
//     date when it must change), null removes it, a date moves it; 409
//     REVERSAL_EDITED once changed, closing date on both dates;
//   - debits = credits exactly (0.0001 off is refused).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, transactions, journalLines,
  contacts, transactionTags, userPermissions,
} from '../db/schema/index.js';
import { transactionsRouter } from './transactions.routes.js';
import { journalEntriesRouter } from './journal-entries.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as authService from '../services/auth.service.js';
import * as ledger from '../services/ledger.service.js';
import * as journalEntryService from '../services/journal-entry.service.js';
import { hashClosingPassword } from '../services/closing-password.service.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
const suffix = () => Date.now() + '-' + Math.random().toString(36).slice(2, 6);
const PASSWORD = 'closing-pass-123';

interface Res { status: number; json: any }

function request(method: string, pathname: string, token: string, body?: unknown, companyId?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
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
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tid));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tid));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tid));
  await db.delete(transactions).where(eq(transactions.tenantId, tid));
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

interface Co {
  tenantId: string; userId: string; token: string; companyId: string; companyB: string;
  bank: string; ar: string; ap: string; expense: string; revenue: string;
  customer: string; vendor: string; customerB: string;
}

async function bySystemTag(tenantId: string, tag: string) {
  const a = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)) });
  if (!a) throw new Error(`missing ${tag}`);
  return a.id;
}

async function makeCompany(label: string): Promise<Co> {
  const reg = await authService.register({
    email: `je-${label}-${suffix()}@example.com`, password: 'password123',
    displayName: `Owner ${label}`, companyName: `Journal ${label}`,
  });
  const tenantId = reg.user.tenantId;
  tenantIds.push(tenantId);
  const [companyA] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const [companyB] = await db.insert(companies).values({ tenantId, businessName: `Journal ${label} B`, setupComplete: true }).returning();
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  const expense = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) });
  const revenue = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'revenue')) });
  const [customer] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Rivera Remodel' }).returning();
  const [vendor] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Cosmos Granite' }).returning();
  const [customerB] = await db.insert(contacts).values({ tenantId, companyId: companyB!.id, contactType: 'customer', displayName: 'B only' }).returning();
  return {
    tenantId, userId: reg.user.id, token: reg.tokens.accessToken, companyId: companyA!.id, companyB: companyB!.id,
    bank: bank!.id, expense: expense!.id, revenue: revenue!.id,
    ar: await bySystemTag(tenantId, 'accounts_receivable'), ap: await bySystemTag(tenantId, 'accounts_payable'),
    customer: customer!.id, vendor: vendor!.id, customerB: customerB!.id,
  };
}

const je = (lines: unknown[], extra: Record<string, unknown> = {}) => ({
  txnType: 'journal_entry', txnDate: '2026-07-31', memo: 'Accrue', lines, ...extra,
});
const accrual = (c: Co, amount = '1200.0000') => [
  { accountId: c.expense, debit: amount, credit: '0', description: 'Rent' },
  { accountId: c.ap, debit: '0', credit: amount, contactId: c.vendor },
];

async function balance(accountId: string) {
  const a = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  return a!.balance;
}

async function reversalsOf(tenantId: string, id: string) {
  return db.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.reversesTransactionId, id)));
}

let c: Co;

beforeEach(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/transactions', transactionsRouter);
  app.use('/api/v1/journal-entries', journalEntriesRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); });
  });
  c = await makeCompany('a');
});

afterEach(async () => {
  if (server) { await new Promise<void>((r) => server!.close(() => r())); server = null; }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('journal entry names (U-58)', () => {
  it('stores and returns a contactId per line', async () => {
    const res = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.ar, debit: '50.0000', credit: '0', contactId: c.customer },
      { accountId: c.revenue, debit: '0', credit: '50.0000', contactId: c.vendor },
    ]));
    expect(res.status).toBe(201);
    const got = await request('GET', `/api/v1/transactions/${res.json.transaction.id}`, c.token);
    expect(got.json.transaction.lines.map((l: any) => l.contactId)).toEqual([c.customer, c.vendor]);
    expect(got.json.transaction.lines[0].contactName).toBe('Rivera Remodel');
  });

  it('an A/R or A/P line needs a name; several such lines are allowed in one entry', async () => {
    const noName = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.expense, debit: '10', credit: '0' },
      { accountId: c.ap, debit: '0', credit: '10' },
    ]));
    expect(noName.status).toBe(400);
    expect(noName.json.error.code).toBe('JE_AR_AP_NAME_REQUIRED');

    const two = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.ar, debit: '10', credit: '0', contactId: c.customer },
      { accountId: c.ap, debit: '0', credit: '10', contactId: c.vendor },
    ]));
    expect(two.status).toBe(201);

    // Lines on other accounts need no name.
    const plain = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.expense, debit: '10', credit: '0' },
      { accountId: c.bank, debit: '0', credit: '10' },
    ]));
    expect(plain.status).toBe(201);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId))).toHaveLength(2);
  });

  it('system and bulk posters can opt out of the A/R / A/P name rule, not the scope check', async () => {
    const lines = [
      { accountId: c.expense, debit: '10', credit: '0' },
      { accountId: c.ap, debit: '0', credit: '10' },
    ];
    await expect(journalEntryService.createJournalEntry(c.tenantId, { txnDate: '2026-07-31', lines }, c.userId, c.companyId))
      .rejects.toMatchObject({ code: 'JE_AR_AP_NAME_REQUIRED' });
    const ok = await journalEntryService.createJournalEntry(c.tenantId, { txnDate: '2026-07-31', lines }, c.userId, c.companyId, { arApNames: false });
    expect(ok.id).toBeDefined();
    const other = await makeCompany('opt');
    await expect(journalEntryService.createJournalEntry(c.tenantId, {
      txnDate: '2026-07-31', lines: [lines[0]!, { ...lines[1]!, contactId: other.vendor }],
    }, c.userId, c.companyId, { arApNames: false })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('refuses another tenant’s or another company’s contact', async () => {
    const other = await makeCompany('b');
    const foreign = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.ar, debit: '10', credit: '0', contactId: other.customer },
      { accountId: c.revenue, debit: '0', credit: '10' },
    ]));
    expect(foreign.status).toBe(400);
    expect(foreign.json.error.code).toBe('VALIDATION_ERROR');

    // customerB belongs to company B: refused in company A, accepted in B.
    const wrongCompany = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.ar, debit: '10', credit: '0', contactId: c.customerB },
      { accountId: c.revenue, debit: '0', credit: '10' },
    ]), c.companyId);
    expect(wrongCompany.status).toBe(400);
    const inB = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.ar, debit: '10', credit: '0', contactId: c.customerB },
      { accountId: c.revenue, debit: '0', credit: '10' },
    ]), c.companyB);
    expect(inB.status).toBe(201);
  });
});

describe('journal entry numbers (U-59)', () => {
  it('stores txnNumber, suggests the next one per company, keeps it on edit unless sent', async () => {
    expect((await request('GET', '/api/v1/journal-entries/next-number', c.token)).json).toEqual({ next: '1' });
    const first = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { txnNumber: '41' }));
    expect(first.status).toBe(201);
    expect(first.json.transaction.txnNumber).toBe('41');
    await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { txnNumber: 'ADJ-7' }));
    // Duplicates are allowed.
    expect((await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { txnNumber: '41' }))).status).toBe(201);
    expect((await request('GET', '/api/v1/journal-entries/next-number', c.token)).json).toEqual({ next: '42' });
    // Company B has its own sequence.
    expect((await request('GET', '/api/v1/journal-entries/next-number', c.token, undefined, c.companyB)).json).toEqual({ next: '1' });
    // A voided entry's number still counts.
    const hi = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { txnNumber: '99' }));
    await request('POST', `/api/v1/transactions/${hi.json.transaction.id}/void`, c.token, { reason: 'mistake' });
    expect((await request('GET', '/api/v1/journal-entries/next-number', c.token)).json).toEqual({ next: '100' });

    const id = first.json.transaction.id;
    const kept = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c), { memo: 'edited' }));
    expect(kept.status).toBe(200);
    expect(kept.json.transaction.txnNumber).toBe('41');
    const cleared = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c), { txnNumber: '' }));
    expect(cleared.json.transaction.txnNumber).toBeNull();

    const tooLong = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { txnNumber: '1'.repeat(21) }));
    expect(tooLong.status).toBe(400);
  });
});

describe('adjusting entries (U-60)', () => {
  it('isAdjusting is stored, returned on GET and the list, and filters the list', async () => {
    const adj = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { isAdjusting: true }));
    const reg = await request('POST', '/api/v1/transactions', c.token, je(accrual(c)));
    expect(adj.json.transaction.isAdjusting).toBe(true);
    expect(reg.json.transaction.isAdjusting).toBe(false);
    expect((await request('GET', `/api/v1/transactions/${adj.json.transaction.id}`, c.token)).json.transaction.isAdjusting).toBe(true);

    const all = await request('GET', '/api/v1/transactions?txnType=journal_entry', c.token);
    expect(all.json.data.map((t: any) => [t.id, t.isAdjusting]).sort()).toEqual(
      [[adj.json.transaction.id, true], [reg.json.transaction.id, false]].sort());
    const only = await request('GET', '/api/v1/transactions?adjusting=only', c.token);
    expect(only.json.data.map((t: any) => t.id)).toEqual([adj.json.transaction.id]);
    const excl = await request('GET', '/api/v1/transactions?adjusting=exclude', c.token);
    expect(excl.json.data.map((t: any) => t.id)).toEqual([reg.json.transaction.id]);
    expect((await request('GET', '/api/v1/transactions?adjusting=maybe', c.token)).status).toBe(400);

    // Omitted on edit keeps the flag; false clears it.
    const id = adj.json.transaction.id;
    expect((await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c)))).json.transaction.isAdjusting).toBe(true);
    expect((await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c), { isAdjusting: false }))).json.transaction.isAdjusting).toBe(false);
  });
});

describe('reversing entries (U-61)', () => {
  it('posts the reversal in the same transaction, swapped, linked and returned', async () => {
    const res = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), {
      txnNumber: '12', isAdjusting: true, reverseOn: '2026-08-01',
    }));
    expect(res.status).toBe(201);
    const id = res.json.transaction.id;
    expect(res.json.transaction.reverseOn).toBe('2026-08-01');
    const [rev] = await reversalsOf(c.tenantId, id);
    expect(rev).toBeDefined();
    expect(res.json.transaction.reversalTransactionId).toBe(rev!.id);
    expect(rev).toMatchObject({ txnType: 'journal_entry', txnDate: '2026-08-01', memo: 'Reverses JE 12', status: 'posted', isAdjusting: true, txnNumber: null });
    const revLines = await db.select().from(journalLines).where(eq(journalLines.transactionId, rev!.id));
    expect(revLines.map((l) => [l.accountId, l.debit, l.credit, l.contactId]).sort()).toEqual([
      [c.expense, '0.0000', '1200.0000', null],
      [c.ap, '1200.0000', '0.0000', c.vendor],
    ].sort());
    // Net effect of both on balances: zero.
    expect(Number(await balance(c.expense))).toBe(0);
    expect(Number(await balance(c.ap))).toBe(0);

    const got = await request('GET', `/api/v1/transactions/${id}`, c.token);
    expect(got.json.transaction).toMatchObject({ reversalTransactionId: rev!.id, reverseOn: '2026-08-01' });
    const gotRev = await request('GET', `/api/v1/transactions/${rev!.id}`, c.token);
    expect(gotRev.json.transaction.reversesTransactionId).toBe(id);
  });

  it('reverseOn must be after txnDate', async () => {
    const res = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-07-31' }));
    expect(res.status).toBe(400);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId))).toHaveLength(0);
  });

  it('void and delete of the original take the unchanged reversal with them', async () => {
    const a = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }));
    const [revA] = await reversalsOf(c.tenantId, a.json.transaction.id);
    expect((await request('POST', `/api/v1/transactions/${a.json.transaction.id}/void`, c.token, { reason: 'wrong' })).status).toBe(200);
    expect((await db.query.transactions.findFirst({ where: eq(transactions.id, revA!.id) }))!.status).toBe('void');

    const b = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }));
    const [revB] = await reversalsOf(c.tenantId, b.json.transaction.id);
    expect((await request('DELETE', `/api/v1/transactions/${b.json.transaction.id}`, c.token, {})).status).toBe(200);
    expect((await db.query.transactions.findFirst({ where: eq(transactions.id, revB!.id) }))!.status).toBe('deleted');
    expect(Number(await balance(c.expense))).toBe(0);
    expect(Number(await balance(c.ap))).toBe(0);
  });

  it('an edited reversal blocks void, delete and edit of the original (409 REVERSAL_EDITED)', async () => {
    const a = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }));
    const id = a.json.transaction.id;
    const [rev] = await reversalsOf(c.tenantId, id);
    const edit = await request('PUT', `/api/v1/transactions/${rev!.id}`, c.token, {
      txnType: 'journal_entry', txnDate: '2026-08-02', memo: 'moved',
      lines: [
        { accountId: c.ap, debit: '1200', credit: '0', contactId: c.vendor },
        { accountId: c.expense, debit: '0', credit: '1200' },
      ],
    });
    expect(edit.status).toBe(200);
    for (const [method, path, body] of [
      ['POST', `/api/v1/transactions/${id}/void`, { reason: 'x' }],
      ['DELETE', `/api/v1/transactions/${id}`, {}],
      ['PUT', `/api/v1/transactions/${id}`, je(accrual(c, '1300'), { reverseOn: '2026-08-01' })],
    ] as const) {
      const r = await request(method, path, c.token, body);
      expect(r.status).toBe(409);
      expect(r.json.error.code).toBe('REVERSAL_EDITED');
      expect(r.json.error.details.reversalTransactionId).toBe(rev!.id);
    }
    expect((await db.query.transactions.findFirst({ where: eq(transactions.id, id) }))!.status).toBe('posted');

    // Once the owner voids the reversal, the original voids alone.
    expect((await request('POST', `/api/v1/transactions/${rev!.id}/void`, c.token, { reason: 'x' })).status).toBe(200);
    expect((await request('POST', `/api/v1/transactions/${id}/void`, c.token, { reason: 'x' })).status).toBe(200);
  });

  it('a recategorized reversal line (no header edit) also counts as edited', async () => {
    const a = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }));
    const [rev] = await reversalsOf(c.tenantId, a.json.transaction.id);
    await db.update(journalLines).set({ accountId: c.bank })
      .where(and(eq(journalLines.transactionId, rev!.id), eq(journalLines.accountId, c.expense)));
    const r = await request('POST', `/api/v1/transactions/${a.json.transaction.id}/void`, c.token, { reason: 'x' });
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('REVERSAL_EDITED');
  });

  const live = async (id: string) => (await reversalsOf(c.tenantId, id)).filter((t) => t.status === 'posted');
  const creditsOf = async (txnId: string) =>
    (await db.select().from(journalLines).where(eq(journalLines.transactionId, txnId))).map((l) => l.credit).sort();

  it('edit, reverseOn omitted: keeps the reversal; re-posts it on its stored date when the lines change', async () => {
    const a = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }));
    const id = a.json.transaction.id;
    const [first] = await reversalsOf(c.tenantId, id);

    // Header-only edit: the same reversal row stays, untouched.
    const memoOnly = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c), { memo: 'Accrue rent' }));
    expect(memoOnly.status).toBe(200);
    expect(memoOnly.json.transaction).toMatchObject({ reversalTransactionId: first!.id, reverseOn: '2026-08-01' });
    expect((await reversalsOf(c.tenantId, id)).map((t) => [t.id, t.status])).toEqual([[first!.id, 'posted']]);

    // New lines: the old reversal is deleted and a new one posted on the stored date.
    const edited = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c, '1300.5000')));
    expect(edited.status).toBe(200);
    expect(edited.json.transaction.reverseOn).toBe('2026-08-01');
    const all = await reversalsOf(c.tenantId, id);
    expect(all.find((t) => t.id === first!.id)!.status).toBe('deleted');
    const now = await live(id);
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ txnDate: '2026-08-01', id: edited.json.transaction.reversalTransactionId });
    expect(await creditsOf(now[0]!.id)).toEqual(['0.0000', '1300.5000']);
    expect(Number(await balance(c.expense))).toBe(0);

    // A new number changes the reversal memo, so it is re-posted too.
    const numbered = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c, '1300.5000'), { txnNumber: '77' }));
    expect(numbered.status).toBe(200);
    const [renamed] = await live(id);
    expect(renamed).toMatchObject({ memo: 'Reverses JE 77', txnDate: '2026-08-01' });

    // The kept date must still be after the entry date.
    const tooLate = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c, '1300.5000'), { txnDate: '2026-08-01' }));
    expect(tooLate.status).toBe(400);
    expect(tooLate.json.error.code).toBe('VALIDATION_ERROR');
    expect((await live(id))[0]!.id).toBe(renamed!.id);

    // An entry with no reversal does not get one from an omitted reverseOn.
    const plain = await request('POST', '/api/v1/transactions', c.token, je(accrual(c)));
    const plainEdit = await request('PUT', `/api/v1/transactions/${plain.json.transaction.id}`, c.token, je(accrual(c, '5')));
    expect(plainEdit.json.transaction.reversalTransactionId).toBeNull();
    expect(await reversalsOf(c.tenantId, plain.json.transaction.id)).toHaveLength(0);
  });

  it('edit, reverseOn null: removes the reversal', async () => {
    const a = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }));
    const id = a.json.transaction.id;
    const removed = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c, '1300.5000'), { reverseOn: null }));
    expect(removed.status).toBe(200);
    expect(removed.json.transaction).toMatchObject({ reversalTransactionId: null, reverseOn: null });
    expect(await live(id)).toHaveLength(0);
    expect((await reversalsOf(c.tenantId, id))[0]!.status).toBe('deleted');
    expect(Number(await balance(c.expense))).toBe(1300.5);
    const got = await request('GET', `/api/v1/transactions/${id}`, c.token);
    expect(got.json.transaction.reverseOn).toBeNull();
  });

  it('edit, reverseOn a date: moves (or adds) the reversal; the same date and lines keep it', async () => {
    const a = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }));
    const id = a.json.transaction.id;
    const [first] = await reversalsOf(c.tenantId, id);

    // What the web form sends back: the reverseOn GET returned.
    const got = await request('GET', `/api/v1/transactions/${id}`, c.token);
    const roundTrip = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c), { reverseOn: got.json.transaction.reverseOn }));
    expect(roundTrip.json.transaction.reversalTransactionId).toBe(first!.id);
    expect(await reversalsOf(c.tenantId, id)).toHaveLength(1);

    const moved = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c, '1300.5000'), { reverseOn: '2026-08-15' }));
    expect(moved.status).toBe(200);
    expect(moved.json.transaction.reverseOn).toBe('2026-08-15');
    expect((await reversalsOf(c.tenantId, id)).find((t) => t.id === first!.id)!.status).toBe('deleted');
    const now = await live(id);
    expect(now.map((t) => t.txnDate)).toEqual(['2026-08-15']);
    expect(await creditsOf(now[0]!.id)).toEqual(['0.0000', '1300.5000']);

    // An entry without a reversal gets one from a date.
    const plain = await request('POST', '/api/v1/transactions', c.token, je(accrual(c)));
    const added = await request('PUT', `/api/v1/transactions/${plain.json.transaction.id}`, c.token, je(accrual(c), { reverseOn: '2026-08-02' }));
    expect(added.json.transaction.reverseOn).toBe('2026-08-02');
    expect(await live(plain.json.transaction.id)).toHaveLength(1);
    expect(Number(await balance(c.expense))).toBe(0);
  });

  it('a reversal changed by hand still blocks an omitted-reverseOn edit that must re-post it', async () => {
    const a = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }));
    const id = a.json.transaction.id;
    const [rev] = await reversalsOf(c.tenantId, id);
    await db.update(transactions).set({ updatedAt: new Date(Date.now() + 60_000) }).where(eq(transactions.id, rev!.id));
    // Nothing about the reversal changes: allowed, reversal kept.
    expect((await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c), { memo: 'x' }))).status).toBe(200);
    expect((await live(id))[0]!.id).toBe(rev!.id);
    // New lines need a re-post: refused, nothing changes.
    const r = await request('PUT', `/api/v1/transactions/${id}`, c.token, je(accrual(c, '9')));
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe('REVERSAL_EDITED');
    expect(Number(await balance(c.expense))).toBe(0);
  });

  it('edit and reversal stay in the company of the entry (L5)', async () => {
    const a = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }), c.companyId);
    const id = a.json.transaction.id;
    // Through company B the entry is not found, and nothing changes.
    const other = await request('PUT', `/api/v1/transactions/${id}`, c.token, je([
      { accountId: c.expense, debit: '5', credit: '0' },
      { accountId: c.bank, debit: '0', credit: '5' },
    ], { reverseOn: null }), c.companyB);
    expect(other.status).toBe(404);
    expect(await live(id)).toHaveLength(1);
    await expect(ledger.updateTransaction(c.tenantId, id, {
      txnType: 'journal_entry', txnDate: '2026-07-31',
      lines: [{ accountId: c.expense, debit: '5', credit: '0' }, { accountId: c.bank, debit: '0', credit: '5' }],
    }, c.userId, c.companyB)).rejects.toMatchObject({ statusCode: 404 });
    // postReversal refuses a caller company that differs from the entry's.
    const entry = await db.query.transactions.findFirst({ where: eq(transactions.id, id) });
    await expect(db.transaction(async (tx) => ledger.postReversal(tx, c.tenantId, { ...entry!, lines: [] }, '2026-08-05', c.userId, c.companyB)))
      .rejects.toMatchObject({ statusCode: 404 });
    // The reversal carries the entry's company.
    expect((await live(id))[0]!.companyId).toBe(c.companyId);
  });

  it('txnDate must be a calendar date (L8)', async () => {
    for (const txnDate of ['2026-07-31T00:00:00Z', '2026-02-30', '07/31/2026']) {
      const r = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { txnDate }));
      expect(r.status).toBe(400);
    }
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId))).toHaveLength(0);
  });

  it('duplicate copies line names and the adjusting flag (L6)', async () => {
    const a = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { isAdjusting: true }));
    const dup = await request('POST', `/api/v1/transactions/${a.json.transaction.id}/duplicate`, c.token, {});
    expect(dup.status).toBe(201);
    const got = await request('GET', `/api/v1/transactions/${dup.json.transaction.id}`, c.token);
    expect(got.json.transaction.isAdjusting).toBe(true);
    expect(got.json.transaction.lines.map((l: any) => l.contactId ?? 'none').sort()).toEqual([c.vendor, 'none'].sort());
  });

  it('closing date applies to both dates (reversing across a closed period)', async () => {
    await db.update(companies).set({ lockDate: '2026-07-31', closingPasswordHash: await hashClosingPassword(PASSWORD) })
      .where(eq(companies.id, c.companyId));
    // Original in the closed period, reversal after it: needs the password.
    const locked = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01' }));
    expect(locked.status).toBe(423);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, c.tenantId))).toHaveLength(0);
    const ok = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { reverseOn: '2026-08-01', closingPassword: PASSWORD }));
    expect(ok.status).toBe(201);
    expect(await reversalsOf(c.tenantId, ok.json.transaction.id)).toHaveLength(1);

    // Posted open, then the period closes over the reversal's date too:
    // voiding needs the password for both, and nothing changes without it.
    await db.update(companies).set({ lockDate: '2026-06-30' }).where(eq(companies.id, c.companyId));
    const open = await request('POST', '/api/v1/transactions', c.token, je(accrual(c), { txnDate: '2026-08-10', reverseOn: '2026-09-01' }));
    expect(open.status).toBe(201);
    await db.update(companies).set({ lockDate: '2026-09-30' }).where(eq(companies.id, c.companyId));
    const noPw = await request('POST', `/api/v1/transactions/${open.json.transaction.id}/void`, c.token, { reason: 'x' });
    expect(noPw.status).toBe(423);
    expect((await reversalsOf(c.tenantId, open.json.transaction.id))[0]!.status).toBe('posted');
    const withPw = await request('POST', `/api/v1/transactions/${open.json.transaction.id}/void`, c.token, { reason: 'x', closingPassword: PASSWORD });
    expect(withPw.status).toBe(200);
    expect((await reversalsOf(c.tenantId, open.json.transaction.id))[0]!.status).toBe('void');
  });
});

describe('exact balance (U-65)', () => {
  it('refuses 0.0001 off, accepts exact four-place amounts', async () => {
    const off = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.expense, debit: '100.0001', credit: '0' },
      { accountId: c.bank, debit: '0', credit: '100.0000' },
    ]));
    expect(off.status).toBe(400);
    expect(off.json.error.message).toMatch(/does not balance/);
    const exact = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.expense, debit: '100.0001', credit: '0' },
      { accountId: c.bank, debit: '0', credit: '100.0001' },
    ]));
    expect(exact.status).toBe(201);
  });

  it('compares at the stored scale: sub-0.0001 parts that round apart are refused', async () => {
    // 0.00005 + 0.00005 stores as 0.0001 + 0.0001 = 0.0002 against 0.0001.
    await expect(ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2026-07-31',
      lines: [
        { accountId: c.expense, debit: '0.00005', credit: '0' },
        { accountId: c.expense, debit: '0.00005', credit: '0' },
        { accountId: c.bank, debit: '0', credit: '0.0001' },
      ],
    }, c.userId, c.companyId)).rejects.toThrow('does not balance');
  });

  it('edits are held to the same rule', async () => {
    const ok = await request('POST', '/api/v1/transactions', c.token, je([
      { accountId: c.expense, debit: '10', credit: '0' },
      { accountId: c.bank, debit: '0', credit: '10' },
    ]));
    const bad = await request('PUT', `/api/v1/transactions/${ok.json.transaction.id}`, c.token, je([
      { accountId: c.expense, debit: '10.0001', credit: '0' },
      { accountId: c.bank, debit: '0', credit: '10' },
    ]));
    expect(bad.status).toBe(400);
  });
});
