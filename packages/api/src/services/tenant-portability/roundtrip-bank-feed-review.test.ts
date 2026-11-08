// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Tenant archive round trip of the P26 E2 columns (migrations 0265-0266):
// bank_feed_items.matched_journal_line_id (remapped to the imported line),
// entry_voided_at, suggested_rule_id / _kind (remapped, polymorphic),
// exclusion_reason and transaction_classification_state.matched_bank_rule_id.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { accounts, companies, bankConnections, bankFeedItems, bankRules, transactionClassificationState } from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as ledger from '../ledger.service.js';
import * as bankFeed from '../bank-feed.service.js';
import { ArchiveReader } from './archive-reader.js';
import { runExport, type ExportResult } from './export.service.js';
import { runImport } from './import.service.js';
import { buildPortabilityPlan, SOFT_REFS, scopeSql, type PortabilityPlan } from './plan.js';

const PASS = 'feed review round trip passphrase 2026!';
const stamp = crypto.randomUUID().slice(0, 8);
let plan: PortabilityPlan;
let archiveRoot = '';
const createdTenants: string[] = [];
const createdUsers: string[] = [];
let tenantId = '';
let callerId = '';
let archive: ExportResult;

async function q<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.execute(sql.raw(text.replace(/\$(\d+)/g, (_m, n) => {
    const v = params[Number(n) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  })));
  return r.rows as T[];
}

/** The feed state with ids replaced by what they point at. */
async function feedShape(tid: string) {
  return q(`
    SELECT b.description, b.status, b.exclusion_reason AS reason, b.entry_voided_at IS NOT NULL AS voided,
      jl.credit::text AS line_credit, (jl.transaction_id = b.matched_transaction_id) AS line_of_txn,
      b.suggested_rule_kind AS rule_kind, br.name AS rule_name, sbr.name AS state_rule
    FROM bank_feed_items b
    LEFT JOIN journal_lines jl ON jl.tenant_id = b.tenant_id AND jl.id = b.matched_journal_line_id
    LEFT JOIN bank_rules br ON br.tenant_id = b.tenant_id AND br.id = b.suggested_rule_id
    LEFT JOIN transaction_classification_state s ON s.bank_feed_item_id = b.id
    LEFT JOIN bank_rules sbr ON sbr.id = s.matched_bank_rule_id
    WHERE b.tenant_id = $1 ORDER BY b.description`, [tid]);
}

beforeAll(async () => {
  plan = await buildPortabilityPlan(db);
  archiveRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-archives-feedrev-'));
  process.env['CL_ARCHIVE_DIR'] = archiveRoot;
  const reg = await authService.register({
    email: `rtf-${stamp}@example.test`, password: 'password123', displayName: 'Owner', companyName: `RTF ${stamp}`,
  });
  tenantId = reg.user.tenantId;
  createdTenants.push(tenantId);
  callerId = crypto.randomUUID();
  await q(`INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, is_super_admin, is_active)
           VALUES ($1, $2, $3, $4, 'Caller', 'owner', true, true)`,
  [callerId, tenantId, `rtf-caller-${stamp}@example.test`, '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789']);
  createdUsers.push(callerId);

  const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  const companyId = company!.id;
  const bank = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!;
  const expense = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense')) }))!;
  const [conn] = await db.insert(bankConnections).values({ tenantId, companyId, accountId: bank.id, provider: 'manual' }).returning();
  const [rule] = await db.insert(bankRules).values({
    tenantId, name: 'Utility rule', isActive: true, descriptionContains: 'UTILITY', assignAccountId: expense.id,
  }).returning();
  const base = { tenantId, companyId, bankConnectionId: conn!.id, feedDate: '2026-06-15', status: 'pending' as const };

  const e = await ledger.postTransaction(tenantId, {
    txnType: 'expense', txnDate: '2026-06-14', total: '42.0000',
    lines: [{ accountId: expense.id, debit: '42.0000', credit: '0' }, { accountId: bank.id, debit: '0', credit: '42.0000' }],
  }, undefined, companyId);
  const [matched] = await db.insert(bankFeedItems).values({ ...base, amount: '42.0000', description: 'A matched' }).returning();
  await bankFeed.match(tenantId, matched!.id, e.id);
  const e2 = await ledger.postTransaction(tenantId, {
    txnType: 'expense', txnDate: '2026-06-14', total: '43.0000',
    lines: [{ accountId: expense.id, debit: '43.0000', credit: '0' }, { accountId: bank.id, debit: '0', credit: '43.0000' }],
  }, undefined, companyId);
  const [voided] = await db.insert(bankFeedItems).values({ ...base, amount: '43.0000', description: 'B voided' }).returning();
  await bankFeed.match(tenantId, voided!.id, e2.id);
  await ledger.voidTransaction(tenantId, e2.id, 'void', undefined, { companyId });
  const [ruled] = await db.insert(bankFeedItems).values({
    ...base, amount: '12.0000', description: 'C UTILITY', suggestedAccountId: expense.id, matchType: 'rule',
    suggestedRuleId: rule!.id, suggestedRuleKind: 'legacy',
  }).returning();
  await db.insert(transactionClassificationState).values({
    tenantId, companyId, bankFeedItemId: ruled!.id, bucket: 'rule', matchedBankRuleId: rule!.id,
  });
  await db.insert(bankFeedItems).values({ ...base, amount: '5.0000', description: 'D removed', status: 'excluded', exclusionReason: 'duplicate' });

  archive = await runExport(tenantId, callerId, { passphrase: PASS, host: { app: 'ClientLedger', kind: 'backup' } });
}, 180_000);

afterAll(async () => {
  for (const id of createdTenants) {
    for (const t of [...plan.scoped].reverse()) {
      const where = scopeSql(plan, t, 'a').replace('$1', `'${id}'::uuid`);
      await q(`DELETE FROM "${t}" a WHERE ${where}`).catch(() => undefined);
    }
    await q(`DELETE FROM tenant_archive_imports WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = $1)`, [id]).catch(() => undefined);
    await q(`DELETE FROM user_tenant_access WHERE tenant_id = $1`, [id]).catch(() => undefined);
    await q(`DELETE FROM users WHERE tenant_id = $1`, [id]).catch(() => undefined);
  }
  for (const u of createdUsers) await q(`DELETE FROM users WHERE id = $1`, [u]).catch(() => undefined);
  for (const id of createdTenants) await q(`DELETE FROM tenants WHERE id = $1`, [id]).catch(() => undefined);
  fs.rmSync(archiveRoot, { recursive: true, force: true });
  delete process.env['CL_ARCHIVE_DIR'];
});

describe('bank feed review columns in tenant archives (U-166, U-168, U-174)', () => {
  it('classifies the new columns', () => {
    expect(SOFT_REFS['bank_feed_items.matched_journal_line_id']).toBe('tenant-ref:journal_lines');
    expect(SOFT_REFS['bank_feed_items.suggested_rule_id']).toBe('polymorphic');
    expect(SOFT_REFS['transaction_classification_state.matched_bank_rule_id']).toBe('tenant-ref:bank_rules');
  });

  it('matched lines, voided flags, rule attribution and exclusion reasons survive with remapped ids', async () => {
    const reader = await ArchiveReader.open(archive.path!, PASS);
    await reader.verifyAll();
    const before = await feedShape(tenantId);
    expect(before).toEqual([
      expect.objectContaining({ description: 'A matched', status: 'matched', voided: false, line_credit: '42.0000', line_of_txn: true }),
      expect.objectContaining({ description: 'B voided', status: 'matched', voided: true, line_credit: '43.0000', line_of_txn: true }),
      expect.objectContaining({ description: 'C UTILITY', rule_kind: 'legacy', rule_name: 'Utility rule', state_rule: 'Utility rule' }),
      expect.objectContaining({ description: 'D removed', status: 'excluded', reason: 'duplicate' }),
    ]);
    const imported = await runImport({ filePath: archive.path!, passphrase: PASS, callerUserId: callerId });
    createdTenants.push(imported.tenantId);
    expect(imported.verification).toMatchObject({ contentEqual: true, trialBalanceEqual: true });
    expect(await feedShape(imported.tenantId)).toEqual(before);
    const leaked = await q<{ n: number }>(`SELECT count(*)::int AS n FROM bank_feed_items b
      WHERE b.tenant_id = $1 AND (b.matched_journal_line_id IN (SELECT id FROM journal_lines WHERE tenant_id = $2)
        OR b.suggested_rule_id IN (SELECT id FROM bank_rules WHERE tenant_id = $2))`, [imported.tenantId, tenantId]);
    expect(leaked[0]!.n).toBe(0);
  }, 600_000);
});
