// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// listBills: the whitelisted server-side sort, and a status SET where
// 'overdue' also matches unpaid/partial bills past due — the column
// derives "overdue" from the due date, so the filter must match the column.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, contacts, transactions, journalLines } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as billService from './bill.service.js';

let tenantId = '';
let userId = '';
let expenseId = '';
let vendorA = '';
let vendorB = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanDb();
  const { user } = await authService.register({
    email: `billsort-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Bill Sort', companyName: 'Bill Sort Co',
  });
  tenantId = user.tenantId; userId = user.id;
  await db.insert(accounts).values({ tenantId, name: 'Accounts Payable', accountType: 'liability', accountNumber: '2060', systemTag: 'accounts_payable', isSystem: true });
  const [exp] = await db.insert(accounts).values({ tenantId, name: 'Utilities', accountType: 'expense', accountNumber: '7021' }).returning();
  expenseId = exp!.id;
  const [a] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Acme' }).returning();
  const [b] = await db.insert(contacts).values({ tenantId, contactType: 'vendor', displayName: 'Zenith' }).returning();
  vendorA = a!.id; vendorB = b!.id;
  const mk = (contactId: string, txnDate: string, dueDate: string, amount: string, vin: string) =>
    billService.createBill(tenantId, { contactId, txnDate, dueDate, vendorInvoiceNumber: vin, lines: [{ accountId: expenseId, amount }] }, userId);
  // Past due (unpaid): due 2020. Future due: 2099.
  await mk(vendorB, '2020-01-01', '2020-01-15', '300.00', 'Z-3');
  await mk(vendorA, '2026-09-01', '2099-01-01', '10.00', 'A-1');
  await mk(vendorA, '2026-09-02', '2099-02-01', '20.00', 'A-2');
});
afterEach(async () => { await cleanDb(); });

const vins = async (f: Parameters<typeof billService.listBills>[1]) =>
  (await billService.listBills(tenantId, f)).data.map((b) => b.vendorInvoiceNumber);

describe('listBills — sort and status set', () => {
  it('keeps due-soonest-first by default and honours the whitelisted sorts', async () => {
    expect(await vins({})).toEqual(['Z-3', 'A-1', 'A-2']);
    // Equal vendors fall back to newest-first (created_at DESC), the list's tiebreak.
    expect(await vins({ sortBy: 'vendor', sortDir: 'asc' })).toEqual(['A-2', 'A-1', 'Z-3']);
    expect(await vins({ sortBy: 'total', sortDir: 'desc' })).toEqual(['Z-3', 'A-2', 'A-1']);
    expect(await vins({ sortBy: 'date', sortDir: 'desc' })).toEqual(['A-2', 'A-1', 'Z-3']);
  });

  it('a status set with "overdue" also matches past-due unpaid bills the column shows as overdue', async () => {
    // Stored status is 'unpaid' on all three; only Z-3 is past due.
    expect(await vins({ billStatus: ['overdue'] })).toEqual(['Z-3']);
    expect(await vins({ billStatus: ['paid'] })).toEqual([]);
    expect((await vins({ billStatus: ['unpaid', 'paid'] })).sort()).toEqual(['A-1', 'A-2', 'Z-3']);
    // A single string still works the old exact way.
    expect(await vins({ billStatus: 'overdue' })).toEqual([]);
  });
});
