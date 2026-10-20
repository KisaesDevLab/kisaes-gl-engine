// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Deposit settlement links (deposit_lines): which documents a bank deposit
// settles. Two kinds of source (U-52, U-54):
//   - an item sitting in Payments Clearing (customer payment, sales receipt,
//     daily sales, a journal entry…) — deposited whole, at most once;
//   - a vendor credit — refunded by the vendor, possibly in several deposits,
//     never past its open balance.
//
// A link only counts while its deposit is posted. Voiding, deleting or
// editing a deposit releases its links (the rows are removed inside the
// same database transaction; the deposit's audit row records them).
//
// Deliberately free of ledger.service imports: ledger.service calls into
// this module from void / delete / update, and bill.service delegates its
// vendor-credit recompute here.

import { and, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type { DbOrTx } from '../db/index.js';
import { transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

const Decimal = DecimalLib.default || DecimalLib;

export interface DepositLinkRow {
  id: string;
  depositId: string;
  sourceTransactionId: string;
  amount: string;
}

/** The links a deposit holds (any deposit status). */
export async function linksOfDeposit(executor: DbOrTx, tenantId: string, depositId: string): Promise<DepositLinkRow[]> {
  const res = await executor.execute(sql`
    SELECT dl.id, dl.deposit_id, dl.source_transaction_id, dl.amount
    FROM deposit_lines dl
    JOIN transactions d ON d.id = dl.deposit_id AND d.tenant_id = ${tenantId}
    WHERE dl.deposit_id = ${depositId}
    ORDER BY dl.sort_order, dl.id
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r['id']),
    depositId: String(r['deposit_id']),
    sourceTransactionId: String(r['source_transaction_id']),
    amount: new Decimal(String(r['amount'])).toFixed(4),
  }));
}

/**
 * Posted deposits (other than `exceptDepositId`) that hold a link to this
 * source. Empty when the source is free.
 */
export async function liveDepositsForSource(
  executor: DbOrTx,
  tenantId: string,
  sourceId: string,
  exceptDepositId?: string,
): Promise<Array<{ depositId: string; amount: string }>> {
  const except = exceptDepositId ? sql` AND d.id <> ${exceptDepositId}` : sql``;
  const res = await executor.execute(sql`
    SELECT dl.deposit_id, dl.amount
    FROM deposit_lines dl
    JOIN transactions d ON d.id = dl.deposit_id
    WHERE dl.source_transaction_id = ${sourceId}
      AND d.tenant_id = ${tenantId}
      AND d.status = 'posted'
      ${except}
  `);
  return (res.rows as Array<Record<string, unknown>>).map((r) => ({
    depositId: String(r['deposit_id']),
    amount: new Decimal(String(r['amount'])).toFixed(4),
  }));
}

/**
 * Refuses a change to a transaction that a posted deposit settles: void,
 * delete, or an edit that would change the amount the deposit took.
 * 409 TXN_DEPOSITED with the deposit ids.
 */
export async function assertNotDeposited(executor: DbOrTx, tenantId: string, txnId: string, action: 'void' | 'delete' | 'edit') {
  const live = await liveDepositsForSource(executor, tenantId, txnId);
  if (live.length === 0) return;
  throw AppError.conflict(
    `This transaction is part of a bank deposit, so it can’t be ${action === 'edit' ? 'changed that way' : action === 'void' ? 'voided' : 'deleted'}. ` +
      'Remove it from the deposit first (edit or void the deposit).',
    'TXN_DEPOSITED',
    { depositIds: [...new Set(live.map((l) => l.depositId))] },
  );
}

/**
 * Open balance of a vendor credit: total less what bill payments applied
 * (vendor_credit_applications) and what posted deposits refunded
 * (deposit_lines). Writes balance_due / credits_applied / bill_status back,
 * exactly as bill payments always have, now counting refunds too.
 */
export async function recomputeVendorCreditBalance(executor: DbOrTx, tenantId: string, creditId: string) {
  const result = await executor.execute(sql`
    SELECT
      t.total,
      COALESCE((SELECT SUM(amount) FROM vendor_credit_applications
                WHERE credit_id = ${creditId} AND tenant_id = ${tenantId}), 0) AS applied,
      COALESCE((SELECT SUM(dl.amount) FROM deposit_lines dl
                JOIN transactions d ON d.id = dl.deposit_id
                WHERE dl.source_transaction_id = ${creditId}
                  AND d.tenant_id = ${tenantId} AND d.status = 'posted'), 0) AS refunded
    FROM transactions t
    WHERE t.id = ${creditId} AND t.tenant_id = ${tenantId}
  `);
  const row = (result.rows as Array<{ total: string | null; applied: string | number; refunded: string | number }>)[0];
  if (!row) return;

  const total = new Decimal(row.total || '0');
  const used = new Decimal(String(row.applied)).plus(String(row.refunded));
  let balanceDue = total.minus(used);
  if (balanceDue.isNegative()) balanceDue = new Decimal('0');
  const tolerance = new Decimal('0.01');

  await executor.update(transactions).set({
    creditsApplied: used.toFixed(4),
    balanceDue: balanceDue.toFixed(4),
    billStatus: balanceDue.lessThanOrEqualTo(tolerance) ? 'paid' : 'unpaid',
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, creditId)));
}

/**
 * Releases every link a deposit holds (void, delete, or before an edit
 * rewrites them): removes the rows and recomputes the vendor credits they
 * refunded. Returns the released rows for the caller's audit entry.
 */
export async function releaseDepositLinks(executor: DbOrTx, tenantId: string, depositId: string): Promise<DepositLinkRow[]> {
  const links = await linksOfDeposit(executor, tenantId, depositId);
  if (links.length === 0) return links;
  await executor.execute(sql`
    DELETE FROM deposit_lines
    WHERE deposit_id = ${depositId}
      AND EXISTS (SELECT 1 FROM transactions d WHERE d.id = ${depositId} AND d.tenant_id = ${tenantId})
  `);
  const sourceIds = [...new Set(links.map((l) => l.sourceTransactionId))];
  // Lock the credits in id order (as deposit writeLinks does) so two
  // writers touching overlapping credits never deadlock.
  const credits = await executor.execute(sql`
    SELECT id FROM transactions
    WHERE tenant_id = ${tenantId} AND txn_type = 'vendor_credit'
      AND id IN (${sql.join(sourceIds.map((id) => sql`${id}`), sql`, `)})
    ORDER BY id
    FOR UPDATE
  `);
  for (const c of credits.rows as Array<{ id: string }>) {
    await recomputeVendorCreditBalance(executor, tenantId, c.id);
  }
  return links;
}
