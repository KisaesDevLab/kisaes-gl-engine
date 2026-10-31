// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Billable costs (U-128, billable-costs-v1): the costs a client can be
 * billed for (GET /billable-costs), and the claim an invoice makes on them.
 *
 * A cost is a journal line marked billable to a customer (U-50: a check,
 * expense, card charge or bill line, is_billable with contact_id). An
 * invoice line with billableSourceLineId bills it: the line's figures come
 * from the cost (utils/invoice-compute.ts billableFigures), the cost line
 * goes to 'billed' and a billable_cost_links row records which invoice holds
 * it. Rules (the U-128 design, owner answers Q-P20w..z, Q-P20p):
 *   - the cost credits the invoice line's own income account (accountId,
 *     required); the markup credits the company markup account, stored on
 *     the link and kept on every edit;
 *   - a cost is billed whole, once, to its own customer, from a posted
 *     source of the request's company;
 *   - a cost dated in a closed period needs no closing password (nothing of
 *     the source changes); every claim and release is audited on the source.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { billableCostLinks, contacts, journalLines, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditBilledState, lockSourceTransactions, type BillableLink } from './billable-links.js';
import type { BillableFigures } from '../utils/invoice-compute.js';

const Decimal = DecimalLib.default || DecimalLib;

/** A row of another company than the request's (company-null rows are in every company). */
function inOtherCompany(row: { companyId: string | null }, companyId: string | null | undefined): boolean {
  return !!companyId && !!row.companyId && row.companyId !== companyId;
}

// ─── GET /billable-costs ────────────────────────────────────────────

export interface BillableCostListFilters {
  contactId?: string;
  projectId?: string;
  limit?: number;
  offset?: number;
}

/**
 * The company's unbilled costs: lines billable to a customer, not billed,
 * on a posted source (not a void reversal), of the request's company (or
 * of none). Sorted by source date, then line id. totalCount and
 * totalAmount (the sum of costAmount) are over every page. projectId is
 * accepted and ignored until projects-v1.
 */
export async function listBillableCosts(tenantId: string, filters: BillableCostListFilters, companyId?: string) {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const where = sql`jl.tenant_id = ${tenantId}
    AND jl.billed_status = 'unbilled' AND jl.is_billable = true AND jl.is_void_reversal = false
    AND t.status = 'posted'
    ${companyId ? sql`AND (t.company_id = ${companyId} OR t.company_id IS NULL)` : sql``}
    ${filters.contactId ? sql`AND jl.contact_id = ${filters.contactId}` : sql``}`;
  const totals = await db.execute(sql`
    SELECT count(*)::int AS n, coalesce(sum(round(jl.debit - jl.credit, 2)), 0)::text AS amount
    FROM journal_lines jl JOIN transactions t ON t.tenant_id = jl.tenant_id AND t.id = jl.transaction_id
    WHERE ${where}`);
  const rows = await db.execute(sql`
    SELECT jl.id AS source_line_id, jl.transaction_id, t.txn_type, t.txn_number, t.txn_date::text AS txn_date,
      v.display_name AS vendor_name, jl.description, jl.account_id, jl.item_id, jl.quantity::text AS quantity,
      jl.unit_price::text AS unit_price, (jl.debit - jl.credit)::text AS source_amount,
      jl.contact_id, i.income_account_id
    FROM journal_lines jl
    JOIN transactions t ON t.tenant_id = jl.tenant_id AND t.id = jl.transaction_id
    LEFT JOIN contacts v ON v.tenant_id = t.tenant_id AND v.id = t.contact_id
    LEFT JOIN items i ON i.tenant_id = jl.tenant_id AND i.id = jl.item_id
    WHERE ${where}
    ORDER BY t.txn_date, jl.transaction_id, jl.line_order, jl.id
    LIMIT ${limit} OFFSET ${offset}`);
  let defaultMarkupPercent: string | null = null;
  if (filters.contactId) {
    const [c] = await db.select({ p: contacts.defaultMarkupPercent, companyId: contacts.companyId }).from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, filters.contactId))).limit(1);
    if (c && !inOtherCompany(c, companyId)) defaultMarkupPercent = c.p ?? null;
  }
  const total = (totals.rows[0] ?? { n: 0, amount: '0' }) as { n: number; amount: string };
  return {
    items: (rows.rows as Array<Record<string, string | null>>).map((r) => {
      const source = new Decimal(r['source_amount'] ?? '0');
      return {
        sourceLineId: r['source_line_id']!,
        sourceTransactionId: r['transaction_id']!,
        sourceTxnType: r['txn_type']!,
        sourceNumber: r['txn_number'] ?? null,
        sourceDate: r['txn_date']!,
        contactId: r['contact_id'] ?? null,
        vendorName: r['vendor_name'] ?? null,
        description: r['description'] ?? null,
        expenseAccountId: r['account_id']!,
        itemId: r['item_id'] ?? null,
        quantity: r['quantity'] ?? null,
        unitCost: r['unit_price'] ?? null,
        sourceAmount: source.toFixed(4),
        costAmount: source.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
        suggestedIncomeAccountId: r['income_account_id'] ?? null,
        suggestedIncomeAccountSource: r['income_account_id'] ? 'item' as const : null,
      };
    }),
    totalCount: Number(total.n),
    totalAmount: new Decimal(total.amount).toFixed(2),
    defaultMarkupPercent,
    limit,
    offset,
  };
}

// ─── Claim ──────────────────────────────────────────────────────────

export interface BillableSource {
  line: typeof journalLines.$inferSelect;
  txn: { id: string; txnType: string; txnNumber: string | null; txnDate: string; status: string; companyId: string | null };
  /** The active link holding the cost, if any, with its invoice's number and company. */
  link: (BillableLink & { invoiceNumber: string | null; invoiceCompanyId: string | null }) | null;
}

/**
 * The cost lines `ids` with their source and active link. With `lockTx`,
 * the source transactions are locked first (id order, review B2) — plus
 * `alsoLockTxnIds` (the sources of the invoice's current links) — and the
 * lines re-read under the lock.
 */
export async function loadBillableSources(
  executor: DbOrTx, tenantId: string, ids: readonly string[],
  opts: { lockTx?: Tx; alsoLockTxnIds?: readonly string[] } = {},
): Promise<Map<string, BillableSource>> {
  const unique = [...new Set(ids)];
  if (opts.lockTx) {
    const pre = unique.length === 0 ? [] : await executor.select({ txnId: journalLines.transactionId }).from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), inArray(journalLines.id, unique)));
    await lockSourceTransactions(opts.lockTx, tenantId, [...pre.map((p) => p.txnId), ...(opts.alsoLockTxnIds ?? [])]);
  }
  const out = new Map<string, BillableSource>();
  if (unique.length === 0) return out;
  const lines = await executor.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, tenantId), inArray(journalLines.id, unique)));
  const txnIds = [...new Set(lines.map((l) => l.transactionId))];
  const txns = txnIds.length === 0 ? [] : await executor.select({
    id: transactions.id, txnType: transactions.txnType, txnNumber: transactions.txnNumber, txnDate: transactions.txnDate,
    status: transactions.status, companyId: transactions.companyId,
  }).from(transactions).where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, txnIds)));
  const links = await executor.select({
    link: billableCostLinks, invoiceNumber: transactions.txnNumber, invoiceCompanyId: transactions.companyId,
  }).from(billableCostLinks)
    .leftJoin(transactions, and(eq(transactions.tenantId, billableCostLinks.tenantId), eq(transactions.id, billableCostLinks.invoiceId)))
    .where(and(
      eq(billableCostLinks.tenantId, tenantId),
      inArray(billableCostLinks.sourceLineId, unique),
      sql`${billableCostLinks.releasedAt} IS NULL`,
    ));
  const txnById = new Map(txns.map((t) => [t.id, t]));
  const linkByLine = new Map(links.map((l) => [l.link.sourceLineId, l]));
  for (const line of lines) {
    const txn = txnById.get(line.transactionId);
    if (!txn) continue;
    const l = linkByLine.get(line.id);
    out.set(line.id, {
      line,
      txn: { ...txn, status: txn.status ?? 'posted' },
      link: l ? { ...l.link, invoiceNumber: l.invoiceNumber ?? null, invoiceCompanyId: l.invoiceCompanyId ?? null } : null,
    });
  }
  return out;
}

export interface BillableCheckResult {
  /** Costs another invoice holds (preview reports them per line; POST / PUT refuse). */
  alreadyBilled: Map<string, { invoiceId: string | null; invoiceNumber: string | null }>;
}

/**
 * Checks the cost lines an invoice request bills (rule 1, rule 8):
 *   409 BILLABLE_COST_UNAVAILABLE  missing (or a stale id), not billable, a
 *       void reversal, on a source not posted, or of another company;
 *   409 BILLABLE_ALREADY_BILLED     held by another invoice (or 'billed' with
 *       no link); details.conflicts[{sourceLineId, invoiceId, invoiceNumber}]
 *       name the invoice only when it is of the request's company;
 *   400 BILLABLE_CONTACT_MISMATCH   the cost's customer is not the invoice's.
 * Every conflicting cost is listed in one response (S12). With
 * `reportBilled` (preview), already-billed costs are returned, not thrown.
 */
export function checkBillableSources(
  sources: Map<string, BillableSource>, ids: readonly string[],
  ctx: { contactId: string; invoiceId: string | null; companyId: string | null | undefined; reportBilled?: boolean },
): BillableCheckResult {
  const unavailable: Array<{ sourceLineId: string }> = [];
  const billed: Array<{ sourceLineId: string; invoiceId?: string; invoiceNumber?: string | null }> = [];
  const mismatch: Array<{ sourceLineId: string }> = [];
  const alreadyBilled = new Map<string, { invoiceId: string | null; invoiceNumber: string | null }>();
  for (const id of ids) {
    const s = sources.get(id);
    if (!s || s.line.isVoidReversal || !s.line.isBillable || !s.line.billedStatus
      || s.txn.status !== 'posted' || inOtherCompany(s.txn, ctx.companyId)) {
      unavailable.push({ sourceLineId: id });
      continue;
    }
    const ours = s.link !== null && ctx.invoiceId !== null && s.link.invoiceId === ctx.invoiceId;
    if (s.line.billedStatus === 'billed' && !ours) {
      // Name the invoice only when the request may see it (rule 8).
      const visible = s.link && !inOtherCompany({ companyId: s.link.invoiceCompanyId }, ctx.companyId);
      billed.push(visible
        ? { sourceLineId: id, invoiceId: s.link!.invoiceId, invoiceNumber: s.link!.invoiceNumber }
        : { sourceLineId: id });
      alreadyBilled.set(id, { invoiceId: visible ? s.link!.invoiceId : null, invoiceNumber: visible ? s.link!.invoiceNumber : null });
      continue;
    }
    if ((s.line.contactId ?? null) !== ctx.contactId) mismatch.push({ sourceLineId: id });
  }
  if (unavailable.length > 0) {
    throw AppError.conflict('One or more costs are no longer available to bill (changed, voided or removed). Reload the costs and try again.',
      'BILLABLE_COST_UNAVAILABLE', { conflicts: unavailable });
  }
  if (billed.length > 0 && !ctx.reportBilled) {
    const first = billed.find((b) => b.invoiceNumber);
    throw AppError.conflict(first
      ? `One or more costs are already on invoice ${first.invoiceNumber}. Reload the costs and try again.`
      : 'One or more costs are already on another invoice. Reload the costs and try again.',
    'BILLABLE_ALREADY_BILLED', { conflicts: billed });
  }
  if (mismatch.length > 0) {
    throw AppError.badRequest('One or more costs are billable to another customer than this invoice’s.',
      'BILLABLE_CONTACT_MISMATCH', { conflicts: mismatch });
  }
  return { alreadyBilled };
}

export interface BillableClaim {
  sourceLineId: string;
  sourceTransactionId: string;
  figures: BillableFigures;
  markupAccountId: string | null;
  /** The active link of this invoice already holding the cost (an edit keeps it). */
  existingLinkId: string | null;
}

/**
 * Writes an invoice's claims, under the source locks its caller took:
 * a new cost goes to 'billed' and gets a link (and a source audit row); a
 * kept one keeps its link, with the markup recomputed. Returns the source
 * line ids newly claimed.
 */
export async function writeClaims(
  tx: Tx, tenantId: string, companyId: string | null, invoiceId: string, claims: readonly BillableClaim[], userId?: string,
): Promise<string[]> {
  const claimed: string[] = [];
  for (const c of claims) {
    const values = {
      costAmount: c.figures.costAmount,
      markupPercent: c.figures.markupPercent,
      markupAmount: c.figures.markupAmount,
      markupAccountId: c.markupAccountId,
    };
    if (c.existingLinkId) {
      await tx.update(billableCostLinks).set(values)
        .where(and(eq(billableCostLinks.tenantId, tenantId), eq(billableCostLinks.id, c.existingLinkId)));
      continue;
    }
    const [line] = await tx.update(journalLines).set({ billedStatus: 'billed' })
      .where(and(
        eq(journalLines.tenantId, tenantId),
        eq(journalLines.id, c.sourceLineId),
        eq(journalLines.billedStatus, 'unbilled'),
      ))
      .returning({ id: journalLines.id });
    if (!line) {
      throw AppError.conflict('A cost is no longer available to bill. Reload the costs and try again.',
        'BILLABLE_COST_UNAVAILABLE', { conflicts: [{ sourceLineId: c.sourceLineId }] });
    }
    await tx.insert(billableCostLinks).values({
      tenantId, companyId, sourceTransactionId: c.sourceTransactionId, sourceLineId: c.sourceLineId, invoiceId,
      ...values, createdBy: userId ?? null,
    });
    await auditBilledState(tx, tenantId, c.sourceTransactionId, c.sourceLineId, 'unbilled', 'billed', invoiceId, userId);
    claimed.push(c.sourceLineId);
  }
  return claimed;
}

/**
 * Maps the database backstops of a claim (review B2): the partial unique
 * index (a second active link for one cost) to 409 BILLABLE_ALREADY_BILLED,
 * a deadlock to 409 RETRY. The transaction is already rolled back.
 */
export async function mapBillableDbErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
    const code = err?.code ?? err?.cause?.code;
    const constraint = err?.constraint ?? err?.cause?.constraint;
    if (code === '23505' && constraint === 'uq_bcl_active_source') {
      throw AppError.conflict('One or more costs are already on another invoice. Reload the costs and try again.',
        'BILLABLE_ALREADY_BILLED', { conflicts: [] });
    }
    if (code === '40P01') {
      throw AppError.conflict('Someone else was changing the same records. Try again.', 'RETRY');
    }
    throw e;
  }
}

/**
 * GET /invoices/:id billableCosts: one entry per cost the invoice bills
 * (its cost and markup journal lines grouped by billableSourceLineId), with
 * the link's figures. A void invoice's costs are released; its last links
 * still describe its lines.
 */
export async function billableCostsForInvoice(
  executor: DbOrTx, tenantId: string, invoiceId: string,
  lines: ReadonlyArray<{ id: string; accountId: string; credit: string | null; debit: string | null; lineRole: string | null; billableSourceLineId: string | null; quantity?: string | null }>,
) {
  const byLine = new Map<string, { cost?: (typeof lines)[number]; markup?: (typeof lines)[number] }>();
  for (const l of lines) {
    if (!l.billableSourceLineId) continue;
    const e = byLine.get(l.billableSourceLineId) ?? {};
    if (l.lineRole === 'billable_markup') e.markup = l; else e.cost = l;
    byLine.set(l.billableSourceLineId, e);
  }
  if (byLine.size === 0) return [];
  const ids = [...byLine.keys()];
  const rows = await executor.select({
    link: billableCostLinks, sourceTxnType: transactions.txnType, sourceNumber: transactions.txnNumber,
  }).from(billableCostLinks)
    .leftJoin(transactions, and(eq(transactions.tenantId, billableCostLinks.tenantId), eq(transactions.id, billableCostLinks.sourceTransactionId)))
    .where(and(
      eq(billableCostLinks.tenantId, tenantId),
      eq(billableCostLinks.invoiceId, invoiceId),
      inArray(billableCostLinks.sourceLineId, ids),
    ))
    .orderBy(sql`${billableCostLinks.createdAt} DESC`, billableCostLinks.id);
  const latest = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!latest.has(r.link.sourceLineId)) latest.set(r.link.sourceLineId, r);
  const money = (l?: (typeof lines)[number]) => new Decimal(l?.credit || '0').minus(l?.debit || '0');
  return ids.map((id) => {
    const e = byLine.get(id)!;
    const r = latest.get(id);
    const amount = money(e.cost).plus(money(e.markup));
    // The invoice's own cost line quantity, as the PDF prints it (review S-6):
    // a later edit of the source line's quantity doesn't move it.
    const sq = e.cost?.quantity;
    const q = sq && !new Decimal(sq).isZero() ? new Decimal(sq) : new Decimal(1);
    return {
      sourceLineId: id,
      sourceTransactionId: r?.link.sourceTransactionId ?? null,
      sourceTxnType: r?.sourceTxnType ?? null,
      sourceNumber: r?.sourceNumber ?? null,
      costAmount: money(e.cost).toFixed(2),
      markupPercent: r ? new Decimal(r.link.markupPercent).toFixed(4) : '0.0000',
      markupAmount: money(e.markup).toFixed(2),
      amount: amount.toFixed(2),
      quantity: q.toString(),
      displayRate: amount.dividedBy(q).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4),
      incomeAccountId: e.cost?.accountId ?? null,
      markupAccountId: e.markup?.accountId ?? r?.link.markupAccountId ?? null,
      costLineId: e.cost?.id ?? null,
      markupLineId: e.markup?.id ?? null,
      billed: r ? r.link.releasedAt === null : false,
    };
  });
}
