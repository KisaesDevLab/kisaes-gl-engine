// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants,
  bankConnections,
  bankFeedItems,
  conditionalRules,
  conditionalRuleAudit,
  accounts,
  contacts,
  firms,
  firmUsers,
  tenantFirmAssignments,
  tenantFeatureFlags,
} from '../db/schema/index.js';
// `tenants` import retained — referenced by seedTenant below.
void tenants;
import { applyForFeedItem } from './conditional-rules-apply.service.js';

// Targeted regression coverage for the bug fixes shipped in this
// review pass:
//   1. mark_for_review combined with set_account must NOT leave
//      matchType='rule' on the feed item (the row should land in
//      Needs Review, not the Rule bucket).
//   2. Repeated pipeline runs for the same (rule, feed_item) must
//      not insert duplicate audit rows — the existing fire is
//      refreshed in place.

let tenantId = '';
let connectionId = '';
let accountId = '';
// 3-tier rules plan, Phase 2 — synthetic owner uuid for test
// inserts. The CHECK constraint added in 0085 requires
// owner_user_id when scope='tenant_user'; tests don't actually
// auth as this user, so any uuid satisfies the constraint.
const ownerUserId = '00000000-0000-0000-0000-0000000000aa';

async function cleanDb() {
  if (!tenantId) return;
  // Tenant-scoped cleanup. Skip the tenant row itself — sibling
  // test files (notably aggressive-e2e) issue TRUNCATE CASCADE
  // on every public table to nuke their own state, which acquires
  // an AccessExclusiveLock on tenants. Issuing our DELETE FROM
  // tenants in parallel deadlocks on the cascade chain. Leaving
  // the tenant row to be swept by either the next aggressive
  // truncate or the next test run is harmless: every test makes
  // its own fresh tenant so prior tenant rows never collide.
  await db.delete(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, tenantId));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  tenantId = '';
}

async function seedTenant() {
  const [t] = await db.insert(tenants).values({
    name: 'Apply Test',
    slug: 'apply-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
  }).returning();
  tenantId = t!.id;
  // Synthetic uuid for the bank-connection's GL account; we don't
  // need a real chart-of-accounts row for the apply path.
  accountId = '00000000-0000-0000-0000-000000000aaa';
  const [c] = await db.insert(bankConnections).values({
    tenantId,
    accountId,
    institutionName: 'Test Bank',
    mask: '0001',
    syncStatus: 'active',
  }).returning();
  connectionId = c!.id;
}

async function seedFeedItem(): Promise<{ id: string }> {
  const [item] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: connectionId,
    feedDate: '2026-04-15',
    description: 'AMAZON MKTPLACE',
    originalDescription: 'AMAZON MKTPLACE',
    amount: '42.5000',
    status: 'pending',
  }).returning({ id: bankFeedItems.id });
  return { id: item!.id };
}

beforeEach(async () => {
  await cleanDb();
  await seedTenant();
});

afterEach(async () => {
  await cleanDb();
});

describe('applyForFeedItem — mark_for_review precedence', () => {
  it('does NOT stamp matchType="rule" when mark_for_review co-exists with set_account', async () => {
    const targetAccountId = '00000000-0000-0000-0000-000000000010';
    await db.insert(conditionalRules).values({
      tenantId,
      scope: 'tenant_user',
      ownerUserId,
      name: 'Flag amazon for review',
      priority: 100,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      // The rule sets a suggested account AND marks for review.
      // The bookkeeper wants the row in Needs Review, not Rule.
      actions: [
        { type: 'set_account', accountId: targetAccountId },
        { type: 'mark_for_review' },
      ],
      active: true,
    });

    const item = await seedFeedItem();
    const result = await applyForFeedItem(tenantId, {
      id: item.id,
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      feedDate: '2026-04-15',
      bankConnectionAccountId: accountId,
    });

    expect(result.shortCircuitedLegacyRules).toBe(true);
    expect(result.fires).toHaveLength(1);

    const [updated] = await db
      .select()
      .from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)));
    expect(updated).toBeDefined();
    expect(updated!.suggestedAccountId).toBe(targetAccountId);
    // Critical: matchType must NOT be 'rule' when mark_for_review
    // is present — otherwise assignBucket lands the row in 'rule'.
    expect(updated!.matchType).toBeNull();
    // Confidence is zeroed so the row falls below the bucket-4
    // floor and lands in needs_review.
    expect(updated!.confidenceScore).toBe('0.00');
  });

  it('still stamps matchType="rule" when set_account fires alone', async () => {
    const targetAccountId = '00000000-0000-0000-0000-000000000011';
    await db.insert(conditionalRules).values({
      tenantId,
      scope: 'tenant_user',
      ownerUserId,
      name: 'Auto-categorize amazon',
      priority: 100,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      actions: [{ type: 'set_account', accountId: targetAccountId }],
      active: true,
    });

    const item = await seedFeedItem();
    await applyForFeedItem(tenantId, {
      id: item.id,
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      feedDate: '2026-04-15',
      bankConnectionAccountId: accountId,
    });

    const [updated] = await db
      .select()
      .from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)));
    expect(updated!.matchType).toBe('rule');
    expect(updated!.confidenceScore).toBe('1.00');
  });
});

describe('applyForFeedItem — idempotency', () => {
  it('does NOT duplicate audit rows when re-applied for the same feed item', async () => {
    const targetAccountId = '00000000-0000-0000-0000-000000000020';
    const [rule] = await db.insert(conditionalRules).values({
      tenantId,
      scope: 'tenant_user',
      ownerUserId,
      name: 'Stable amazon rule',
      priority: 100,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      actions: [{ type: 'set_account', accountId: targetAccountId }],
      active: true,
    }).returning({ id: conditionalRules.id });

    const item = await seedFeedItem();

    const first = await applyForFeedItem(tenantId, {
      id: item.id,
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      feedDate: '2026-04-15',
      bankConnectionAccountId: accountId,
    });
    const second = await applyForFeedItem(tenantId, {
      id: item.id,
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      feedDate: '2026-04-15',
      bankConnectionAccountId: accountId,
    });

    // The same audit id is reused across reruns.
    expect(first.fires[0]!.auditId).toBe(second.fires[0]!.auditId);

    const auditRows = await db
      .select()
      .from(conditionalRuleAudit)
      .where(and(
        eq(conditionalRuleAudit.tenantId, tenantId),
        eq(conditionalRuleAudit.ruleId, rule!.id),
        eq(conditionalRuleAudit.bankFeedItemId, item.id),
      ));
    expect(auditRows).toHaveLength(1);
  });

  it('preserves was_overridden across pipeline reruns', async () => {
    const targetAccountId = '00000000-0000-0000-0000-000000000021';
    await db.insert(conditionalRules).values({
      tenantId,
      scope: 'tenant_user',
      ownerUserId,
      name: 'Stable amazon rule',
      priority: 100,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      actions: [{ type: 'set_account', accountId: targetAccountId }],
      active: true,
    });

    const item = await seedFeedItem();

    const first = await applyForFeedItem(tenantId, {
      id: item.id,
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      feedDate: '2026-04-15',
      bankConnectionAccountId: accountId,
    });

    // Simulate a bookkeeper overriding the rule's categorization.
    await db
      .update(conditionalRuleAudit)
      .set({ wasOverridden: true, overriddenAt: new Date() })
      .where(eq(conditionalRuleAudit.id, first.fires[0]!.auditId));

    // Pipeline reruns the apply step (e.g. on a new sync cycle).
    await applyForFeedItem(tenantId, {
      id: item.id,
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      feedDate: '2026-04-15',
      bankConnectionAccountId: accountId,
    });

    const [audit] = await db
      .select()
      .from(conditionalRuleAudit)
      .where(eq(conditionalRuleAudit.id, first.fires[0]!.auditId));
    // The override flag survives the rerun (we update in place,
    // we don't reset wasOverridden).
    expect(audit!.wasOverridden).toBe(true);
  });
});

// 3-tier rules plan, Phase 4 — tier-aware evaluator coverage.
// Verifies most-specific-first ordering across tiers, fork
// shadowing per-tenant, system_tag resolution for global rules,
// and effective_tier on the audit row.
describe('applyForFeedItem — Phase 4 tier-aware evaluator (RULES_TIERED_V1=on)', () => {
  let firmId = '';
  let secondTenantId = '';
  let secondConnectionId = '';
  let secondAccountId = '';

  // Seeds the tier-flag, a firm, a second tenant managed by the
  // same firm, and feed items + bank connections in both. Returns
  // ids for assertions.
  async function seedTieredScenario(): Promise<void> {
    await db.insert(tenantFeatureFlags).values({
      tenantId,
      flagKey: 'RULES_TIERED_V1',
      enabled: true,
    }).onConflictDoNothing();

    const [firm] = await db.insert(firms).values({
      name: 'Tier Apply Firm',
      slug: `tier-apply-firm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    firmId = firm!.id;
    await db.insert(tenantFirmAssignments).values({ tenantId, firmId });

    const [t2] = await db.insert(tenants).values({
      name: 'Tier Apply Tenant 2',
      slug: `tier-apply-t2-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    }).returning();
    secondTenantId = t2!.id;
    await db.insert(tenantFirmAssignments).values({ tenantId: secondTenantId, firmId });
    await db.insert(tenantFeatureFlags).values({
      tenantId: secondTenantId,
      flagKey: 'RULES_TIERED_V1',
      enabled: true,
    }).onConflictDoNothing();

    secondAccountId = '00000000-0000-0000-0000-0000000000bb';
    const [c2] = await db.insert(bankConnections).values({
      tenantId: secondTenantId,
      accountId: secondAccountId,
      institutionName: 'Test Bank',
      mask: '0002',
      syncStatus: 'active',
    }).returning();
    secondConnectionId = c2!.id;
  }

  async function tieredCleanup() {
    if (firmId) {
      await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
      await db.delete(firmUsers).where(eq(firmUsers.firmId, firmId));
    }
    for (const t of [tenantId, secondTenantId].filter(Boolean)) {
      await db.delete(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, t));
      await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, t));
      await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, t));
      await db.delete(bankConnections).where(eq(bankConnections.tenantId, t));
      await db.delete(accounts).where(eq(accounts.tenantId, t));
      await db.delete(contacts).where(eq(contacts.tenantId, t));
      await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, t));
    }
    // Globals owned by this firm have NULL tenant — clean by firmId.
    if (firmId) {
      await db.delete(conditionalRules).where(eq(conditionalRules.ownerFirmId, firmId));
    }
    if (firmId) {
      await db.delete(firms).where(eq(firms.id, firmId));
      firmId = '';
    }
    if (secondTenantId) {
      await db.delete(tenants).where(eq(tenants.id, secondTenantId));
      secondTenantId = '';
    }
  }

  afterEach(async () => {
    await tieredCleanup();
  });

  it('tenant_user beats tenant_firm beats global_firm on type-conflict', async () => {
    await seedTieredScenario();
    const userAcct = '00000000-0000-0000-0000-000000000111';
    const firmAcct = '00000000-0000-0000-0000-000000000222';
    const globalAcct = '00000000-0000-0000-0000-000000000333';
    // User rule (priority 100), firm rule (priority 50), global
    // rule (priority 10) — note that lower numbers usually win in
    // priority terms, but tier wins over priority. So user's 100
    // beats global's 10.
    await db.insert(conditionalRules).values([
      {
        tenantId,
        scope: 'tenant_user',
        ownerUserId,
        priority: 100,
        name: 'user',
        conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
        actions: [{ type: 'set_account', accountId: userAcct }],
        active: true,
      },
      {
        tenantId,
        scope: 'tenant_firm',
        ownerFirmId: firmId,
        priority: 50,
        name: 'firm',
        conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
        actions: [{ type: 'set_account', accountId: firmAcct }],
        active: true,
      },
      {
        tenantId: null,
        scope: 'global_firm',
        ownerFirmId: firmId,
        priority: 10,
        name: 'global',
        conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
        actions: [{ type: 'set_account', accountId: globalAcct }],
        active: true,
      },
    ]);

    const item = await seedFeedItem();
    await applyForFeedItem(
      tenantId,
      {
        id: item.id,
        description: 'AMAZON MKTPLACE',
        originalDescription: 'AMAZON MKTPLACE',
        amount: '42.5000',
        feedDate: '2026-04-15',
        bankConnectionAccountId: accountId,
      },
      { currentUserId: ownerUserId },
    );

    const [updated] = await db
      .select()
      .from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item.id)));
    // The user's account wins.
    expect(updated!.suggestedAccountId).toBe(userAcct);
  });

  it('forks shadow globals on the forked tenant only', async () => {
    await seedTieredScenario();
    const globalAcct = '00000000-0000-0000-0000-000000000444';
    const forkedAcct = '00000000-0000-0000-0000-000000000555';

    const [global] = await db.insert(conditionalRules).values({
      tenantId: null,
      scope: 'global_firm',
      ownerFirmId: firmId,
      priority: 100,
      name: 'global-rule',
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      actions: [{ type: 'set_account', accountId: globalAcct }],
      active: true,
    }).returning({ id: conditionalRules.id });

    // Fork the global on tenant #1 only.
    await db.insert(conditionalRules).values({
      tenantId,
      scope: 'tenant_firm',
      ownerFirmId: firmId,
      forkedFromGlobalId: global!.id,
      priority: 100,
      name: 'fork-on-tenant-1',
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      actions: [{ type: 'set_account', accountId: forkedAcct }],
      active: true,
    });

    // Pre-create accounts in BOTH tenants with matching system_tag
    // so global rule resolution works on tenant #2 (which has no fork).
    const sharedTag = 'office_supplies_shared';
    const [acctSrc] = await db.insert(accounts).values({
      tenantId,
      accountNumber: '6210',
      name: 'Office Supplies',
      accountType: 'expense',
      systemTag: sharedTag,
      isActive: true,
    }).returning();
    void acctSrc;
    // Re-author the global to reference an account WITH a system_tag
    // — the resolver looks up systemTag from the source UUID.
    await db.update(conditionalRules)
      .set({
        actions: [{ type: 'set_account', accountId: acctSrc!.id }],
      } as never)
      .where(eq(conditionalRules.id, global!.id));
    // Tenant #2 carries the same system_tag on its own account.
    const [acctTarget] = await db.insert(accounts).values({
      tenantId: secondTenantId,
      accountNumber: '6210',
      name: 'Office Supplies',
      accountType: 'expense',
      systemTag: sharedTag,
      isActive: true,
    }).returning();

    // Tenant #1 — the fork fires (forked_from_global_id shadows
    // the global for this tenant); suggestedAccountId becomes the
    // fork's chosen account.
    const item1 = await seedFeedItem();
    await applyForFeedItem(tenantId, {
      id: item1.id,
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      feedDate: '2026-04-15',
      bankConnectionAccountId: accountId,
    });
    const [updated1] = await db
      .select()
      .from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, item1.id)));
    expect(updated1!.suggestedAccountId).toBe(forkedAcct);

    // Tenant #2 — no fork; global fires AND the resolver rebinds
    // the source accountId to the target tenant's matching
    // system_tag account.
    const [item2] = await db.insert(bankFeedItems).values({
      tenantId: secondTenantId,
      bankConnectionId: secondConnectionId,
      feedDate: '2026-04-15',
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      status: 'pending',
    }).returning({ id: bankFeedItems.id });
    await applyForFeedItem(secondTenantId, {
      id: item2!.id,
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      feedDate: '2026-04-15',
      bankConnectionAccountId: secondAccountId,
    });
    const [updated2] = await db
      .select()
      .from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, secondTenantId), eq(bankFeedItems.id, item2!.id)));
    // The resolver rebound the global's account to tenant #2's
    // own Office Supplies account.
    expect(updated2!.suggestedAccountId).toBe(acctTarget!.id);
  });

  it('records effective_tier on the audit row', async () => {
    await seedTieredScenario();
    const firmAcct = '00000000-0000-0000-0000-000000000777';
    const [rule] = await db.insert(conditionalRules).values({
      tenantId,
      scope: 'tenant_firm',
      ownerFirmId: firmId,
      priority: 100,
      name: 'firm-rule',
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'amazon' },
      actions: [{ type: 'set_account', accountId: firmAcct }],
      active: true,
    }).returning({ id: conditionalRules.id });

    const item = await seedFeedItem();
    await applyForFeedItem(tenantId, {
      id: item.id,
      description: 'AMAZON MKTPLACE',
      originalDescription: 'AMAZON MKTPLACE',
      amount: '42.5000',
      feedDate: '2026-04-15',
      bankConnectionAccountId: accountId,
    });

    const [audit] = await db
      .select()
      .from(conditionalRuleAudit)
      .where(and(
        eq(conditionalRuleAudit.tenantId, tenantId),
        eq(conditionalRuleAudit.ruleId, rule!.id),
      ));
    expect(audit!.effectiveTier).toBe('tenant_firm');
    expect(audit!.effectiveFirmId).toBe(firmId);
  });
});

// Silence an unused-import warning when the suite runs without
// touching the symbol resolver helper directly. The Phase-4
// tests above exercise it transitively through applyForFeedItem.
void sql;
