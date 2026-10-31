// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Billable cost links, the low level (U-128, billable-costs-v1). Used by the
 * ledger's void / delete / edit paths and by the invoice service, so it
 * imports nothing from ledger.service (no import cycle).
 *
 * Locking (review B2): every writer of a cost line's billed state takes the
 * row lock of the line's SOURCE transaction (the row a source edit, void or
 * delete already locks), in id order so two claims can't deadlock. A claim
 * or release changes journal_lines.billed_status and the link only: no
 * amount, account or date of the source, so it takes no closing-date check
 * (Q-P20x) and does not touch the source's updated_at.
 */

import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { DbOrTx, Tx } from '../db/index.js';
import { accounts, billableCostLinks, journalLines, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

export type ReleaseReason = 'removed' | 'invoice_void' | 'invoice_delete';
export type BillableLink = typeof billableCostLinks.$inferSelect;

/** Locks the source transactions' rows FOR UPDATE in id order. */
export async function lockSourceTransactions(tx: Tx, tenantId: string, sourceTxnIds: Iterable<string>): Promise<void> {
  const ids = [...new Set(sourceTxnIds)].sort();
  if (ids.length === 0) return;
  await tx.execute(sql`SELECT id FROM transactions
    WHERE tenant_id = ${tenantId} AND id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY id FOR UPDATE`);
}

/** The invoice's active links (released_at null), oldest first. */
export async function activeLinksForInvoice(executor: DbOrTx, tenantId: string, invoiceId: string): Promise<BillableLink[]> {
  return executor.select().from(billableCostLinks)
    .where(and(
      eq(billableCostLinks.tenantId, tenantId),
      eq(billableCostLinks.invoiceId, invoiceId),
      isNull(billableCostLinks.releasedAt),
    ))
    .orderBy(billableCostLinks.createdAt, billableCostLinks.id);
}

/** Audit row on the source transaction for one claim or release (S5). */
export async function auditBilledState(
  tx: Tx, tenantId: string, sourceTxnId: string, lineId: string,
  before: string | null, after: string, invoiceId: string, userId: string | undefined, reason?: ReleaseReason,
) {
  await auditLog(tenantId, 'update', 'transaction', sourceTxnId,
    { lineId, billedStatus: before },
    { lineId, billedStatus: after, invoiceId, via: after === 'billed' ? 'billable_claim' : 'billable_release', ...(reason ? { reason } : {}) },
    userId, tx);
}

/**
 * Releases a billing document's active links (review B3): every one, or the
 * named source lines only. The source rows are locked first (id order),
 * then each cost line goes back to 'unbilled' and its link is stamped
 * released. Returns what it released, for the caller's audit after-image.
 */
export async function releaseBilledCosts(
  tx: Tx, tenantId: string, billingTxnId: string, reason: ReleaseReason, userId?: string,
  sourceLineIds?: readonly string[],
): Promise<Array<{ sourceLineId: string; sourceTransactionId: string }>> {
  let links = await activeLinksForInvoice(tx, tenantId, billingTxnId);
  if (sourceLineIds) {
    const want = new Set(sourceLineIds);
    links = links.filter((l) => want.has(l.sourceLineId));
  }
  if (links.length === 0) return [];
  await lockSourceTransactions(tx, tenantId, links.map((l) => l.sourceTransactionId));
  const now = new Date();
  for (const link of links) {
    const [line] = await tx.update(journalLines).set({ billedStatus: 'unbilled' })
      .where(and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.id, link.sourceLineId),
        eq(journalLines.billedStatus, 'billed'),
      ))
      .returning({ id: journalLines.id });
    if (!line) {
      throw new AppError(500, 'A billed cost line is missing; nothing was changed.', 'BILLABLE_LINK_BROKEN');
    }
    await tx.update(billableCostLinks).set({ releasedAt: now, releasedBy: userId ?? null, releaseReason: reason })
      .where(and(eq(billableCostLinks.tenantId, tenantId), eq(billableCostLinks.id, link.id)));
    await auditBilledState(tx, tenantId, link.sourceTransactionId, link.sourceLineId, 'billed', 'unbilled', billingTxnId, userId, reason);
  }
  return links.map((l) => ({ sourceLineId: l.sourceLineId, sourceTransactionId: l.sourceTransactionId }));
}

/**
 * After a source edit (review B1): every active link of the source points
 * at a live line of it still marked 'billed'. Else 500
 * BILLABLE_LINK_BROKEN and the edit rolls back.
 */
export async function assertSourceLinksIntact(executor: DbOrTx, tenantId: string, sourceTxnId: string): Promise<void> {
  const links = await executor.select({ lineId: billableCostLinks.sourceLineId }).from(billableCostLinks)
    .where(and(
      eq(billableCostLinks.tenantId, tenantId),
      eq(billableCostLinks.sourceTransactionId, sourceTxnId),
      isNull(billableCostLinks.releasedAt),
    ));
  if (links.length === 0) return;
  const ids = links.map((l) => l.lineId);
  const lines = await executor.select({ id: journalLines.id }).from(journalLines)
    .where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, sourceTxnId),
      inArray(journalLines.id, ids),
      eq(journalLines.billedStatus, 'billed'),
      eq(journalLines.isVoidReversal, false),
    ));
  if (lines.length !== ids.length) {
    throw new AppError(500, 'A billed cost lost its invoice link; the change was rolled back.', 'BILLABLE_LINK_BROKEN');
  }
}

/**
 * The invoice each billed line of a source is on (source reads):
 * Map<sourceLineId, {invoiceId, invoiceNumber}>. `companyId`: the reader's
 * company; an invoice of another company shows as null (review S-5: a
 * tenant-wide cost billed by another company must not name its invoice).
 */
export async function billedInvoicesForLines(
  executor: DbOrTx, tenantId: string, lineIds: readonly string[], companyId?: string | null,
): Promise<Map<string, { invoiceId: string | null; invoiceNumber: string | null }>> {
  if (lineIds.length === 0) return new Map();
  const rows = await executor.select({
    lineId: billableCostLinks.sourceLineId, invoiceId: billableCostLinks.invoiceId, invoiceNumber: transactions.txnNumber,
    invoiceCompanyId: transactions.companyId,
  }).from(billableCostLinks)
    .leftJoin(transactions, and(eq(transactions.tenantId, billableCostLinks.tenantId), eq(transactions.id, billableCostLinks.invoiceId)))
    .where(and(
      eq(billableCostLinks.tenantId, tenantId),
      inArray(billableCostLinks.sourceLineId, [...lineIds]),
      isNull(billableCostLinks.releasedAt),
    ));
  return new Map(rows.map((r) => [r.lineId, companyId && r.invoiceCompanyId && r.invoiceCompanyId !== companyId
    ? { invoiceId: null, invoiceNumber: null }
    : { invoiceId: r.invoiceId, invoiceNumber: r.invoiceNumber ?? null }]));
}

/**
 * Invariant I1 (tests and diagnostics): the tenant's live source lines
 * marked 'billed' are exactly the source lines of active links, one to one;
 * each active link's invoice is a posted invoice and its source line is
 * billable, on a posted source of the same company and customer. Returns
 * the problems found (empty when it holds).
 */
export async function checkBillableInvariant(executor: DbOrTx, tenantId: string): Promise<string[]> {
  const problems: string[] = [];
  const orphanBilled = await executor.execute(sql`
    SELECT jl.id FROM journal_lines jl
    WHERE jl.tenant_id = ${tenantId} AND jl.billed_status = 'billed' AND jl.is_void_reversal = false
      AND NOT EXISTS (SELECT 1 FROM billable_cost_links l
        WHERE l.tenant_id = jl.tenant_id AND l.source_line_id = jl.id AND l.released_at IS NULL)`);
  for (const r of orphanBilled.rows as Array<{ id: string }>) problems.push(`billed line without a link: ${r.id}`);
  const bad = await executor.execute(sql`
    SELECT l.id, l.source_line_id,
      jl.id AS jl_id, jl.billed_status, jl.is_billable, jl.contact_id, jl.company_id AS jl_company,
      src.status AS src_status, src.id AS src_id,
      inv.status AS inv_status, inv.txn_type AS inv_type, inv.contact_id AS inv_contact, inv.company_id AS inv_company
    FROM billable_cost_links l
    LEFT JOIN journal_lines jl ON jl.tenant_id = l.tenant_id AND jl.id = l.source_line_id
    LEFT JOIN transactions src ON src.tenant_id = l.tenant_id AND src.id = jl.transaction_id
    LEFT JOIN transactions inv ON inv.tenant_id = l.tenant_id AND inv.id = l.invoice_id
    WHERE l.tenant_id = ${tenantId} AND l.released_at IS NULL`);
  for (const r of bad.rows as Array<Record<string, unknown>>) {
    const id = String(r['id']);
    if (!r['jl_id']) { problems.push(`link ${id}: source line missing`); continue; }
    if (r['billed_status'] !== 'billed' || r['is_billable'] !== true) problems.push(`link ${id}: source line not billed`);
    if (r['src_status'] !== 'posted') problems.push(`link ${id}: source not posted`);
    if (r['inv_status'] !== 'posted' || r['inv_type'] !== 'invoice') problems.push(`link ${id}: invoice not posted`);
    if (r['contact_id'] !== r['inv_contact']) problems.push(`link ${id}: customer differs`);
    if (r['jl_company'] && r['inv_company'] && r['jl_company'] !== r['inv_company']) problems.push(`link ${id}: company differs`);
  }
  const dup = await executor.execute(sql`
    SELECT source_line_id FROM billable_cost_links WHERE tenant_id = ${tenantId} AND released_at IS NULL
    GROUP BY source_line_id HAVING count(*) > 1`);
  for (const r of dup.rows as Array<{ source_line_id: string }>) problems.push(`two active links: ${r.source_line_id}`);
  return problems;
}

/**
 * The company's billable-cost markup account (U-128): an active income
 * account (revenue or other_revenue) of this tenant, tenant-wide or of
 * `companyId`. Otherwise 400 MARKUP_ACCOUNT_INVALID.
 */
export async function assertMarkupAccount(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined, accountId: string,
): Promise<void> {
  const [row] = await executor.select({
    id: accounts.id, companyId: accounts.companyId, accountType: accounts.accountType, isActive: accounts.isActive,
  }).from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))).limit(1);
  const invalid = (message: string) => AppError.badRequest(message, 'MARKUP_ACCOUNT_INVALID', { accountId });
  if (!row || (companyId && row.companyId !== null && row.companyId !== companyId)) {
    throw invalid('The markup account is not an account of this company.');
  }
  if (row.isActive === false) throw invalid('The markup account is inactive.');
  if (row.accountType !== 'revenue' && row.accountType !== 'other_revenue') {
    throw invalid('The markup account must be an income account.');
  }
}

/**
 * 400 RECURRING_HAS_BILLABLE_COSTS when the transaction is an invoice that
 * bills costs (Q-P20ah): such an invoice can't be made recurring, since
 * each cost is billed once.
 */
export async function assertNoBillableCostsForRecurring(executor: DbOrTx, tenantId: string, transactionId: string): Promise<void> {
  const [row] = await executor.select({ id: journalLines.id }).from(journalLines)
    .innerJoin(transactions, and(eq(transactions.tenantId, journalLines.tenantId), eq(transactions.id, journalLines.transactionId)))
    .where(and(
      eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, transactionId),
      eq(transactions.txnType, 'invoice'),
      or(isNotNull(journalLines.billableSourceLineId), inArray(journalLines.lineRole, ['billable_cost', 'billable_markup'])),
    ))
    .limit(1);
  if (row) {
    throw AppError.badRequest(
      'An invoice that bills costs can\'t repeat: each cost is billed once. Make the schedule from an invoice without billable costs.',
      'RECURRING_HAS_BILLABLE_COSTS',
    );
  }
}
