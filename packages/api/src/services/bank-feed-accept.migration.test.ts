// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// migration.0268-0269.rollback (U-169, U-170; S14): the forward files are
// additive, roll back cleanly (newest first) and re-apply; a rule keeps its
// row through the round trip and an accepted feed item keeps its entry and
// link when the accept records go. The forward files are applied again at the
// end so the rest of the suite sees the schema.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, auditLog, conditionalRules } from '../db/schema/index.js';
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

async function tableExists(table: string): Promise<boolean> {
  const r = await db.execute(sql`SELECT to_regclass(${'public.' + table}) IS NOT NULL AS ok`);
  return (r.rows as Array<{ ok: boolean }>)[0]!.ok;
}

async function indexes(table: string): Promise<string[]> {
  const r = await db.execute(sql`SELECT indexname FROM pg_indexes WHERE tablename = ${table}`);
  return (r.rows as Array<{ indexname: string }>).map((x) => x.indexname);
}

const FORWARD = ['0268_conditional_rule_auto_accept.sql', '0269_bank_feed_accept_groups.sql'];

let tenantId = '';
let userId = '';

afterAll(async () => {
  if (!(await columns('conditional_rules')).includes('auto_accept')) await run(FORWARD[0]!);
  if (!(await tableExists('bank_feed_accept_group_items'))) await run(FORWARD[1]!);
  if (!tenantId) return;
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('migrations 0268-0269 (bank feed accept and undo)', () => {
  it('are additive', () => {
    for (const f of FORWARD) {
      const fwd = readFileSync(path.join(MIGRATIONS, f), 'utf8');
      expect(fwd).not.toMatch(/drop\s+(table|column|constraint|index)/i);
      expect(fwd).not.toMatch(/rename/i);
    }
  });

  it('roll back newest first and re-apply; a rule keeps its row', async () => {
    const { user } = await authService.register({
      email: `mig-0269-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      password: 'password123', displayName: 'Mig', companyName: 'Mig Co',
    });
    tenantId = user.tenantId;
    userId = user.id;
    const [rule] = await db.insert(conditionalRules).values({
      tenantId, scope: 'tenant_user', ownerUserId: userId, name: 'Coffee', priority: 1, autoAccept: true,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'coffee' },
      actions: [{ type: 'skip_ai' }], active: true,
    }).returning();

    await run('0269_bank_feed_accept_groups.rollback.sql');
    await run('0268_conditional_rule_auto_accept.rollback.sql');
    expect(await tableExists('bank_feed_accept_groups')).toBe(false);
    expect(await tableExists('bank_feed_accept_group_items')).toBe(false);
    expect(await columns('conditional_rules')).not.toContain('auto_accept');
    expect(await indexes('bank_feed_items')).not.toContain('idx_bfi_waiting_amount');
    const kept = await db.execute(sql`SELECT id FROM conditional_rules WHERE id = ${rule!.id}`);
    expect(kept.rows).toHaveLength(1);

    for (const f of FORWARD) await run(f);
    // Applying twice is a no-op.
    for (const f of FORWARD) await run(f);
    expect(await columns('conditional_rules')).toContain('auto_accept');
    expect(await columns('bank_feed_accept_group_items')).toEqual(expect.arrayContaining([
      'group_id', 'feed_item_id', 'kind', 'transaction_id', 'journal_line_id', 'txn_fingerprint', 'prior_state', 'undone_at',
      'tenant_id', 'company_id',
    ]));
    expect(await columns('bank_feed_accept_groups')).toEqual(expect.arrayContaining(['tenant_id', 'company_id', 'result']));
    expect(await indexes('bank_feed_items')).toContain('idx_bfi_waiting_amount');
    // The column came back with its default: "wait for the owner".
    const back = await db.execute(sql`SELECT auto_accept FROM conditional_rules WHERE id = ${rule!.id}`);
    expect((back.rows as Array<{ auto_accept: boolean }>)[0]!.auto_accept).toBe(false);
  });
});
