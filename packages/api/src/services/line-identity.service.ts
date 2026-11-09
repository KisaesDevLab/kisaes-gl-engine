// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Line identity across a full-replace edit (U-192, line-identity-v1).
 *
 * `updateTransaction`'s full-replace path deletes every journal line of the
 * entry and inserts new ones, so anything that names a line by id points at
 * nothing afterwards. Two references matter while the owner is still working:
 *
 *   - a row of an IN-PROGRESS reconciliation worksheet (reconciliation_lines,
 *     no FK): GET and complete drop it through their inner joins and refresh
 *     re-adds the new line unticked, so an edit that only fixed a memo
 *     silently unticked the item;
 *   - bank_feed_items.matched_journal_line_id (the bank-file row behind the
 *     line, migration 0265).
 *
 * Each old line referenced by one of them is paired with the single new line
 * on the same account and the same side (debit, credit or zero), when that
 * pairing is unambiguous on both sides. Then:
 *   worksheet row  re-pointed; still ticked only if the amount is unchanged,
 *                  otherwise unticked and audited. Without a pairing the row
 *                  is deleted (refresh adds the new line).
 *   feed row       re-pointed only if the amount is unchanged; otherwise
 *                  left as it was (a changed amount is a separate review).
 * Completed reconciliations are never touched: the ledger refuses the edits
 * that would replace their lines.
 */

import { sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import type { Tx } from '../db/index.js';
import { auditLog } from '../middleware/audit.js';

export interface LineRef {
  id: string;
  accountId: string;
  debit: string | null;
  credit: string | null;
}

export interface CarryResult {
  /** Worksheet rows moved to the new line (ticks kept or dropped). */
  worksheetRepointed: number;
  /** Ticked rows that lost their tick because the amount changed. */
  worksheetUnticked: number;
  /** Worksheet rows deleted for want of a single matching line. */
  worksheetRemoved: number;
  /** Feed rows moved to the new line. */
  feedRepointed: number;
}

function amountOf(l: LineRef) {
  return new Decimal(l.debit || '0').minus(l.credit || '0');
}

function keyOf(l: LineRef): string {
  const a = amountOf(l);
  return `${l.accountId}|${a.isZero() ? 'Z' : a.isPositive() ? 'D' : 'C'}`;
}

function uuidArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

/** Pairs each old line with its single successor (same account and side, unique on both sides). */
export function pairLines(oldLines: readonly LineRef[], newLines: readonly LineRef[]): Map<string, LineRef> {
  const count = (lines: readonly LineRef[]) => {
    const m = new Map<string, LineRef[]>();
    for (const l of lines) {
      const k = keyOf(l);
      const list = m.get(k);
      if (list) list.push(l); else m.set(k, [l]);
    }
    return m;
  };
  const olds = count(oldLines);
  const news = count(newLines);
  const pairs = new Map<string, LineRef>();
  for (const [k, list] of olds) {
    const next = news.get(k);
    if (list.length === 1 && next && next.length === 1) pairs.set(list[0]!.id, next[0]!);
  }
  return pairs;
}

export async function carryLineReferences(
  tx: Tx,
  tenantId: string,
  transactionId: string,
  oldLines: readonly LineRef[],
  newLines: readonly LineRef[],
  userId?: string,
): Promise<CarryResult> {
  const result: CarryResult = { worksheetRepointed: 0, worksheetUnticked: 0, worksheetRemoved: 0, feedRepointed: 0 };
  if (oldLines.length === 0) return result;
  const oldIds = oldLines.map((l) => l.id);

  const wsRes = await tx.execute(sql`
    SELECT rl.id, rl.reconciliation_id, rl.journal_line_id, rl.is_cleared
    FROM reconciliation_lines rl
    JOIN reconciliations r ON r.id = rl.reconciliation_id
    WHERE r.tenant_id = ${tenantId} AND r.status = 'in_progress'
      AND rl.journal_line_id = ANY(${uuidArray(oldIds)}::uuid[])
  `);
  const wsRows = wsRes.rows as Array<{ id: string; reconciliation_id: string; journal_line_id: string; is_cleared: boolean | null }>;
  const feedRes = await tx.execute(sql`
    SELECT id, matched_journal_line_id FROM bank_feed_items
    WHERE tenant_id = ${tenantId} AND matched_journal_line_id = ANY(${uuidArray(oldIds)}::uuid[])
  `);
  const feedRows = feedRes.rows as Array<{ id: string; matched_journal_line_id: string }>;
  if (wsRows.length === 0 && feedRows.length === 0) return result;

  const oldById = new Map(oldLines.map((l) => [l.id, l]));
  const pairs = pairLines(oldLines, newLines);

  for (const row of wsRows) {
    const next = pairs.get(row.journal_line_id);
    if (!next) {
      await tx.execute(sql`DELETE FROM reconciliation_lines WHERE id = ${row.id}`);
      result.worksheetRemoved += 1;
      if (row.is_cleared) {
        await auditLog(tenantId, 'update', 'reconciliation', row.reconciliation_id,
          { journalLineId: row.journal_line_id, isCleared: true },
          { journalLineId: null, isCleared: false, reason: 'line_replaced', transactionId },
          userId, tx);
      }
      continue;
    }
    const sameAmount = amountOf(oldById.get(row.journal_line_id)!).equals(amountOf(next));
    const keepTick = row.is_cleared === true && sameAmount;
    await tx.execute(sql`
      UPDATE reconciliation_lines
      SET journal_line_id = ${next.id},
          is_cleared = ${keepTick},
          cleared_at = CASE WHEN ${keepTick} THEN cleared_at ELSE NULL END
      WHERE id = ${row.id}
    `);
    result.worksheetRepointed += 1;
    if (row.is_cleared && !keepTick) {
      result.worksheetUnticked += 1;
      await auditLog(tenantId, 'update', 'reconciliation', row.reconciliation_id,
        { journalLineId: row.journal_line_id, isCleared: true },
        { journalLineId: next.id, isCleared: false, reason: 'amount_changed', transactionId },
        userId, tx);
    }
  }

  for (const row of feedRows) {
    const next = pairs.get(row.matched_journal_line_id);
    if (!next) continue;
    if (!amountOf(oldById.get(row.matched_journal_line_id)!).equals(amountOf(next))) continue;
    await tx.execute(sql`
      UPDATE bank_feed_items SET matched_journal_line_id = ${next.id}, updated_at = now()
      WHERE id = ${row.id} AND tenant_id = ${tenantId}
    `);
    result.feedRepointed += 1;
  }
  return result;
}
