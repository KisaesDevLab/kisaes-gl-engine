// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Reproduction: on a comparative balance sheet, an account with a balance in
// the PRIOR period but zero in the CURRENT period (e.g. a loan paid off during
// the year) must still appear, showing the prior amount. Zero-balance accounts
// are omitted from each period's balance sheet, so the merge must union names
// across BOTH periods.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, transactions, journalLines } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as accountsService from './accounts.service.js';
import * as ledger from './ledger.service.js';
import * as comparison from './report-comparison.service.js';

let tenantId = '', userId = '', bankId = '', loanId = '';

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

async function post(date: string, debit: string, credit: string, amount: string) {
  await ledger.postTransaction(tenantId, {
    txnType: 'journal_entry', txnDate: date,
    lines: [{ accountId: debit, debit: amount, credit: '0' }, { accountId: credit, debit: '0', credit: amount }],
  });
}

async function setup() {
  const { user } = await authService.register({
    email: `bsprior-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'BS', companyName: 'BS Co',
  });
  tenantId = user.tenantId; userId = user.id;
  bankId = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!.id;
  loanId = (await accountsService.create(tenantId, { name: 'Equipment Loan', accountType: 'liability', accountNumber: '2500' })).id;

  // 2025: borrow $500 (bank +500, loan +500). 2026: repay in full (loan 0 as-of 2026).
  await post('2025-06-01', bankId, loanId, '500');
  await post('2026-06-01', loanId, bankId, '500');
}

beforeEach(async () => { await cleanDb(); await setup(); });
afterEach(async () => { await cleanDb(); });

describe('comparative BS keeps prior-only rows', () => {
  it('shows the loan (0 current, 500 prior) instead of dropping it', async () => {
    const bs = await comparison.buildComparativeBS(tenantId, '2026-12-31', 'accrual', 'previous_year', null) as {
      liabilities: Array<{ name: string; values: Array<number | null> }>;
    };
    const loan = bs.liabilities.find((r) => r.name === 'Equipment Loan');
    expect(loan).toBeTruthy();
    expect(loan!.values[0]).toBeCloseTo(0, 4);   // current: paid off
    expect(loan!.values[1]).toBeCloseTo(500, 4); // prior: still shown
  });

  it('two accounts sharing a name each keep their prior amount (accountId keyed, not name)', async () => {
    // Account names are not unique. Create a SECOND "Equipment Loan" (different
    // number), borrow 300 in 2025, repay in 2026 → 0 current, 300 prior. The
    // existing loan is 0 current / 500 prior. Name-keying would collapse both
    // into one row and hide one prior amount; accountId-keying keeps both.
    const loan2 = (await accountsService.create(tenantId, { name: 'Equipment Loan', accountType: 'liability', accountNumber: '2600' })).id;
    await post('2025-06-01', bankId, loan2, '300');
    await post('2026-06-01', loan2, bankId, '300');

    const bs = await comparison.buildComparativeBS(tenantId, '2026-12-31', 'accrual', 'previous_year', null) as {
      liabilities: Array<{ name: string; values: Array<number | null> }>;
    };
    const loans = bs.liabilities.filter((r) => r.name === 'Equipment Loan');
    expect(loans.length).toBe(2); // both survive, not merged by name
    const priorAmounts = loans.map((r) => r.values[1]).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(priorAmounts[0]).toBeCloseTo(300, 4);
    expect(priorAmounts[1]).toBeCloseTo(500, 4);
  });

  it('grouped mode also keeps the prior-only loan inside its detail-type group', async () => {
    const bs = await comparison.buildComparativeBS(tenantId, '2026-12-31', 'accrual', 'previous_year', null, 'detail_type') as {
      groups?: { liabilities: Array<{ rows: Array<{ name: string; values: Array<number | null> }> }> };
    };
    const rows = (bs.groups?.liabilities ?? []).flatMap((g) => g.rows);
    const loan = rows.find((r) => r.name === 'Equipment Loan');
    expect(loan).toBeTruthy();
    expect(loan!.values[1]).toBeCloseTo(500, 4);
  });
});
