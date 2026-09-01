// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// listTransactions search: matches the header memo, txn number, payee, amount —
// and (added) per-line journal_lines.description, so a detail typed on an
// individual line is findable even when the header memo says something else.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, transactions, journalLines } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as ledger from './ledger.service.js';

let tenantId = '', userId = '', bankId = '', expId = '';

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function post(memo: string, lineDescriptions: [string | undefined, string | undefined]) {
  await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: '2026-03-15', memo,
    lines: [
      { accountId: expId, debit: '10.00', credit: '0', description: lineDescriptions[0] },
      { accountId: bankId, debit: '0', credit: '10.00', description: lineDescriptions[1] },
    ],
  });
}

async function setup() {
  const { user } = await authService.register({
    email: `lsearch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Search', companyName: 'Search Co',
  });
  tenantId = user.tenantId; userId = user.id;
  bankId = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  expId = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1))[0]!.id;
  await post('office supplies run', [undefined, undefined]);
  await post('monthly close', ['reclass ZEBRA printer lease', undefined]);
  await post('unrelated', [undefined, undefined]);
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

const search = async (term: string) =>
  (await ledger.listTransactions(tenantId, { search: term })).data.map((t: { memo: string | null }) => t.memo).sort();

describe('listTransactions search', () => {
  it('matches the header memo (case-insensitive)', async () => {
    expect(await search('OFFICE supplies')).toEqual(['office supplies run']);
  });

  it('matches a line-level description', async () => {
    expect(await search('zebra')).toEqual(['monthly close']);
  });

  it('does not return transactions matching neither memo nor lines', async () => {
    expect(await search('no-such-term')).toEqual([]);
  });

  it('returns a matching count and totals alongside the data', async () => {
    const result = await ledger.listTransactions(tenantId, { search: 'zebra' });
    expect(result.total).toBe(1);
  });
});
