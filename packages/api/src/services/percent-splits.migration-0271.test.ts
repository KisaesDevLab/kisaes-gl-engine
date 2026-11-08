// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Migration 0271 (percentage splits total exactly 100): stored
// split_by_percentage actions (flat and inside an if / then / elif / else
// tree, tenant and global rules) and staged bank_feed_items.splits_config
// rows whose total the old ±0.01 tolerance accepted come out at exactly 100
// with the remainder on the last split, as exact decimals; a total outside
// the tolerance, an exact total and a fixed split are left alone; the file
// runs twice without a second change; the audit log keeps the old values;
// what comes out passes the rule-save and posting validators.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts, auditLog, bankConnections, bankFeedItems, companies, conditionalRules, firms, sessions, tenants, users, userTenantAccess,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import { computeSplitLines, type StagedSplitsConfig } from './bank-feed-splits.js';
import { percentsTotalExactly100 } from '@kis-books/shared';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FILE = '0271_percent_splits_normalize.sql';

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

type Body = Record<string, any>;
const split = (pcts: Array<number | string>, accountId: string): Body => ({
  type: 'split_by_percentage', splits: pcts.map((percent, i) => ({ accountId, percent, memo: `leg ${i + 1}` })),
});
const pcts = (action: Body): unknown[] => (action['splits'] as Body[]).map((s) => s['percent']);

let tenantId = '';
let userId = '';
let firmId = '';

afterAll(async () => {
  if (firmId) {
    await db.delete(conditionalRules).where(eq(conditionalRules.ownerFirmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
  }
  if (!tenantId) return;
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('migration 0271 percent splits normalize', () => {
  it('is data only, with a rollback companion', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FILE), 'utf8');
    expect(fwd).not.toMatch(/\b(drop|alter|create)\s+(table|column|index)\b/i);
    expect(fwd).toMatch(/UPDATE conditional_rules/);
    expect(fwd).toMatch(/UPDATE bank_feed_items/);
    expect(readFileSync(path.join(MIGRATIONS, FILE.replace('.sql', '.rollback.sql')), 'utf8')).toMatch(/DROP FUNCTION IF EXISTS percent_splits_normalize_tenant/);
  });

  it('normalizes what the old tolerance accepted, leaves the rest, twice, with an audit trail', async () => {
    const { user } = await authService.register({
      email: `mig-0271-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
      password: 'password123', displayName: 'Mig', companyName: 'Mig 0271 Co',
    });
    tenantId = user.tenantId;
    userId = user.id;
    const [company] = await db.select().from(companies).where(eq(companies.tenantId, tenantId));
    const bank = (await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) }))!;
    const expense = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1))[0]!;
    const acct = expense.id;
    const cond = { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'split' };
    const rule = async (name: string, actions: unknown, extra: Partial<typeof conditionalRules.$inferInsert> = {}) => (await db.insert(conditionalRules).values({
      tenantId, companyId: company!.id, scope: 'tenant_user', ownerUserId: userId, name, priority: 10, conditions: cond, actions: actions as never, active: true, ...extra,
    }).returning())[0]!;

    // The stored rules, written the way the old validator let them be saved.
    const thirds = await rule('thirds', [split([33.33, 33.33, 33.33], acct)]);                  // 99.99 -> last 33.34
    const fine = await rule('fine', [{ type: 'set_memo', memo: 'x' }, split([33.333, 33.333, 33.333], acct)]); // 99.999 -> 33.334
    const over = await rule('over', [split([33.34, 33.33, 33.34], acct)]);                     // 100.01 -> last 33.33
    const strings = await rule('strings', [split(['50', '49.995'], acct)]);                    // 99.995 -> 50 (scale trimmed)
    const exact = await rule('exact', [split([50, 50], acct)]);                                // untouched
    const far = await rule('far', [split([30, 30, 30], acct)]);                                // 90: the owner's
    const negative = await rule('negative', [split([100.005, 0], acct)]);                      // last would go below 0: the owner's
    const fixed = await rule('fixed', [{ type: 'split_by_fixed', splits: [{ accountId: acct, amount: '1.00' }, { accountId: acct, amount: '2.00' }] }]);
    const tree = await rule('tree', {
      if: cond,
      then: [split([33.33, 33.33, 33.33], acct)],
      elif: [{ if: cond, then: [{ type: 'set_account', accountId: acct }] }, { if: cond, then: { if: cond, then: [split([25, 25, 25, 24.99], acct)] } }],
      else: [split([60, 40], acct), { type: 'skip_ai' }],
    });
    const [firm] = await db.insert(firms).values({ name: `Firm 0271 ${Date.now()}`, slug: `firm-0271-${Date.now()}` }).returning();
    firmId = firm!.id;
    const [global] = await db.insert(conditionalRules).values({
      tenantId: null, scope: 'global_firm', ownerFirmId: firmId, name: 'global thirds', priority: 10, conditions: cond,
      actions: [split([33.33, 33.33, 33.33], acct)] as never, active: true,
    }).returning();

    // Staged feed items, as a split_by_percentage rule leaves them.
    const [conn] = await db.insert(bankConnections).values({ tenantId, companyId: company!.id, accountId: bank.id, provider: 'manual' }).returning();
    const base = { tenantId, companyId: company!.id, bankConnectionId: conn!.id, feedDate: '2026-06-15', status: 'pending' as const };
    const cfg = (p: Array<number | string>): StagedSplitsConfig => ({ kind: 'percentage', splits: p.map((percent) => ({ accountId: acct, percent, tagId: null, memo: null })) });
    const [stagedThirds] = await db.insert(bankFeedItems).values({ ...base, amount: '100.0000', description: 'A thirds', splitsConfig: cfg([33.33, 33.33, 33.33]) }).returning();
    const [stagedStrings] = await db.insert(bankFeedItems).values({ ...base, amount: '0.0300', description: 'B strings', splitsConfig: cfg(['33.33', '33.33', '33.33']) }).returning();
    const [stagedExact] = await db.insert(bankFeedItems).values({ ...base, amount: '10.0000', description: 'C exact', splitsConfig: cfg([50, 50]) }).returning();
    const [stagedFar] = await db.insert(bankFeedItems).values({ ...base, amount: '10.0000', description: 'D far', splitsConfig: cfg([50, 40]) }).returning();
    const fixedCfg: StagedSplitsConfig = { kind: 'fixed', splits: [{ accountId: acct, amount: '4.00' }, { accountId: acct, amount: '6.00' }] };
    const [stagedFixed] = await db.insert(bankFeedItems).values({ ...base, amount: '10.0000', description: 'E fixed', splitsConfig: fixedCfg }).returning();
    const [stagedNone] = await db.insert(bankFeedItems).values({ ...base, amount: '10.0000', description: 'F none' }).returning();
    const beforeUpdatedAt = (await db.select({ u: conditionalRules.updatedAt }).from(conditionalRules).where(eq(conditionalRules.id, thirds.id)))[0]!.u;

    await run(FILE);

    const actionsOf = async (id: string) => (await db.select({ a: conditionalRules.actions, u: conditionalRules.updatedAt }).from(conditionalRules).where(eq(conditionalRules.id, id)))[0]!;
    const first = async (id: string) => ((await actionsOf(id)).a as Body[]).find((a) => a['type'] === 'split_by_percentage')!;
    expect(pcts(await first(thirds.id))).toEqual([33.33, 33.33, 33.34]);
    expect(pcts(await first(fine.id))).toEqual([33.333, 33.333, 33.334]);
    expect(pcts(await first(over.id))).toEqual([33.34, 33.33, 33.33]);
    expect(pcts(await first(strings.id))).toEqual(['50', 50]);
    expect(pcts(await first(exact.id))).toEqual([50, 50]);
    expect(pcts(await first(far.id))).toEqual([30, 30, 30]);
    expect(pcts(await first(negative.id))).toEqual([100.005, 0]);
    expect((await actionsOf(fixed.id)).a).toEqual(fixed.actions);
    expect(pcts(await first(global!.id))).toEqual([33.33, 33.33, 33.34]);
    // Exact decimal text in the stored JSON, no double tail, nothing else moved.
    const raw = await db.execute(sql`SELECT actions::text AS t FROM conditional_rules WHERE id = ${thirds.id}`);
    expect((raw.rows[0] as Body)['t']).toContain('"percent": 33.34');
    expect((raw.rows[0] as Body)['t']).not.toMatch(/33\.34\d/);
    expect(((await actionsOf(fine.id)).a as Body[])[0]).toEqual({ type: 'set_memo', memo: 'x' });
    expect((await first(thirds.id))['splits'].map((s: Body) => s['memo'])).toEqual(['leg 1', 'leg 2', 'leg 3']);
    expect((await actionsOf(thirds.id)).u).toEqual(beforeUpdatedAt);
    // The tree: then, the nested elif then and else all normalized; the elif set_account untouched.
    const t = (await actionsOf(tree.id)).a as Body;
    expect(pcts(t['then'][0])).toEqual([33.33, 33.33, 33.34]);
    expect(t['elif'][0]['then']).toEqual([{ type: 'set_account', accountId: acct }]);
    expect(pcts(t['elif'][1]['then']['then'][0])).toEqual([25, 25, 25, 25]);
    expect(pcts(t['else'][0])).toEqual([60, 40]);
    expect(t['else'][1]).toEqual({ type: 'skip_ai' });
    // Staged items.
    const cfgOf = async (id: string) => (await db.select({ c: bankFeedItems.splitsConfig }).from(bankFeedItems).where(eq(bankFeedItems.id, id)))[0]!.c as Body | null;
    expect((await cfgOf(stagedThirds!.id))!['splits'].map((s: Body) => s['percent'])).toEqual([33.33, 33.33, 33.34]);
    expect((await cfgOf(stagedStrings!.id))!['splits'].map((s: Body) => s['percent'])).toEqual(['33.33', '33.33', 33.34]);
    expect(await cfgOf(stagedExact!.id)).toEqual(cfg([50, 50]));
    expect(await cfgOf(stagedFar!.id)).toEqual(cfg([50, 40]));
    expect(await cfgOf(stagedFixed!.id)).toEqual(fixedCfg);
    expect(await cfgOf(stagedNone!.id)).toBeNull();

    // What came out passes the rule-save validator and posts to the cent.
    for (const id of [thirds.id, fine.id, over.id, strings.id, exact.id]) expect(percentsTotalExactly100(pcts(await first(id)) as never)).toBe(true);
    expect(percentsTotalExactly100(pcts(await first(far.id)) as never)).toBe(false);
    expect(computeSplitLines('100.0000', (await cfgOf(stagedThirds!.id)) as StagedSplitsConfig).map((l) => l.amount.toFixed(2))).toEqual(['33.33', '33.33', '33.34']);
    expect(computeSplitLines('0.0300', (await cfgOf(stagedStrings!.id)) as StagedSplitsConfig).map((l) => l.amount.toFixed(2))).toEqual(['0.01', '0.01', '0.01']);
    const farCfg = (await cfgOf(stagedFar!.id)) as StagedSplitsConfig;
    expect(() => computeSplitLines('10.0000', farCfg)).toThrow(/90%/);

    // One audit row per changed tenant row, before and after; none for the global rule or the untouched rows.
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'update')));
    const ruleAudits = audits.filter((a) => a.entityType === 'conditional_rule');
    const itemAudits = audits.filter((a) => a.entityType === 'bank_feed_item');
    expect(ruleAudits.map((a) => a.entityId).sort()).toEqual([thirds.id, fine.id, over.id, strings.id, tree.id].sort());
    expect(itemAudits.map((a) => a.entityId).sort()).toEqual([stagedThirds!.id, stagedStrings!.id].sort());
    const thirdsAudit = ruleAudits.find((a) => a.entityId === thirds.id)!;
    expect(pcts((thirdsAudit.beforeData as Body)['actions'][0])).toEqual([33.33, 33.33, 33.33]);
    expect(pcts((thirdsAudit.afterData as Body)['actions'][0])).toEqual([33.33, 33.33, 33.34]);

    // Idempotent: the file again changes nothing and files nothing; the counts say what is left for the owner.
    await run(FILE);
    expect((await db.select().from(auditLog).where(and(eq(auditLog.tenantId, tenantId), eq(auditLog.action, 'update'))))).toHaveLength(audits.length);
    expect(pcts(await first(thirds.id))).toEqual([33.33, 33.33, 33.34]);
    const again = await db.execute(sql`SELECT percent_splits_normalize_tenant(${tenantId}::uuid) AS r`);
    expect((again.rows[0] as Body)['r']).toEqual({ rulesNormalized: 0, itemsNormalized: 0, rulesNeedOwner: 2, itemsNeedOwner: 1 });
    const globalAgain = await db.execute(sql`SELECT percent_splits_normalize_tenant(NULL::uuid) AS r`);
    expect((globalAgain.rows[0] as Body)['r']).toMatchObject({ rulesNormalized: 0, itemsNormalized: 0 });
  });
});
