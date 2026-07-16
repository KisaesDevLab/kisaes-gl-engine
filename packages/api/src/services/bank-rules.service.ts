// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankRules, accounts } from '../db/schema/index.js';
// 3-tier rules plan, Phase 4 — vendor find-or-create lives in
// rule-symbol-resolution.service.ts now so the legacy and the
// conditional-rules pipeline use ONE implementation.
import { findOrCreateContact } from './rule-symbol-resolution.service.js';

// ─── Bank-rule firing engine ────────────────────────────────────
//
// The authoring UI + CRUD/global-submission API for legacy bank rules
// has been retired in favour of Conditional Rules (Practice → Rules).
// What remains here is the *firing* engine: evaluateRules() and
// cleanNameViaRules() are still called by bank-feed.service.ts on every
// import so existing rows in the `bank_rules` table keep categorizing
// and cleaning transactions. The tables and migration tooling are kept
// (additive-only DB policy); only the authoring surface is gone.

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

// Resolve a GLOBAL rule's target account into THIS tenant's chart. A rule's
// account UUID belongs to the origin tenant and is meaningless here, so we key
// on the account NAME the rule stored — but prefer the STABLE cross-tenant keys
// first: an exact account NUMBER or system_tag match (both survive a firm
// renaming an account) wins outright over fuzzy-name scoring.
async function fuzzyMatchAccount(tenantId: string, target: string): Promise<string | null> {
  const needle = target.trim().toLowerCase();
  if (!needle) return null;
  const allAccounts = await db
    .select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber, systemTag: accounts.systemTag })
    .from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.isActive, true)));

  // Exact match on a stable key → definitive.
  for (const acct of allAccounts) {
    if (acct.accountNumber && acct.accountNumber.toLowerCase() === needle) return acct.id;
    if (acct.systemTag && acct.systemTag.toLowerCase() === needle) return acct.id;
  }

  // Otherwise best fuzzy name score (threshold 0.5).
  let bestId: string | null = null;
  let bestScore = 0;
  for (const acct of allAccounts) {
    const score = fuzzyScore(target, acct.name);
    if (score > bestScore) { bestScore = score; bestId = acct.id; }
  }
  return bestScore >= 0.5 ? bestId : null;
}


// ─── Rule Evaluation ────────────────────────────────────────────

// Minimal contract — only the fields evaluateRules actually reads.
// Both tenant `bankRules` rows and the older global-firm shape match
// these, so widening past this would be premature coupling.
interface RuleCondition {
  applyTo: string;
  bankAccountId?: string | null;
  descriptionContains?: string | null;
  descriptionExact?: string | null;
  amountEquals?: string | null;
  amountMin?: string | null;
  amountMax?: string | null;
}

function matchesConditions(rule: RuleCondition, desc: string, direction: string, absAmount: number, bankAccountId?: string): boolean {
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
      // ADR 0XY §6 — carry the rule's assigned tag into the
      // categorization result so the bank feed service can stamp it
      // onto the created transaction's journal lines.
      assignTagId: rule.assignTagId,
      autoConfirm: rule.autoConfirm,
    };
  }

  // 2. Check global rules as fallback
  const globalRules = await db.select().from(bankRules)
    .where(and(eq(bankRules.isGlobal, true), eq(bankRules.isActive, true)))
    .orderBy(sql`${bankRules.priority} DESC`);

  for (const rule of globalRules) {
    if (!matchesConditions(rule, desc, direction, absAmount, feedItem.bankConnectionAccountId)) continue;

    // Resolve the target account into THIS tenant's COA. Prefer the stored
    // name; if the rule carried ONLY the origin tenant's account UUID (which is
    // meaningless in another tenant and would otherwise make the rule silently
    // assign nothing), recover a portable key from that UUID — the account's
    // number (best) or name — since account ids are globally unique.
    let accountId: string | null = null;
    let target: string | null = rule.assignAccountName;
    if (!target && rule.assignAccountId) {
      const [origin] = await db
        .select({ name: accounts.name, accountNumber: accounts.accountNumber })
        .from(accounts).where(eq(accounts.id, rule.assignAccountId)).limit(1);
      target = origin?.accountNumber || origin?.name || null;
    }
    if (target) {
      accountId = await fuzzyMatchAccount(tenantId, target);
      if (!accountId) continue; // can't map the account in this tenant → skip
    } else {
      console.warn(`[bank-rules] global rule ${rule.id} has no resolvable account target — skipping`);
      continue;
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
      // Global rules do not currently carry a tag (would need to live in
      // global_rule_submissions and be approved). Return null for shape
      // consistency so callers can uniformly read assignTagId.
      assignTagId: null as string | null,
      autoConfirm: rule.autoConfirm,
    };
  }

  return { matched: false };
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
