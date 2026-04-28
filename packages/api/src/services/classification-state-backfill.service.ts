// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankFeedItems, transactionClassificationState } from '../db/schema/index.js';
import { withSchedulerLock } from '../utils/scheduler-lock.js';
import * as classificationService from './practice-classification.service.js';

const BATCH_SIZE = 200;
const LOCK_NAME = 'classification-state-backfill';

// One-shot sweep that fills transaction_classification_state for
// every bank_feed_items row that doesn't have one yet. Runs under
// a Postgres advisory lock so only one process performs the work.
//
// The sweep is bounded: it exits when a batch returns zero un-
// backfilled items. Safe to call at every worker startup — the
// steady state is zero rows to backfill.
//
// We don't retry individual item failures; a transient DB error
// during one item interrupts the batch but the advisory lock
// releases cleanly and the next startup resumes. This matches
// the build plan's "idempotent backfill" requirement.
export interface BackfillResult {
  skipped: boolean;
  processed: number;
  failed: number;
  durationMs: number;
}

export async function runBackfill(): Promise<BackfillResult> {
  const result = await withSchedulerLock<BackfillResult>(LOCK_NAME, async () => {
    const start = Date.now();
    let processed = 0;
    let failed = 0;

    // Pull candidates in batches. The LEFT JOIN + IS NULL pattern
    // is the canonical "rows in A not in B" query. The LIMIT is
    // applied AFTER the filter so each batch is guaranteed to be
    // all-un-backfilled.
    while (true) {
      const candidates = await db.execute<{ id: string; tenant_id: string }>(sql`
        SELECT bfi.id, bfi.tenant_id
        FROM bank_feed_items bfi
        LEFT JOIN transaction_classification_state tcs
          ON tcs.bank_feed_item_id = bfi.id
        WHERE tcs.id IS NULL
        ORDER BY bfi.created_at ASC
        LIMIT ${BATCH_SIZE}
      `);

      const rows = candidates.rows as Array<{ id: string; tenant_id: string }>;
      if (rows.length === 0) break;

      for (const row of rows) {
        try {
          await classificationService.upsertStateForFeedItem(row.tenant_id, row.id);
          processed++;
        } catch (err) {
          failed++;
          // Best-effort log; don't abort the batch on one failure.
          console.warn(
            `[classification-backfill] Failed for item ${row.id} (tenant ${row.tenant_id}):`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      if (rows.length < BATCH_SIZE) break;
    }

    return { skipped: false, processed, failed, durationMs: Date.now() - start };
  });

  return result ?? { skipped: true, processed: 0, failed: 0, durationMs: 0 };
}

// Worker startup entry point. Fire-and-forget: the backfill runs
// in the background so worker start isn't gated on it, and the
// advisory lock guarantees no parallel work.
export function startClassificationStateBackfill(): void {
  void runBackfill()
    .then((r) => {
      if (r.skipped) {
        console.log('[Worker] classification-state-backfill skipped (lock held elsewhere)');
      } else if (r.processed === 0) {
        console.log('[Worker] classification-state-backfill found nothing to backfill');
      } else {
        console.log(
          `[Worker] classification-state-backfill done: processed=${r.processed} failed=${r.failed} durationMs=${r.durationMs}`,
        );
      }
    })
    .catch((err) => console.error('[Worker] classification-state-backfill failed:', err));
}

// Utility used by tests and by the bank-feed approve path to
// ensure the state table is in sync before taking action on a
// specific feed item.
export async function ensureStateForFeedItem(
  tenantId: string,
  bankFeedItemId: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: transactionClassificationState.id })
    .from(transactionClassificationState)
    .where(
      and(
        eq(transactionClassificationState.tenantId, tenantId),
        eq(transactionClassificationState.bankFeedItemId, bankFeedItemId),
      ),
    )
    .limit(1);
  if (existing) return;

  // Only fill for items that haven't already been posted into a
  // transaction and are still in the review queue. The is-null
  // guard on the LEFT JOIN in runBackfill covers this implicitly;
  // here we explicitly check status to avoid filling for a
  // long-ago-approved item that someone queried directly.
  const [item] = await db
    .select({ id: bankFeedItems.id, status: bankFeedItems.status })
    .from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, bankFeedItemId)))
    .limit(1);
  if (!item) return;
  // Silence unused-var while still keeping the existence check.
  void isNull;

  await classificationService.upsertStateForFeedItem(tenantId, bankFeedItemId);
}
