// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, isNull } from 'drizzle-orm';
import type { CreateBankRuleInput, UpdateBankRuleInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { bankRules, accounts, contacts, globalRuleSubmissions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// ─── Tenant Rules (existing) ────────────────────────────────────

export async function list(tenantId: string) {
  return db.select().from(bankRules).where(and(eq(bankRules.tenantId, tenantId), eq(bankRules.isGlobal, false)))
    .orderBy(sql`${bankRules.priority} DESC`, bankRules.name);
}

export async function getById(tenantId: string, id: string) {
  const rule = await db.query.bankRules.findFirst({ where: and(eq(bankRules.tenantId, tenantId), eq(bankRules.id, id)) });
  if (!rule) throw AppError.notFound('Bank rule not found');
  return rule;
}

export async function create(tenantId: string, input: CreateBankRuleInput) {
  const [rule] = await db.insert(bankRules).values({ tenantId, isGlobal: false, ...input }).returning();
  return rule;
}

export async function update(tenantId: string, id: string, input: UpdateBankRuleInput) {
  const [updated] = await db.update(bankRules).set({ ...input, updatedAt: new Date() })
    .where(and(eq(bankRules.tenantId, tenantId), eq(bankRules.id, id))).returning();
  if (!updated) throw AppError.notFound('Bank rule not found');
  return updated;
}

export async function remove(tenantId: string, id: string) {
  await db.delete(bankRules).where(and(eq(bankRules.tenantId, tenantId), eq(bankRules.id, id)));
}

export async function reorder(tenantId: string, orderedIds: string[]) {
  for (let i = 0; i < orderedIds.length; i++) {
    await db.update(bankRules).set({ priority: orderedIds.length - i })
      .where(and(eq(bankRules.tenantId, tenantId), eq(bankRules.id, orderedIds[i]!)));
  }
}

// ─── Global Rules (super admin) ─────────────────────────────────

export async function listGlobal() {
  return db.select().from(bankRules).where(eq(bankRules.isGlobal, true))
    .orderBy(sql`${bankRules.priority} DESC`, bankRules.name);
}

export async function getGlobalById(id: string) {
  const rule = await db.query.bankRules.findFirst({ where: and(eq(bankRules.id, id), eq(bankRules.isGlobal, true)) });
  if (!rule) throw AppError.notFound('Global bank rule not found');
  return rule;
}

export async function createGlobal(input: {
  name: string; priority?: number; applyTo?: string;
  descriptionContains?: string; descriptionExact?: string;
  amountEquals?: string; amountMin?: string; amountMax?: string;
  assignAccountName?: string; assignContactName?: string;
  assignMemo?: string; autoConfirm?: boolean;
}) {
  const [rule] = await db.insert(bankRules).values({
    tenantId: null,
    isGlobal: true,
    name: input.name,
    priority: input.priority ?? 0,
    applyTo: input.applyTo || 'both',
    descriptionContains: input.descriptionContains || null,
    descriptionExact: input.descriptionExact || null,
    amountEquals: input.amountEquals || null,
    amountMin: input.amountMin || null,
    amountMax: input.amountMax || null,
    assignAccountName: input.assignAccountName || null,
    assignContactName: input.assignContactName || null,
    assignMemo: input.assignMemo || null,
    autoConfirm: input.autoConfirm ?? false,
  }).returning();
  return rule;
}

export async function updateGlobal(id: string, input: Record<string, any>) {
  const [updated] = await db.update(bankRules).set({ ...input, updatedAt: new Date() })
    .where(and(eq(bankRules.id, id), eq(bankRules.isGlobal, true))).returning();
  if (!updated) throw AppError.notFound('Global bank rule not found');
  return updated;
}

export async function removeGlobal(id: string) {
  await db.delete(bankRules).where(and(eq(bankRules.id, id), eq(bankRules.isGlobal, true)));
}

// ─── Fuzzy Matching ─────────────────────────────────────────────

function fuzzyScore(needle: string, haystack: string): number {
  const n = needle.toLowerCase().trim();
  const h = haystack.toLowerCase().trim();
  if (n === h) return 1.0;
  if (h.includes(n) || n.includes(h)) return 0.8;
  // Word overlap
  const nWords = n.split(/\s+/);
  const hWords = h.split(/\s+/);
  const matches = nWords.filter((w) => hWords.some((hw) => hw.includes(w) || w.includes(hw)));
  if (matches.length > 0) return (matches.length / Math.max(nWords.length, hWords.length)) * 0.6;
  return 0;
}

async function fuzzyMatchAccount(tenantId: string, accountName: string): Promise<string | null> {
  const allAccounts = await db.select({ id: accounts.id, name: accounts.name })
    .from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.isActive, true)));

  let bestId: string | null = null;
  let bestScore = 0;

  for (const acct of allAccounts) {
    const score = fuzzyScore(accountName, acct.name);
    if (score > bestScore) {
      bestScore = score;
      bestId = acct.id;
    }
  }

  return bestScore >= 0.5 ? bestId : null;
}

async function findOrCreateContact(tenantId: string, contactName: string): Promise<string | null> {
  if (!contactName) return null;

  // Try exact match first
  const existing = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), sql`LOWER(${contacts.displayName}) = LOWER(${contactName})`),
  });
  if (existing) return existing.id;

  // Auto-create
  const [created] = await db.insert(contacts).values({
    tenantId,
    displayName: contactName,
    contactType: 'vendor',
  }).returning();

  return created?.id || null;
}

// ─── Rule Evaluation ────────────────────────────────────────────

function matchesConditions(rule: any, desc: string, direction: string, absAmount: number, bankAccountId?: string): boolean {
  if (rule.applyTo !== 'both' && rule.applyTo !== direction) return false;
  if (rule.bankAccountId && rule.bankAccountId !== bankAccountId) return false;
  if (rule.descriptionContains && !desc.includes(rule.descriptionContains.toLowerCase())) return false;
  if (rule.descriptionExact && desc !== rule.descriptionExact.toLowerCase()) return false;
  if (rule.amountEquals && Math.abs(absAmount - parseFloat(rule.amountEquals)) > 0.01) return false;
  if (rule.amountMin && absAmount < parseFloat(rule.amountMin)) return false;
  if (rule.amountMax && absAmount > parseFloat(rule.amountMax)) return false;
  return true;
}

export async function evaluateRules(tenantId: string, feedItem: { description: string | null; amount: number; bankConnectionAccountId?: string }) {
  const isDeposit = feedItem.amount < 0;
  const direction = isDeposit ? 'deposits' : 'expenses';
  const absAmount = Math.abs(feedItem.amount);
  const desc = (feedItem.description || '').toLowerCase();

  // 1. Check tenant rules first
  const tenantRules = await db.select().from(bankRules)
    .where(and(eq(bankRules.tenantId, tenantId), eq(bankRules.isActive, true), eq(bankRules.isGlobal, false)))
    .orderBy(sql`${bankRules.priority} DESC`);

  for (const rule of tenantRules) {
    if (!matchesConditions(rule, desc, direction, absAmount, feedItem.bankConnectionAccountId)) continue;

    await db.update(bankRules).set({
      timesApplied: sql`${bankRules.timesApplied} + 1`,
      lastAppliedAt: new Date(),
    }).where(eq(bankRules.id, rule.id));

    return {
      matched: true,
      ruleId: rule.id,
      ruleName: rule.name,
      isGlobal: false,
      assignAccountId: rule.assignAccountId,
      assignContactId: rule.assignContactId,
      assignMemo: rule.assignMemo,
      autoConfirm: rule.autoConfirm,
    };
  }

  // 2. Check global rules as fallback
  const globalRules = await db.select().from(bankRules)
    .where(and(eq(bankRules.isGlobal, true), eq(bankRules.isActive, true)))
    .orderBy(sql`${bankRules.priority} DESC`);

  for (const rule of globalRules) {
    if (!matchesConditions(rule, desc, direction, absAmount, feedItem.bankConnectionAccountId)) continue;

    // Fuzzy match account name to tenant's COA
    let accountId: string | null = null;
    if (rule.assignAccountName) {
      accountId = await fuzzyMatchAccount(tenantId, rule.assignAccountName);
      if (!accountId) continue; // Skip rule if we can't match the account
    }

    // Find or create contact
    let contactId: string | null = null;
    if (rule.assignContactName) {
      contactId = await findOrCreateContact(tenantId, rule.assignContactName);
    }

    await db.update(bankRules).set({
      timesApplied: sql`${bankRules.timesApplied} + 1`,
      lastAppliedAt: new Date(),
    }).where(eq(bankRules.id, rule.id));

    return {
      matched: true,
      ruleId: rule.id,
      ruleName: rule.name,
      isGlobal: true,
      assignAccountId: accountId,
      assignContactId: contactId,
      assignMemo: rule.assignMemo,
      autoConfirm: rule.autoConfirm,
    };
  }

  return { matched: false };
}

// Test a rule against sample data
export async function testRule(tenantId: string, ruleId: string, description: string, amount: number) {
  const result = await evaluateRules(tenantId, { description, amount });
  return { wouldMatch: result.matched && result.ruleId === ruleId };
}

// ─── Global Rule Submissions ────────────────────────────────────

export async function submitRuleForGlobal(userId: string, email: string, tenantId: string, ruleId: string, note?: string) {
  const rule = await db.query.bankRules.findFirst({ where: and(eq(bankRules.id, ruleId), eq(bankRules.tenantId, tenantId)) });
  if (!rule) throw AppError.notFound('Rule not found');

  // Get account name from the assigned account (if any)
  let accountName: string | null = null;
  if (rule.assignAccountId) {
    const acct = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, rule.assignAccountId)),
    });
    accountName = acct?.name || null;
  }

  // Get contact name (if any)
  let contactName: string | null = null;
  if (rule.assignContactId) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, rule.assignContactId)),
    });
    contactName = contact?.displayName || null;
  }

  const [submission] = await db.insert(globalRuleSubmissions).values({
    submittedByUserId: userId,
    submittedByEmail: email,
    sourceTenantId: tenantId,
    sourceRuleId: ruleId,
    name: rule.name,
    applyTo: rule.applyTo,
    descriptionContains: rule.descriptionContains,
    descriptionExact: rule.descriptionExact,
    amountEquals: rule.amountEquals,
    amountMin: rule.amountMin,
    amountMax: rule.amountMax,
    assignAccountName: accountName || rule.assignAccountName,
    assignContactName: contactName || rule.assignContactName,
    assignMemo: rule.assignMemo,
    autoConfirm: rule.autoConfirm,
    note: note || null,
  }).returning();

  return submission;
}

export async function listSubmissions(status?: string) {
  if (status) {
    return db.select().from(globalRuleSubmissions)
      .where(eq(globalRuleSubmissions.status, status))
      .orderBy(sql`${globalRuleSubmissions.createdAt} DESC`);
  }
  return db.select().from(globalRuleSubmissions)
    .orderBy(sql`${globalRuleSubmissions.createdAt} DESC`);
}

export async function approveSubmission(submissionId: string) {
  const submission = await db.query.globalRuleSubmissions.findFirst({ where: eq(globalRuleSubmissions.id, submissionId) });
  if (!submission) throw AppError.notFound('Submission not found');
  if (submission.status !== 'pending') throw AppError.badRequest('Submission already reviewed');

  // Create global rule from submission
  const rule = await createGlobal({
    name: submission.name,
    applyTo: submission.applyTo,
    descriptionContains: submission.descriptionContains || undefined,
    descriptionExact: submission.descriptionExact || undefined,
    amountEquals: submission.amountEquals || undefined,
    amountMin: submission.amountMin || undefined,
    amountMax: submission.amountMax || undefined,
    assignAccountName: submission.assignAccountName || undefined,
    assignContactName: submission.assignContactName || undefined,
    assignMemo: submission.assignMemo || undefined,
    autoConfirm: submission.autoConfirm || false,
  });

  await db.update(globalRuleSubmissions).set({ status: 'approved', reviewedAt: new Date() })
    .where(eq(globalRuleSubmissions.id, submissionId));

  return rule;
}

export async function rejectSubmission(submissionId: string) {
  await db.update(globalRuleSubmissions).set({ status: 'rejected', reviewedAt: new Date() })
    .where(eq(globalRuleSubmissions.id, submissionId));
}

// ─── Name Cleaning via Rules ────────────────────────────────────

/**
 * Checks tenant + global rules for a description match and returns the
 * rule's clean name (assignContactName or rule name). Returns null if
 * no rule matches, so the caller can fall back to its own cleaning.
 */
export async function cleanNameViaRules(tenantId: string, rawDescription: string): Promise<string | null> {
  const desc = rawDescription.toLowerCase();

  // 1. Tenant rules first
  const tenantRules = await db.select().from(bankRules)
    .where(and(eq(bankRules.tenantId, tenantId), eq(bankRules.isActive, true), eq(bankRules.isGlobal, false)))
    .orderBy(sql`${bankRules.priority} DESC`);

  for (const rule of tenantRules) {
    if (rule.descriptionExact && desc === rule.descriptionExact.toLowerCase()) {
      return rule.assignContactName || rule.name;
    }
    if (rule.descriptionContains && desc.includes(rule.descriptionContains.toLowerCase())) {
      return rule.assignContactName || rule.name;
    }
  }

  // 2. Global rules as fallback
  const globalRules = await db.select().from(bankRules)
    .where(and(eq(bankRules.isGlobal, true), eq(bankRules.isActive, true)))
    .orderBy(sql`${bankRules.priority} DESC`);

  for (const rule of globalRules) {
    if (rule.descriptionExact && desc === rule.descriptionExact.toLowerCase()) {
      return rule.assignContactName || rule.name;
    }
    if (rule.descriptionContains && desc.includes(rule.descriptionContains.toLowerCase())) {
      return rule.assignContactName || rule.name;
    }
  }

  return null;
}
