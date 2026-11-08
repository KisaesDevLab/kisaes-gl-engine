// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Feed row locks for Accept, Undo and the feed transfer (U-187,
 * feed-accept-busy-wait).
 *
 * The rows are locked in sorted id order, FOR UPDATE SKIP LOCKED: a request
 * never sits in a lock wait on a feed row, so it can never be part of a
 * deadlock (Void and delete lock the entry, then its feed rows). A row
 * another transaction holds is looked for again, SKIP LOCKED each time, for
 * at most FEED_ROW_WAIT.ms; only a row still held then is reported in use.
 *
 * Why: the holder is usually short-lived. Import post-processing
 * (bank-import/post-process.ts) locks each chunk's rows FOR UPDATE while it
 * writes the suggestions, right after the import commits, so an Accept sent
 * at once (the owner imports a file and clicks Accept) met the chunk and
 * skipped the row as in_use although it was free a moment later.
 */

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { bankFeedItems } from '../db/schema/index.js';

type FeedRow = typeof bankFeedItems.$inferSelect;

/** How long a held row is looked for again (ms), and the longest pause between looks. Tests may lower them. */
export const FEED_ROW_WAIT = { ms: 2_000, maxStepMs: 100 };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Locks the tenant's feed rows with these ids (sorted, FOR UPDATE SKIP
 * LOCKED, see the header) and returns them in id order. A row missing from
 * the result does not exist in the tenant or was still held after
 * FEED_ROW_WAIT; the caller tells the two apart. The company is the
 * caller's check.
 */
export async function lockFeedRows(tx: Tx, tenantId: string, ids: string[]): Promise<FeedRow[]> {
  const sorted = [...new Set(ids)].sort();
  if (sorted.length === 0) return [];
  const take = (want: string[]) => tx.select().from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), inArray(bankFeedItems.id, want)))
    .orderBy(asc(bankFeedItems.id))
    .for('update', { skipLocked: true });

  const got = new Map((await take(sorted)).map((r) => [r.id, r]));
  let held = sorted.filter((id) => !got.has(id));
  if (held.length > 0 && FEED_ROW_WAIT.ms > 0) {
    // Only rows that exist can be held; a missing id is not waited for.
    held = (await tx.select({ id: bankFeedItems.id }).from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), inArray(bankFeedItems.id, held))))
      .map((r) => r.id).sort();
    const deadline = Date.now() + FEED_ROW_WAIT.ms;
    let step = 10;
    while (held.length > 0) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      await pause(Math.min(step, left));
      step = Math.min(step * 2, FEED_ROW_WAIT.maxStepMs);
      for (const r of await take(held)) got.set(r.id, r);
      held = held.filter((id) => !got.has(id));
    }
  }
  return sorted.filter((id) => got.has(id)).map((id) => got.get(id)!);
}
