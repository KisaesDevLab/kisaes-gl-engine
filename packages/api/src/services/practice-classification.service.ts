// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type {
  BucketReceiptOcr,
  BucketRow,
  BucketSummary,
  ClassificationBucket,
  ClassificationReasoning,
  ClassificationState,
  ClassificationThresholds,
  MatchCandidate,
  VendorEnrichment,
} from '@kis-books/shared';
import { CLASSIFICATION_BUCKETS } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  accounts,
  bankFeedItems,
  bankRules,
  categorizationHistory,
  contacts,
  findings,
  transactionClassificationState,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// Inputs the pure bucket-assignment function consumes. The
// function is deliberately called `assignBucket` rather than
// `classify` so it doesn't collide with the existing AI
// categorizer's `categorize()`.
export interface AssignBucketInput {
  // Already-stored confidence from the three-layer categorizer
  // (bank_feed_items.confidence_score). In [0, 1].
  storedConfidence: number;
  // matchType from the three-layer categorizer: 'rule' | 'history'
  // | 'exact' | 'fuzzy' | 'ai' | null.
  matchType: string | null;
  // Did a legacy bank rule fire? If so, carries the rule id so the
  // upsert can stamp matched_rule_id.
  matchedRuleId: string | null;
  // Does a Bucket-1-style match exist? Populated by Phase 3; in
  // Phase 2a this is always empty/null and always interpreted as
  // "no potential match."
  hasPotentialMatch: boolean;
  // Learning-layer signals for Bucket 3/4 discrimination.
  vendorConsistency: number | null;
  isNewVendor: boolean;
  isMultiAccountHistory: boolean;
  // Raw history stats — included only for the reasoning blob.
  overrideRate: number | null;
  recurrenceCount: number | null;
}

export interface AssignBucketOutput {
  bucket: ClassificationBucket;
  confidenceScore: number;
  reasoning: ClassificationReasoning;
}

// The pure bucket-assignment function. No DB access — callers pass
// in the already-fetched signals. Centralizing the threshold logic
// here means the tenant-override mechanism works everywhere
// (backfill, real-time upsert, test fixtures) without duplicated
// comparison code.
//
// Precedence (first-match-wins):
//   1. Legacy bank rule fired           → bucket = 'rule'
//   2. Phase 3 potential match exists   → bucket = 'potential_match'
//   3. Bucket-3 High conditions met     → bucket = 'auto_high'
//   4. Bucket-3 Medium conditions met   → bucket = 'auto_medium'
//   5. Everything else                  → bucket = 'needs_review'
//
// The reasoning blob records why each decision was taken so the
// UI can render "why this bucket?" on hover without another API
// call.
export function assignBucket(
  input: AssignBucketInput,
  thresholds: ClassificationThresholds,
): AssignBucketOutput {
  const {
    storedConfidence,
    matchType,
    matchedRuleId,
    hasPotentialMatch,
    vendorConsistency,
    isNewVendor,
    isMultiAccountHistory,
  } = input;

  const adjustments: ClassificationReasoning['adjustments'] = [];

  // Rule precedence: if a bank rule fired, the bucket is 'rule'
  // regardless of confidence. Bank rules are the user's explicit
  // intent — overriding them via a confidence check would be
  // surprising.
  if (matchType === 'rule' || matchedRuleId !== null) {
    return {
      bucket: 'rule',
      confidenceScore: clamp(storedConfidence, 0, 1),
      reasoning: {
        bucket: 'rule',
        baseConfidence: storedConfidence,
        adjustments,
        finalConfidence: storedConfidence,
        vendorConsistency,
        isNewVendor,
        isMultiAccountHistory,
        matchType,
      },
    };
  }

  if (hasPotentialMatch) {
    return {
      bucket: 'potential_match',
      confidenceScore: clamp(storedConfidence, 0, 1),
      reasoning: {
        bucket: 'potential_match',
        baseConfidence: storedConfidence,
        adjustments,
        finalConfidence: storedConfidence,
        vendorConsistency,
        isNewVendor,
        isMultiAccountHistory,
        matchType,
      },
    };
  }

  // Confidence adjustments for Bucket 3/4 discrimination. These
  // do NOT overwrite the stored confidence on bank_feed_items —
  // they produce the "final" score recorded on the state row for
  // display + reasoning. Keeps legacy writers' confidence semantics
  // intact.
  let adjusted = storedConfidence;
  if (isNewVendor) {
    adjustments.push({ reason: 'new_vendor', delta: -0.15 });
    adjusted -= 0.15;
  }
  if (isMultiAccountHistory) {
    adjustments.push({ reason: 'multi_account_history', delta: -0.10 });
    adjusted -= 0.10;
  }
  adjusted = clamp(adjusted, 0, 1);

  // Bucket 4 "Needs Review" — build plan §2.2 surfaces any one of:
  //   - confidence below bucket4Floor
  //   - new vendor (even if above floor)
  //   - multi-account history (ambiguity)
  const needsReview =
    adjusted < thresholds.bucket4Floor || isNewVendor || isMultiAccountHistory;
  if (needsReview) {
    return {
      bucket: 'needs_review',
      confidenceScore: adjusted,
      reasoning: {
        bucket: 'needs_review',
        baseConfidence: storedConfidence,
        adjustments,
        finalConfidence: adjusted,
        vendorConsistency,
        isNewVendor,
        isMultiAccountHistory,
        matchType,
      },
    };
  }

  // Bucket 3 High requires BOTH the confidence floor AND the
  // vendor-consistency floor. A vendor with no history yet has
  // consistency === null, which cannot satisfy the ≥ check.
  const vcPass =
    vendorConsistency !== null &&
    vendorConsistency >= thresholds.bucket3HighVendorConsistency;
  if (adjusted >= thresholds.bucket3HighConfidence && vcPass) {
    return {
      bucket: 'auto_high',
      confidenceScore: adjusted,
      reasoning: {
        bucket: 'auto_high',
        baseConfidence: storedConfidence,
        adjustments,
        finalConfidence: adjusted,
        vendorConsistency,
        isNewVendor,
        isMultiAccountHistory,
        matchType,
      },
    };
  }

  // Bucket 3 Medium: below high but above bucket4Floor. The
  // needsReview check above already ruled out the < floor case.
  return {
    bucket: 'auto_medium',
    confidenceScore: adjusted,
    reasoning: {
      bucket: 'auto_medium',
      baseConfidence: storedConfidence,
      adjustments,
      finalConfidence: adjusted,
      vendorConsistency,
      isNewVendor,
      isMultiAccountHistory,
      matchType,
    },
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

// Gather the learning-layer signals for a bank feed item. Pure
// data-reader — no side effects, no DB writes. The result feeds
// straight into assignBucket().
export async function gatherSignals(
  tenantId: string,
  bankFeedItemId: string,
): Promise<AssignBucketInput> {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, bankFeedItemId)),
  });
  if (!item) throw AppError.notFound('Bank feed item not found');

  const storedConfidence = item.confidenceScore ? parseFloat(item.confidenceScore) : 0;
  const matchType = item.matchType ?? null;
  const description = (item.originalDescription || item.description || '').toLowerCase().trim();

  // Override rate, recurrence, multi-account history all come from
  // the `categorization_history` learning layer. A payee with
  // exactly one row in history that points to one account has
  // `isMultiAccountHistory = false`; two+ rows for the same
  // payee pattern pointing to different accounts is multi-account.
  const historyRows = await db
    .select({
      accountId: categorizationHistory.accountId,
      timesConfirmed: categorizationHistory.timesConfirmed,
      timesOverridden: categorizationHistory.timesOverridden,
    })
    .from(categorizationHistory)
    .where(
      and(
        eq(categorizationHistory.tenantId, tenantId),
        eq(categorizationHistory.payeePattern, description),
      ),
    );

  const totalConfirmed = historyRows.reduce((s, r) => s + (r.timesConfirmed ?? 0), 0);
  const totalOverridden = historyRows.reduce((s, r) => s + (r.timesOverridden ?? 0), 0);
  const isNewVendor = historyRows.length === 0;
  const distinctAccounts = new Set(historyRows.map((r) => r.accountId)).size;
  const isMultiAccountHistory = distinctAccounts > 1;

  const overrideRate =
    totalConfirmed + totalOverridden > 0
      ? totalOverridden / (totalConfirmed + totalOverridden)
      : null;

  // Vendor consistency = confirmation rate of the dominant account.
  // In the single-account case it's simply timesConfirmed /
  // (timesConfirmed + timesOverridden). In the multi-account case
  // we take the max across rows as the "how consistent is the
  // dominant code?" signal — still useful but the
  // isMultiAccountHistory flag drops these into Bucket 4 anyway.
  const vendorConsistency = isNewVendor
    ? null
    : Math.max(
        ...historyRows.map((r) => {
          const t = (r.timesConfirmed ?? 0) + (r.timesOverridden ?? 0);
          return t > 0 ? (r.timesConfirmed ?? 0) / t : 0;
        }),
      );

  // hasPotentialMatch is derived from any candidates already
  // persisted on the state row by Phase 3's matcher. The upsert
  // caller can override this when fresher candidates are about
  // to be written (avoids reading our own pending write).
  const [existingState] = await db
    .select({ matchCandidates: transactionClassificationState.matchCandidates })
    .from(transactionClassificationState)
    .where(
      and(
        eq(transactionClassificationState.tenantId, tenantId),
        eq(transactionClassificationState.bankFeedItemId, bankFeedItemId),
      ),
    )
    .limit(1);
  const persistedCandidates = (existingState?.matchCandidates as MatchCandidate[] | null) ?? null;
  const hasPotentialMatch =
    Array.isArray(persistedCandidates) && persistedCandidates.length > 0;

  return {
    storedConfidence,
    matchType,
    matchedRuleId: null, // filled in by the upsert caller if a rule fired
    hasPotentialMatch,
    vendorConsistency,
    isNewVendor,
    isMultiAccountHistory,
    overrideRate,
    recurrenceCount: totalConfirmed,
  };
}

// Upsert a state row for a bank feed item. Computes the bucket
// fresh from signals + thresholds. Safe to re-run — the unique
// index on bank_feed_item_id guarantees one row per item, and
// onConflictDoUpdate refreshes the computed columns.
//
// If `matchCandidates` is provided, those are persisted and used
// to derive `hasPotentialMatch` for bucket assignment (overriding
// whatever persisted candidates `gatherSignals` would otherwise
// see). Pass `[]` to explicitly clear candidates.
export async function upsertStateForFeedItem(
  tenantId: string,
  bankFeedItemId: string,
  opts?: {
    matchedRuleId?: string | null;
    modelUsed?: string | null;
    matchCandidates?: MatchCandidate[] | null;
  },
): Promise<ClassificationState> {
  const { getThresholds } = await import('./practice-thresholds.service.js');
  const thresholds = await getThresholds(tenantId);

  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, bankFeedItemId)),
  });
  if (!item) throw AppError.notFound('Bank feed item not found');

  const signals = await gatherSignals(tenantId, bankFeedItemId);
  signals.matchedRuleId = opts?.matchedRuleId ?? null;
  // If the caller is supplying fresh candidates, override the
  // gathered hasPotentialMatch so bucket assignment uses the new
  // candidates instead of the (about-to-be-overwritten) persisted
  // ones.
  if (opts?.matchCandidates !== undefined) {
    signals.hasPotentialMatch = (opts.matchCandidates ?? []).length > 0;
  }

  const { bucket, confidenceScore, reasoning } = assignBucket(signals, thresholds);

  const values: typeof transactionClassificationState.$inferInsert = {
    tenantId,
    companyId: item.companyId,
    bankFeedItemId,
    bucket,
    confidenceScore: confidenceScore.toFixed(3),
    suggestedAccountId: item.suggestedAccountId ?? null,
    suggestedVendorId: item.suggestedContactId ?? null,
    matchedRuleId: opts?.matchedRuleId ?? null,
    reasoningBlob: reasoning,
    modelUsed: opts?.modelUsed ?? null,
    updatedAt: new Date(),
  };
  // Only set matchCandidates when explicitly provided — `undefined`
  // means "leave whatever's there alone" (the upsert path covers
  // both an existing row + a new row).
  if (opts?.matchCandidates !== undefined) {
    values.matchCandidates = opts.matchCandidates;
  }

  const updateSet: Record<string, unknown> = {
    bucket: values.bucket,
    confidenceScore: values.confidenceScore,
    suggestedAccountId: values.suggestedAccountId,
    suggestedVendorId: values.suggestedVendorId,
    matchedRuleId: values.matchedRuleId,
    reasoningBlob: values.reasoningBlob,
    modelUsed: values.modelUsed,
    updatedAt: values.updatedAt,
  };
  if (opts?.matchCandidates !== undefined) {
    updateSet['matchCandidates'] = opts.matchCandidates;
  }

  const [row] = await db
    .insert(transactionClassificationState)
    .values(values)
    .onConflictDoUpdate({
      target: transactionClassificationState.bankFeedItemId,
      set: updateSet,
    })
    .returning();
  return mapRowToState(row!);
}

// Mark the transaction_id on the state row once the bank feed
// item has been approved into a posted transaction. Called from
// the bank-feed approval path.
export async function stampTransactionId(
  tenantId: string,
  bankFeedItemId: string,
  transactionId: string,
): Promise<void> {
  await db
    .update(transactionClassificationState)
    .set({ transactionId, updatedAt: new Date() })
    .where(
      and(
        eq(transactionClassificationState.tenantId, tenantId),
        eq(transactionClassificationState.bankFeedItemId, bankFeedItemId),
      ),
    );
}

// Bucket summary for the Close Review header. Counts the state
// rows per bucket within the period window. Already-approved
// rows (transaction_id NOT NULL) are excluded so the per-bucket
// counts reflect remaining triage work, not historical totals.
// `totalApproved` reports how many rows in the period have been
// posted so the page-level progress bar has a real denominator.
export async function summarizeForPeriod(
  tenantId: string,
  companyId: string | null,
  periodStart: string,
  periodEnd: string,
): Promise<BucketSummary> {
  const base = and(
    eq(transactionClassificationState.tenantId, tenantId),
    gte(transactionClassificationState.createdAt, new Date(periodStart)),
    lte(transactionClassificationState.createdAt, new Date(periodEnd)),
  );
  const scope = companyId
    ? and(base, eq(transactionClassificationState.companyId, companyId))
    : base;

  // Per-bucket count, restricted to rows still awaiting approval.
  const remainingClause = and(scope, isNull(transactionClassificationState.transactionId));
  const rows = await db
    .select({
      bucket: transactionClassificationState.bucket,
      count: sql<number>`count(*)::int`,
    })
    .from(transactionClassificationState)
    .where(remainingClause)
    .groupBy(transactionClassificationState.bucket);

  const empty: Record<ClassificationBucket, number> = {
    potential_match: 0,
    rule: 0,
    auto_high: 0,
    auto_medium: 0,
    needs_review: 0,
  };
  for (const r of rows) {
    if ((CLASSIFICATION_BUCKETS as readonly string[]).includes(r.bucket)) {
      empty[r.bucket as ClassificationBucket] = Number(r.count);
    }
  }
  const totalRemaining = Object.values(empty).reduce((a, b) => a + b, 0);

  // Approved rows in the same period — used by the progress bar
  // to compute "X of Y remaining" against a real total.
  const [{ approved = 0 } = { approved: 0 }] = await db
    .select({ approved: sql<number>`count(*)::int` })
    .from(transactionClassificationState)
    .where(and(scope, sql`${transactionClassificationState.transactionId} IS NOT NULL`));
  const totalApproved = Number(approved);

  // Open + assigned + in_review findings for this tenant/company,
  // gated on the period — findings.created_at semantics match
  // state.created_at (both stamped at insert).
  const findingsBase = [
    eq(findings.tenantId, tenantId),
    inArray(findings.status, ['open', 'assigned', 'in_review']),
    gte(findings.createdAt, new Date(periodStart)),
    lte(findings.createdAt, new Date(periodEnd)),
  ];
  if (companyId) findingsBase.push(eq(findings.companyId, companyId));
  const [findingsRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(findings)
    .where(and(...findingsBase));
  const findingsCount = Number(findingsRow?.count ?? 0);

  return {
    periodStart,
    periodEnd,
    buckets: empty,
    totalUncategorized: totalRemaining,
    totalApproved,
    findingsCount,
  };
}

// Paginated list of rows in a bucket. Joins to bank_feed_items,
// accounts, contacts, and bank_rules so the UI has everything it
// needs in one round-trip.
export async function listByBucket(
  tenantId: string,
  bucket: ClassificationBucket,
  opts: {
    companyId?: string | null;
    periodStart?: string;
    periodEnd?: string;
    cursor?: string;
    limit: number;
  },
): Promise<{ rows: BucketRow[]; nextCursor: string | null }> {
  const conditions = [
    eq(transactionClassificationState.tenantId, tenantId),
    eq(transactionClassificationState.bucket, bucket),
    // Don't surface already-approved rows — once a state row has a
    // transaction_id stamped, the work is done. Keeps bucket lists
    // aligned with the count summary.
    isNull(transactionClassificationState.transactionId),
  ];
  if (opts.companyId) {
    conditions.push(eq(transactionClassificationState.companyId, opts.companyId));
  }
  if (opts.periodStart) {
    conditions.push(gte(transactionClassificationState.createdAt, new Date(opts.periodStart)));
  }
  if (opts.periodEnd) {
    conditions.push(lte(transactionClassificationState.createdAt, new Date(opts.periodEnd)));
  }
  if (opts.cursor) {
    // Strictly less-than: lte would re-emit the boundary row across
    // pages because the order key (created_at) repeats at the seam.
    conditions.push(lt(transactionClassificationState.createdAt, new Date(opts.cursor)));
  }

  const rows = await db
    .select({
      state: transactionClassificationState,
      item: bankFeedItems,
      account: accounts,
      contact: contacts,
      rule: bankRules,
    })
    .from(transactionClassificationState)
    .innerJoin(bankFeedItems, eq(bankFeedItems.id, transactionClassificationState.bankFeedItemId))
    .leftJoin(accounts, eq(accounts.id, transactionClassificationState.suggestedAccountId))
    .leftJoin(contacts, eq(contacts.id, transactionClassificationState.suggestedVendorId))
    .leftJoin(bankRules, eq(bankRules.id, transactionClassificationState.matchedRuleId))
    .where(and(...conditions))
    .orderBy(desc(transactionClassificationState.createdAt), asc(transactionClassificationState.id))
    .limit(opts.limit + 1);

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;

  // Pull the most recent OCR-complete attachment per page row in a
  // single query so the receipt-comparison panel has the data
  // without a per-row round-trip. The first row per attachable_id
  // wins thanks to the ORDER BY + DISTINCT ON pattern. Empty
  // result is fine — most rows don't have a receipt attached.
  const ocrByItemId = new Map<string, BucketReceiptOcr>();
  if (page.length > 0) {
    const itemIds = page.map((r) => r.item.id);
    const attRows = await db.execute<{
      attachable_id: string;
      attachment_id: string;
      ocr_vendor: string | null;
      ocr_date: string | null;
      ocr_total: string | null;
      ocr_tax: string | null;
    }>(sql`
      SELECT DISTINCT ON (attachable_id)
        attachable_id,
        id AS attachment_id,
        ocr_vendor,
        ocr_date,
        ocr_total,
        ocr_tax
      FROM attachments
      WHERE tenant_id = ${tenantId}
        AND attachable_type = 'bank_feed_items'
        AND attachable_id IN (${sql.join(itemIds.map((id) => sql`${id}::uuid`), sql`, `)})
        AND ocr_status = 'complete'
      ORDER BY attachable_id, created_at DESC
    `);
    for (const row of attRows.rows as Array<{
      attachable_id: string;
      attachment_id: string;
      ocr_vendor: string | null;
      ocr_date: string | null;
      ocr_total: string | null;
      ocr_tax: string | null;
    }>) {
      ocrByItemId.set(row.attachable_id, {
        attachmentId: row.attachment_id,
        vendor: row.ocr_vendor,
        date: row.ocr_date,
        total: row.ocr_total,
        tax: row.ocr_tax,
      });
    }
  }

  const mapped: BucketRow[] = page.map((r) => ({
    stateId: r.state.id,
    bankFeedItemId: r.item.id,
    bankConnectionId: r.item.bankConnectionId,
    feedDate: r.item.feedDate,
    description: r.item.description ?? '',
    amount: r.item.amount,
    suggestedAccountId: r.state.suggestedAccountId,
    suggestedAccountName: r.account?.name ?? null,
    suggestedVendorId: r.state.suggestedVendorId,
    suggestedVendorName: r.contact?.displayName ?? null,
    matchedRuleId: r.state.matchedRuleId,
    matchedRuleName: r.rule?.name ?? null,
    bucket: r.state.bucket as ClassificationBucket,
    confidenceScore: parseFloat(r.state.confidenceScore),
    reasoning: r.state.reasoningBlob as ClassificationReasoning | null,
    matchCandidates: r.state.matchCandidates as MatchCandidate[] | null,
    receiptOcr: ocrByItemId.get(r.item.id) ?? null,
  }));

  return {
    rows: mapped,
    nextCursor: hasMore ? page[page.length - 1]!.state.createdAt.toISOString() : null,
  };
}

// Manual reclassification — bookkeeper moved a row to a different
// bucket. Stamps the new bucket and refreshes reasoning to note
// the manual override.
export async function reclassify(
  tenantId: string,
  stateId: string,
  newBucket: ClassificationBucket,
): Promise<ClassificationState> {
  const [current] = await db
    .select()
    .from(transactionClassificationState)
    .where(
      and(
        eq(transactionClassificationState.tenantId, tenantId),
        eq(transactionClassificationState.id, stateId),
      ),
    );
  if (!current) throw AppError.notFound('Classification state not found');

  const reasoning = current.reasoningBlob as ClassificationReasoning | null;
  const nextReasoning: ClassificationReasoning | null = reasoning
    ? {
        ...reasoning,
        bucket: newBucket,
        adjustments: [
          ...reasoning.adjustments,
          { reason: `manual_reclassify_to_${newBucket}`, delta: 0 },
        ],
      }
    : null;

  const [row] = await db
    .update(transactionClassificationState)
    .set({ bucket: newBucket, reasoningBlob: nextReasoning, updatedAt: new Date() })
    .where(
      and(
        eq(transactionClassificationState.tenantId, tenantId),
        eq(transactionClassificationState.id, stateId),
      ),
    )
    .returning();
  return mapRowToState(row!);
}

export async function getById(tenantId: string, stateId: string): Promise<ClassificationState | null> {
  const [row] = await db
    .select()
    .from(transactionClassificationState)
    .where(
      and(
        eq(transactionClassificationState.tenantId, tenantId),
        eq(transactionClassificationState.id, stateId),
      ),
    );
  return row ? mapRowToState(row) : null;
}

// Bulk-approve. Phase 2b makes this meaningful: for each state row
// with a suggested account, post a transaction via the existing
// bank-feed categorize path and stamp the resulting transaction
// id onto the state row. Rows without a suggested account fail
// with reason='missing_suggested_account' — the UI must surface
// these to the bookkeeper so they can pick an account first.
//
// Failures inside categorize (already-categorized item,
// concurrent claim, etc.) bubble up as failed entries with the
// underlying error message as the reason — they don't abort the
// whole batch.
export async function approveSelected(
  tenantId: string,
  stateIds: string[],
  userId?: string,
): Promise<{ approved: string[]; failed: Array<{ stateId: string; reason: string }> }> {
  if (stateIds.length === 0) return { approved: [], failed: [] };

  const rows = await db
    .select()
    .from(transactionClassificationState)
    .where(
      and(
        eq(transactionClassificationState.tenantId, tenantId),
        inArray(transactionClassificationState.id, stateIds),
      ),
    );

  const approved: string[] = [];
  const failed: Array<{ stateId: string; reason: string }> = [];
  const found = new Set(rows.map((r) => r.id));
  for (const id of stateIds) {
    if (!found.has(id)) failed.push({ stateId: id, reason: 'not_found_or_wrong_tenant' });
  }

  // Lazy import to avoid a cyclic import between this service and
  // bank-feed.service (the latter imports this one to upsert
  // classification state in runCategorizationPipeline).
  const bankFeedService = await import('./bank-feed.service.js');

  for (const state of rows) {
    if (!state.suggestedAccountId) {
      failed.push({ stateId: state.id, reason: 'missing_suggested_account' });
      continue;
    }
    try {
      const txn = await bankFeedService.categorize(
        tenantId,
        state.bankFeedItemId,
        {
          accountId: state.suggestedAccountId,
          contactId: state.suggestedVendorId ?? undefined,
        },
        userId,
        state.companyId ?? undefined,
      );
      await stampTransactionId(tenantId, state.bankFeedItemId, txn.id);
      approved.push(state.id);
    } catch (err) {
      failed.push({
        stateId: state.id,
        reason: err instanceof Error ? err.message : 'unknown_error',
      });
    }
  }
  return { approved, failed };
}

// Manual queue — bank-feed items the system could not auto-
// classify and that need a human to pick an account/vendor. Two
// shapes qualify:
//   1. Pending bank-feed items with no classification state row
//      (orphans — the categorization worker never reached them).
//   2. Pending bank-feed items whose state row is in needs_review
//      AND has neither a suggestedAccountId nor any
//      matchCandidates (worker reached them but produced nothing
//      actionable — vendor unknown, no rule, no AI confidence).
// Period filter is on bank_feed_items.feedDate so the close-period
// scoping matches what the bookkeeper expects (the date the
// transaction landed at the bank, not the day the worker ran).
export interface ManualQueueRow {
  bankFeedItemId: string;
  bankConnectionId: string;
  feedDate: string;
  description: string;
  amount: string;
  stateId: string | null;
  reason: 'orphan' | 'no_suggestion';
}

export async function listManualQueue(
  tenantId: string,
  opts: {
    companyId?: string | null;
    periodStart?: string;
    periodEnd?: string;
    limit?: number;
  },
): Promise<{ rows: ManualQueueRow[] }> {
  const limit = Math.min(opts.limit ?? 100, 500);

  // Scope by bank feed item (not state) so we catch orphans.
  const conditions = [
    eq(bankFeedItems.tenantId, tenantId),
    eq(bankFeedItems.status, 'pending'),
  ];
  if (opts.companyId) {
    conditions.push(eq(bankFeedItems.companyId, opts.companyId));
  }
  if (opts.periodStart) {
    conditions.push(gte(bankFeedItems.feedDate, opts.periodStart.slice(0, 10)));
  }
  if (opts.periodEnd) {
    conditions.push(lt(bankFeedItems.feedDate, opts.periodEnd.slice(0, 10)));
  }

  const rows = await db
    .select({
      item: bankFeedItems,
      state: transactionClassificationState,
    })
    .from(bankFeedItems)
    .leftJoin(
      transactionClassificationState,
      eq(transactionClassificationState.bankFeedItemId, bankFeedItems.id),
    )
    .where(and(...conditions))
    .orderBy(desc(bankFeedItems.feedDate))
    .limit(limit);

  const result: ManualQueueRow[] = [];
  for (const r of rows) {
    if (!r.state) {
      // Orphan — no classification result at all.
      result.push({
        bankFeedItemId: r.item.id,
        bankConnectionId: r.item.bankConnectionId,
        feedDate: r.item.feedDate,
        description: r.item.description ?? '',
        amount: r.item.amount,
        stateId: null,
        reason: 'orphan',
      });
      continue;
    }
    const candidates = (r.state.matchCandidates as MatchCandidate[] | null) ?? null;
    const hasCandidates = Array.isArray(candidates) && candidates.length > 0;
    const noSuggestion =
      r.state.bucket === 'needs_review' &&
      !r.state.suggestedAccountId &&
      !hasCandidates;
    if (noSuggestion) {
      result.push({
        bankFeedItemId: r.item.id,
        bankConnectionId: r.item.bankConnectionId,
        feedDate: r.item.feedDate,
        description: r.item.description ?? '',
        amount: r.item.amount,
        stateId: r.state.id,
        reason: 'no_suggestion',
      });
    }
  }
  return { rows: result };
}

function mapRowToState(row: typeof transactionClassificationState.$inferSelect): ClassificationState {
  return {
    id: row.id,
    tenantId: row.tenantId,
    companyId: row.companyId,
    bankFeedItemId: row.bankFeedItemId,
    transactionId: row.transactionId,
    bucket: row.bucket as ClassificationBucket,
    confidenceScore: parseFloat(row.confidenceScore),
    suggestedAccountId: row.suggestedAccountId,
    suggestedVendorId: row.suggestedVendorId,
    matchedRuleId: row.matchedRuleId,
    reasoningBlob: row.reasoningBlob as ClassificationReasoning | null,
    modelUsed: row.modelUsed,
    matchCandidates: row.matchCandidates as MatchCandidate[] | null,
    vendorEnrichment: row.vendorEnrichment as VendorEnrichment | null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
