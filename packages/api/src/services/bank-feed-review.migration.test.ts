// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// migration.0265-0266.rollback (U-166, U-168, U-174; S14): the forward
// files are additive, roll back cleanly (newest first) and re-apply; 0266
// backfills the rule attribution of waiting rows a conditional rule staged,
// without posting. The forward files are applied again at the end so the
// rest of the suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, bankConnections, bankFeedItems, conditionalRules, conditionalRuleAudit,
  transactions,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

async function columns(table: string): Promise<string[]> {
  const r = await db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name = ${table} ORDER BY column_name`);
  return (r.rows as Array<{ column_name: string }>).map((x) => x.column_name);
}

const NEW_BFI = ['matched_journal_line_id', 'entry_voided_at', 'suggested_rule_id', 'suggested_rule_kind', 'exclusion_reason'];

let tenantId = '';
let userId = '';

afterAll(async () => {
  const cols = await columns('bank_feed_items');
  if (!cols.includes('matched_journal_line_id')) await run('0265_bank_feed_line_match.sql');
  if (!cols.includes('suggested_rule_id')) await run('0266_bank_feed_rule_review.sql');
  if (!tenantId) return;
  await db.delete(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('migrations 0265-0266 (bank feed review)', () => {
  it('are additive', () => {
    for (const f of ['0265_bank_feed_line_match.sql', '0266_bank_feed_rule_review.sql']) {
      const fwd = readFileSync(path.join(MIGRATIONS, f), 'utf8');
      expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
      expect(fwd).not.toMatch(/rename/i);
    }
  });

  it('roll back newest first, re-apply, and 0266 backfills conditional-rule attribution without posting', async () => {
    const { user } = await authService.register({
      email: `mig-0266-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      password: 'password123', displayName: 'Mig', companyName: 'Mig Co',
    });
    tenantId = user.tenantId;
    userId = user.id;
    const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
    const expense = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1))[0]!;
    const [conn] = await db.insert(bankConnections).values({ tenantId, accountId: bank!.id, provider: 'manual' }).returning();
    const [rule] = await db.insert(conditionalRules).values({
      tenantId, scope: 'tenant_user', ownerUserId: userId, name: 'Coffee', priority: 1,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'coffee' },
      actions: [{ type: 'set_account', accountId: expense.id }], active: true,
    }).returning();
    const [waiting] = await db.insert(bankFeedItems).values({
      tenantId, bankConnectionId: conn!.id, feedDate: '2026-06-15', amount: '4.5000', description: 'COFFEE', status: 'pending',
      suggestedAccountId: expense.id, matchType: 'rule',
    }).returning();
    const [posted] = await db.insert(bankFeedItems).values({
      tenantId, bankConnectionId: conn!.id, feedDate: '2026-06-15', amount: '4.5000', description: 'COFFEE', status: 'excluded',
      suggestedAccountId: expense.id, matchType: 'rule',
    }).returning();
    for (const it of [waiting!, posted!]) {
      await db.insert(conditionalRuleAudit).values({ tenantId, ruleId: rule!.id, bankFeedItemId: it.id, actionsApplied: [] });
    }

    await run('0266_bank_feed_rule_review.rollback.sql');
    await run('0265_bank_feed_line_match.rollback.sql');
    const gone = await columns('bank_feed_items');
    for (const c of NEW_BFI) expect(gone).not.toContain(c);
    expect(await columns('transaction_classification_state')).not.toContain('matched_bank_rule_id');

    await run('0265_bank_feed_line_match.sql');
    await run('0266_bank_feed_rule_review.sql');
    // Applying twice is a no-op.
    await run('0265_bank_feed_line_match.sql');
    await run('0266_bank_feed_rule_review.sql');
    const back = await columns('bank_feed_items');
    for (const c of NEW_BFI) expect(back).toContain(c);
    expect(await columns('transaction_classification_state')).toContain('matched_bank_rule_id');

    const r = await db.execute(sql`SELECT id, suggested_rule_id, suggested_rule_kind, status FROM bank_feed_items WHERE tenant_id = ${tenantId}`);
    const byId = new Map((r.rows as Array<{ id: string; suggested_rule_id: string | null; suggested_rule_kind: string | null; status: string }>)
      .map((x) => [x.id, x]));
    expect(byId.get(waiting!.id)).toMatchObject({ suggested_rule_id: rule!.id, suggested_rule_kind: 'conditional', status: 'pending' });
    // Only waiting rows are attributed.
    expect(byId.get(posted!.id)).toMatchObject({ suggested_rule_id: null });
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).toHaveLength(0);
    const idx = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = 'bank_feed_items'`);
    const names = (idx.rows as Array<{ indexname: string }>).map((x) => x.indexname);
    expect(names).toEqual(expect.arrayContaining(['uq_bfi_matched_journal_line', 'idx_bfi_entry_voided', 'idx_bfi_suggested_rule']));
  });
});
