// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Record stamps owned by the database (U-291, stale-all-v1; migration
 * 0286_record_stamps). In desktop mode triggers set `updated_at` on the
 * stale-checked tables; on the server appliance they never run.
 *
 * - STAMP_HEADERS: each stale-checked table and the columns its trigger
 *   ignores (columns the engine maintains itself). record-stamps.test.ts pins
 *   every table's column list, so a new column has to be classified here
 *   (bumps the stamp, or ignored) before it ships.
 * - STAMP_CHILDREN: child tables whose rows bump their header once per
 *   database transaction.
 * - quietStamps(): for maintained writes to child rows (the inventory costing
 *   walk, merges, backfills, whole-company deletes) that must not move the
 *   stamps of the records they touch, nor lock those records.
 * - lockHeaders(): writers that change child rows of many records (bulk tag,
 *   bulk update) lock the headers first, in id order, so they take locks in
 *   the same order as an editor (header, then its lines) and cannot deadlock
 *   with one.
 */

import { sql } from 'drizzle-orm';
import type { DbOrTx } from '../db/index.js';
import { AppError } from './errors.js';

export const STAMP_HEADERS: Readonly<Record<string, readonly string[]>> = {
  transactions: ['viewed_at'],
  accounts: ['balance'],
  contacts: ['bill_lines_mode'],
  items: [],
  tags: ['usage_count'],
  tag_groups: [],
  // 0287 (U-291b)
  companies: ['invoice_next_number', 'remote_backup_last_at', 'remote_backup_last_status', 'remote_backup_last_size'],
  recurring_schedules: ['next_occurrence', 'last_posted_at', 'remaining_count'],
  invoice_templates: [],
  permission_templates: [],
  conditional_rules: [],
  document_drafts: [],
  vendor_layout_templates: ['last_used_at', 'samples'],
  tenants: [],
  sales_tax_agencies: [],
  sales_tax_codes: [],
  sales_tax_items: [],
  contact_tax_exemptions: [],
  daily_sales_entries: [],
  daily_sales_templates: [],
  je_templates: [],
  unit_sets: [],
  price_levels: [],
};

export const STAMP_CHILDREN: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  // billed_status and inventory_movement_id are maintained (billing, costing): they move no stamp.
  journal_lines: [['transactions', 'transaction_id']],
  transaction_tags: [['transactions', 'transaction_id']],
  payment_applications: [['transactions', 'payment_id'], ['transactions', 'invoice_id']],
  bill_payment_applications: [['transactions', 'payment_id'], ['transactions', 'bill_id']],
  vendor_credit_applications: [['transactions', 'payment_id'], ['transactions', 'credit_id'], ['transactions', 'bill_id']],
  // The deposit only: a deposited payment is state-guarded (409 ALREADY_DEPOSITED), its stamp does not move.
  deposit_lines: [['transactions', 'deposit_id']],
  // 0287 (U-291b)
  daily_sales_entry_values: [['daily_sales_entries', 'entry_id']],
  daily_sales_template_lines: [['daily_sales_templates', 'template_id']],
  je_template_lines: [['je_templates', 'template_id']],
  unit_set_units: [['unit_sets', 'unit_set_id']],
  price_level_items: [['price_levels', 'price_level_id']],
  // attachments: the link (attachable_type, attachable_id) only; contacts or transactions.
};

/**
 * Runs `fn` with child-row stamp bumps off, inside the caller's transaction
 * (a no-op setting outside desktop mode). Restores the previous value after.
 */
export async function quietStamps<T>(tx: DbOrTx, fn: () => Promise<T>): Promise<T> {
  await tx.execute(sql`SELECT set_config('mybooks.stamp_quiet', 'on', true)`);
  try {
    return await fn();
  } finally {
    await tx.execute(sql`SELECT set_config('mybooks.stamp_quiet', 'off', true)`);
  }
}

/** Locks the transactions `ids` (FOR UPDATE, id order) inside `tx`. */
export async function lockTransactionHeaders(tx: DbOrTx, tenantId: string, ids: readonly string[]): Promise<void> {
  const unique = [...new Set(ids.filter((i) => typeof i === 'string' && i.length > 0))].sort();
  if (unique.length === 0) return;
  await tx.execute(sql`SELECT 1 FROM transactions WHERE tenant_id = ${tenantId}
    AND id = ANY(${`{${unique.join(',')}}`}::uuid[]) ORDER BY id FOR UPDATE`);
}

/**
 * Optimistic concurrency on a locked row (U-84, ap-edit-v1): `expected` is
 * the record's updatedAt as the caller last read it (ISO 8601). Compared to
 * the millisecond, as JSON carries it, after the row is read FOR UPDATE, so
 * two writers can't both pass. Mismatch: 409 STALE, details.updatedAt = the
 * stored value; nothing changes. Omitted: no check (old behaviour).
 */
export function assertNotStale(
  row: { updatedAt: Date | null },
  expected: string | undefined,
  what = 'This transaction',
): void {
  if (expected === undefined) return;
  const stored = row.updatedAt ? row.updatedAt.getTime() : null;
  const wanted = Date.parse(expected);
  if (stored === null || Number.isNaN(wanted) || stored !== wanted) {
    throw AppError.conflict(
      `${what} was changed by someone else since you opened it. Reload it and make your change again.`,
      'STALE',
      { updatedAt: row.updatedAt ? row.updatedAt.toISOString() : null },
    );
  }
}


/**
 * The current stamp of the record an attachment or tag write touched (U-291,
 * S2): a contact, or else a transaction of that id. Null when there is none.
 * Child writes return it so an open form saves on the stamp its own write made.
 */
export async function parentStamp(exec: DbOrTx, tenantId: string, kind: string, id: string): Promise<string | null> {
  const table = kind === 'contact' ? sql`contacts` : sql`transactions`;
  const r = await exec.execute(sql`SELECT updated_at FROM ${table} WHERE tenant_id = ${tenantId} AND id = ${id}`);
  const row = r.rows[0] as { updated_at: Date | string | null } | undefined;
  return row?.updated_at ? new Date(row.updated_at).toISOString() : null;
}
