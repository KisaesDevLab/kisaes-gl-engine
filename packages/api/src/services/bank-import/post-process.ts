// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Post-processing of a bank file import batch (U-06), set-based.
 *
 * The same stages, in the same order and with the same results, as
 * bank-feed.service runCleansingPipeline(items, { llm: false }) followed by
 * runCategorizationPipeline(items, { llm: false, autoConfirm: false }):
 *
 *   1. cleansing: check payee, tenant then global bank rules, the pre-AI
 *      layers (rule suggestion, payee history, trusted categorization
 *      history), else the regex cleaner;
 *   2. conditional rules (staged, fires recorded);
 *   3. legacy bank rules (attributed; a rule's account is staged as a
 *      suggestion, never posted);
 *   4. potential-match detection;
 *   5. the classification state row.
 *
 * Every item depends only on itself and on data the stages do not write,
 * so the batch runs in chunks of POST_CHUNK.size items: rules, thresholds
 * and accounts are loaded once per run; each chunk loads its items, history
 * rows and match sources with one query each, evaluates in memory and
 * writes in one transaction (one UPDATE … FROM jsonb_to_recordset for the
 * items, one INSERT … ON CONFLICT for the state rows, the rule fires and
 * rule counters in bulk, and the batch's progress). Nothing posts and
 * nothing calls AI.
 *
 * Between chunks the run stops when the batch has a cancel request (an
 * undo while preparing; import-batch.service undoBatch).
 *
 * The per-row pipelines stay in bank-feed.service: the other import paths
 * (Plaid sync, /feed/import, statements) and MyBooks Online use them, and
 * post-process.test.ts compares the two on a mixed fixture. The pure parts
 * (rule matching, action aggregation, match scoring, bucket assignment)
 * are shared, so the two cannot drift.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Action, ConditionalRule, MatchCandidate, RuleEvaluationResult } from '@kis-books/shared';
import { db } from '../../db/index.js';
import {
  accounts, bankConnections, bankFeedItems, bankImportBatches, bankRules, conditionalRuleAudit, conditionalRules, contacts,
  recurringSchedules, transactionClassificationState, transactions,
} from '../../db/schema/index.js';
import { cleanBankDescription } from '../../utils/bank-name-cleaner.js';
import * as bankRulesService from '../bank-rules.service.js';
import * as conditionalApply from '../conditional-rules-apply.service.js';
import * as conditionalEngine from '../conditional-rules-engine.service.js';
import * as symbolResolution from '../rule-symbol-resolution.service.js';
import { historyKeysFor, isTrustedHistory } from '../ai-categorization.service.js';
import { suggestAccountFromPayeeHistory } from '../categorization-ai.service.js';
import { applyCleanseContactName } from '../bank-feed.service.js';
import * as potentialMatch from '../potential-match.service.js';
import * as classification from '../practice-classification.service.js';
import { getThresholds } from '../practice-thresholds.service.js';
import { findSystemAccountId, SUSPENSE_TAG } from '../system-accounts.service.js';
import { Decimal } from './keys.js';

/** Items per chunk; a test may lower it. */
export const POST_CHUNK = { size: 1000 };

type Item = typeof bankFeedItems.$inferSelect;
type LegacyRule = typeof bankRules.$inferSelect;

interface RunContext {
  tenantId: string;
  legacy: bankRulesService.LegacyRuleSet;
  ruleSet: conditionalApply.RuleSet | null;
  resolveCaches: symbolResolution.ResolveCaches;
  thresholds: Awaited<ReturnType<typeof getThresholds>>;
  suspenseId: string | null;
  connectionAccount: Map<string, string | null>;
  activeAccounts?: bankRulesService.AccountForMatch[];
  originTarget: Map<string, string | null>;
  contactByName: Map<string, string | null>;
}

/** Whether an undo asked this batch to stop (checked between chunks). */
async function cancelRequested(tenantId: string, batchId: string): Promise<boolean> {
  const [b] = await db.select({ at: bankImportBatches.cancelRequestedAt, undone: bankImportBatches.undoneAt })
    .from(bankImportBatches)
    .where(and(eq(bankImportBatches.tenantId, tenantId), eq(bankImportBatches.id, batchId)));
  return !b || b.at !== null || b.undone !== null;
}

/**
 * Post-processes the batch's items. Records `total_rows` first and adds
 * each chunk to `processed_rows` in the chunk's transaction. Returns
 * 'cancelled' when a cancel request stopped it between chunks.
 */
export async function postProcessBatch(tenantId: string, batchId: string): Promise<'done' | 'cancelled'> {
  const ids = (await db.select({ id: bankFeedItems.id }).from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.importBatchId, batchId)))
    .orderBy(bankFeedItems.sourceLine, bankFeedItems.id)).map((r) => r.id);
  await db.update(bankImportBatches).set({ totalRows: ids.length, processedRows: 0 })
    .where(and(eq(bankImportBatches.tenantId, tenantId), eq(bankImportBatches.id, batchId)));
  if (ids.length === 0) return 'done';

  const ctx = await loadRunContext(tenantId);
  for (let s = 0; s < ids.length; s += POST_CHUNK.size) {
    if (await cancelRequested(tenantId, batchId)) return 'cancelled';
    await processChunk(ctx, batchId, ids.slice(s, s + POST_CHUNK.size));
  }
  return 'done';
}

async function loadRunContext(tenantId: string): Promise<RunContext> {
  let ruleSet: conditionalApply.RuleSet | null = null;
  try {
    // runRulesStages passes no user: tier-1 personal rules are not prioritized.
    ruleSet = await conditionalApply.loadRuleSet(tenantId, null);
  } catch (err) {
    // As applyForFeedItem failing per item: the conditional stage is skipped.
    console.warn('[import-post] conditional rules could not be loaded:', err instanceof Error ? err.message : String(err));
  }
  return {
    tenantId,
    legacy: await bankRulesService.loadLegacyRules(tenantId),
    ruleSet,
    resolveCaches: symbolResolution.newCaches(),
    thresholds: await getThresholds(tenantId),
    suspenseId: await findSystemAccountId(tenantId, SUSPENSE_TAG),
    connectionAccount: new Map(),
    originTarget: new Map(),
    contactByName: new Map(),
  };
}

// ─── One chunk ───────────────────────────────────────────────────────

/** The item columns the stages may change, written back once per chunk. */
const WRITABLE = ['description', 'suggestedAccountId', 'suggestedContactId', 'suggestedTagId', 'matchType', 'confidenceScore',
  'skipAi', 'splitsConfig'] as const;
type Writable = (typeof WRITABLE)[number];

interface Fire { ruleId: string; itemId: string; actions: Action[]; tier: string; firmId: string | null }

async function processChunk(ctx: RunContext, batchId: string, ids: string[]): Promise<void> {
  const { tenantId } = ctx;
  const loaded = await db.select().from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), inArray(bankFeedItems.id, ids)));
  const byId = new Map(loaded.map((i) => [i.id, i]));
  const items = ids.map((id) => byId.get(id)).filter((i): i is Item => i !== undefined);
  const dirty = new Map<string, Set<Writable>>();
  const patch = (item: Item, values: Partial<Pick<Item, Writable>>) => {
    const d = dirty.get(item.id) ?? new Set<Writable>();
    for (const [k, v] of Object.entries(values) as Array<[Writable, unknown]>) {
      if (v === undefined) continue;
      (item as Record<string, unknown>)[k] = v;
      d.add(k);
    }
    dirty.set(item.id, d);
  };

  await cleanse(ctx, items, patch);

  // Stage 1: conditional rules (pending items).
  const ruleFired = new Map<string, string | null>();
  const shortCircuited = new Set<string>();
  const fires: Fire[] = [];
  await connectionAccounts(ctx, items);
  for (const item of items) {
    if (item.status !== 'pending' || !ctx.ruleSet || ctx.ruleSet.rules.length === 0) continue;
    try {
      const r = await applyConditional(ctx, ctx.ruleSet, item);
      if (!r) continue;
      patch(item, conditionalApply.stagePatch(r.aggregated));
      for (const f of r.fires) fires.push(f);
      if (r.shortCircuited) shortCircuited.add(item.id);
      if (r.fires.length > 0 && !ruleFired.has(item.id)) ruleFired.set(item.id, r.fires[0]!.ruleId);
    } catch (err) {
      console.warn(`[import-post] conditional-rules apply failed for item ${item.id}:`, err instanceof Error ? err.message : String(err));
    }
  }

  // Stage 2: legacy bank rules, staged as a suggestion only (Q-P25j).
  const ruleCounts = new Map<string, number>();
  for (const item of items) {
    if (shortCircuited.has(item.id) || item.status !== 'pending') continue;
    const r = await evaluateLegacy(ctx, item);
    if (!r) continue;
    ruleCounts.set(r.rule.id, (ruleCounts.get(r.rule.id) ?? 0) + 1);
    ruleFired.set(item.id, r.rule.id);
    if (r.accountId && !item.suggestedAccountId) {
      patch(item, {
        suggestedAccountId: r.accountId,
        ...(r.contactId && !item.suggestedContactId ? { suggestedContactId: r.contactId } : {}),
        ...(r.tagId && !item.suggestedTagId ? { suggestedTagId: r.tagId } : {}),
        matchType: 'rule',
      });
    }
  }

  // Potential matches (pending items), then the state rows (every item).
  const candidates = await findMatchesForItems(tenantId, items.filter((i) => i.status === 'pending'));
  const states = await stateRows(ctx, items, ruleFired, candidates);

  await db.transaction(async (tx) => {
    const changed = items.filter((i) => dirty.has(i.id));
    if (changed.length > 0) {
      const rows = changed.map((i) => ({
        id: i.id, description: i.description, suggested_account_id: i.suggestedAccountId, suggested_contact_id: i.suggestedContactId,
        suggested_tag_id: i.suggestedTagId, match_type: i.matchType, confidence_score: i.confidenceScore, skip_ai: i.skipAi,
        splits_config: i.splitsConfig ?? null,
      }));
      await tx.execute(sql`
        UPDATE bank_feed_items b SET description = v.description, suggested_account_id = v.suggested_account_id,
          suggested_contact_id = v.suggested_contact_id, suggested_tag_id = v.suggested_tag_id, match_type = v.match_type,
          confidence_score = v.confidence_score, skip_ai = v.skip_ai, splits_config = v.splits_config, updated_at = now()
        FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS v(id uuid, description text, suggested_account_id uuid,
          suggested_contact_id uuid, suggested_tag_id uuid, match_type text, confidence_score numeric, skip_ai boolean, splits_config jsonb)
        WHERE b.tenant_id = ${tenantId} AND b.id = v.id`);
    }
    await recordFires(tx, tenantId, fires);
    if (ruleCounts.size > 0) {
      const counts = [...ruleCounts].map(([id, n]) => ({ id, n }));
      await tx.execute(sql`
        UPDATE bank_rules r SET times_applied = COALESCE(r.times_applied, 0) + v.n, last_applied_at = now()
        FROM jsonb_to_recordset(${JSON.stringify(counts)}::jsonb) AS v(id uuid, n int) WHERE r.id = v.id`);
    }
    if (states.length > 0) {
      await tx.insert(transactionClassificationState).values(states).onConflictDoUpdate({
        target: transactionClassificationState.bankFeedItemId,
        set: {
          bucket: sql`excluded.bucket`, confidenceScore: sql`excluded.confidence_score`,
          suggestedAccountId: sql`excluded.suggested_account_id`, suggestedVendorId: sql`excluded.suggested_vendor_id`,
          matchedRuleId: sql`excluded.matched_rule_id`, reasoningBlob: sql`excluded.reasoning_blob`, modelUsed: sql`excluded.model_used`,
          updatedAt: sql`excluded.updated_at`, matchCandidates: sql`excluded.match_candidates`,
        },
      });
    }
    await tx.update(bankImportBatches).set({ processedRows: sql`${bankImportBatches.processedRows} + ${ids.length}` })
      .where(and(eq(bankImportBatches.tenantId, tenantId), eq(bankImportBatches.id, batchId)));
  });
}

// ─── Cleansing ───────────────────────────────────────────────────────

type Patch = (item: Item, values: Partial<Pick<Item, Writable>>) => void;

/** runCleansingPipeline with { llm: false }, over a chunk. */
async function cleanse(ctx: RunContext, items: Item[], patch: Patch): Promise<void> {
  const { tenantId } = ctx;
  const names = new Map<string, string | null>();
  const needHistory: Item[] = [];
  for (const item of items) {
    const raw = item.originalDescription || item.description || '';
    let name: string | null = item.payeeNameOnCheck || null;
    if (!name) name = bankRulesService.cleanNameFromRules(ctx.legacy, raw);
    names.set(item.id, name);
    if (!name) needHistory.push(item);
  }

  // resolvePreAiLayers for the rows still without a name.
  const keys = needHistory.map((i) => historyKeysFor(i));
  const wanted = [...new Set(keys.flatMap((k) => (k.readable ? [k.currentKey, k.legacyKey].filter(Boolean) : [])))];
  const history = await historyByPattern(tenantId, wanted);
  const hits = new Map<string, { accountId: string; contactId: string | null }>();
  for (let n = 0; n < needHistory.length; n++) {
    const item = needHistory[n]!;
    try {
      // Layer 1: an existing high-confidence suggestion (no name).
      if (item.suggestedAccountId && item.confidenceScore && parseFloat(item.confidenceScore) >= 0.9) continue;
      // Layer 2a: payee history for a check payee or a contact (no name).
      if (item.payeeNameOnCheck || item.suggestedContactId) {
        const byPayee = await suggestAccountFromPayeeHistory(tenantId, {
          contactId: item.suggestedContactId ?? null, payeeName: item.payeeNameOnCheck ?? null, companyId: item.companyId ?? null,
        });
        if (byPayee) {
          patch(item, { suggestedAccountId: byPayee.accountId, confidenceScore: byPayee.confidence.toFixed(2), matchType: 'history' });
          continue;
        }
      }
      // Layer 2: trusted categorization history (current key, else the legacy key).
      const k = keys[n]!;
      if (!k.readable) continue;
      const row = (k.currentKey ? history.get(k.currentKey)?.[0] : undefined)
        ?? (k.legacyKey && k.legacyKey !== k.currentKey ? history.get(k.legacyKey)?.[0] : undefined);
      if (row && isTrustedHistory(row)) {
        patch(item, { suggestedAccountId: row.accountId, suggestedContactId: row.contactId, confidenceScore: '0.95', matchType: 'history' });
        hits.set(item.id, { accountId: row.accountId, contactId: row.contactId });
      }
    } catch {
      // resolvePreAiLayers(...).catch(() => null): the regex cleaner below.
    }
  }
  const contactIds = [...new Set([...hits.values()].map((h) => h.contactId).filter((c): c is string => c !== null))];
  const contactNames = new Map<string, string>();
  if (contactIds.length > 0) {
    const rows = await db.select({ id: contacts.id, displayName: contacts.displayName }).from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, contactIds)));
    for (const c of rows) contactNames.set(c.id, c.displayName);
  }
  for (const [itemId, h] of hits) {
    const contactName = h.contactId ? contactNames.get(h.contactId) || null : null;
    if (!contactName) continue;
    const applied = applyCleanseContactName(contactName, h.contactId);
    if (applied) names.set(itemId, applied);
  }

  for (const item of items) {
    const raw = item.originalDescription || item.description || '';
    const name = names.get(item.id) || cleanBankDescription(raw);
    if (name && name !== item.description) patch(item, { description: name });
  }
}

/** categorization_history rows by pattern, in the order a findFirst would see them. */
async function historyByPattern(tenantId: string, patterns: string[]) {
  const out = new Map<string, Array<{ accountId: string; contactId: string | null; timesConfirmed: number | null; timesOverridden: number | null }>>();
  if (patterns.length === 0) return out;
  const r = await db.execute(sql`
    SELECT payee_pattern, account_id, contact_id, times_confirmed, times_overridden FROM categorization_history
    WHERE tenant_id = ${tenantId} AND payee_pattern IN (SELECT jsonb_array_elements_text(${JSON.stringify(patterns)}::jsonb))
    ORDER BY ctid`);
  for (const row of r.rows as Array<{ payee_pattern: string; account_id: string; contact_id: string | null; times_confirmed: number | null; times_overridden: number | null }>) {
    const list = out.get(row.payee_pattern) ?? [];
    list.push({ accountId: row.account_id, contactId: row.contact_id, timesConfirmed: row.times_confirmed, timesOverridden: row.times_overridden });
    out.set(row.payee_pattern, list);
  }
  return out;
}

// ─── Rules ───────────────────────────────────────────────────────────

async function connectionAccounts(ctx: RunContext, items: Item[]): Promise<void> {
  const missing = [...new Set(items.map((i) => i.bankConnectionId))].filter((c) => !ctx.connectionAccount.has(c));
  if (missing.length === 0) return;
  const rows = await db.select({ id: bankConnections.id, accountId: bankConnections.accountId }).from(bankConnections)
    .where(and(eq(bankConnections.tenantId, ctx.tenantId), inArray(bankConnections.id, missing)));
  for (const c of missing) ctx.connectionAccount.set(c, rows.find((r) => r.id === c)?.accountId ?? null);
}

/** applyForFeedItem without its writes: what to stage and which fires to record. */
async function applyConditional(ctx: RunContext, ruleSet: conditionalApply.RuleSet, item: Item) {
  const { rules, tiered } = ruleSet;
  const matches = conditionalEngine.evaluateRules(rules, conditionalEngine.contextFromFeedItem({
    description: item.description, originalDescription: item.originalDescription, amount: item.amount, feedDate: item.feedDate,
    bankConnectionAccountId: ctx.connectionAccount.get(item.bankConnectionId) ?? item.bankConnectionId,
    payeeNameOnCheck: item.payeeNameOnCheck,
  }));
  if (matches.length === 0) return null;
  const ruleById = new Map<string, ConditionalRule>(rules.map((r) => [r.id, r]));
  const fires: Fire[] = [];
  let aggregated: Action[];
  if (!tiered) {
    aggregated = conditionalApply.aggregateActions(matches.flatMap((m) => m.appliedActions));
    for (const m of matches) {
      if (m.appliedActions.length > 0) fires.push({ ruleId: m.ruleId, itemId: item.id, actions: m.appliedActions, tier: 'tenant_user', firmId: null });
    }
  } else {
    const resolved: RuleEvaluationResult[] = [];
    for (const m of matches) {
      const rule = ruleById.get(m.ruleId);
      if (!rule) continue;
      resolved.push({ ...m, appliedActions: await symbolResolution.resolveActionsForTenant(ctx.tenantId, m.appliedActions, { scope: rule.scope, caches: ctx.resolveCaches }) });
    }
    aggregated = conditionalApply.aggregateActionsTiered(resolved, ruleById);
    for (const m of resolved) {
      const rule = ruleById.get(m.ruleId);
      if (m.appliedActions.length === 0 || !rule) continue;
      fires.push({ ruleId: m.ruleId, itemId: item.id, actions: m.appliedActions, tier: rule.scope, firmId: rule.ownerFirmId ?? null });
    }
  }
  const last = ruleById.get(matches[matches.length - 1]!.ruleId);
  return { aggregated, fires, shortCircuited: !last?.continueAfterMatch };
}

/** recordFire in bulk: refresh an existing fire of (rule, item), else insert. */
async function recordFires(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], tenantId: string, fires: Fire[]): Promise<void> {
  if (fires.length === 0) return;
  const existing = await tx.select({ id: conditionalRuleAudit.id, ruleId: conditionalRuleAudit.ruleId, itemId: conditionalRuleAudit.bankFeedItemId })
    .from(conditionalRuleAudit)
    .where(and(eq(conditionalRuleAudit.tenantId, tenantId), inArray(conditionalRuleAudit.bankFeedItemId, [...new Set(fires.map((f) => f.itemId))])));
  const found = new Map(existing.map((e) => [`${e.ruleId}|${e.itemId}`, e.id]));
  const fresh: typeof conditionalRuleAudit.$inferInsert[] = [];
  for (const f of fires) {
    const id = found.get(`${f.ruleId}|${f.itemId}`);
    if (id) {
      await tx.update(conditionalRuleAudit).set({
        actionsApplied: f.actions, matchedAt: new Date(), effectiveTier: f.tier as never, effectiveFirmId: f.firmId ?? undefined,
      }).where(eq(conditionalRuleAudit.id, id));
    } else {
      fresh.push({ tenantId, ruleId: f.ruleId, bankFeedItemId: f.itemId, transactionId: null, actionsApplied: f.actions,
        effectiveTier: f.tier as never, effectiveFirmId: f.firmId });
    }
  }
  if (fresh.length > 0) await tx.insert(conditionalRuleAudit).values(fresh);
}

/** evaluateRules (bank-rules.service) against the rules loaded once; null when none matches. */
async function evaluateLegacy(ctx: RunContext, item: Item): Promise<{ rule: LegacyRule; accountId: string | null; contactId: string | null; tagId: string | null } | null> {
  const description = item.payeeNameOnCheck ? `${item.description ?? ''} ${item.payeeNameOnCheck}`.trim() : item.description;
  const amount = parseFloat(item.amount);
  const direction = amount < 0 ? 'deposits' : 'expenses';
  const abs = Math.abs(amount);
  const desc = (description || '').toLowerCase();
  // runRulesStages passes no account: a rule scoped to an account never matches here.
  for (const rule of ctx.legacy.tenant) {
    if (!bankRulesService.matchesConditions(rule, desc, direction, abs, undefined)) continue;
    return { rule, accountId: rule.assignAccountId, contactId: rule.assignContactId, tagId: rule.assignTagId };
  }
  for (const rule of ctx.legacy.global) {
    if (!bankRulesService.matchesConditions(rule, desc, direction, abs, undefined)) continue;
    let target: string | null = rule.assignAccountName;
    if (!target && rule.assignAccountId) {
      if (!ctx.originTarget.has(rule.id)) {
        const [origin] = await db.select({ name: accounts.name, accountNumber: accounts.accountNumber })
          .from(accounts).where(eq(accounts.id, rule.assignAccountId)).limit(1);
        ctx.originTarget.set(rule.id, origin?.accountNumber || origin?.name || null);
      }
      target = ctx.originTarget.get(rule.id) ?? null;
    }
    if (!target) {
      console.warn(`[bank-rules] global rule ${rule.id} has no resolvable account target — skipping`);
      continue;
    }
    ctx.activeAccounts ??= await bankRulesService.activeAccountsForMatch(ctx.tenantId);
    const accountId = bankRulesService.pickAccountForTarget(ctx.activeAccounts, target);
    if (!accountId) continue;
    let contactId: string | null = null;
    if (rule.assignContactName) {
      const key = rule.assignContactName.trim().toLowerCase();
      if (!ctx.contactByName.has(key)) ctx.contactByName.set(key, await symbolResolution.findOrCreateContact(ctx.tenantId, rule.assignContactName));
      contactId = ctx.contactByName.get(key) ?? null;
    }
    return { rule, accountId, contactId, tagId: null };
  }
  return null;
}

// ─── Potential matches ───────────────────────────────────────────────

/**
 * findMatches for many items: each source is read once for the chunk's
 * date span, then every item gets the rows its own query would return
 * (same filters and windows, the same per-item limits, in date order) and
 * the shared scorers rank them.
 */
async function findMatchesForItems(tenantId: string, items: Item[]): Promise<Map<string, MatchCandidate[]>> {
  const out = new Map<string, MatchCandidate[]>();
  if (items.length === 0) return out;
  const inputs = items.map((i): potentialMatch.FeedItemForMatching => ({
    id: i.id, tenantId: i.tenantId, companyId: i.companyId, amount: i.amount, feedDate: i.feedDate,
    description: i.description, originalDescription: i.originalDescription, bankConnectionId: i.bankConnectionId,
  }));
  const span = (days: number) => {
    const w = inputs.map((i) => potentialMatch.dateWindow(i.feedDate, days));
    return { min: w.reduce((m, x) => (x.min < m ? x.min : m), w[0]!.min), max: w.reduce((m, x) => (x.max > m ? x.max : m), w[0]!.max) };
  };
  const s14 = span(14);
  const s7 = span(7);
  const s3 = span(3);

  const open = await db.select({ txn: transactions, contactName: contacts.displayName }).from(transactions)
    .leftJoin(contacts, eq(contacts.id, transactions.contactId))
    .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.txnType, ['invoice', 'bill']), sql`${transactions.balanceDue} > 0`,
      sql`${transactions.txnDate} BETWEEN ${s14.min} AND ${s14.max}`))
    .orderBy(transactions.txnDate, transactions.id);
  const jeTotals = [...new Set(inputs.map((i) => parseFloat(i.amount)).filter((a) => a !== 0).map((a) => Math.abs(a).toFixed(4)))];
  const jes = jeTotals.length === 0 ? [] : await db.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'journal_entry'),
      sql`${transactions.txnDate} BETWEEN ${s7.min} AND ${s7.max}`,
      sql`${transactions.total} IN (SELECT x::numeric FROM jsonb_array_elements_text(${JSON.stringify(jeTotals)}::jsonb) AS x)`))
    .orderBy(transactions.txnDate, transactions.id);
  const targets = [...new Set(inputs.map((i) => parseFloat(i.amount)).filter((a) => a !== 0).map((a) => (-a).toFixed(4)))];
  const conns = [...new Set(inputs.map((i) => i.bankConnectionId))];
  const others = targets.length === 0 ? [] : await db.select().from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId),
      conns.length === 1 ? sql`${bankFeedItems.bankConnectionId} <> ${conns[0]}` : sql`true`,
      sql`${bankFeedItems.feedDate} BETWEEN ${s3.min} AND ${s3.max}`,
      sql`${bankFeedItems.amount} IN (SELECT x::numeric FROM jsonb_array_elements_text(${JSON.stringify(targets)}::jsonb) AS x)`))
    .orderBy(bankFeedItems.feedDate, bankFeedItems.id);
  const recurring = await db.select({ schedule: recurringSchedules, txn: transactions, contactName: contacts.displayName })
    .from(recurringSchedules)
    .innerJoin(transactions, eq(transactions.id, recurringSchedules.templateTransactionId))
    .leftJoin(contacts, eq(contacts.id, transactions.contactId))
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.isActive, true),
      sql`${recurringSchedules.nextOccurrence} BETWEEN ${s7.min} AND ${s7.max}`, sql`${transactions.total} IS NOT NULL`))
    .orderBy(recurringSchedules.nextOccurrence, recurringSchedules.id);

  const within = (d: string | null, w: { min: string; max: string }) => d !== null && d >= w.min && d <= w.max;
  for (const item of inputs) {
    try {
      const feedAmount = parseFloat(item.amount);
      const w14 = potentialMatch.dateWindow(item.feedDate, 14);
      const w7 = potentialMatch.dateWindow(item.feedDate, 7);
      const w3 = potentialMatch.dateWindow(item.feedDate, 3);
      const all: MatchCandidate[] = [];
      if (!(feedAmount > 0)) {
        all.push(...potentialMatch.scoreOpenInvoices(item, open.filter((r) => r.txn.txnType === 'invoice' && within(r.txn.txnDate, w14)).slice(0, 200)));
      }
      if (!(feedAmount < 0)) {
        all.push(...potentialMatch.scoreOpenBills(item, open.filter((r) => r.txn.txnType === 'bill' && within(r.txn.txnDate, w14)).slice(0, 200)));
      }
      if (feedAmount !== 0) {
        const total = Math.abs(feedAmount).toFixed(4);
        all.push(...potentialMatch.scoreUnpostedJEs(item, jes.filter((r) => r.total !== null && new Decimal(r.total).eq(total) && within(r.txnDate, w7)).slice(0, 50)));
        const target = (-feedAmount).toFixed(4);
        all.push(...potentialMatch.scoreTransfers(item, others.filter((r) => r.id !== item.id && r.bankConnectionId !== item.bankConnectionId
          && new Decimal(r.amount).eq(target) && within(r.feedDate, w3)).slice(0, 20)));
        all.push(...potentialMatch.scoreRecurring(item, recurring.filter((r) => within(r.schedule.nextOccurrence, w7)).slice(0, 50)));
      }
      out.set(item.id, potentialMatch.rankCandidates(all));
    } catch (err) {
      console.warn(`[import-post] potential-match find failed for item ${item.id}:`, err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

// ─── Classification state ────────────────────────────────────────────

/**
 * upsertStateForFeedItem's values for every item. An item attributed to a
 * legacy bank rule gets no row: matched_rule_id references
 * conditional_rules, so the per-row upsert fails on it and only logs
 * (kept as is; see the PR notes).
 */
async function stateRows(
  ctx: RunContext, items: Item[], ruleFired: Map<string, string | null>, candidates: Map<string, MatchCandidate[]>,
): Promise<Array<typeof transactionClassificationState.$inferInsert>> {
  const { tenantId } = ctx;
  const patterns = [...new Set(items.map((i) => classification.signalPattern(i)))];
  const history = await db.execute(sql`
    SELECT payee_pattern, account_id, times_confirmed, times_overridden FROM categorization_history
    WHERE tenant_id = ${tenantId} AND payee_pattern IN (SELECT jsonb_array_elements_text(${JSON.stringify(patterns)}::jsonb))`);
  const byPattern = new Map<string, Array<{ accountId: string; timesConfirmed: number | null; timesOverridden: number | null }>>();
  for (const r of history.rows as Array<{ payee_pattern: string; account_id: string; times_confirmed: number | null; times_overridden: number | null }>) {
    const list = byPattern.get(r.payee_pattern) ?? [];
    list.push({ accountId: r.account_id, timesConfirmed: r.times_confirmed, timesOverridden: r.times_overridden });
    byPattern.set(r.payee_pattern, list);
  }
  const ruleIds = [...new Set([...ruleFired.values()].filter((r): r is string => r !== null))];
  const conditionalIds = new Set(ruleIds.length === 0 ? [] : (await db.select({ id: conditionalRules.id }).from(conditionalRules)
    .where(inArray(conditionalRules.id, ruleIds))).map((r) => r.id));

  const out: Array<typeof transactionClassificationState.$inferInsert> = [];
  const now = new Date();
  let skipped = 0;
  for (const item of items) {
    const matchedRuleId = ruleFired.get(item.id) ?? null;
    if (matchedRuleId !== null && !conditionalIds.has(matchedRuleId)) {
      skipped++;
      continue;
    }
    const matchCandidates = candidates.get(item.id) ?? [];
    const signals = classification.signalsFromHistory(item, byPattern.get(classification.signalPattern(item)) ?? []);
    signals.matchedRuleId = matchedRuleId;
    signals.hasPotentialMatch = matchCandidates.length > 0;
    const { bucket, confidenceScore, reasoning } = classification.bucketForItem(item, signals, ctx.thresholds, ctx.suspenseId);
    out.push({
      tenantId, companyId: item.companyId, bankFeedItemId: item.id, bucket, confidenceScore: confidenceScore.toFixed(3),
      suggestedAccountId: item.suggestedAccountId ?? null, suggestedVendorId: item.suggestedContactId ?? null,
      matchedRuleId, reasoningBlob: reasoning, modelUsed: null, updatedAt: now, matchCandidates,
    });
  }
  if (skipped > 0) console.warn(`[import-post] classification state not written for ${skipped} item(s) a legacy bank rule attributed`);
  return out;
}
