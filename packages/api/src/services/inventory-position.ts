// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * The position order of an item's stock ledger rows (U-157; PR-4 B1).
 *
 * A document's position is (movement_date, txn_created_at, transaction_id).
 * A credit memo can hold several rows of one part (one per linked sale, plus
 * the unlinked units), so every read that walks rows in order, or picks the
 * latest row, breaks the tie inside a document by the linked sale's position
 * (source_movement_date, source_txn_created_at, both NULLS FIRST: the
 * unlinked units first, then the linked rows by their sale), then
 * source_transaction_id, then id. The sale's position is stored on the row
 * (migration 0261) and survives a tenant import unchanged, unlike the ids
 * (the import re-walks every item for the rest, RB1). The unique index
 * (transaction_id, item_id, source_transaction_id) makes the order total per
 * item; id only keeps it total across items.
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
  return sql.raw(`${a}movement_date, ${a}txn_created_at, ${a}transaction_id, ${a}source_movement_date NULLS FIRST, `
    + `${a}source_txn_created_at NULLS FIRST, ${a}source_transaction_id NULLS FIRST, ${a}id`);
}

/** ORDER BY terms, latest first (the exact mirror of positionAsc). */
export function positionDesc(alias = ''): SQL {
  const a = cols(alias);
  return sql.raw(`${a}movement_date DESC, ${a}txn_created_at DESC, ${a}transaction_id DESC, ${a}source_movement_date DESC NULLS LAST, `
    + `${a}source_txn_created_at DESC NULLS LAST, ${a}source_transaction_id DESC NULLS LAST, ${a}id DESC`);
}
