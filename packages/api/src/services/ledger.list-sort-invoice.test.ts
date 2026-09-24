// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// listTransactions for the Invoices list: the three invoice sort keys, a
// customer SET, and an invoice-status SET.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, contacts, transactions, journalLines } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';

let tenantId = '';
let userId = '';
let arId = '';
let salesId = '';
let custA = '';
let custB = '';

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
    email: `invsort-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Inv Sort', companyName: 'Inv Sort Co',
  });
  tenantId = user.tenantId; userId = user.id;
  const [ar] = await db.insert(accounts).values({ tenantId, name: 'A/R', accountType: 'asset', accountNumber: '1200', systemTag: 'accounts_receivable', isSystem: true }).returning();
  const [sales] = await db.insert(accounts).values({ tenantId, name: 'Sales', accountType: 'revenue', accountNumber: '4000' }).returning();
  arId = ar!.id; salesId = sales!.id;
  const [a] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Ann' }).returning();
  const [b] = await db.insert(contacts).values({ tenantId, contactType: 'customer', displayName: 'Bob' }).returning();
  custA = a!.id; custB = b!.id;
  const inv = (txnNumber: string, contactId: string, total: string, dueDate: string, invoiceStatus: string, balanceDue: string) =>
    ledger.postTransaction(tenantId, {
      txnType: 'invoice', txnDate: '2026-09-01', txnNumber, contactId, total, dueDate, invoiceStatus, balanceDue,
      lines: [{ accountId: arId, debit: total, credit: '0' }, { accountId: salesId, debit: '0', credit: total }],
    } as never, userId);
  await inv('INV-1', custA, '100.00', '2026-10-01', 'sent', '100.00');
  await inv('INV-2', custB, '20.00', '2026-09-15', 'paid', '0.00');
  await inv('INV-3', custA, '300.00', '2026-11-01', 'partial', '150.00');
});
afterEach(async () => { await cleanDb(); });

const nums = async (f: Parameters<typeof ledger.listTransactions>[1]) =>
  (await ledger.listTransactions(tenantId, { ...f, txnType: 'invoice' })).data.map((t) => t.txnNumber);

describe('listTransactions — invoice sort keys and sets', () => {
  it('sorts by due date, balance due (numeric) and invoice status', async () => {
    expect(await nums({ sortBy: 'dueDate', sortDir: 'asc' })).toEqual(['INV-2', 'INV-1', 'INV-3']);
    expect(await nums({ sortBy: 'balanceDue', sortDir: 'desc' })).toEqual(['INV-3', 'INV-1', 'INV-2']);
    expect(await nums({ sortBy: 'invoiceStatus', sortDir: 'asc' })).toEqual(['INV-2', 'INV-3', 'INV-1']);
  });
  it('filters by a customer set and an invoice-status set; a single contact id still works', async () => {
    expect((await nums({ contactId: [custA] })).sort()).toEqual(['INV-1', 'INV-3']);
    expect((await nums({ contactId: [custA, custB] })).sort()).toEqual(['INV-1', 'INV-2', 'INV-3']);
    expect(await nums({ contactId: custB })).toEqual(['INV-2']);
    expect((await nums({ invoiceStatus: ['paid', 'partial'] })).sort()).toEqual(['INV-2', 'INV-3']);
  });
});
