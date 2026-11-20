// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * The companies row in the posting lock order (ClientLedger P33 soak).
 *
 * A posting takes its locks in this order:
 *   1. the Idempotency-Key claim: an advisory lock, then an idempotency_keys
 *      row, whose company_id foreign key takes FOR KEY SHARE on the
 *      companies row until commit;
 *   2. the documents it changes or applies to (FOR UPDATE, id order);
 *   3. the companies row, for a counter (invoice, sales receipt, credit
 *      memo and statement numbers; check numbers; vendor credit numbers) or
 *      for the inventory costing lock: FOR NO KEY UPDATE, this module;
 *   4. inventory items (id order);
 *   5. journal_lines, whose triggers take the company's gl_version_stamps
 *      row (0144, 0277) until commit;
 *   6. account and other balance rows (id order);
 *   7. the change feed, append-only rows (0289): no shared row.
 *
 * Step 3 is FOR NO KEY UPDATE, never FOR UPDATE: FOR UPDATE also conflicts
 * with the FOR KEY SHARE of step 1 (and of any other row inserted with the
 * company's id), so two postings that had each claimed their key waited for
 * each other to upgrade, and every pair of concurrent invoice creates
 * deadlocked. FOR NO KEY UPDATE conflicts with itself, FOR SHARE and FOR
 * UPDATE, so counters stay gap-free and the costing lock still serializes
 * with every other counter or costing lock and with the settings writes,
 * which keep FOR UPDATE. Nothing here changes the company's id.
 */

import { sql } from 'drizzle-orm';

/** The posting paths' lock on the companies row, for Drizzle's `.for()`. */
export const COMPANY_ROW_LOCK = 'no key update' as const;

/** The same lock in raw SQL. */
export const COMPANY_ROW_LOCK_SQL = sql.raw('FOR NO KEY UPDATE');
