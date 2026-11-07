// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * The position order of an item's stock ledger rows (U-157; PR-4 B1).
 *
 * A document's position is (movement_date, txn_created_at, transaction_id).
 * A credit memo can hold several rows of one part (one per linked sale, plus
 * the unlinked units), so every read that walks rows in order, or picks the
 * latest row, breaks the tie inside a document by source_transaction_id
 * NULLS FIRST (the unlinked units first, then the linked rows), then id. The
 * unique index (transaction_id, item_id, source_transaction_id) makes the
 * order total per item; id only keeps it total across items.
 *
 * The walk start and the seed's "before the start" test stay at document
 * granularity (the 3-tuple): an edit of one line of a document re-walks every
 * row of that document.
 */

import { sql, type SQL } from 'drizzle-orm';

const cols = (alias: string) => (alias ? `${alias}.` : '');

/** ORDER BY terms, earliest first. `alias`: the movements table alias ('' for none). */
export function positionAsc(alias = ''): SQL {
  const a = cols(alias);
  return sql.raw(`${a}movement_date, ${a}txn_created_at, ${a}transaction_id, ${a}source_transaction_id NULLS FIRST, ${a}id`);
}

/** ORDER BY terms, latest first (the exact mirror of positionAsc). */
export function positionDesc(alias = ''): SQL {
  const a = cols(alias);
  return sql.raw(`${a}movement_date DESC, ${a}txn_created_at DESC, ${a}transaction_id DESC, ${a}source_transaction_id DESC NULLS LAST, ${a}id DESC`);
}

/** The same order in memory (rows already read): -1, 0 or 1. */
export function comparePosition(
  x: { movementDate: string; txnCreatedAt: Date; transactionId: string; sourceTransactionId: string | null; id: string },
  y: { movementDate: string; txnCreatedAt: Date; transactionId: string; sourceTransactionId: string | null; id: string },
): number {
  const k = (m: typeof x) => [m.movementDate, m.txnCreatedAt.getTime(), m.transactionId] as const;
  const [a, b] = [k(x), k(y)];
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  if (x.sourceTransactionId !== y.sourceTransactionId) {
    if (x.sourceTransactionId === null) return -1;
    if (y.sourceTransactionId === null) return 1;
    return x.sourceTransactionId < y.sourceTransactionId ? -1 : 1;
  }
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
}
