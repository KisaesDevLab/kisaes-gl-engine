// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-163: a bank's transaction id (OFX FITID) is unique per bank connection.
//   - two accounts of one tenant may each import a transaction with the
//     same FITID (the old tenant-wide lookup dropped the second);
//   - re-importing a file into one account adds nothing;
//   - a FITID repeated inside one file is ignored on every occurrence: the
//     rows import (no 500 from the unique index) and dedupe by date, amount
//     and description on the next import.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, bankConnections, bankFeedItems,
  transactionClassificationState, categorizationHistory, transactions, journalLines,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';

let tenantId = '';
let userId = '';
let connA = '';
let connB = '';

function ofx(rows: Array<{ fitid?: string; date: string; amount: string; name: string }>): string {
  const body = rows.map((r) => [
    '<STMTTRN>', '<TRNTYPE>DEBIT', `<DTPOSTED>${r.date}`, `<TRNAMT>${r.amount}`,
    ...(r.fitid ? [`<FITID>${r.fitid}`] : []), `<NAME>${r.name}`, '</STMTTRN>',
  ].join('\n')).join('\n');
  return `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n${body}\n</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
}

async function feedRows(connectionId: string) {
  return db.select().from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.bankConnectionId, connectionId)));
}

async function cleanDb() {
  if (!tenantId) return;
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
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

beforeEach(async () => {
  const { user } = await authService.register({
    email: `fitid-scope-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123',
    displayName: 'FITID Scope User',
    companyName: 'FITID Scope Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const banks = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'asset')));
  // Two distinct accounts stand in for two bank accounts; the connection is
  // what scopes the FITID.
  const [a, b] = banks;
  const [ca] = await db.insert(bankConnections).values({ tenantId, accountId: a!.id, provider: 'manual', institutionName: 'A' }).returning();
  const [cb] = await db.insert(bankConnections).values({ tenantId, accountId: b!.id, provider: 'manual', institutionName: 'B' }).returning();
  connA = ca!.id;
  connB = cb!.id;
});

afterEach(cleanDb);

describe('importFromOfx FITID scope (U-163)', () => {
  it('imports the same FITID into two accounts, and a re-import into one adds nothing', async () => {
    const file = ofx([{ fitid: 'F-1', date: '20261101', amount: '-12.34', name: 'COFFEE' }]);
    const a = await bankFeedService.importFromOfx(tenantId, connA, file);
    const b = await bankFeedService.importFromOfx(tenantId, connB, file);
    expect(a.items).toHaveLength(1);
    expect(b.items).toHaveLength(1);
    expect((await feedRows(connA))[0]!.providerTransactionId).toBe('F-1');
    expect((await feedRows(connB))[0]!.providerTransactionId).toBe('F-1');

    const again = await bankFeedService.importFromOfx(tenantId, connA, file);
    expect(again.items).toHaveLength(0);
    expect(await feedRows(connA)).toHaveLength(1);
  });

  it('ignores a FITID repeated in one file on every occurrence (different rows)', async () => {
    const file = ofx([
      { fitid: 'DUP', date: '20261102', amount: '-5.00', name: 'PARKING' },
      { fitid: 'DUP', date: '20261103', amount: '-7.50', name: 'TOLL' },
      { fitid: 'OK-1', date: '20261104', amount: '100.00', name: 'DEPOSIT' },
    ]);
    const first = await bankFeedService.importFromOfx(tenantId, connA, file);
    expect(first.items).toHaveLength(3);
    const rows = await feedRows(connA);
    expect(rows.filter((r) => r.providerTransactionId === null)).toHaveLength(2);
    expect(rows.find((r) => r.providerTransactionId === 'OK-1')!.amount).toBe('-100.0000');

    // The rows without a FITID dedupe by date, amount and description.
    const again = await bankFeedService.importFromOfx(tenantId, connA, file);
    expect(again.items).toHaveLength(0);
    expect(await feedRows(connA)).toHaveLength(3);
  });

  it('ignores a FITID repeated in one file on every occurrence (identical rows)', async () => {
    const row = { fitid: 'SAME', date: '20261105', amount: '-3.25', name: 'VENDING' };
    const file = ofx([row, row]);
    const first = await bankFeedService.importFromOfx(tenantId, connA, file);
    expect(first.items).toHaveLength(2);
    expect((await feedRows(connA)).every((r) => r.providerTransactionId === null)).toBe(true);
    const again = await bankFeedService.importFromOfx(tenantId, connA, file);
    expect(again.items).toHaveLength(0);
  });

  it('two concurrent imports of one file insert each FITID once', async () => {
    const file = ofx([
      { fitid: 'C-1', date: '20261106', amount: '-1.00', name: 'ONE' },
      { fitid: 'C-2', date: '20261106', amount: '-2.00', name: 'TWO' },
    ]);
    const results = await Promise.allSettled([
      bankFeedService.importFromOfx(tenantId, connA, file),
      bankFeedService.importFromOfx(tenantId, connA, file),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const rows = await feedRows(connA);
    expect(rows.map((r) => r.providerTransactionId).sort()).toEqual(['C-1', 'C-2']);
  });
});
