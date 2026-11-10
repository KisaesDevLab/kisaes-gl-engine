// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// migration.0273 (U-199, feed-entry-changed-v1): the forward file is
// additive, rolls back cleanly and re-applies; it clears and flags a feed row
// whose matched_journal_line_id names a deleted line (one audit row each) and
// leaves rows with a live line alone. The forward file is applied again at
// the end so the rest of the suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, companies, accounts, auditLog, bankConnections, bankFeedItems, journalLines, transactions,
} from '../db/schema/index.js';
import * as ledger from './ledger.service.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function hasColumn(): Promise<boolean> {
  const r = await db.execute(sql`SELECT 1 FROM information_schema.columns
    WHERE table_name = 'bank_feed_items' AND column_name = 'entry_changed_at'`);
  return r.rows.length > 0;
}

let tenantId = '';

afterAll(async () => {
  if (!(await hasColumn())) await run('0273_bank_feed_entry_changed.sql');
  if (!tenantId) return;
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('migration 0273 (bank feed entry changed)', () => {
  it('rolls back, re-applies, and clears + flags dangling line links (audited)', async () => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const [t] = await db.insert(tenants).values({ name: 'Mig 0273', slug: `mig-0273-${stamp}` }).returning();
    tenantId = t!.id;
    const [co] = await db.insert(companies).values({ tenantId, businessName: 'Mig 0273 Co' }).returning();
    const companyId = co!.id;
    const mk = async (name: string, accountType: string, accountNumber: string) => {
      const [a] = await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber }).returning();
      return a!.id;
    };
    const bank = await mk('Checking', 'asset', '1010');
    const exp = await mk('Supplies', 'expense', '6000');
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'expense', txnDate: '2026-03-10', total: '40.0000',
      lines: [{ accountId: exp, debit: '40.0000', credit: '0' }, { accountId: bank, debit: '0', credit: '40.0000' }],
    }, undefined, companyId);
    const [line] = await db.select({ id: journalLines.id }).from(journalLines)
      .where(and(eq(journalLines.transactionId, txn.id), eq(journalLines.accountId, bank)));
    const [conn] = await db.insert(bankConnections).values({ tenantId, companyId, accountId: bank, provider: 'manual' }).returning();
    const base = { tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-03-10', status: 'matched', matchedTransactionId: txn.id };
    const [live] = await db.insert(bankFeedItems).values({ ...base, amount: '40.0000', description: 'LIVE', matchedJournalLineId: line!.id })
      .returning();
    const deadLine = '00000000-0000-4000-8000-000000000273';
    const [dead] = await db.insert(bankFeedItems).values({ ...base, amount: '45.0000', description: 'DEAD', matchedJournalLineId: deadLine })
      .returning();

    await run('0273_bank_feed_entry_changed.rollback.sql');
    expect(await hasColumn()).toBe(false);
    await run('0273_bank_feed_entry_changed.sql');
    expect(await hasColumn()).toBe(true);

    const rows = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(live!.id)!.matchedJournalLineId).toBe(line!.id);
    expect(byId.get(live!.id)!.entryChangedAt).toBeNull();
    expect(byId.get(dead!.id)!.matchedJournalLineId).toBeNull();
    expect(byId.get(dead!.id)!.entryChangedAt).not.toBeNull();
    expect(byId.get(dead!.id)!.status).toBe('matched');
    expect(byId.get(dead!.id)!.matchedTransactionId).toBe(txn.id);

    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_feed')));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.entityId).toBe(dead!.id);
    expect(audits[0]!.beforeData).toMatchObject({ matchedJournalLineId: deadLine });
    expect(audits[0]!.afterData).toMatchObject({ action: 'entry_changed', matchedJournalLineId: null, reason: 'backfill_0273' });

    // Re-running the forward file is a no-op for already-flagged rows.
    await run('0273_bank_feed_entry_changed.sql');
    const again = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.entityType, 'bank_feed')));
    expect(again).toHaveLength(1);
  });
});
