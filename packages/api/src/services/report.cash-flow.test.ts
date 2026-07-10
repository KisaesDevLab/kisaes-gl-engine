// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Direct-method cash flow: net change must equal the actual cash-account
// movement, classified operating / investing / financing by counter-leg.
// (The previous implementation was a stub that reported accrual net
// income as the net change in cash.)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, auditLog, contacts,
  transactions, journalLines, tags, transactionTags,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';
import * as reportService from './report.service.js';

let tenantId: string;

async function cleanDb() {
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function mk(name: string, accountType: string, accountNumber: string, detailType: string | null) {
  const [a] = await db.insert(accounts).values({ tenantId, name, accountNumber, accountType, detailType }).returning();
  return a!;
}

async function post(memo: string, lines: Array<{ accountId: string; debit: string; credit: string }>, date: string) {
  return ledger.postTransaction(tenantId, { txnType: 'journal_entry', txnDate: date, memo, lines });
}

beforeEach(async () => {
  await cleanDb();
  const [t] = await db.insert(tenants).values({ name: 'CF', slug: `cf-${Date.now()}` }).returning();
  tenantId = t!.id;
});

afterEach(async () => {
  await cleanDb();
});

describe('buildCashFlowStatement (direct method)', () => {
  it('classifies cash movements and nets to the true cash change', async () => {
    const cash = await mk('Checking', 'asset', '1000', 'checking');
    const rev = await mk('Sales', 'revenue', '4000', 'service');
    const truck = await mk('Vehicles', 'asset', '10600', 'fixed_asset');
    const draw = await mk('Owner Withdraw', 'equity', '30170', 'owners_equity');

    // Operating: cash sale +10,000
    await post('sale', [
      { accountId: cash.id, debit: '10000', credit: '0' },
      { accountId: rev.id, debit: '0', credit: '10000' },
    ], '2026-03-01');
    // Investing: buy a truck −6,000
    await post('truck', [
      { accountId: truck.id, debit: '6000', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '6000' },
    ], '2026-04-01');
    // Financing: owner draw −1,500
    await post('draw', [
      { accountId: draw.id, debit: '1500', credit: '0' },
      { accountId: cash.id, debit: '0', credit: '1500' },
    ], '2026-05-01');

    const cf = await reportService.buildCashFlowStatement(tenantId, '2026-01-01', '2026-12-31');
    expect(cf.operatingActivities).toBeCloseTo(10000, 2);
    expect(cf.investingActivities).toBeCloseTo(-6000, 2);
    expect(cf.financingActivities).toBeCloseTo(-1500, 2);
    expect(cf.netChange).toBeCloseTo(2500, 2); // = true cash movement
  });

  it('drops cash-to-cash transfers (net zero)', async () => {
    const checking = await mk('Checking', 'asset', '1000', 'checking');
    const savings = await mk('Savings', 'asset', '1010', 'savings');
    await post('transfer', [
      { accountId: savings.id, debit: '500', credit: '0' },
      { accountId: checking.id, debit: '0', credit: '500' },
    ], '2026-03-01');

    const cf = await reportService.buildCashFlowStatement(tenantId, '2026-01-01', '2026-12-31');
    expect(cf.netChange).toBeCloseTo(0, 2);
    expect(cf.operatingActivities).toBeCloseTo(0, 2);
  });
});
