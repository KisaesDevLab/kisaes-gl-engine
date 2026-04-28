// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq } from 'drizzle-orm';
import type { Action, ConditionalRule, ConditionalRuleContext, RuleEvaluationResult } from '@kis-books/shared';
import { db } from '../db/index.js';
import { bankFeedItems } from '../db/schema/index.js';
import * as engine from './conditional-rules-engine.service.js';
import * as crudService from './conditional-rules.service.js';
import * as featureFlagsService from './feature-flags.service.js';
import * as tenantFirmAssignmentService from './tenant-firm-assignment.service.js';
import * as symbolResolution from './rule-symbol-resolution.service.js';

// Glue between the pure evaluator and the persisted feed item.
// For each rule fire, this service:
//   1. Stages the rule's actions on `bank_feed_items` (sets
//      suggested account/vendor/tag/memo/skip_ai/splits_config).
//   2. Records a per-fire audit row.
// Returns whether ANY rule fired without `continue_after_match`,
// which the pipeline uses to decide whether to skip legacy
// bank-rule evaluation for that item.

export interface ApplyResult {
  // True when at least one rule fired AND none of the matched
  // rules had continue_after_match=false. (i.e., a "first match
  // wins" rule fired — the pipeline should skip legacy rules.)
  shortCircuitedLegacyRules: boolean;
  fires: Array<{ ruleId: string; auditId: string }>;
  // Aggregated set of action types applied — Phase 5 stats UI
  // can show what kinds of actions are firing without iterating
  // the audit rows.
  appliedActionTypes: string[];
}

export interface ApplyOptions {
  /** Caller's user id when the pipeline was triggered by an
   *  interactive session (approve / re-categorize). Null in
   *  background sync — tier-1 personal-rule prioritization
   *  inside the tenant_user tier is skipped in that case. */
  currentUserId?: string | null;
}

export async function applyForFeedItem(
  tenantId: string,
  feedItem: {
    id: string;
    description: string | null;
    originalDescription: string | null;
    amount: string;
    feedDate: string;
    bankConnectionAccountId: string;
  },
  opts: ApplyOptions = {},
): Promise<ApplyResult> {
  // 3-tier rules plan, Phase 4 — branch on RULES_TIERED_V1.
  //   - OFF: legacy path. listActiveOrderedByPriority returns
  //          tenant_user-only rules; aggregation is last-write-
  //          wins; recordFire writes effectiveTier='tenant_user'
  //          for the snapshot.
  //   - ON:  tier-aware listEvaluableRulesForTenant unions all
  //          three tiers; symbol resolver re-binds global-rule
  //          targets to the current tenant's UUIDs;
  //          aggregateActionsTiered does first-occurrence-wins
  //          across tiers (most-specific wins).
  const tieredEnabled = await featureFlagsService
    .isEnabled(tenantId, 'RULES_TIERED_V1')
    .catch(() => false);

  if (!tieredEnabled) {
    return applyLegacy(tenantId, feedItem);
  }

  return applyTiered(tenantId, feedItem, opts.currentUserId ?? null);
}

// Legacy (pre-Phase-4) path. Single-tier flat aggregation.
async function applyLegacy(
  tenantId: string,
  feedItem: {
    id: string;
    description: string | null;
    originalDescription: string | null;
    amount: string;
    feedDate: string;
    bankConnectionAccountId: string;
  },
): Promise<ApplyResult> {
  const rules = await crudService.listActiveOrderedByPriority(tenantId);
  if (rules.length === 0) {
    return { shortCircuitedLegacyRules: false, fires: [], appliedActionTypes: [] };
  }

  const ctx = engine.contextFromFeedItem(feedItem);
  const matches = engine.evaluateRules(rules, ctx);
  if (matches.length === 0) {
    return { shortCircuitedLegacyRules: false, fires: [], appliedActionTypes: [] };
  }

  const aggregated = aggregateActions(matches.flatMap((m) => m.appliedActions));
  await stageOnFeedItem(tenantId, feedItem.id, aggregated);

  const fires: ApplyResult['fires'] = [];
  for (const match of matches) {
    if (match.appliedActions.length === 0) continue;
    const auditId = await crudService.recordFire({
      tenantId,
      ruleId: match.ruleId,
      bankFeedItemId: feedItem.id,
      transactionId: null,
      actionsApplied: match.appliedActions,
      effectiveTier: 'tenant_user',
      effectiveFirmId: null,
    });
    fires.push({ ruleId: match.ruleId, auditId });
  }

  const lastMatchedRule = rules.find((r) => r.id === matches[matches.length - 1]?.ruleId);
  const shortCircuited = !lastMatchedRule?.continueAfterMatch && matches.length > 0;

  return {
    shortCircuitedLegacyRules: shortCircuited,
    fires,
    appliedActionTypes: Array.from(new Set(aggregated.map((a) => a.type))),
  };
}

// 3-tier rules plan, Phase 4 — tier-aware path. Resolves global-
// rule action targets to the current tenant's UUIDs at fire
// time so the staged categorization references real local rows.
async function applyTiered(
  tenantId: string,
  feedItem: {
    id: string;
    description: string | null;
    originalDescription: string | null;
    amount: string;
    feedDate: string;
    bankConnectionAccountId: string;
  },
  currentUserId: string | null,
): Promise<ApplyResult> {
  const assignment = await tenantFirmAssignmentService.getActiveForTenant(tenantId);
  const firmId = assignment?.firmId ?? null;

  const rules = await crudService.listEvaluableRulesForTenant(tenantId, {
    currentUserId,
    firmId,
  });
  if (rules.length === 0) {
    return { shortCircuitedLegacyRules: false, fires: [], appliedActionTypes: [] };
  }

  const ctx = engine.contextFromFeedItem(feedItem);
  const matches = engine.evaluateRules(rules, ctx);
  if (matches.length === 0) {
    return { shortCircuitedLegacyRules: false, fires: [], appliedActionTypes: [] };
  }

  // Index rules by id so we can look up ownership/scope at
  // resolve + aggregation time.
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  // Resolve action targets per match. Globals get their
  // accountId / vendorId rebound to the current tenant via the
  // symbol resolver; tenant-scoped rules pass through untouched.
  const resolvedMatches: RuleEvaluationResult[] = [];
  for (const match of matches) {
    const rule = ruleById.get(match.ruleId);
    if (!rule) continue;
    const resolved = await symbolResolution.resolveActionsForTenant(
      tenantId,
      match.appliedActions,
      { scope: rule.scope },
    );
    resolvedMatches.push({ ...match, appliedActions: resolved });
  }

  const aggregated = aggregateActionsTiered(resolvedMatches, ruleById);
  await stageOnFeedItem(tenantId, feedItem.id, aggregated);

  const fires: ApplyResult['fires'] = [];
  for (const match of resolvedMatches) {
    if (match.appliedActions.length === 0) continue;
    const rule = ruleById.get(match.ruleId);
    if (!rule) continue;
    const auditId = await crudService.recordFire({
      tenantId,
      ruleId: match.ruleId,
      bankFeedItemId: feedItem.id,
      transactionId: null,
      actionsApplied: match.appliedActions,
      effectiveTier: rule.scope,
      effectiveFirmId: rule.ownerFirmId,
    });
    fires.push({ ruleId: match.ruleId, auditId });
  }

  const lastMatchedRule = ruleById.get(matches[matches.length - 1]?.ruleId ?? '');
  const shortCircuited = !lastMatchedRule?.continueAfterMatch && matches.length > 0;

  return {
    shortCircuitedLegacyRules: shortCircuited,
    fires,
    appliedActionTypes: Array.from(new Set(aggregated.map((a) => a.type))),
  };
}

// 3-tier rules plan, Phase 4 — tier-aware aggregator. Most-
// specific tier wins on type-conflict, but within a tier today's
// last-write-wins continues. Walks each match's tier (via the
// rule lookup) and partitions actions into per-tier buckets,
// runs the legacy aggregator per-bucket, then merges the
// per-tier results with FIRST-OCCURRENCE-WINS so:
//
//   tenant_user.set_account beats tenant_firm.set_account beats
//   global_firm.set_account.
//
// `mark_for_review` from any tier propagates (the suppression of
// matchType='rule' in stageOnFeedItem hooks on `mark_for_review`
// being present anywhere in the merged list).
function aggregateActionsTiered(
  matches: RuleEvaluationResult[],
  ruleById: Map<string, ConditionalRule>,
): Action[] {
  const tier_user: Action[] = [];
  const tier_firm: Action[] = [];
  const tier_global: Action[] = [];
  for (const m of matches) {
    const rule = ruleById.get(m.ruleId);
    if (!rule) continue;
    if (rule.scope === 'tenant_user') tier_user.push(...m.appliedActions);
    else if (rule.scope === 'tenant_firm') tier_firm.push(...m.appliedActions);
    else tier_global.push(...m.appliedActions);
  }
  const buckets = [aggregateActions(tier_user), aggregateActions(tier_firm), aggregateActions(tier_global)];

  // First-occurrence wins by action type across the buckets,
  // except for cumulative flags (mark_for_review / skip_ai)
  // which propagate from any tier.
  const seen = new Set<string>();
  const out: Action[] = [];
  let markForReview = false;
  let skipAi = false;
  for (const bucket of buckets) {
    for (const a of bucket) {
      if (a.type === 'mark_for_review') {
        markForReview = true;
        continue;
      }
      if (a.type === 'skip_ai') {
        skipAi = true;
        continue;
      }
      // Splits collapse to a single "split" key — fixed and
      // percentage are mutually exclusive at the action layer.
      const key = a.type === 'split_by_percentage' || a.type === 'split_by_fixed'
        ? 'split'
        : a.type;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(a);
      }
    }
  }
  if (markForReview) out.push({ type: 'mark_for_review' });
  if (skipAi) out.push({ type: 'skip_ai' });
  return out;
}

// Last-write-wins consolidation of a flat action list. A
// stacked rule chain might produce two `set_account` actions —
// the later one wins. Splits and flow-control actions are
// passed through as-is (they don't aggregate).
function aggregateActions(actions: Action[]): Action[] {
  const out: Action[] = [];
  let setAccount: Action | undefined;
  let setVendor: Action | undefined;
  let setTag: Action | undefined;
  let setMemo: Action | undefined;
  let split: Action | undefined;
  let markForReview = false;
  let skipAi = false;

  for (const a of actions) {
    switch (a.type) {
      case 'set_account': setAccount = a; break;
      case 'set_vendor':  setVendor = a; break;
      case 'set_tag':     setTag = a; break;
      case 'set_memo':    setMemo = a; break;
      case 'split_by_percentage':
      case 'split_by_fixed':
        split = a;
        break;
      case 'mark_for_review': markForReview = true; break;
      case 'skip_ai':         skipAi = true; break;
      // set_class / set_location are deferred — engine has
      // already filtered them out, but we'd ignore them here too.
      default: break;
    }
  }

  if (setAccount) out.push(setAccount);
  if (setVendor) out.push(setVendor);
  if (setTag) out.push(setTag);
  if (setMemo) out.push(setMemo);
  if (split) out.push(split);
  if (markForReview) out.push({ type: 'mark_for_review' });
  if (skipAi) out.push({ type: 'skip_ai' });
  return out;
}

// Persists the staged action results to the feed item. Splits
// actions write a JSONB blob; the categorize-on-approve path
// reads it and posts N journal lines instead of 2.
async function stageOnFeedItem(
  tenantId: string,
  feedItemId: string,
  actions: Action[],
): Promise<void> {
  const updates: Partial<typeof bankFeedItems.$inferInsert> = {
    updatedAt: new Date(),
  };
  // First pass: detect mark_for_review so we can suppress the
  // matchType='rule' stamp from set_account. Without this, a rule
  // that combined `set_account` + `mark_for_review` would land
  // the row in the 'rule' bucket (because matchType wins in
  // assignBucket) instead of 'needs_review' as the author intended.
  const hasMarkForReview = actions.some((a) => a.type === 'mark_for_review');

  for (const a of actions) {
    switch (a.type) {
      case 'set_account':
        updates.suggestedAccountId = a.accountId;
        if (!hasMarkForReview) {
          updates.matchType = 'rule';
          updates.confidenceScore = '1.00';
        }
        break;
      case 'set_vendor':
        updates.suggestedContactId = a.vendorId;
        break;
      case 'set_tag':
        updates.suggestedTagId = a.tagId;
        break;
      case 'set_memo':
        updates.description = a.memo;
        break;
      case 'split_by_percentage':
        updates.splitsConfig = {
          kind: 'percentage',
          splits: a.splits.map((s) => ({
            accountId: s.accountId,
            percent: s.percent,
            tagId: s.tagId ?? null,
            memo: s.memo ?? null,
          })),
        };
        break;
      case 'split_by_fixed':
        updates.splitsConfig = {
          kind: 'fixed',
          splits: a.splits.map((s) => ({
            accountId: s.accountId,
            amount: s.amount,
            tagId: s.tagId ?? null,
            memo: s.memo ?? null,
          })),
        };
        break;
      case 'skip_ai':
        updates.skipAi = true;
        break;
      case 'mark_for_review':
        // Force the item out of the 'rule' bucket: clear matchType
        // and zero confidence so practice-classification's
        // assignBucket falls through to 'needs_review'. The
        // suggestedAccountId stays so the bookkeeper can see the
        // proposed code and approve / override it.
        updates.matchType = null;
        updates.confidenceScore = '0.00';
        break;
      default:
        break;
    }
  }
  await db
    .update(bankFeedItems)
    .set(updates)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));
}
