// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.
//
// Build-plan Phase 3 — chunked split-level-tag backfill for the big
// tables. Migration 0059 ran the `journal_lines` backfill as a single
// UPDATE, which is fine for normal-sized tenants but risks long
// exclusive-row locks on operators with millions of bank-feed rows or
// deep Plaid import history.
//
// This service runs the same backfill in 10k-row chunks:
//
//   UPDATE journal_lines jl
//   SET tag_id = <first-assigned tag from transaction_tags>
//   WHERE jl.id IN (
//     SELECT jl2.id FROM journal_lines jl2
//     ...
//     ORDER BY jl2.id
//     LIMIT 10000
//   ) AND jl.tag_id IS NULL;
//
// Each chunk commits on its own so concurrent writers never wait more
// than the per-chunk duration. The sweep is a true no-op when no NULL
// rows remain, so re-running it is safe and free — it's invoked from
// the API bootstrap and the worker, whichever acquires the advisory
// lock first. The other becomes a silent no-op.
//
// The plan called for BullMQ; the repo does not yet have queue
// infrastructure, only advisory-lock schedulers (see CLAUDE.md "Why
// BullMQ"). This sweep follows the same pattern so it can migrate to
// BullMQ later without changing the correctness contract.

import { sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { withSchedulerLock } from '../../utils/scheduler-lock.js';

export interface BackfillSweepResult {
  startedAt: string;
  finishedAt: string;
  chunks: number;
  rowsUpdated: number;
  lastBatchRows: number;
  skipped: boolean;
}

// Chunk size chosen to fit comfortably under a 1-minute row-lock
// window on 7200 RPM disks. Adjust via env if an operator needs
// smaller chunks on very slow storage. Anything over 50k starts to
// trip the default `statement_timeout` on shared Postgres providers.
const CHUNK_SIZE = Number(process.env['TAG_BACKFILL_CHUNK_SIZE'] || 10_000);
const MAX_CHUNKS_PER_RUN = Number(process.env['TAG_BACKFILL_MAX_CHUNKS'] || 10_000);

async function countRemaining(): Promise<number> {
  const rs = await db.execute(sql`
    SELECT count(*)::bigint AS n
    FROM journal_lines jl
    WHERE jl.tag_id IS NULL
      AND EXISTS (
        SELECT 1 FROM transaction_tags tt
        WHERE tt.transaction_id = jl.transaction_id
      )
  `);
  const row = (rs.rows as Array<{ n: string | number }>)[0];
  if (!row) return 0;
  // pg returns bigint as string in node-postgres; coerce once.
  return typeof row.n === 'string' ? parseInt(row.n, 10) : row.n;
}

async function runChunk(): Promise<number> {
  // The primary-tag selection mirrors migration 0059: take the
  // earliest-created junction row per transaction. We re-derive it
  // per chunk so concurrent writes to transaction_tags are picked up
  // in later chunks rather than relying on a snapshot.
  const rs = await db.execute(sql`
    WITH candidate AS (
      SELECT jl.id, jl.transaction_id
      FROM journal_lines jl
      WHERE jl.tag_id IS NULL
        AND EXISTS (
          SELECT 1 FROM transaction_tags tt
          WHERE tt.transaction_id = jl.transaction_id
        )
      ORDER BY jl.id
      LIMIT ${CHUNK_SIZE}
    ),
    primary_tag AS (
      SELECT DISTINCT ON (tt.transaction_id)
        tt.transaction_id,
        tt.tag_id
      FROM transaction_tags tt
      JOIN candidate c ON c.transaction_id = tt.transaction_id
      ORDER BY tt.transaction_id, tt.created_at ASC, tt.tag_id
    )
    UPDATE journal_lines jl
    SET tag_id = primary_tag.tag_id
    FROM primary_tag
    WHERE jl.id IN (SELECT id FROM candidate)
      AND jl.transaction_id = primary_tag.transaction_id
      AND jl.tag_id IS NULL
    RETURNING jl.id
  `);
  return rs.rows.length;
}

// Run the chunked backfill under an advisory lock so only one process
// sweeps at a time. Returns the per-run report. Safe to invoke from
// both the API bootstrap and the worker's startup — whichever gets
// the lock first does the work; the other gets `skipped: true`.
export async function runChunkedTagBackfill(): Promise<BackfillSweepResult> {
  const startedAt = new Date().toISOString();
  const held = await withSchedulerLock('tag-backfill-sweep', async () => {
    let chunks = 0;
    let rowsUpdated = 0;
    let lastBatchRows = 0;

    // Fast path: nothing to do. Skip the loop entirely so the
    // lock-held window is sub-millisecond on every subsequent boot.
    const remaining = await countRemaining();
    if (remaining === 0) {
      return { chunks: 0, rowsUpdated: 0, lastBatchRows: 0 };
    }

    while (chunks < MAX_CHUNKS_PER_RUN) {
      const updated = await runChunk();
      lastBatchRows = updated;
      if (updated === 0) break;
      rowsUpdated += updated;
      chunks += 1;
      console.log(`[tag-backfill] chunk ${chunks}: processed=${updated} total=${rowsUpdated}`);
    }

    return { chunks, rowsUpdated, lastBatchRows };
  });

  const finishedAt = new Date().toISOString();
  if (held === null) {
    // Another process is sweeping (or just finished). Report the
    // no-op plainly so callers can log without branching.
    return { startedAt, finishedAt, chunks: 0, rowsUpdated: 0, lastBatchRows: 0, skipped: true };
  }
  return { startedAt, finishedAt, ...held, skipped: false };
}

// Export the internals so the aggressive-e2e suite can exercise the
// chunk query directly against a small fixture without needing the
// whole scheduler lock machinery.
export const __testables = { countRemaining, runChunk, CHUNK_SIZE };
