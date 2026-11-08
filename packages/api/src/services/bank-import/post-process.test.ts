// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-06 follow-up: import post-processing of a whole batch. Timing of a
// 20,000-row batch with every stage doing work (a tenant rule, a rule scoped
// to an account, a conditional rule, trusted history, open bills and
// invoices).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  tenants, users, userTenantAccess, sessions, companies, accounts, auditLog, bankConnections, bankFeedItems, bankRules,
  bankImportBatches, transactions, journalLines, transactionClassificationState, categorizationHistory, idempotencyKeys,
  conditionalRules, conditionalRuleAudit, contacts, firms, tenantFirmAssignments, tenantFeatureFlags,
} from '../../db/schema/index.js';
import * as authService from '../auth.service.js';
import * as accountsService from '../accounts.service.js';
import { normalizePayeePattern } from '../categorization-ai.service.js';
import * as importBatch from './import-batch.service.js';

let tenantId = '';
let companyId = '';
let ownerId = '';
let bankId = '';
let expenseId = '';
let otherExpenseId = '';
let vendorId = '';
let createdFirmId = '';
let globalRuleIds: string[] = [];
let sourceTenantId = '';
const rand = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

beforeEach(async () => {
  const reg = await authService.register({
    email: `post-process-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Owner', companyName: 'Post Process Co',
  });
  tenantId = reg.user.tenantId;
  ownerId = reg.user.id;
  const [co] = await db.select().from(companies).where(eq(companies.tenantId, tenantId));
  companyId = co!.id;
  bankId = (await accountsService.create(tenantId, { name: 'PP Checking', accountType: 'asset', detailType: 'bank', accountNumber: '1092' })).id;
  expenseId = (await accountsService.create(tenantId, { name: 'PP Supplies', accountType: 'expense', accountNumber: '6092' })).id;
  otherExpenseId = (await accountsService.create(tenantId, { name: 'PP Utilities', accountType: 'expense', accountNumber: '6093' })).id;
  const [v] = await db.insert(contacts).values({ tenantId, displayName: 'History Payee Inc', contactType: 'vendor' }).returning();
  vendorId = v!.id;
});

afterEach(async () => {
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, tenantId));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
  if (globalRuleIds.length > 0) {
    await db.delete(conditionalRules).where(inArray(conditionalRules.id, globalRuleIds));
    globalRuleIds = [];
  }
  if (sourceTenantId) {
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, sourceTenantId));
    await db.delete(contacts).where(eq(contacts.tenantId, sourceTenantId));
    await db.delete(accounts).where(eq(accounts.tenantId, sourceTenantId));
    await db.delete(tenants).where(eq(tenants.id, sourceTenantId));
    sourceTenantId = '';
  }
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  if (createdFirmId) {
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.firmId, createdFirmId));
    await db.delete(firms).where(eq(firms.id, createdFirmId));
    createdFirmId = '';
  }
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankImportBatches).where(eq(bankImportBatches.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(bankRules).where(eq(bankRules.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  const staff = await db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId));
  for (const u of staff) await db.delete(sessions).where(eq(sessions.userId, u.id));
  await db.delete(userTenantAccess).where(eq(userTenantAccess.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

type Row = importBatch.BatchRowInput;

/** Rules, history, open bills/invoices: every post-processing stage has work. */
async function seedRulesAndBooks(): Promise<void> {
  await db.insert(bankRules).values([
    { tenantId, name: 'Acme utilities', isActive: true, isGlobal: false, applyTo: 'both', descriptionContains: 'ACME UTIL',
      assignAccountId: otherExpenseId, autoConfirm: true, priority: 5 },
    // Scoped to an account: the import pipeline never passes the account, so it never matches there.
    { tenantId, name: 'Scoped parking', isActive: true, isGlobal: false, applyTo: 'expenses', descriptionContains: 'PARKING',
      bankAccountId: bankId, assignAccountId: expenseId, priority: 9 },
    { tenantId, name: 'Exact rent', isActive: true, isGlobal: false, applyTo: 'expenses', descriptionExact: 'RENT PAYMENT',
      assignAccountId: expenseId, assignContactName: 'Landlord LLC', priority: 3 },
  ]);
  await db.insert(conditionalRules).values({
    tenantId, scope: 'tenant_user', ownerUserId: ownerId, name: 'Coffee to supplies', priority: 100,
    conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'coffee' },
    actions: [{ type: 'set_account', accountId: expenseId }, { type: 'set_memo', memo: 'Coffee run' }],
    active: true,
  });
  await db.insert(categorizationHistory).values({
    tenantId, payeePattern: normalizePayeePattern('HISTORY PAYEE'), accountId: expenseId, contactId: vendorId,
    timesConfirmed: 6, timesOverridden: 0,
  });
  for (let i = 0; i < 40; i++) {
    const day = String((i % 28) + 1).padStart(2, '0');
    await db.insert(transactions).values([
      { tenantId, companyId, txnType: 'bill', txnDate: `2026-03-${day}`, total: `${100 + i}.0000`, balanceDue: `${100 + i}.0000`, status: 'posted', contactId: vendorId },
      { tenantId, companyId, txnType: 'invoice', txnDate: `2026-04-${day}`, total: `${200 + i}.0000`, balanceDue: `${200 + i}.0000`, status: 'posted' },
    ]);
  }
}

/** A mixed file: rule hits, history hits, bills and invoices to match, plain rows. */
function mixedRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0');
    const month = String((i % 12) + 1).padStart(2, '0');
    const line = i + 1;
    switch (i % 10) {
      case 0: return { line, date: `2026-${month}-${day}`, amount: `${(i % 40) + 3}.50`, description: `COFFEE HOUSE ${i % 37}` };
      case 1: return { line, date: `2026-${month}-${day}`, amount: `${(i % 90) + 20}.00`, description: `ACME UTILITIES ${i % 13}` };
      case 2: return { line, date: `2026-${month}-${day}`, amount: '61.00', description: 'HISTORY PAYEE' };
      case 3: return { line, date: `2026-03-${day}`, amount: `${100 + (i % 40)}.00`, description: `BILL PAY VENDOR ${i % 40}` };
      case 4: return { line, date: `2026-04-${day}`, amount: `-${200 + (i % 40)}.00`, description: `DEPOSIT CUSTOMER ${i % 40}` };
      case 5: return { line, date: `2026-${month}-${day}`, amount: '12.00', description: 'PARKING GARAGE' };
      case 6: return { line, date: `2026-${month}-${day}`, amount: '1500.00', description: 'RENT PAYMENT' };
      default: return { line, date: `2026-${month}-${day}`, amount: `${(i % 500) + 1}.25`, description: `VENDOR ${i}` };
    }
  });
}

function batchInput(rows: Row[], sha: string): importBatch.BatchInput {
  return {
    accountId: bankId, format: 'csv', fileName: 'mixed.csv', sourceFileSha256: sha.repeat(64), sectionIndex: 0,
    sectionStart: null, sectionEnd: null, amountsFlipped: false, dryRun: false, rows,
  };
}

async function itemsByLine(batchId: string) {
  const rows = await db.select().from(bankFeedItems).where(eq(bankFeedItems.importBatchId, batchId));
  return new Map(rows.map((r) => [r.sourceLine!, r]));
}

async function statesByLine(batchId: string) {
  const r = await db.select({ line: bankFeedItems.sourceLine, s: transactionClassificationState })
    .from(transactionClassificationState)
    .innerJoin(bankFeedItems, eq(bankFeedItems.id, transactionClassificationState.bankFeedItemId))
    .where(eq(bankFeedItems.importBatchId, batchId));
  return new Map(r.map((x) => [x.line!, x.s]));
}

async function firesByLine(batchId: string) {
  const r = await db.select({ line: bankFeedItems.sourceLine, ruleId: conditionalRuleAudit.ruleId, actions: conditionalRuleAudit.actionsApplied, tier: conditionalRuleAudit.effectiveTier })
    .from(conditionalRuleAudit)
    .innerJoin(bankFeedItems, eq(bankFeedItems.id, conditionalRuleAudit.bankFeedItemId))
    .where(eq(bankFeedItems.importBatchId, batchId));
  return r.map((x) => ({ ...x })).sort((a, b) => a.line! - b.line! || a.ruleId.localeCompare(b.ruleId));
}

async function ruleCounts(): Promise<Record<string, number>> {
  const r = await db.select({ name: bankRules.name, n: bankRules.timesApplied }).from(bankRules).where(eq(bankRules.tenantId, tenantId));
  return Object.fromEntries(r.map((x) => [x.name, x.n ?? 0]));
}

/**
 * RULES_TIERED_V1 on, a firm managing the tenant, a global rule whose
 * account and vendor live in another tenant (resolved through the symbol
 * caches the batch shares across chunks) and a firm rule on the tenant.
 */
async function seedTiered(): Promise<{ mappedAccountId: string }> {
  await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'RULES_TIERED_V1', enabled: true }).onConflictDoNothing();
  // The firm managing the tenant (registration may already have assigned one).
  const [managed] = await db.select({ firmId: tenantFirmAssignments.firmId }).from(tenantFirmAssignments)
    .where(and(eq(tenantFirmAssignments.tenantId, tenantId), eq(tenantFirmAssignments.isActive, true)));
  let firmId = managed?.firmId;
  if (!firmId) {
    const [firm] = await db.insert(firms).values({ name: 'PP Firm', slug: `pp-firm-${rand()}` }).returning();
    firmId = createdFirmId = firm!.id;
    await db.insert(tenantFirmAssignments).values({ tenantId, firmId });
  }
  const [src] = await db.insert(tenants).values({ name: 'PP Source', slug: `pp-source-${rand()}` }).returning();
  sourceTenantId = src!.id;
  await db.insert(tenantFirmAssignments).values({ tenantId: sourceTenantId, firmId });
  const tag = `pp_fees_${Math.random().toString(36).slice(2, 8)}`;
  const [srcAccount] = await db.insert(accounts).values({
    tenantId: sourceTenantId, accountNumber: '6300', name: 'Bank Fees', accountType: 'expense', systemTag: tag, isActive: true,
  }).returning();
  const [mapped] = await db.insert(accounts).values({
    tenantId, accountNumber: '6301', name: 'PP Bank Fees', accountType: 'expense', systemTag: tag, isActive: true,
  }).returning();
  const [srcVendor] = await db.insert(contacts).values({ tenantId: sourceTenantId, displayName: 'Deposit Source Co', contactType: 'vendor' }).returning();
  const [global] = await db.insert(conditionalRules).values({
    tenantId: null, scope: 'global_firm', ownerFirmId: firmId, name: 'Global deposits', priority: 10,
    conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'deposit customer' },
    actions: [{ type: 'set_account', accountId: srcAccount!.id }, { type: 'set_vendor', vendorId: srcVendor!.id }], active: true,
  }).returning({ id: conditionalRules.id });
  globalRuleIds.push(global!.id);
  await db.insert(conditionalRules).values([
    { tenantId, scope: 'tenant_firm', ownerFirmId: firmId, name: 'Firm parking', priority: 20, continueAfterMatch: true,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'parking' },
      actions: [{ type: 'set_account', accountId: expenseId }, { type: 'mark_for_review' }], active: true },
  ]);
  return { mappedAccountId: mapped!.id };
}

const itemCols = (i: typeof bankFeedItems.$inferSelect) => ({
  description: i.description, suggestedAccountId: i.suggestedAccountId, suggestedContactId: i.suggestedContactId,
  suggestedTagId: i.suggestedTagId, matchType: i.matchType, confidenceScore: i.confidenceScore, skipAi: i.skipAi,
  splitsConfig: i.splitsConfig, status: i.status, payeeNameOnCheck: i.payeeNameOnCheck,
});
const stateCols = (s: typeof transactionClassificationState.$inferSelect) => ({
  bucket: s.bucket, confidenceScore: s.confidenceScore, suggestedAccountId: s.suggestedAccountId, suggestedVendorId: s.suggestedVendorId,
  matchedRuleId: s.matchedRuleId, reasoningBlob: s.reasoningBlob, matchCandidates: s.matchCandidates, modelUsed: s.modelUsed, companyId: s.companyId,
});

/** Batch `b`'s items, state rows and rule fires equal batch `a`'s, line by line. */
async function expectSameResults(a: string, b: string): Promise<void> {
  const [ia, ib] = [await itemsByLine(a), await itemsByLine(b)];
  expect(ib.size).toBe(ia.size);
  for (const [line, x] of ia) expect({ line, ...itemCols(ib.get(line)!) }).toEqual({ line, ...itemCols(x) });
  const [sa, sb] = [await statesByLine(a), await statesByLine(b)];
  expect([...sb.keys()].sort((x, y) => x - y)).toEqual([...sa.keys()].sort((x, y) => x - y));
  for (const [line, x] of sa) expect({ line, ...stateCols(sb.get(line)!) }).toEqual({ line, ...stateCols(x) });
  expect((await firesByLine(b)).map(({ line, ruleId, actions, tier }) => ({ line, ruleId, actions, tier })))
    .toEqual((await firesByLine(a)).map(({ line, ruleId, actions, tier }) => ({ line, ruleId, actions, tier })));
}

describe('import post-processing (U-06 follow-up)', () => {
  it.each([
    ['off', false],
    ['on', true],
  ])('gives the same result as the per-row pipelines on a mixed file (chunks of 7, RULES_TIERED_V1 %s)', async (_label, tiered) => {
    await seedRulesAndBooks();
    const tieredSeed = tiered ? await seedTiered() : null;
    // A global rule (account by name, contact found or made), a rule matching a check payee,
    // a journal entry and a pending item of another account for the matchers.
    await db.insert(bankRules).values([
      { tenantId, name: 'Global fuel', isActive: true, isGlobal: true, applyTo: 'expenses', descriptionContains: 'FUEL STOP',
        assignAccountName: 'PP Utilities', assignContactName: 'Fuel Stop Inc', priority: 1 },
      { tenantId, name: 'Payee plumber', isActive: true, isGlobal: false, applyTo: 'expenses', descriptionContains: 'joe plumber',
        assignAccountId: expenseId, priority: 2 },
    ]);
    await db.insert(conditionalRules).values({
      tenantId, scope: 'tenant_user', ownerUserId: ownerId, name: 'Review rent', priority: 50, continueAfterMatch: true,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'contains', value: 'rent' },
      actions: [{ type: 'mark_for_review' }, { type: 'skip_ai' }],
      active: true,
    });
    await db.insert(transactions).values({ tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-03-03', total: '61.0000', status: 'posted', memo: 'history payee' });
    const otherBank = (await accountsService.create(tenantId, { name: 'PP Savings', accountType: 'asset', detailType: 'bank', accountNumber: '1093' })).id;
    const [plaid] = await db.insert(bankConnections).values({ tenantId, companyId, accountId: otherBank, provider: 'plaid' }).returning();
    await db.insert(bankFeedItems).values({ tenantId, companyId, bankConnectionId: plaid!.id, status: 'pending', feedDate: '2026-02-03',
      amount: '-51.0000', description: 'TRANSFER IN', originalDescription: 'TRANSFER IN' });

    const rows: Row[] = [
      ...mixedRows(50),
      { line: 51, date: '2026-02-03', amount: '45.00', description: 'FUEL STOP 22' },
      { line: 52, date: '2026-02-04', amount: '51.00', description: 'ONLINE TRANSFER' },
      { line: 53, date: '2026-02-05', amount: '80.00', description: 'CHECK 1201', checkNumber: 1201 },
      { line: 54, date: '2026-02-06', amount: '12.00', description: 'DEPOSIT' },
    ];
    const bankB = (await accountsService.create(tenantId, { name: 'PP Checking B', accountType: 'asset', detailType: 'bank', accountNumber: '1094' })).id;
    const a = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, batchInput(rows, 'c'));
    const b = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, { ...batchInput(rows, 'd'), accountId: bankB });
    // A check payee read off the image, on both.
    for (const id of [a.batchId!, b.batchId!]) {
      await db.update(bankFeedItems).set({ payeeNameOnCheck: 'Joe Plumber' })
        .where(and(eq(bankFeedItems.importBatchId, id), eq(bankFeedItems.sourceLine, 53)));
    }

    // Per row (the bank-feed pipelines, as the import ran them before).
    const before = await ruleCounts();
    const bankFeed = await import('../bank-feed.service.js');
    const items = await db.select().from(bankFeedItems).where(eq(bankFeedItems.importBatchId, a.batchId!));
    await bankFeed.runCleansingPipeline(tenantId, items, { llm: false });
    await bankFeed.runCategorizationPipeline(tenantId, items, { llm: false, autoConfirm: false });
    const mid = await ruleCounts();

    // Batched.
    const { postProcessBatch, POST_CHUNK } = await import('./post-process.js');
    const size = POST_CHUNK.size;
    POST_CHUNK.size = 7;
    try {
      expect(await postProcessBatch(tenantId, b.batchId!)).toBe('done');
    } finally {
      POST_CHUNK.size = size;
    }
    const after = await ruleCounts();

    await expectSameResults(a.batchId!, b.batchId!);
    for (const name of Object.keys(after)) expect({ name, n: after[name]! - mid[name]! }).toEqual({ name, n: mid[name]! - before[name]! });

    // The fixture exercises every stage.
    const ib = await itemsByLine(b.batchId!);
    const sb = await statesByLine(b.batchId!);
    expect(ib.size).toBe(rows.length);
    if (tieredSeed) {
      // The global rule, resolved into this tenant (account by system tag, vendor by name), and the firm rule fired.
      const deposits = [...ib.values()].filter((i) => i.description?.startsWith('DEPOSIT CUSTOMER') || i.originalDescription?.startsWith('DEPOSIT CUSTOMER'));
      expect(deposits.length).toBeGreaterThan(0);
      for (const d of deposits) expect(d.suggestedAccountId).toBe(tieredSeed.mappedAccountId);
      expect(new Set((await firesByLine(b.batchId!)).map((f) => f.tier))).toEqual(new Set(['tenant_user', 'tenant_firm', 'global_firm']));
    }
    const kinds = new Set([...ib.values()].map((i) => i.matchType));
    expect(kinds).toEqual(new Set(['rule', 'history', null]));
    expect([...sb.values()].some((s) => (s.matchCandidates as unknown[]).length > 0)).toBe(true);
    expect([...sb.values()].map((s) => s.bucket)).toEqual(expect.arrayContaining(['rule', 'potential_match', 'needs_review']));
    expect(ib.get(51)!.suggestedContactId).toBeTruthy();
    expect(ib.get(53)!.suggestedAccountId).toBe(expenseId);
  }, 120_000);

  it('records progress per chunk; total and processed are the inserted rows when done', async () => {
    const r = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, batchInput(mixedRows(250), 'e'));
    const { POST_CHUNK } = await import('./post-process.js');
    const size = POST_CHUNK.size;
    POST_CHUNK.size = 100;
    // What another connection sees after each chunk committed.
    const seen: Array<{ processed: number; total: number | null }> = [];
    POST_CHUNK.afterChunk = async (id) => {
      const [x] = await db.select({ processed: bankImportBatches.processedRows, total: bankImportBatches.totalRows })
        .from(bankImportBatches).where(eq(bankImportBatches.id, id));
      seen.push(x!);
    };
    try {
      expect(await importBatch.runImportPostProcessing(tenantId, r.batchId!)).toBe('done');
    } finally {
      POST_CHUNK.size = size;
      POST_CHUNK.afterChunk = undefined;
    }
    const [listed] = await importBatch.listBatches({ tenantId, companyId }, { accountId: bankId });
    expect(listed).toMatchObject({ postProcessing: 'done', processed: 250, total: 250 });
    expect(seen).toEqual([{ processed: 100, total: 250 }, { processed: 200, total: 250 }, { processed: 250, total: 250 }]);
  });

  it('a run stopped by an undo that is refused goes on where it stopped: the same result as a straight run', async () => {
    await seedRulesAndBooks();
    const rows = mixedRows(2_000);
    const bankB = (await accountsService.create(tenantId, { name: 'PP Checking B', accountType: 'asset', detailType: 'bank', accountNumber: '1094' })).id;
    const actor = { tenantId, companyId, userId: ownerId };
    const assign = (batchId: string) => db.update(bankFeedItems).set({ status: 'assigned', assignedAt: new Date(), assignedAccountId: expenseId })
      .where(and(eq(bankFeedItems.importBatchId, batchId), eq(bankFeedItems.sourceLine, 5)));
    const { POST_CHUNK } = await import('./post-process.js');
    const size = POST_CHUNK.size;
    POST_CHUNK.size = 100;
    try {
      // Straight run; line 5 used afterwards.
      const a = await importBatch.commitBatch(actor, batchInput(rows, 'j'));
      const before = await ruleCounts();
      expect(await importBatch.runImportPostProcessing(tenantId, a.batchId!)).toBe('done');
      await assign(a.batchId!);
      const mid = await ruleCounts();

      // Line 5 used once its chunk is done, then an undo: it stops the run and is refused.
      const b = await importBatch.commitBatch(actor, { ...batchInput(rows, 'k'), accountId: bankB });
      const running = importBatch.runImportPostProcessing(tenantId, b.batchId!);
      for (let i = 0; i < 2_000; i++) {
        const [x] = await db.select({ p: bankImportBatches.processedRows }).from(bankImportBatches).where(eq(bankImportBatches.id, b.batchId!));
        if (x && x.p >= 100) break;
        await new Promise((res) => setTimeout(res, 5));
      }
      await assign(b.batchId!);
      await expect(importBatch.undoBatch(actor, b.batchId!, false)).rejects.toMatchObject({ code: 'rows_already_used' });
      expect(await running).toBe('cancelled');
      await importBatch.__postProcessing.last;
      const after = await ruleCounts();

      const [bb] = await db.select().from(bankImportBatches).where(eq(bankImportBatches.id, b.batchId!));
      expect(bb).toMatchObject({ postProcessing: 'done', cancelRequestedAt: null, undoneAt: null, processedRows: 2_000, totalRows: 2_000 });
      await expectSameResults(a.batchId!, b.batchId!);
      for (const name of Object.keys(after)) expect({ name, n: after[name]! - mid[name]! }).toEqual({ name, n: mid[name]! - before[name]! });
      expect(mid['Acme utilities']! - before['Acme utilities']!).toBe(200);
    } finally {
      POST_CHUNK.size = size;
    }
  }, 300_000);

  it('a row changed while its chunk is prepared is left as it is; the others are written', async () => {
    await seedRulesAndBooks();
    const r = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, batchInput(mixedRows(20), 'l'));
    const lines = await itemsByLine(r.batchId!);
    const acme = lines.get(2)!; // ACME UTILITIES: a legacy rule hit
    const hist = lines.get(3)!; // HISTORY PAYEE: trusted history
    const { pool } = await import('../../db/index.js');
    const owner = await pool.connect();
    try {
      // The owner assigns two rows in a transaction still open while the chunk is read and evaluated.
      await owner.query('BEGIN');
      await owner.query(`UPDATE bank_feed_items SET status = 'assigned', assigned_at = now(), assigned_account_id = $1 WHERE id = ANY($2::uuid[])`,
        [otherExpenseId, [acme.id, hist.id]]);
      const running = importBatch.runImportPostProcessing(tenantId, r.batchId!);
      // The chunk's write waits on those rows.
      for (let i = 0; i < 2_000; i++) {
        const w = await db.execute(sql`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%md5(bank_feed_items::text)%FOR UPDATE%'`);
        if ((w.rows[0] as { n: number }).n > 0) break;
        await new Promise((res) => setTimeout(res, 5));
      }
      await owner.query('COMMIT');
      expect(await running).toBe('done');
    } finally {
      owner.release();
    }
    const after = await itemsByLine(r.batchId!);
    for (const x of [acme, hist]) {
      expect(itemCols(after.get(x.sourceLine!)!)).toEqual({ ...itemCols(x), status: 'assigned' });
    }
    const states = await statesByLine(r.batchId!);
    expect(states.has(2)).toBe(false);
    expect(states.has(3)).toBe(false);
    // The other rows were written: line 12 (ACME) counted, line 13 (history) suggested.
    expect(after.get(12)!.suggestedAccountId).toBe(otherExpenseId);
    expect(after.get(13)!).toMatchObject({ suggestedAccountId: expenseId, matchType: 'history' });
    expect((await ruleCounts())['Acme utilities']).toBe(1);
  });

  it('a row that cannot be written is skipped; the rest of its chunk is written and the run is done', async () => {
    await seedRulesAndBooks();
    const r = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, batchInput(mixedRows(20), 'm'));
    const bad = (await itemsByLine(r.batchId!)).get(2)!; // ACME UTILITIES: a legacy rule hit
    const fn = `pp_fail_${Math.random().toString(36).slice(2, 10)}`;
    await db.execute(sql.raw(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${bad.id}' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER ${fn} BEFORE UPDATE ON bank_feed_items FOR EACH ROW EXECUTE FUNCTION ${fn}()`));
    try {
      expect(await importBatch.runImportPostProcessing(tenantId, r.batchId!)).toBe('done');
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON bank_feed_items`));
      await db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    }
    const [b] = await db.select().from(bankImportBatches).where(eq(bankImportBatches.id, r.batchId!));
    expect(b).toMatchObject({ postProcessing: 'done', processedRows: 20, totalRows: 20 });
    const after = await itemsByLine(r.batchId!);
    expect(itemCols(after.get(2)!)).toEqual(itemCols(bad));
    expect(after.get(12)!.suggestedAccountId).toBe(otherExpenseId);
    expect(after.get(3)!).toMatchObject({ suggestedAccountId: expenseId, matchType: 'history' });
    // The bad row's rule count went back with it.
    expect((await ruleCounts())['Acme utilities']).toBe(1);
    const states = await statesByLine(r.batchId!);
    expect(states.has(1)).toBe(true);
    expect(states.has(3)).toBe(true);
  });

  it('an undo while preparing stops post-processing after its chunk and undoes; reported cancelled', async () => {
    const r = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, batchInput(mixedRows(2_000), 'f'));
    const { POST_CHUNK } = await import('./post-process.js');
    const size = POST_CHUNK.size;
    POST_CHUNK.size = 100;
    try {
      const running = importBatch.runImportPostProcessing(tenantId, r.batchId!);
      for (let i = 0; i < 400; i++) {
        const [b] = await db.select({ p: bankImportBatches.processedRows }).from(bankImportBatches).where(eq(bankImportBatches.id, r.batchId!));
        if (b && b.p >= 100) break;
        await new Promise((res) => setTimeout(res, 10));
      }
      const undone = await importBatch.undoBatch({ tenantId, companyId, userId: ownerId }, r.batchId!, false);
      expect(undone).toMatchObject({ removed: 2_000, kept: 0 });
      expect(await running).toBe('cancelled');
    } finally {
      POST_CHUNK.size = size;
    }
    const [listed] = await importBatch.listBatches({ tenantId, companyId }, { accountId: bankId });
    expect(listed!.postProcessing).toBe('cancelled');
    expect(listed!.undoneAt).toEqual(expect.any(String));
    expect(listed!.processed).toBeLessThan(2_000);
    expect(listed!.total).toBe(2_000);
    const left = await db.execute(sql`SELECT
      (SELECT count(*)::int FROM bank_feed_items WHERE tenant_id = ${tenantId}) AS items,
      (SELECT count(*)::int FROM transaction_classification_state WHERE tenant_id = ${tenantId}) AS states`);
    expect(left.rows[0]).toEqual({ items: 0, states: 0 });
    // Not resumed on start.
    await importBatch.resumeScheduledPostProcessing();
    expect((await importBatch.readBatchResult(tenantId, r.batchId!)).postProcessing).toBe('cancelled');
  }, 120_000);

  it('a batch not yet started is undone at once and never runs', async () => {
    const r = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, batchInput(mixedRows(20), 'g'));
    expect(await importBatch.undoBatch({ tenantId, companyId, userId: ownerId }, r.batchId!, false)).toMatchObject({ removed: 20 });
    expect(await importBatch.runImportPostProcessing(tenantId, r.batchId!)).toBe('skipped');
    expect((await importBatch.readBatchResult(tenantId, r.batchId!)).postProcessing).toBe('cancelled');
  });

  it('an undo refused (rows used) withdraws its request and post-processing goes on', async () => {
    const r = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, batchInput(mixedRows(20), 'h'));
    await db.update(bankFeedItems).set({ status: 'assigned', assignedAt: new Date(), assignedAccountId: expenseId })
      .where(eq(bankFeedItems.id, r.insertedItemIds[0]!));
    await expect(importBatch.undoBatch({ tenantId, companyId, userId: ownerId }, r.batchId!, false))
      .rejects.toMatchObject({ code: 'rows_already_used' });
    await importBatch.__postProcessing.last;
    const [b] = await db.select().from(bankImportBatches).where(eq(bankImportBatches.id, r.batchId!));
    expect(b).toMatchObject({ postProcessing: 'done', cancelRequestedAt: null, undoneAt: null, processedRows: 20, totalRows: 20 });
  });

  it('409 still_preparing only when post-processing does not stop in time; nothing undone, the request withdrawn', async () => {
    const r = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, batchInput(mixedRows(20), 'i'));
    // Another engine holds the run's lock (a chunk that does not finish).
    const { pool } = await import('../../db/index.js');
    const holder = await pool.connect();
    const wait = importBatch.UNDO_WAIT.ms;
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [`bank-import-post:${r.batchId}`]);
      importBatch.UNDO_WAIT.ms = 300;
      await expect(importBatch.undoBatch({ tenantId, companyId, userId: ownerId }, r.batchId!, false))
        .rejects.toMatchObject({ code: 'still_preparing' });
    } finally {
      importBatch.UNDO_WAIT.ms = wait;
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`bank-import-post:${r.batchId}`]);
      holder.release();
    }
    // The withdrawal re-schedules post-processing (skipped while the other holder still had the lock).
    await importBatch.__postProcessing.last;
    const [b] = await db.select().from(bankImportBatches).where(eq(bankImportBatches.id, r.batchId!));
    expect(b).toMatchObject({ cancelRequestedAt: null, undoneAt: null });
    if (b!.postProcessing === 'scheduled') expect(await importBatch.runImportPostProcessing(tenantId, r.batchId!)).toBe('done');
    expect(await importBatch.undoBatch({ tenantId, companyId, userId: ownerId }, r.batchId!, false)).toMatchObject({ removed: 20 });
  });

  it('20,000 rows are post-processed in at most 30 s', async () => {
    await seedRulesAndBooks();
    const r = await importBatch.commitBatch({ tenantId, companyId, userId: ownerId }, batchInput(mixedRows(20_000), 'b'));
    expect(r.counts.inserted).toBe(20_000);
    const started = Date.now();
    const state = await importBatch.runImportPostProcessing(tenantId, r.batchId!);
    const took = Date.now() - started;
    console.log(`[perf] post-processing of 20,000 rows: ${took} ms`);
    expect(state).toBe('done');
    const n = ((await db.execute(sql`SELECT count(*)::int AS n FROM transaction_classification_state WHERE tenant_id = ${tenantId}`)).rows[0] as { n: number }).n;
    // U-168: rows a legacy bank rule attributed get their state row too, with matched_bank_rule_id.
    expect(n).toBe(20_000);
    const legacy = ((await db.execute(sql`SELECT count(*)::int AS n FROM transaction_classification_state WHERE tenant_id = ${tenantId} AND matched_bank_rule_id IS NOT NULL`)).rows[0] as { n: number }).n;
    expect(legacy).toBe(2_000);
    const lines = await db.select().from(journalLines).where(and(eq(journalLines.tenantId, tenantId)));
    expect(lines).toHaveLength(0); // nothing posted (the seeded bills and invoices have no lines)
    expect(took).toBeLessThan(30_000);
  }, 900_000);
});
