// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Client rules overview: cross-client counts of what the conditional rules
// would post, per-client account mappings for global rules, and the post
// action. The scenario is the one the feature exists for — a global rule
// written on client A targets A's "Software" account, and client B names its
// equivalent account differently.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  bankConnections, bankFeedItems, conditionalRules, conditionalRuleAudit,
  transactionClassificationState, transactions, journalLines, categorizationHistory,
  contacts, firms, tenantFirmAssignments, tenantFeatureFlags, userTenantAccess,
  tenantFirmAccountMappings, portalQuestions,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as service from './client-rules-overview.service.js';

let tenantA = '';
let tenantB = '';
let outsiderTenant = '';
let userId = '';
let firmId = '';
let sourceAccountId = ''; // A's expense account the global rule targets
let bAccountId = '';      // B's account mapped to it
let connB = '';

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function cleanup() {
  const tids = [tenantA, tenantB, outsiderTenant].filter(Boolean);
  if (firmId) {
    await db.delete(tenantFirmAccountMappings).where(eq(tenantFirmAccountMappings.firmId, firmId));
    await db.delete(conditionalRules).where(eq(conditionalRules.ownerFirmId, firmId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, firmId));
    await db.delete(firms).where(eq(firms.id, firmId));
    firmId = '';
  }
  if (tids.length > 0) {
    await db.delete(portalQuestions).where(inArray(portalQuestions.tenantId, tids));
    await db.delete(transactionClassificationState).where(inArray(transactionClassificationState.tenantId, tids));
    await db.delete(conditionalRuleAudit).where(inArray(conditionalRuleAudit.tenantId, tids));
    await db.delete(conditionalRules).where(inArray(conditionalRules.tenantId, tids));
    await db.delete(categorizationHistory).where(inArray(categorizationHistory.tenantId, tids));
    await db.delete(bankFeedItems).where(inArray(bankFeedItems.tenantId, tids));
    await db.delete(bankConnections).where(inArray(bankConnections.tenantId, tids));
    await db.delete(journalLines).where(inArray(journalLines.tenantId, tids));
    await db.delete(transactions).where(inArray(transactions.tenantId, tids));
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tids));
    await db.delete(contacts).where(inArray(contacts.tenantId, tids));
    await db.delete(accounts).where(inArray(accounts.tenantId, tids));
    await db.delete(companies).where(inArray(companies.tenantId, tids));
    await db.delete(tenantFeatureFlags).where(inArray(tenantFeatureFlags.tenantId, tids));
    await db.delete(userTenantAccess).where(inArray(userTenantAccess.tenantId, tids));
    const us = await db.select({ id: users.id }).from(users).where(inArray(users.tenantId, tids));
    if (us.length > 0) await db.delete(sessions).where(inArray(sessions.userId, us.map((u) => u.id)));
    await db.delete(users).where(inArray(users.tenantId, tids));
    await db.delete(tenants).where(inArray(tenants.id, tids));
  }
  tenantA = ''; tenantB = ''; outsiderTenant = ''; userId = '';
}

async function registerTenant(label: string) {
  const { user } = await authService.register({
    email: `cro-${label}-${uniq()}@example.com`,
    password: 'password123',
    displayName: `${label} User`,
    companyName: `${label} Co`,
  });
  return user;
}

async function expenseAccounts(tenantId: string) {
  return db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'), eq(accounts.isActive, true)))
    .orderBy(accounts.accountNumber)
    .limit(2);
}

async function pendingItem(tenantId: string, connectionId: string, description: string) {
  const [row] = await db.insert(bankFeedItems).values({
    tenantId, bankConnectionId: connectionId, feedDate: '2026-06-15',
    description, originalDescription: description, amount: '25.0000', status: 'pending',
  }).returning();
  return row!;
}

async function connectionFor(tenantId: string) {
  const bank = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')),
  });
  const [conn] = await db.insert(bankConnections).values({
    tenantId, accountId: bank!.id, provider: 'manual', institutionName: 'Test Bank',
  }).returning();
  return conn!.id;
}

beforeEach(async () => {
  await cleanup();
  const a = await registerTenant('A');
  const b = await registerTenant('B');
  const outsider = await registerTenant('Outsider');
  tenantA = a.tenantId;
  tenantB = b.tenantId;
  outsiderTenant = outsider.tenantId;
  userId = a.id;

  // The staff user works both A and B; never the outsider.
  await db.insert(userTenantAccess).values({ userId, tenantId: tenantA, role: 'accountant' }).onConflictDoNothing();
  await db.insert(userTenantAccess).values({ userId, tenantId: tenantB, role: 'accountant' }).onConflictDoNothing();

  const [firm] = await db.insert(firms).values({ name: 'Overview Firm', slug: `overview-firm-${uniq()}` }).returning();
  firmId = firm!.id;
  for (const t of [tenantA, tenantB, outsiderTenant]) {
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, t));
    // Upsert, not insert-or-skip: provisioning may already have seeded the
    // flag row as disabled.
    await db.insert(tenantFeatureFlags).values({ tenantId: t, flagKey: 'RULES_TIERED_V1', enabled: true })
      .onConflictDoUpdate({ target: [tenantFeatureFlags.tenantId, tenantFeatureFlags.flagKey], set: { enabled: true } });
  }
  await db.insert(tenantFirmAssignments).values({ tenantId: tenantA, firmId });
  await db.insert(tenantFirmAssignments).values({ tenantId: tenantB, firmId });

  sourceAccountId = (await expenseAccounts(tenantA))[0]!.id;
  bAccountId = (await expenseAccounts(tenantB))[1]!.id;

  await db.insert(conditionalRules).values({
    tenantId: null,
    scope: 'global_firm',
    ownerFirmId: firmId,
    name: 'Adobe → Software',
    priority: 100,
    conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'adobe' },
    actions: [{ type: 'set_account', accountId: sourceAccountId }],
    active: true,
  });

  connB = await connectionFor(tenantB);
  await pendingItem(tenantB, connB, 'ADOBE CREATIVE CLOUD');
  await pendingItem(tenantB, connB, 'Adobe Acrobat');
  await pendingItem(tenantB, connB, 'Corner Deli');
});

afterEach(async () => {
  await cleanup();
});

const QUERY = { limit: 50, offset: 0, sortBy: 'tenantName', sortDir: 'asc', includeExcluded: false } as const;
const rowFor = (res: Awaited<ReturnType<typeof service.getOverview>>, tenantId: string) =>
  res.data.find((r) => r.tenantId === tenantId);

describe('getOverview', () => {
  it('lists only the caller’s clients', async () => {
    const res = await service.getOverview(userId, QUERY);
    const ids = res.data.map((r) => r.tenantId);
    expect(ids).toContain(tenantA);
    expect(ids).toContain(tenantB);
    expect(ids).not.toContain(outsiderTenant);
    expect(res.total).toBe(res.data.length);
  });

  it('reports global-rule matches whose account is not mapped as needing mapping, not ready', async () => {
    const b = rowFor(await service.getOverview(userId, QUERY), tenantB)!;
    expect(b.pendingItems).toBe(3);
    expect(b.matched).toBe(2);
    expect(b.ready).toBe(0);
    expect(b.needsMapping).toBe(2);
    expect(b.rules).toHaveLength(1);
    expect(b.rules[0]).toMatchObject({ ruleName: 'Adobe → Software', scope: 'global_firm', matched: 2, needsMapping: 2 });
    expect(b.tieredRules).toBe(true);
    expect(b.unmappedAccounts).toEqual([
      expect.objectContaining({ sourceAccountId, sourceAccountType: 'expense', items: 2 }),
    ]);
  });

  it('flags a client whose firm/global rules are switched off', async () => {
    await db.update(tenantFeatureFlags).set({ enabled: false })
      .where(and(eq(tenantFeatureFlags.tenantId, tenantB), eq(tenantFeatureFlags.flagKey, 'RULES_TIERED_V1')));
    const b = rowFor(await service.getOverview(userId, QUERY), tenantB)!;
    expect(b.tieredRules).toBe(false);
    expect(b.matched).toBe(0);
  });

  it('is read-only: no fire is recorded, nothing is staged, no vendor is created', async () => {
    await service.getOverview(userId, QUERY);
    const fires = await db.select().from(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, tenantB));
    expect(fires).toHaveLength(0);
    const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantB));
    expect(items.every((i) => i.matchType === null && i.suggestedAccountId === null)).toBe(true);
  });

  it('counts the global rule as ready on the client it was written on', async () => {
    const connA = await connectionFor(tenantA);
    await pendingItem(tenantA, connA, 'ADOBE STOCK');
    const a = rowFor(await service.getOverview(userId, QUERY), tenantA)!;
    expect(a.ready).toBe(1);
    expect(a.needsMapping).toBe(0);
  });

  it('does not post to the source account once it is deactivated', async () => {
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, sourceAccountId));
    const connA = await connectionFor(tenantA);
    await pendingItem(tenantA, connA, 'ADOBE STOCK');
    const a = rowFor(await service.getOverview(userId, QUERY), tenantA)!;
    expect(a.ready).toBe(0);
    expect(a.needsMapping).toBe(1);
  });

  it('counts portal questions still waiting on the client', async () => {
    const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantB) });
    for (const status of ['open', 'viewed', 'responded', 'resolved']) {
      await db.insert(portalQuestions).values({
        tenantId: tenantB, companyId: company!.id, body: `q ${status}`, status, createdBy: userId,
      });
    }
    const b = rowFor(await service.getOverview(userId, QUERY), tenantB)!;
    expect(b.openQuestions).toBe(2);
  });

  it('filters by client name', async () => {
    await db.update(tenants).set({ name: `Zephyr Dental ${uniq()}` }).where(eq(tenants.id, tenantB));
    const res = await service.getOverview(userId, { ...QUERY, search: 'zephyr dental' });
    expect(res.data.map((r) => r.tenantId)).toEqual([tenantB]);
    expect(res.total).toBe(1);
  });

  it('sorts by a rule counter across every client, then pages', async () => {
    // B has 2 matched items, A none: "matched desc" puts B first even
    // though A sorts first by name.
    const desc = await service.getOverview(userId, { ...QUERY, sortBy: 'matched', sortDir: 'desc' });
    expect(desc.data.map((r) => r.tenantId)).toEqual([tenantB, tenantA]);
    const asc = await service.getOverview(userId, { ...QUERY, sortBy: 'matched', sortDir: 'asc' });
    expect(asc.data.map((r) => r.tenantId)).toEqual([tenantA, tenantB]);

    // Paging happens after the sort, and total covers the whole list.
    const firstPage = await service.getOverview(userId, { ...QUERY, sortBy: 'matched', sortDir: 'desc', limit: 1 });
    expect(firstPage.data.map((r) => r.tenantId)).toEqual([tenantB]);
    expect(firstPage.total).toBe(2);
    const secondPage = await service.getOverview(userId, { ...QUERY, sortBy: 'matched', sortDir: 'desc', limit: 1, offset: 1 });
    expect(secondPage.data.map((r) => r.tenantId)).toEqual([tenantA]);
  });

  it('sorts by name and by a portal counter', async () => {
    const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantA) });
    await db.insert(portalQuestions).values({
      tenantId: tenantA, companyId: company!.id, body: 'q', status: 'open', createdBy: userId,
    });
    const byName = await service.getOverview(userId, { ...QUERY, sortDir: 'desc' });
    expect(byName.data.map((r) => r.tenantId)).toEqual([tenantB, tenantA]);
    const byQuestions = await service.getOverview(userId, { ...QUERY, sortBy: 'openQuestions', sortDir: 'desc' });
    expect(byQuestions.data.map((r) => r.tenantId)).toEqual([tenantA, tenantB]);
  });
});

describe('exclusion', () => {
  it('hides an excluded client unless asked for, and counts it', async () => {
    await service.setExcluded(userId, tenantB, true);
    const res = await service.getOverview(userId, QUERY);
    expect(res.data.map((r) => r.tenantId)).toEqual([tenantA]);
    expect(res.total).toBe(1);
    expect(res.excludedTotal).toBe(1);

    const shown = await service.getOverview(userId, { ...QUERY, includeExcluded: true });
    expect(shown.total).toBe(2);
    expect(rowFor(shown, tenantB)!.excluded).toBe(true);
    expect(rowFor(shown, tenantA)!.excluded).toBe(false);

    await service.setExcluded(userId, tenantB, false);
    const back = await service.getOverview(userId, QUERY);
    expect(back.total).toBe(2);
    expect(back.excludedTotal).toBe(0);
  });

  it('refuses to post into an excluded client', async () => {
    await service.upsertMapping(userId, tenantB, { sourceAccountId, accountId: bAccountId });
    await service.setExcluded(userId, tenantB, true);
    const res = await service.post(userId, [tenantB]);
    expect(res.posted).toBe(0);
    expect(res.results[0]!.error).toMatch(/excluded from bulk rule posting/i);
    const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantB));
    expect(items.every((i) => i.status === 'pending')).toBe(true);
  });

  it('keeps the other practice settings and writes an audit entry', async () => {
    await db.update(tenants).set({ practiceSettings: { classificationThresholds: { bucket4Floor: 0.5 } } })
      .where(eq(tenants.id, tenantB));
    await service.setExcluded(userId, tenantB, true);
    const row = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantB), columns: { practiceSettings: true } });
    expect(row!.practiceSettings).toEqual({
      classificationThresholds: { bucket4Floor: 0.5 },
      excludeFromRulesOverview: true,
    });
    const audits = await db.select().from(auditLog)
      .where(and(eq(auditLog.tenantId, tenantB), eq(auditLog.entityType, 'practice_settings')));
    expect(audits).toHaveLength(1);
  });

  it('rejects a client the caller cannot reach', async () => {
    await expect(service.setExcluded(userId, outsiderTenant, true)).rejects.toThrow(/do not have access/i);
  });
});

describe('account mappings', () => {
  it('a mapping makes the global rule’s matches ready in that client', async () => {
    await service.upsertMapping(userId, tenantB, { sourceAccountId, accountId: bAccountId });
    const b = rowFor(await service.getOverview(userId, QUERY), tenantB)!;
    expect(b.ready).toBe(2);
    expect(b.needsMapping).toBe(0);
    expect(b.unmappedAccounts).toEqual([]);
  });

  it('re-mapping updates in place', async () => {
    const other = (await expenseAccounts(tenantB))[0]!.id;
    await service.upsertMapping(userId, tenantB, { sourceAccountId, accountId: bAccountId });
    await service.upsertMapping(userId, tenantB, { sourceAccountId, accountId: other });
    const rows = await db.select().from(tenantFirmAccountMappings).where(eq(tenantFirmAccountMappings.tenantId, tenantB));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.accountId).toBe(other);
  });

  it('rejects a target account from another client', async () => {
    const aAccount = (await expenseAccounts(tenantA))[1]!.id;
    await expect(service.upsertMapping(userId, tenantB, { sourceAccountId, accountId: aAccount }))
      .rejects.toThrow(/not found in this client/i);
  });

  it('rejects a target account of a different type', async () => {
    const bank = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, tenantB), eq(accounts.detailType, 'bank')),
    });
    await expect(service.upsertMapping(userId, tenantB, { sourceAccountId, accountId: bank!.id }))
      .rejects.toThrow(/account of type "expense"/i);
  });

  it('rejects a source account from a client the firm does not manage', async () => {
    const outsiderAccount = (await expenseAccounts(outsiderTenant))[0]!.id;
    await expect(service.upsertMapping(userId, tenantB, { sourceAccountId: outsiderAccount, accountId: bAccountId }))
      .rejects.toThrow(/not a firm global-rule account/i);
  });

  it('rejects a client the caller cannot reach', async () => {
    await expect(service.upsertMapping(userId, outsiderTenant, { sourceAccountId, accountId: bAccountId }))
      .rejects.toThrow(/do not have access/i);
  });
});

describe('post', () => {
  it('refuses to post unmapped matches, then posts them to the mapped account once mapped', async () => {
    const before = await service.post(userId, [tenantB]);
    expect(before.posted).toBe(0);

    await service.upsertMapping(userId, tenantB, { sourceAccountId, accountId: bAccountId });
    const res = await service.post(userId, [tenantB]);
    expect(res.results[0]).toMatchObject({ tenantId: tenantB, posted: 2, failed: 0, error: null, more: false });

    const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantB));
    const byDesc = new Map(items.map((i) => [i.description, i]));
    expect(byDesc.get('ADOBE CREATIVE CLOUD')!.status).toBe('categorized');
    expect(byDesc.get('Adobe Acrobat')!.status).toBe('categorized');
    expect(byDesc.get('Corner Deli')!.status).toBe('pending');

    const lines = await db.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantB), eq(journalLines.accountId, bAccountId)));
    expect(lines).toHaveLength(2);
    // Never touches the source client's ledger.
    const aLines = await db.select().from(journalLines).where(eq(journalLines.accountId, sourceAccountId));
    expect(aLines).toHaveLength(0);
  });

  it('narrows to the given rules', async () => {
    await service.upsertMapping(userId, tenantB, { sourceAccountId, accountId: bAccountId });
    const res = await service.post(userId, [tenantB], [crypto.randomUUID()]);
    expect(res.posted).toBe(0);
  });

  it('reports a client the caller cannot reach as an error without posting', async () => {
    const connO = await connectionFor(outsiderTenant);
    await pendingItem(outsiderTenant, connO, 'ADOBE');
    const res = await service.post(userId, [outsiderTenant]);
    expect(res.results[0]!.error).toMatch(/do not have access/i);
    const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.tenantId, outsiderTenant));
    expect(items.every((i) => i.status === 'pending')).toBe(true);
  });
});
