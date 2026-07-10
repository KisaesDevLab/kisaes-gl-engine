// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// listTransactions basis lens: 'cash' keeps transactions whose basis flag is
// both or cash; 'accrual' keeps both or accrual; omitted keeps all. Mirrors how
// reports include transactions per basis (a basis-specific adjusting entry only
// shows on its own basis; 'both' always shows).

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

async function post(basis: 'both' | 'cash' | 'accrual', memo: string) {
  await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: '2026-03-15', memo, basis,
    lines: [
      { accountId: expId, debit: '10.00', credit: '0' },
      { accountId: bankId, debit: '0', credit: '10.00' },
    ],
  });
}

async function setup() {
  const { user } = await authService.register({
    email: `basis-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Basis', companyName: 'Basis Co',
  });
  tenantId = user.tenantId; userId = user.id;
  bankId = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  expId = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1))[0]!.id;
  await post('both', 'JE both');
  await post('cash', 'JE cash');
  await post('accrual', 'JE accrual');
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

const memos = async (basis?: 'cash' | 'accrual') =>
  (await ledger.listTransactions(tenantId, basis ? { basis } : {})).data.map((t: { memo: string | null }) => t.memo).sort();

describe('listTransactions basis lens', () => {
  it('no basis filter returns all bases', async () => {
    expect(await memos()).toEqual(['JE accrual', 'JE both', 'JE cash']);
  });
  it('cash keeps both + cash, hides accrual-only', async () => {
    expect(await memos('cash')).toEqual(['JE both', 'JE cash']);
  });
  it('accrual keeps both + accrual, hides cash-only', async () => {
    expect(await memos('accrual')).toEqual(['JE accrual', 'JE both']);
  });
});
