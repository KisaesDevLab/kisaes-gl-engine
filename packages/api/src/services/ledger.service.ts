// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, or, sql, lte, count, inArray, notInArray, isNull } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import type { JournalLineInput, TxnType, TxnStatus, PaymentMethod, BulkUpdateTransactionsInput, BulkUpdateTransactionsResult } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { transactions, journalLines, accounts, companies, contacts, reconciliations, reconciliationLines, bankFeedItems, transactionTags, items } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { env } from '../config/env.js';
import { deriveHeaderTags } from './tags/derive-header-tags.js';
import { getLockContext } from './lock-context.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import { closingPasswordMatches, closingPasswordInvalid, auditClosingPasswordFailed } from './closing-password.service.js';
import { resolveDefaultTag } from './tags/resolve-default-tag.js';
import { escapeLike } from '../utils/sql-like.js';
import { assertNotDeposited, releaseDepositLinks, liveDepositsForSource } from './deposit-links.service.js';
import { releaseBilledCosts, assertSourceLinksIntact, billedInvoicesForLines } from './billable-links.js';

// ADR 0XY §3.2 — belt-and-suspenders default-tag resolution at the
// ledger write path. When the split-level tags flag is on we batch-load
// both sources available at this layer — the contact's default_tag_id
// and items.default_tag_id for every itemId present on the lines — and
// feed them into `resolveDefaultTag` per line. Bank-rule and AI sources
// are attached by the calling service and flow through verbatim.
async function loadContactDefaultTagId(
  executor: DbOrTx,
  tenantId: string,
  contactId: string | null | undefined,
): Promise<string | null> {
  if (!contactId) return null;
  if (!env.TAGS_SPLIT_LEVEL_V2) return null;
  const rows = await executor
    .select({ defaultTagId: contacts.defaultTagId, contactType: contacts.contactType })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // ADR 0XY §2.1 — contact default only applies to vendor-type contacts.
  // Customers do not contribute to the default-tag chain.
  if (row.contactType !== 'vendor' && row.contactType !== 'both') return null;
  return row.defaultTagId ?? null;
}

// Batch-load items.default_tag_id for every distinct itemId referenced by
// the input lines. Returns a Map keyed by itemId so the resolver lookup
// stays O(1) inside the per-line loop. One query per transaction, not
// one per line — critical for invoices with many items.
async function loadItemDefaultTagMap(
  executor: DbOrTx,
  tenantId: string,
  lines: Array<{ itemId?: string | null | undefined }>,
): Promise<Map<string, string | null>> {
  if (!env.TAGS_SPLIT_LEVEL_V2) return new Map();
  const itemIds = Array.from(
    new Set(
      lines
        .map((l) => l.itemId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ),
  );
  if (itemIds.length === 0) return new Map();
  const rows = await executor
    .select({ id: items.id, defaultTagId: items.defaultTagId })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), inArray(items.id, itemIds)));
  const map = new Map<string, string | null>();
  for (const r of rows) map.set(r.id, r.defaultTagId ?? null);
  return map;
}

// ADR 0XX §4: when TAGS_SPLIT_LEVEL_V2 is on, journal_lines.tag_id is
// authoritative and transaction_tags is a derived compatibility surface.
// On every ledger write we replace the junction rows for this transaction
// with the set of distinct tag IDs present on its lines. When the flag is
// off (rollout states 1–3) we leave transaction_tags alone — it stays
// authoritative and tags.service.ts remains the sole writer.
//
// ADR 0XX §3.1 backfill rule "first-assigned wins" means multi-tag header
// transactions end up with every line stamped with the earliest tag.
// Re-syncing from lines then collapses the junction to that single tag,
// silently dropping the secondary tags. We detect that here and audit-log
// it so multi-tag tenants have a paper trail and can reconcile with
// ADR 0XX §5.3 multi-tag-per-line future work.
async function syncTransactionTagsFromLines(
  executor: DbOrTx,
  tenantId: string,
  companyId: string | null,
  transactionId: string,
  lines: Array<{ tagId?: string | null | undefined }>,
  // Header tags kept beside the line-derived ones (a check's own tags, U-80).
  keepTagIds: readonly string[] = [],
): Promise<void> {
  if (!env.TAGS_SPLIT_LEVEL_V2) return;
  const tagIds = [...new Set([...deriveHeaderTags(lines), ...keepTagIds])];

  // Read existing junction rows before we clobber them — needed so we can
  // log exactly which tags get dropped. One SELECT is cheap; multi-tag
  // transactions are rare in practice.
  const existing = await executor
    .select({ tagId: transactionTags.tagId })
    .from(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, transactionId)));
  const existingIds = existing.map((r) => r.tagId);
  const newSet = new Set(tagIds);
  const dropped = existingIds.filter((id) => !newSet.has(id));

  await executor
    .delete(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, transactionId)));
  if (tagIds.length > 0) {
    await executor.insert(transactionTags).values(
      tagIds.map((tagId) => ({ tenantId, companyId, transactionId, tagId })),
    );
  }

  if (dropped.length > 0) {
    // Best-effort audit trail; never block the ledger write on a logging
    // failure. auditLog writes to its own table, so even if this throws
    // on a flaky DB connection the core write has already committed.
    try {
      await auditLog(
        tenantId,
        'update',
        'transaction_tags',
        transactionId,
        { tagIds: existingIds },
        { tagIds, droppedTagIds: dropped, reason: 'multi_tag_collapsed_by_line_sync' },
      );
    } catch {
      // Intentionally swallow — audit-log pressure shouldn't break ledger writes.
    }
  }
}

/**
 * A check's own header tags (U-80): POST / PUT /checks write tagIds to
 * transaction_tags beside the ones derived from its lines, so with
 * TAGS_SPLIT_LEVEL_V2 on an edit that re-derives the header from the lines
 * would drop them. Returns the header tags of a transaction with a print
 * status that its current lines don't account for; the edit keeps those.
 * Tags that come from the lines keep following the lines. Empty when the
 * flag is off (transaction_tags is then left alone anyway) or the
 * transaction is not a check.
 */
async function checkHeaderOnlyTags(
  executor: DbOrTx,
  tenantId: string,
  existing: { id: string; printStatus: string | null },
  currentLines: Array<{ tagId?: string | null | undefined; isVoidReversal?: boolean | null }>,
): Promise<string[]> {
  if (!env.TAGS_SPLIT_LEVEL_V2 || existing.printStatus === null) return [];
  const rows = await executor.select({ tagId: transactionTags.tagId }).from(transactionTags)
    .where(and(eq(transactionTags.tenantId, tenantId), eq(transactionTags.transactionId, existing.id)));
  const fromLines = new Set(deriveHeaderTags(currentLines.filter((l) => !l.isVoidReversal)));
  return rows.map((r) => r.tagId).filter((id) => !fromLines.has(id));
}

/**
 * journal_lines billable columns for a line (U-50): a billable line starts
 * 'unbilled'; any other line has no billed status. Callers that accept
 * isBillable check that the line has a contact first.
 */
export function billableColumns(line: { isBillable?: boolean }): { isBillable: boolean; billedStatus: string | null } {
  return line.isBillable === true
    ? { isBillable: true, billedStatus: 'unbilled' }
    : { isBillable: false, billedStatus: null };
}

// id: a carried billed line is re-inserted with its old id (U-128 review B1),
// so the billable_cost_links row that names it never dangles.
type BillableCols = { id?: string; isBillable: boolean; billedStatus: string | null };
type LedgerLine = PostTransactionInput['lines'][number];

/** A transaction's live lines already billed to a customer ('billed'). */
/**
 * The settlement columns of a journal line (migration 0223): the document it
 * settles (deposit grouping U-52 / vendor refund U-54) and its role inside
 * its document ('cash_back', U-53). Absent on the input → NULL.
 */
export function settlementColumns(line: { sourceTransactionId?: string | null; lineRole?: string | null; billableSourceLineId?: string | null }): {
  sourceTransactionId: string | null; lineRole: string | null; billableSourceLineId: string | null;
} {
  return {
    sourceTransactionId: line.sourceTransactionId ?? null,
    lineRole: line.lineRole ?? null,
    // An invoice's billable cost / markup line: the cost line it bills (U-128).
    billableSourceLineId: line.billableSourceLineId ?? null,
  };
}

async function loadBilledLines(executor: DbOrTx, tenantId: string, txnId: string) {
  return executor.select().from(journalLines).where(and(
    eq(journalLines.tenantId, tenantId),
    eq(journalLines.transactionId, txnId),
    eq(journalLines.isVoidReversal, false),
    eq(journalLines.billedStatus, 'billed'),
  )).orderBy(journalLines.lineOrder, journalLines.id);
}

function billedLineConflict(line: { id: string; accountId: string }) {
  return AppError.conflict(
    'A line of this transaction has already been billed to a customer, so its account, amount, customer and billable mark ' +
      'can’t change and it can’t be removed or voided. Remove it from the customer’s invoice first.',
    'LINE_BILLED',
    { lineId: line.id, accountId: line.accountId },
  );
}

/**
 * Billable columns for an edit's new line set (U-50). The ledger edit
 * deletes and re-inserts lines, so a line's billed state is carried over by
 * identity: every existing 'billed' line must reappear as a billable input
 * line with the same account, debit, credit and customer (description and
 * tag may change), and that input line keeps 'billed'. A billed line with
 * no such match — removed, or its amount / account / customer / billable
 * mark changed — refuses the edit with 409 LINE_BILLED. Every other line
 * gets billableColumns() (billable → 'unbilled'). A carried line keeps its
 * id (U-128 review B1): the edit deleted the old row earlier in the same
 * transaction, so re-inserting it with that id can't clash, and the
 * billable_cost_links row naming it stays valid. Identical billed lines pair
 * up in line order.
 */
function planBillableColumns(
  inputLines: readonly LedgerLine[],
  billedLines: Array<{ id: string; accountId: string; debit: string | null; credit: string | null; contactId: string | null }>,
): (line: LedgerLine) => BillableCols {
  const amt = (v: string | null | undefined) => new Decimal(v || '0');
  const carried = new Map<LedgerLine, string>();
  for (const billed of billedLines) {
    const match = inputLines.find((l) => !carried.has(l)
      && l.isBillable === true
      && l.accountId === billed.accountId
      && (l.contactId ?? null) === (billed.contactId ?? null)
      && amt(l.debit).equals(amt(billed.debit))
      && amt(l.credit).equals(amt(billed.credit)));
    if (!match) throw billedLineConflict(billed);
    carried.set(match, billed.id);
  }
  return (line) => {
    const id = carried.get(line);
    return id ? { id, isBillable: true, billedStatus: 'billed' } : billableColumns(line);
  };
}

/**
 * Void / delete (U-50): a voided or deleted transaction's costs are no
 * longer billable, so its billable lines are cleared (is_billable false,
 * billed_status NULL — the pair the CHECK constraint allows; the audit
 * before-image keeps the old marks). A line already 'billed' refuses the
 * void / delete with 409 LINE_BILLED, as an edit removing it would.
 */
async function releaseBillableLines(executor: DbOrTx, tenantId: string, txnId: string) {
  const billed = await loadBilledLines(executor, tenantId, txnId);
  if (billed.length > 0) throw billedLineConflict(billed[0]!);
  await executor.update(journalLines).set({ isBillable: false, billedStatus: null }).where(and(
    eq(journalLines.tenantId, tenantId),
    eq(journalLines.transactionId, txnId),
    eq(journalLines.isBillable, true),
  ));
}

/**
 * Every journal line references an accountId. The caller supplies those IDs
 * in their request body — we cannot assume they belong to this tenant just
 * because the enclosing transaction row will. This runs a single query to
 * confirm every distinct accountId in the input is owned by the tenant (and
 * by the company, when a companyId is given). Without it, a malicious but
 * authenticated user in tenant A could post journal lines against an
 * account UUID belonging to tenant B — the lines would land with tenantId=A
 * but the foreign-key reference corrupts tenant B's balance denormalization.
 */
// Exported so divergent posting paths (bill payments) can apply the
// same tenant/company account-scope guard as postTransaction.
export async function assertAccountsInScope(
  executor: DbOrTx,
  tenantId: string,
  companyId: string | null | undefined,
  accountIds: string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  const unique = [...new Set(accountIds)];
  const rows = await executor
    .select({ id: accounts.id, companyId: accounts.companyId })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, unique)));
  if (rows.length !== unique.length) {
    throw AppError.badRequest('One or more journal line accounts do not belong to this tenant');
  }
  // Company-level check: if the caller is acting within a company scope,
  // only tenant-wide accounts (companyId IS NULL) and accounts belonging to
  // that same company are valid. Otherwise an invoice for company A could
  // post revenue to company B's income account inside the same tenant.
  if (companyId) {
    for (const row of rows) {
      if (row.companyId !== null && row.companyId !== companyId) {
        throw AppError.badRequest('One or more journal line accounts belong to a different company');
      }
    }
  }
}

// Company-scoped lock check. The previous version selected an ARBITRARY
// company row (`LIMIT 1`, no ORDER BY), so in a multi-company tenant
// whichever row Postgres returned first governed every company — a
// locked year could be silently editable (or an unlocked company
// over-blocked), and the answer could flip with the query plan. Now:
// with a companyId we check that company's lock; without one we apply
// the STRICTEST lock across the tenant (deterministic, and a scope-less
// posting can't sneak under any company's close).
// Exported so posting paths that can't route through postTransaction
// (bill payments) enforce the same policy.
// Actor context for the closed-period rule (TB module ADR-TB-04 /
// CLAUDE.md TB5). Threaded from routes that host the override modal;
// paths that don't thread it (importers, bank feeds, background jobs)
// get the hard 423 and must fail items gracefully — never bypass.
export interface LockDateContext {
  userType?: 'staff' | 'client';
  overrideConfirmed?: boolean;
  userId?: string;
  // Closing-date password from the request body (U-15). Lives only in the
  // request-scoped store; lockContextMiddleware removes it from req.body.
  closingPassword?: string;
  // Hashes the request's closingPassword already matched (request-scoped,
  // cleared with the password). A batch posting many rows into a closed
  // period compares the password once per hash instead of once per row.
  verifiedClosingPasswordHashes?: Set<string>;
}

/** A permitted closed-period posting, for the closing_date_override audit row. */
export interface LockOverride {
  method: 'password' | 'confirmed';
  companyId: string | null;
  lockDate: string;
  lockDateSetBy: string | null;
  lockDateSetAt: unknown;
  txnDate: string;
  userId?: string;
}

/** What the override touched: the transaction and its old/new date. */
export interface LockOverrideFacts {
  txnId?: string | null;
  oldDate?: string | null;
  newDate?: string | null;
}

/**
 * Writes the closing_date_override audit row (ADR-TB-04, U-15): who, which
 * transaction, the old and new date, and how (password or staff
 * confirmation). Never the password.
 */
export async function auditLockOverride(
  executor: DbOrTx,
  tenantId: string,
  override: LockOverride,
  facts: LockOverrideFacts = {},
) {
  await auditLog(tenantId, 'override', 'closing_date_override', facts.txnId ?? override.companyId ?? tenantId,
    { lockDate: override.lockDate, lockDateSetBy: override.lockDateSetBy, lockDateSetAt: override.lockDateSetAt },
    {
      txnDate: override.txnDate,
      method: override.method,
      overrideConfirmed: override.method === 'confirmed',
      transactionId: facts.txnId ?? null,
      oldDate: facts.oldDate ?? null,
      newDate: facts.newDate ?? null,
      companyId: override.companyId,
    },
    override.userId, executor as Tx);
}

/**
 * Closed-period check. Returns undefined when the date is open. A permitted
 * override is audited here, unless `opts.deferAudit` is set: then it is
 * returned and the caller audits it once it knows the transaction id
 * (auditLockOverride), so one change leaves one row with old and new date.
 */
export async function checkLockDate(
  executor: DbOrTx,
  tenantId: string,
  txnDate: string,
  companyId?: string | null,
  ctx?: LockDateContext,
  opts: LockOverrideFacts & { deferAudit?: boolean; ajeExempt?: boolean } = {},
): Promise<LockOverride | undefined> {
  // Explicit ctx wins; otherwise pick up the request-scoped store set
  // by lockContextMiddleware (see services/lock-context.ts).
  ctx = ctx ?? getLockContext();
  const result = companyId
    ? await executor.execute(sql`
        SELECT lock_date, lock_date_set_by, lock_date_set_at,
               closing_password_hash IS NOT NULL AS password_set
        FROM companies
        WHERE tenant_id = ${tenantId} AND id = ${companyId}
      `)
    : await executor.execute(sql`
        SELECT MAX(lock_date) AS lock_date, NULL AS lock_date_set_by, NULL AS lock_date_set_at,
               COALESCE(BOOL_OR(closing_password_hash IS NOT NULL AND lock_date >= ${txnDate}), false) AS password_set
        FROM companies WHERE tenant_id = ${tenantId}
      `);
  const row = (result.rows as any[])[0];
  const lockDate = row?.lock_date;
  if (!lockDate || txnDate > lockDate) return undefined;
  const passwordSet = row?.password_set === true;
  // AJEs (TB5) are exempt from the closing date unless the company has a
  // closing-date password (U-15): then the closed period is locked for
  // them too and the password is the only way in.
  if (opts.ajeExempt && !passwordSet) return undefined;

  const permit = async (method: LockOverride['method']) => {
    const override: LockOverride = {
      method,
      companyId: companyId ?? null,
      lockDate,
      lockDateSetBy: row?.lock_date_set_by ?? null,
      lockDateSetAt: row?.lock_date_set_at ?? null,
      txnDate,
      userId: ctx?.userId,
    };
    if (!opts.deferAudit) await auditLockOverride(executor, tenantId, override, opts);
    return override;
  };

  // Closing-date password (U-15): any actor holding it may post into the
  // closed period. It must match the password of every company whose
  // closed period covers the date; a company without one can't be opened
  // this way. Wrong: 403, nothing changes (rate limited at the route).
  if (ctx?.closingPassword !== undefined) {
    const locking = companyId
      ? await executor.execute(sql`
          SELECT closing_password_hash FROM companies
          WHERE tenant_id = ${tenantId} AND id = ${companyId}
        `)
      : await executor.execute(sql`
          SELECT closing_password_hash FROM companies
          WHERE tenant_id = ${tenantId} AND lock_date IS NOT NULL AND lock_date >= ${txnDate}
        `);
    const hashes = (locking.rows as Array<{ closing_password_hash: string | null }>).map((r) => r.closing_password_hash);
    let ok = hashes.length > 0;
    for (const hash of hashes) {
      if (!ok) break;
      if (hash && ctx.verifiedClosingPasswordHashes?.has(hash)) continue;
      ok = await closingPasswordMatches(hash, ctx.closingPassword);
      if (ok && hash) (ctx.verifiedClosingPasswordHashes ??= new Set()).add(hash);
    }
    if (!ok) {
      await auditClosingPasswordFailed(tenantId, companyId ?? null, ctx.userId, 'posting', {
        transactionId: opts.txnId ?? null, txnDate,
      });
      throw closingPasswordInvalid();
    }
    return permit('password');
  }

  // Firm staff may proceed with an explicit confirmation; the override
  // is audit-logged with the facts a reviewer needs (ADR-TB-04). Once the
  // company has a closing-date password, the password is the only way in.
  if (ctx?.userType === 'staff' && ctx.overrideConfirmed && !passwordSet) {
    return permit('confirmed');
  }
  if (ctx?.userType === 'client' && !passwordSet) {
    throw AppError.locked(
      `This period was closed by your accounting firm on ${lockDate}. Contact them to make changes.`,
      'TB_PERIOD_LOCKED',
      { lockDate, canOverride: false, closingPasswordRequired: false },
    );
  }
  throw AppError.locked(
    `This period was closed on ${String(row?.lock_date_set_at ?? '').slice(0, 10) || lockDate}. Proceeding will change closed-period balances.`,
    'TB_PERIOD_LOCKED',
    { lockDate, canOverride: ctx?.userType === 'staff' && !passwordSet, closingPasswordRequired: passwordSet },
  );
}

interface PostTransactionInput {
  txnType: TxnType;
  txnDate: string;
  // null (edit) clears the stored number; undefined leaves it unchanged.
  txnNumber?: string | null;
  dueDate?: string;
  status?: TxnStatus;
  // Reporting basis: 'both' (default), 'cash', or 'accrual'. Only meaningful
  // for manual journal entries today; all other txns pass 'both'.
  basis?: 'cash' | 'accrual' | 'both';
  contactId?: string;
  memo?: string;
  internalNotes?: string;
  paymentTerms?: string;
  subtotal?: string;
  taxAmount?: string;
  total?: string;
  amountPaid?: string;
  balanceDue?: string;
  invoiceStatus?: string;
  // Invoice / cash sale / credit memo waiting to be printed (U-113; create only).
  printLater?: boolean;
  // Accounts payable fields
  billStatus?: string;
  termsDays?: number;
  creditsApplied?: string;
  vendorInvoiceNumber?: string;
  // Bill terms and received flag (U-86, U-87; create only — the bill
  // service writes them on edit).
  discountPercent?: string | null;
  discountDays?: number | null;
  discountDate?: string | null;
  dueDateOverridden?: boolean;
  discountDateOverridden?: boolean;
  billReceived?: boolean;
  appliedToInvoiceId?: string;
  sourceEstimateId?: string;
  // Source tracking
  source?: string;
  sourceId?: string;
  // How a payment was made + the payer/payee's reference for it.
  paymentMethod?: PaymentMethod;
  referenceNumber?: string;
  // Adjusting entry (U-60). Omitted: false on create (true for an AJE),
  // unchanged on edit.
  isAdjusting?: boolean;
  // Automatic reversing entry (U-61): the journal entry this one reverses.
  // Create only.
  reversesTransactionId?: string;
  // Posted as part of another transaction (U-132): a returned_payment -> the
  // payment it returns; a bounce's bank fee -> the bounce. Create only.
  sourceTxnId?: string;
  // The recurring schedule that posted this transaction (U-64). Create only.
  recurringScheduleId?: string;
  lines: JournalLineInput[];
}

/**
 * A money amount at the scale the ledger stores: 4 places, half away from
 * zero, as numeric(19,4) rounds. Posting builders round each line amount
 * with this first and add up the rounded values for the matching total
 * line (A/R, A/P, deposit account), so the stored lines balance exactly.
 */
export function round4(value: string | number | InstanceType<typeof Decimal> | null | undefined): InstanceType<typeof Decimal> {
  return new Decimal(value == null || value === '' ? '0' : value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/**
 * Debits must equal credits exactly (U-65), at the scale the ledger stores:
 * each line amount is rounded to 4 places the way numeric(19,4) rounds it
 * (half away from zero), then the sums are compared with no tolerance. So
 * what is stored always balances; a difference of 0.0001 is refused.
 */
export function assertBalanced(lines: ReadonlyArray<{ debit?: string | null; credit?: string | null }>): { debits: InstanceType<typeof Decimal>; credits: InstanceType<typeof Decimal> } {
  let debits = new Decimal('0');
  let credits = new Decimal('0');
  for (const line of lines) {
    debits = debits.plus(new Decimal(line.debit || '0').toDecimalPlaces(4, Decimal.ROUND_HALF_UP));
    credits = credits.plus(new Decimal(line.credit || '0').toDecimalPlaces(4, Decimal.ROUND_HALF_UP));
  }
  if (!debits.equals(credits)) {
    throw AppError.badRequest(
      `Transaction does not balance: debits (${debits.toFixed(4)}) != credits (${credits.toFixed(4)})`,
    );
  }
  return { debits, credits };
}

export { PostTransactionInput };

export async function postTransaction(
  tenantId: string,
  input: PostTransactionInput,
  userId?: string,
  companyId?: string,
  // Optional outer transaction. When provided, postTransaction runs all
  // its writes against `outerTx` instead of opening its own — letting
  // higher-level operations (invoice.recordPayment, bill payment, etc.)
  // commit the ledger post together with their own header updates in a
  // single atomic transaction. Without this, a crash between the ledger
  // commit and the caller's follow-up write leaves stored state torn.
  // Postgres doesn't support nested transactions natively (only
  // savepoints), so callers MUST pass `outerTx` rather than starting
  // their own and calling this unsupplied.
  outerTx?: Tx,
) {
  // Validate debits = credits BEFORE opening a database transaction —
  // there's no point holding a tx open while we add up two numbers in
  // memory, and a fast-fail on bad input avoids unnecessary lock churn.
  // Exact decimal comparison, no tolerance (U-65).
  const { debits: totalDebits, credits: totalCredits } = assertBalanced(input.lines);

  if (totalDebits.isZero() && totalCredits.isZero()) {
    throw AppError.badRequest('Transaction must have non-zero amounts');
  }

  // Wrap the transaction header insert + lines insert + balance updates +
  // audit log in a single database transaction. Without this, a crash or
  // error between any two of these steps leaves torn state — a transaction
  // missing its lines, or lines whose accounts.balance was never updated.
  const inner = async (tx: Tx) => {
    // Idempotency-Key (U-18): claimed first, in this transaction, so the
    // key row commits or rolls back with the posting. No-op without one.
    await claimIdempotency(tx);
    // AJEs bypass the closing-date lock by design (TB module D10 /
    // CLAUDE.md TB5): AJE CRUD is firm-only at all times — the tb
    // router is the only path that posts txn_type 'aje', and closing a
    // period is exactly when the firm posts adjusting entries into it.
    // Exception (U-15): with a closing-date password set, an AJE dated in
    // the closed period needs the password like any other posting.
    const lockOverride = await checkLockDate(tx, tenantId, input.txnDate, companyId ?? null, undefined, {
      deferAudit: true, ajeExempt: input.txnType === 'aje',
    });
    await assertAccountsInScope(
      tx,
      tenantId,
      companyId ?? null,
      input.lines.map((l) => l.accountId),
    );

    // Insert transaction header
    const [txn] = await tx.insert(transactions).values({
      tenantId,
      companyId: companyId || null,
      txnType: input.txnType,
      txnNumber: input.txnNumber || null,
      txnDate: input.txnDate,
      dueDate: input.dueDate || null,
      status: input.status || 'posted',
      basis: input.basis || 'both',
      contactId: input.contactId || null,
      memo: input.memo || null,
      internalNotes: input.internalNotes || null,
      paymentTerms: input.paymentTerms || null,
      subtotal: input.subtotal || null,
      taxAmount: input.taxAmount || '0',
      total: input.total || null,
      amountPaid: input.amountPaid || '0',
      balanceDue: input.balanceDue || null,
      invoiceStatus: input.invoiceStatus || null,
      printLater: input.printLater === true,
      billStatus: input.billStatus || null,
      termsDays: input.termsDays ?? null,
      creditsApplied: input.creditsApplied || '0',
      vendorInvoiceNumber: input.vendorInvoiceNumber || null,
      discountPercent: input.discountPercent ?? null,
      discountDays: input.discountDays ?? null,
      discountDate: input.discountDate || null,
      dueDateOverridden: input.dueDateOverridden ?? false,
      discountDateOverridden: input.discountDateOverridden ?? false,
      billReceived: input.billReceived ?? true,
      appliedToInvoiceId: input.appliedToInvoiceId || null,
      sourceEstimateId: input.sourceEstimateId || null,
      source: input.source || null,
      sourceId: input.sourceId || null,
      paymentMethod: input.paymentMethod || null,
      referenceNumber: input.referenceNumber?.trim() || null,
      isAdjusting: input.isAdjusting ?? input.txnType === 'aje',
      reversesTransactionId: input.reversesTransactionId || null,
      sourceTxnId: input.sourceTxnId || null,
      recurringScheduleId: input.recurringScheduleId || null,
    }).returning();

    if (!txn) throw AppError.internal('Failed to create transaction');
    await recordIdempotentEntity(tx, 'transaction', txn.id);

    // ADR 0XY §3.2 — resolve default tags once per transaction before
    // inserting lines. Contact + item defaults are batch-loaded here;
    // bank-rule and AI sources ride along on each line from the caller.
    const [contactDefaultTagId, itemDefaultTagMap] = await Promise.all([
      loadContactDefaultTagId(tx, tenantId, input.contactId),
      loadItemDefaultTagMap(tx, tenantId, input.lines),
    ]);

    // Insert journal lines
    const lineValues = input.lines.map((line, i) => ({
      tenantId,
      companyId: companyId || null,
      transactionId: txn.id,
      accountId: line.accountId,
      debit: line.debit || '0',
      credit: line.credit || '0',
      description: line.description || null,
      itemId: line.itemId || null,
      quantity: line.quantity || null,
      unitPrice: line.unitPrice || null,
      isTaxable: line.isTaxable || false,
      taxRate: line.taxRate || '0',
      taxAmount: line.taxAmount || '0',
      lineOrder: i,
      contactId: line.contactId ?? null,
      serviceDate: line.serviceDate || null,
      discountPercent: line.discountPercent ?? null,
      unitPriceSource: line.unitPriceSource ?? null,
      ...billableColumns(line),
      ...settlementColumns(line),
      tagId: resolveDefaultTag({
        explicitUserTagId: line.tagId,
        bankRuleTagId: line.bankRuleTagId ?? undefined,
        aiSuggestedTagId: line.aiSuggestedTagId ?? undefined,
        itemDefaultTagId: line.itemId ? itemDefaultTagMap.get(line.itemId) ?? null : undefined,
        contactDefaultTagId,
      }),
    }));

    const lines = await tx.insert(journalLines).values(lineValues).returning();

    await syncTransactionTagsFromLines(tx, tenantId, companyId || null, txn.id, lineValues);

    // Update account balances (only for posted transactions)
    if (txn.status === 'posted') {
      await updateAccountBalances(tx, tenantId, input.lines);
    }

    await auditLog(tenantId, 'create', 'transaction', txn.id, null, { txnType: txn.txnType, total: input.total }, userId, tx);
    if (lockOverride) {
      await auditLockOverride(tx, tenantId, lockOverride, { txnId: txn.id, oldDate: null, newDate: input.txnDate });
    }

    return { ...txn, lines };
  };

  // Reuse the outer tx if one was passed in (caller is already inside a
  // transaction), otherwise open our own.
  if (outerTx) return await inner(outerTx);
  return await db.transaction(inner);
}

export interface VoidTransactionOptions {
  /** ap-edit-v1 (U-84): updatedAt as last read; mismatch is 409 STALE. */
  expectedUpdatedAt?: string;
  /** Only this txn type may be voided (the bills / vendor-credits routes); else 400. */
  expectType?: string;
  /**
   * The request's company: a transaction of another company in the tenant
   * is not found (404), checked after the row lock (review M3). Omitted
   * (jobs, daily sales): tenant scope only.
   */
  companyId?: string;
}

/** A row of another company than the request's (a tenant-wide row, company null, is in every company). */
export function inOtherCompany(row: { companyId: string | null }, companyId: string | null | undefined): boolean {
  return !!companyId && !!row.companyId && row.companyId !== companyId;
}

export async function voidTransaction(tenantId: string, txnId: string, reason: string, userId?: string, opts: VoidTransactionOptions = {}) {
  // Wrap in a database transaction AND lock the row up front. Without the
  // row lock, two concurrent void calls on the same transaction can both
  // observe status='posted', both pass the check below, and both call
  // updateAccountBalances — double-reversing the balances and corrupting
  // the trial balance. SELECT … FOR UPDATE serializes the void path so
  // the second caller blocks until the first commits, then reads the
  // already-voided state and throws "already void" cleanly.
  return await db.transaction((tx) => voidTransactionInTx(tx, tenantId, txnId, reason, userId, opts));
}

/** voidTransaction inside the caller's database transaction. */
export async function voidTransactionInTx(tx: Tx, tenantId: string, txnId: string, reason: string, userId?: string, opts: VoidTransactionOptions = {}) {
  {
    await claimIdempotency(tx);
    await recordIdempotentEntity(tx, 'transaction', txnId);
    const [txn] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update')
      .limit(1);

    if (!txn || txn.status === 'deleted' || inOtherCompany(txn, opts.companyId)) throw AppError.notFound('Transaction not found');
    if (opts.expectType && txn.txnType !== opts.expectType) {
      throw AppError.badRequest(opts.expectType === 'bill' ? 'Not a bill' : opts.expectType === 'vendor_credit' ? 'Not a vendor credit'
        : opts.expectType === 'invoice' ? 'Not an invoice' : 'Wrong transaction type');
    }
    if (txn.status === 'void') throw AppError.badRequest('Transaction is already void');
    assertNotStale(txn, opts.expectedUpdatedAt);

    // A bill payment carries its applications (review B1): voiding it as a
    // plain transaction would leave the bills it paid marked paid. It goes
    // through the bill-payment void, in this database transaction.
    if (txn.txnType === 'bill_payment') {
      const { voidBillPaymentInTx } = await import('./bill-payment.service.js');
      await voidBillPaymentInTx(tx, tenantId, txnId, reason, userId, { companyId: opts.companyId });
      return;
    }
    // A bill or vendor credit with anything applied can't be voided (U-84):
    // 409 BILL_HAS_PAYMENTS / CREDIT_APPLIED, read from the application rows
    // under this row lock.
    await assertApDocumentUnapplied(tx, tenantId, txn);
    // An invoice with a live payment or credit applied can't be voided
    // (U-124): 409 INVOICE_HAS_PAYMENTS, read under this row lock.
    await assertInvoiceUnapplied(tx, tenantId, txn);

    // Check lock date against the transaction's date (company-scoped).
    // AJEs are exempt (firm-only CRUD regardless of closing date — TB5)
    // unless the company has a closing-date password (U-15).
    await checkLockDate(tx, tenantId, txn.txnDate, txn.companyId, undefined, {
      txnId, oldDate: txn.txnDate, newDate: null, ajeExempt: txn.txnType === 'aje',
    });

    // Mirror updateTransaction's reconciliation guard: a transaction
    // whose lines are cleared in a COMPLETED bank rec must not be
    // voided directly. Voiding flips status without writing reversing
    // lines onto the cleared journal_lines themselves, which leaves
    // the rec's cleared total stale and unreconcilable. Operator must
    // undo the rec first, then void + post a correction.
    const clearedInCompleted = await tx.execute(sql`
      SELECT 1
      FROM ${reconciliationLines} rl
      JOIN ${reconciliations} r ON r.id = rl.reconciliation_id
      JOIN ${journalLines} jl ON jl.id = rl.journal_line_id
      WHERE r.tenant_id = ${tenantId}
        AND r.status = 'complete'
        AND rl.is_cleared = true
        AND jl.transaction_id = ${txnId}
      LIMIT 1
    `);
    if ((clearedInCompleted.rows as unknown[]).length > 0) {
      throw AppError.badRequest(
        'Cannot void a transaction whose lines are cleared in a completed bank reconciliation. ' +
          'Undo the reconciliation first, then void and post a correcting entry.',
      );
    }

    // A document a posted deposit settles can't be voided under it (the
    // deposit would keep crediting Payments Clearing / A/P for it): 409
    // TXN_DEPOSITED. A deposit being voided releases what it settled
    // (U-52, U-54), so those items are pending again.
    await assertNotDeposited(tx, tenantId, txnId, 'void');
    // Customer payments keep their applications right on every void path
    // (U-132), after the guards above: a deposit whose payment bounced
    // can't be voided (409 PAYMENT_BOUNCED, the bank would drop twice); a
    // payment reopens the invoices it paid (409 PAYMENT_BOUNCED while its
    // bounce is live); a bounce re-applies what it reversed.
    let voidedBounceFeeId: string | null = null;
    if (txn.txnType === 'deposit' || txn.txnType === 'customer_payment' || txn.txnType === 'returned_payment') {
      const payments = await import('./payment.service.js');
      if (txn.txnType === 'deposit') await payments.assertDepositSourcesNotBounced(tx, tenantId, txnId);
      else if (txn.txnType === 'customer_payment') await payments.releasePaymentForVoidInTx(tx, tenantId, txn, userId);
      else voidedBounceFeeId = (await payments.reapplyBounceForVoidInTx(tx, tenantId, txn, userId)).feeId;
    }
    const releasedLinks = await releaseDepositLinks(tx, tenantId, txnId);

    // Get original lines
    const originalLines = await tx.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));

    // A journal entry's automatic reversal (U-61) is voided with it, in this
    // database transaction, if nobody changed it (else 409 REVERSAL_EDITED).
    const reversal = txn.txnType === 'journal_entry' ? await findLiveReversal(tx, tenantId, txnId) : null;
    if (reversal) await assertReversalUnchanged(tx, tenantId, reversal, originalLines);

    // A billing document (an invoice) gives back the costs it billed (U-128,
    // review B3): here, so every void path (the invoice route,
    // /transactions, api-v2, MCP, duplicate merge) releases them.
    const releasedCosts = await releaseBilledCosts(tx, tenantId, txnId, 'invoice_void', userId);
    // Billable lines stop being billable (U-50); a billed line refuses.
    await releaseBillableLines(tx, tenantId, txnId);

    // Mark as void. Tenant_id is included in the WHERE clause for
    // defense-in-depth (CLAUDE.md rule #17) — even though we already
    // confirmed the row belongs to this tenant via the locked SELECT.
    await tx.update(transactions).set({
      status: 'void',
      voidReason: reason,
      voidedAt: new Date(),
      updatedAt: new Date(),
      invoiceStatus: txn.txnType === 'invoice' ? 'void' : txn.invoiceStatus,
      // A void check waiting to print leaves the print queue (U-115).
      ...(txn.printStatus === 'queue' ? { printStatus: null } : {}),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));

    // Create reversing journal lines (swap debits and credits) and
    // PERSIST them on the voided transaction (CLAUDE.md rule #23 —
    // never delete journal_lines; the reversal is part of the audit
    // record). Previously these lines were built only in memory to
    // adjust the denormalized balances and were never inserted, so the
    // DB held no evidence of the reversal. Reports filter
    // status='posted', so lines attached to the void-status header
    // don't affect any report — but SUM(debit−credit) over ALL lines
    // now nets to zero per voided transaction, and the transaction
    // detail view shows exactly what the void did.
    if (originalLines.length > 0) {
      const maxOrder = originalLines.reduce((m, l) => Math.max(m, l.lineOrder ?? 0), 0);
      const reversingLines = originalLines.map((line) => ({
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: `Void: ${line.description || ''}`.trim(),
      }));

      await tx.insert(journalLines).values(originalLines.map((line, i) => ({
        tenantId,
        companyId: line.companyId,
        transactionId: txnId,
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: `Void: ${line.description || ''}`.trim(),
        tagId: line.tagId,
        // The line's name stays on its reversal, as on delete (U-81), so
        // reports by name over all lines net to zero for the void.
        contactId: line.contactId,
        lineOrder: maxOrder + 1 + i,
        isVoidReversal: true,
      })));

      // Reverse account balances
      await updateAccountBalances(tx, tenantId, reversingLines);
    }

    // Full before-image: the header AND the lines as they stood before the
    // void (the reversing lines are new rows, so originalLines is exact).
    await auditLog(tenantId, 'void', 'transaction', txnId, { ...txn, lines: originalLines }, {
      reason,
      ...(releasedLinks.length > 0 ? { releasedDepositLinks: releasedLinks } : {}),
      ...(releasedCosts.length > 0 ? { releasedBillableCosts: releasedCosts } : {}),
      ...(voidedBounceFeeId ? { bounceFeeId: voidedBounceFeeId } : {}),
    }, userId, tx);

    if (reversal) await voidTransactionInTx(tx, tenantId, reversal.id, reason, userId, { companyId: opts.companyId });
  }
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
 * An invoice may be voided only while no live payment or credit is applied
 * to it (U-124, invoice-edit-v1): payment_applications rows of a posted
 * customer payment (Receive Payments), and posted transactions whose
 * applied_to_invoice_id is the invoice (POST /invoices/:id/payment, credit
 * memos). Read on the caller's transaction after the invoice row is locked.
 * 409 INVOICE_HAS_PAYMENTS, details {payments, credits}. Other types: no-op.
 */
export async function assertInvoiceUnapplied(
  executor: DbOrTx,
  tenantId: string,
  txn: { id: string; txnType: string },
): Promise<void> {
  if (txn.txnType !== 'invoice') return;
  const res = await executor.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM payment_applications pa
         JOIN transactions p ON p.id = pa.payment_id AND p.tenant_id = pa.tenant_id
        WHERE pa.tenant_id = ${tenantId} AND pa.invoice_id = ${txn.id} AND p.status = 'posted'
          AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL)::int
      + (SELECT COUNT(*) FROM transactions t
          WHERE t.tenant_id = ${tenantId} AND t.applied_to_invoice_id = ${txn.id}
            AND t.status = 'posted' AND t.txn_type = 'customer_payment'
            -- U-132: a payment with application rows is counted (live) above.
            AND NOT EXISTS (SELECT 1 FROM payment_applications pa2
              WHERE pa2.tenant_id = t.tenant_id AND pa2.payment_id = t.id))::int AS payments,
      (SELECT COUNT(*) FROM transactions t
        WHERE t.tenant_id = ${tenantId} AND t.applied_to_invoice_id = ${txn.id}
          AND t.status = 'posted' AND t.txn_type <> 'customer_payment')::int AS credits
  `);
  const row = (res.rows as Array<{ payments: number; credits: number }>)[0];
  if ((row?.payments ?? 0) > 0 || (row?.credits ?? 0) > 0) {
    throw AppError.conflict(
      'This invoice has payments or credits applied. Void or remove those first.',
      'INVOICE_HAS_PAYMENTS',
      { payments: row?.payments ?? 0, credits: row?.credits ?? 0 },
    );
  }
}

/** A/P documents with a sub-ledger kept by their own services. */
export const AP_DOCUMENT_TYPES: readonly string[] = ['bill', 'vendor_credit', 'bill_payment'];

/**
 * A bill or vendor credit may be voided, deleted or freely edited only while
 * nothing is applied to it (U-84, review B1). Reads the application rows
 * themselves (not the bill_status column), on the caller's transaction after
 * the document row is locked FOR UPDATE, so a payment racing the change
 * either commits first (and is seen here) or waits for the lock.
 *   bill: bill_payment_applications or vendor_credit_applications for it →
 *         409 BILL_HAS_PAYMENTS
 *   vendor credit: vendor_credit_applications for it → 409 CREDIT_APPLIED
 *         (a refund deposit is TXN_DEPOSITED / TXN_DELETE_LINKED, checked
 *         by the void / delete paths; `includeRefunds` folds it in here)
 */
export async function assertApDocumentUnapplied(
  executor: DbOrTx,
  tenantId: string,
  txn: { id: string; txnType: string },
  opts: { includeRefunds?: boolean } = {},
): Promise<void> {
  if (txn.txnType === 'bill') {
    const res = await executor.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM bill_payment_applications WHERE tenant_id = ${tenantId} AND bill_id = ${txn.id})::int AS paid,
        (SELECT COUNT(*) FROM vendor_credit_applications WHERE tenant_id = ${tenantId} AND bill_id = ${txn.id})::int AS credited
    `);
    const row = (res.rows as Array<{ paid: number; credited: number }>)[0];
    if ((row?.paid ?? 0) > 0 || (row?.credited ?? 0) > 0) {
      throw AppError.conflict(
        'This bill has payments applied (bill payments or vendor credits). Void those bill payments first.',
        'BILL_HAS_PAYMENTS',
        { payments: row?.paid ?? 0, creditsApplied: row?.credited ?? 0 },
      );
    }
    return;
  }
  if (txn.txnType === 'vendor_credit') {
    const res = await executor.execute(sql`
      SELECT (SELECT COUNT(*) FROM vendor_credit_applications WHERE tenant_id = ${tenantId} AND credit_id = ${txn.id})::int AS applied
    `);
    const applied = (res.rows as Array<{ applied: number }>)[0]?.applied ?? 0;
    const refunds = opts.includeRefunds ? await liveDepositsForSource(executor, tenantId, txn.id) : [];
    if (applied > 0 || refunds.length > 0) {
      throw AppError.conflict(
        'This vendor credit has been applied to bills or refunded. Void those bill payments or refund deposits first.',
        'CREDIT_APPLIED',
        { applications: applied, refundDepositIds: [...new Set(refunds.map((r) => r.depositId))] },
      );
    }
  }
}

/**
 * Transaction types DELETE /transactions/:id accepts (txn-delete-v1): the
 * plain register entries whose only effect is their own journal lines (the
 * types PUT /transactions/:id edits; checks post as 'expense'), plus bills
 * and vendor credits with nothing applied (ap-edit-v1, U-84). Documents with
 * a sub-ledger otherwise (invoices, payments, AJEs, daily sales) keep their
 * own void paths and are refused with TXN_DELETE_UNSUPPORTED.
 */
export const DELETABLE_TXN_TYPES: readonly string[] = ['journal_entry', 'expense', 'transfer', 'deposit', 'cash_sale', 'bill', 'vendor_credit'];

/**
 * Soft delete (P12 R7, capability txn-delete-v1). Nothing is physically
 * removed (CLAUDE.md rule #23): a posted transaction gets reversing journal
 * lines (is_void_reversal, like void) and its balances are moved back; then
 * the header is marked status 'deleted', which every register, report,
 * balance and list leaves out (they read status = 'posted', or now exclude
 * 'deleted' where they read "not void"). A draft or void transaction has no
 * balance effect left to undo and is only marked.
 *
 * Same guards as void: the closing date (closingPassword / staff override
 * via the request's lock context, 423 / 403), and a transaction cleared in a
 * completed reconciliation is refused (409 RECONCILED_TRANSACTION). A
 * deposit grouping undeposited payments, or a transaction grouped into such
 * a deposit, is refused (409 TXN_DELETE_LINKED) because the deposit would
 * keep pointing at it.
 *
 * Audited as action 'delete' with the full before-image: the header and
 * every journal line as it stood before the delete.
 */
/**
 * Kinds of record that refuse a delete while they point at the transaction
 * (TXN_DELETE_LINKED details.links). Informational links (findings, rule
 * audit, dismissals, portal questions, tags) don't block: they keep
 * describing a transaction that still exists with status 'deleted'.
 */
export const DELETE_BLOCKING_LINKS = [
  'bank_feed_match', 'accrual', 'payroll', 'portal_receipt', 'category_suggestion',
  'recurring_template', 'daily_sales', 'estimated_tax_payment', 'bill_capture',
] as const;

export async function findDeleteBlockingLinks(
  executor: DbOrTx,
  tenantId: string,
  txnId: string,
): Promise<Array<(typeof DELETE_BLOCKING_LINKS)[number]>> {
  const result = await executor.execute(sql`
    SELECT
      EXISTS (SELECT 1 FROM bank_feed_items WHERE tenant_id = ${tenantId} AND matched_transaction_id = ${txnId}) AS bank_feed_match,
      (EXISTS (SELECT 1 FROM accrual_entries WHERE tenant_id = ${tenantId} AND transaction_id = ${txnId})
        OR EXISTS (SELECT 1 FROM accrual_schedules WHERE tenant_id = ${tenantId} AND source_transaction_id = ${txnId})) AS accrual,
      (EXISTS (SELECT 1 FROM payroll_check_register_rows r JOIN payroll_import_sessions ps ON ps.id = r.session_id
                WHERE ps.tenant_id = ${tenantId} AND r.transaction_id = ${txnId})
        OR EXISTS (SELECT 1 FROM payroll_import_sessions WHERE tenant_id = ${tenantId}
                AND (journal_entry_id = ${txnId}
                  OR (jsonb_typeof(journal_entry_ids) = 'array' AND jsonb_exists(journal_entry_ids, ${txnId}::text))))) AS payroll,
      EXISTS (SELECT 1 FROM portal_receipts WHERE tenant_id = ${tenantId} AND matched_transaction_id = ${txnId}) AS portal_receipt,
      EXISTS (SELECT 1 FROM client_category_suggestions WHERE tenant_id = ${tenantId}
                AND ((transaction_id = ${txnId} AND status = 'pending') OR posted_transaction_id = ${txnId})) AS category_suggestion,
      EXISTS (SELECT 1 FROM recurring_schedules WHERE tenant_id = ${tenantId} AND template_transaction_id = ${txnId}) AS recurring_template,
      EXISTS (SELECT 1 FROM daily_sales_entries WHERE tenant_id = ${tenantId} AND transaction_id = ${txnId}) AS daily_sales,
      EXISTS (SELECT 1 FROM tax_est_payments WHERE tenant_id = ${tenantId} AND transaction_id = ${txnId}) AS estimated_tax_payment,
      EXISTS (SELECT 1 FROM bill_captures WHERE tenant_id = ${tenantId} AND bill_id = ${txnId}) AS bill_capture
  `);
  const row = (result.rows as Array<Record<string, boolean>>)[0] ?? {};
  return DELETE_BLOCKING_LINKS.filter((k) => row[k] === true);
}

export interface DeleteTransactionOptions {
  reason?: string;
  userId?: string;
  companyId?: string;
  /** ap-edit-v1 (U-84): updatedAt as last read; mismatch is 409 STALE. */
  expectedUpdatedAt?: string;
}

export async function deleteTransaction(
  tenantId: string,
  txnId: string,
  opts: DeleteTransactionOptions = {},
) {
  return await db.transaction((tx) => deleteTransactionInTx(tx, tenantId, txnId, opts));
}

/** deleteTransaction inside the caller's database transaction. */
export async function deleteTransactionInTx(
  tx: Tx,
  tenantId: string,
  txnId: string,
  opts: DeleteTransactionOptions = {},
) {
  {
    await claimIdempotency(tx);
    await recordIdempotentEntity(tx, 'transaction', txnId);
    // Row lock: serializes with void / update / a second delete so the
    // reversal can't be applied twice.
    const [txn] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update')
      .limit(1);

    if (!txn || (opts.companyId && txn.companyId && txn.companyId !== opts.companyId)) {
      throw AppError.notFound('Transaction not found');
    }
    if (txn.status === 'deleted') {
      throw AppError.conflict('This transaction has already been deleted.', 'TXN_ALREADY_DELETED');
    }
    if (txn.txnType === 'aje') {
      throw AppError.badRequest('Adjusting journal entries are managed in the Trial Balance module', 'TB_AJE_ROUTE');
    }
    if (!DELETABLE_TXN_TYPES.includes(txn.txnType)) {
      throw AppError.conflict(
        'This kind of transaction can’t be deleted here. Void it from its own screen instead.',
        'TXN_DELETE_UNSUPPORTED',
        { txnType: txn.txnType },
      );
    }
    assertNotStale(txn, opts.expectedUpdatedAt);
    // A bill or vendor credit is deletable only while nothing is applied to
    // it (U-84): 409 BILL_HAS_PAYMENTS / CREDIT_APPLIED (a refunded credit
    // is TXN_DELETE_LINKED below, as any deposited item).
    await assertApDocumentUnapplied(tx, tenantId, txn);

    await checkLockDate(tx, tenantId, txn.txnDate, txn.companyId, undefined, {
      txnId, oldDate: txn.txnDate, newDate: null,
    });

    const clearedInCompleted = await tx.execute(sql`
      SELECT 1
      FROM ${reconciliationLines} rl
      JOIN ${reconciliations} r ON r.id = rl.reconciliation_id
      JOIN ${journalLines} jl ON jl.id = rl.journal_line_id
      WHERE r.tenant_id = ${tenantId}
        AND r.status = 'complete'
        AND rl.is_cleared = true
        AND jl.transaction_id = ${txnId}
      LIMIT 1
    `);
    if ((clearedInCompleted.rows as unknown[]).length > 0) {
      throw AppError.conflict(
        'This transaction is part of a completed bank reconciliation, so it can’t be deleted. ' +
          'Undo the reconciliation first.',
        'RECONCILED_TRANSACTION',
      );
    }

    // An item a posted deposit settles can't be deleted under it (409
    // TXN_DELETE_LINKED, as before). A deposit being deleted releases what
    // it settled (U-52), exactly as a void does.
    if ((await liveDepositsForSource(tx, tenantId, txnId)).length > 0) {
      throw AppError.conflict(
        'This transaction is part of a bank deposit, so it can’t be deleted. Remove it from the deposit first.',
        'TXN_DELETE_LINKED',
        { links: ['deposit'] },
      );
    }
    // A deposit holding a bounced payment stays (U-132): 409 PAYMENT_BOUNCED.
    if (txn.txnType === 'deposit') {
      await (await import('./payment.service.js')).assertDepositSourcesNotBounced(tx, tenantId, txnId);
    }
    const releasedLinks = await releaseDepositLinks(tx, tenantId, txnId);

    // Other records that point at this transaction and would be left
    // pointing at a deleted one (a matched bank-feed item would also stay
    // "matched" and never come back for review). Refused, naming the kinds
    // in details.links; the owner unmatches / removes the link first.
    const links = await findDeleteBlockingLinks(tx, tenantId, txnId);
    if (links.length > 0) {
      throw AppError.conflict(
        'Other records point at this transaction (for example a matched bank-feed item), so it can’t be deleted. Undo that link first, or void it instead.',
        'TXN_DELETE_LINKED',
        { links },
      );
    }

    // Every line as it stands now (for a void transaction this includes its
    // earlier reversal lines) — the before-image.
    const originalLines = await tx.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)))
      .orderBy(journalLines.lineOrder);

    // A journal entry's automatic reversal (U-61) is deleted with it, in
    // this database transaction, if nobody changed it (else 409
    // REVERSAL_EDITED).
    const reversal = txn.txnType === 'journal_entry' ? await findLiveReversal(tx, tenantId, txnId) : null;
    if (reversal) await assertReversalUnchanged(tx, tenantId, reversal, originalLines);

    // A billing document gives back the costs it billed (U-128, review B3).
    const releasedCosts = await releaseBilledCosts(tx, tenantId, txnId, 'invoice_delete', opts.userId);
    // Billable lines stop being billable (U-50); a billed line refuses.
    await releaseBillableLines(tx, tenantId, txnId);

    // Only a posted transaction still moves a balance; reverse it exactly
    // (debit and credit swapped, same amounts, same tags).
    if (txn.status === 'posted' && originalLines.length > 0) {
      const maxOrder = originalLines.reduce((m, l) => Math.max(m, l.lineOrder ?? 0), 0);
      await tx.insert(journalLines).values(originalLines.map((line, i) => ({
        tenantId,
        companyId: line.companyId,
        transactionId: txnId,
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: `Deleted: ${line.description || ''}`.trim(),
        tagId: line.tagId,
        contactId: line.contactId,
        lineOrder: maxOrder + 1 + i,
        isVoidReversal: true,
      })));
      await updateAccountBalances(tx, tenantId, originalLines.map((line) => ({
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
      })));
    }

    await tx.update(transactions).set({
      status: 'deleted',
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));

    await auditLog(tenantId, 'delete', 'transaction', txnId,
      { ...txn, lines: originalLines },
      {
        status: 'deleted',
        reason: opts.reason ?? null,
        ...(releasedLinks.length > 0 ? { releasedDepositLinks: releasedLinks } : {}),
        ...(releasedCosts.length > 0 ? { releasedBillableCosts: releasedCosts } : {}),
      },
      opts.userId, tx);

    // The reversal has its own updatedAt; the caller's token was for the original.
    if (reversal) await deleteTransactionInTx(tx, tenantId, reversal.id, { ...opts, expectedUpdatedAt: undefined });

    return { id: txnId, status: 'deleted' as const };
  }
}

/**
 * Edit guard for a transaction a posted deposit settles (U-52, U-54). A
 * Payments Clearing item must keep exactly the net clearing amount the
 * deposit took; a vendor credit is not edited through this path. Anything
 * else about the transaction (memo, other lines, date) may change.
 */
async function assertDepositedAmountKept(
  executor: DbOrTx,
  tenantId: string,
  existing: { id: string; txnType: string },
  input: PostTransactionInput,
) {
  const live = await liveDepositsForSource(executor, tenantId, existing.id);
  if (live.length === 0) return;
  const deposited = live.reduce((s, l) => s.plus(l.amount), new Decimal(0));
  const clearing = await executor.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'payments_clearing')))
    .limit(1);
  const clearingId = clearing[0]?.id;
  const held = input.lines
    .filter((l) => clearingId && l.accountId === clearingId)
    .reduce((s, l) => s.plus(l.debit || '0').minus(l.credit || '0'), new Decimal(0));
  if (existing.txnType !== 'vendor_credit' && held.equals(deposited)) return;
  await assertNotDeposited(executor, tenantId, existing.id, 'edit');
}

export async function updateTransaction(
  tenantId: string,
  txnId: string,
  input: PostTransactionInput,
  userId?: string,
  companyId?: string,
  // Optional outer transaction, as for postTransaction: lets a caller
  // (PUT /checks/:id) commit the ledger edit together with its own header
  // fields. Omitted, the update opens its own transaction as before.
  outerTx?: Tx,
  // apDocumentEdit: the caller is the A/P document's own service (bills,
  // vendor credits), which keeps its sub-ledger fields right. Every other
  // caller is refused on an A/P document (review B1).
  opts: { apDocumentEdit?: boolean } = {},
) {
  // Validate the new lines balance up front (in-memory, no DB access);
  // exact, no tolerance (U-65).
  assertBalanced(input.lines);

  // Wrap in a database transaction AND lock the row. Without the lock,
  // two concurrent updates of the same transaction can interleave their
  // reverse-old-balances → delete-lines → insert-new-lines → apply-new
  // balances steps and corrupt account balances + leave duplicated /
  // missing journal lines. SELECT … FOR UPDATE serializes them.
  const run = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => (outerTx ? fn(outerTx) : db.transaction(fn));
  return await run(async (tx) => {
    await claimIdempotency(tx);
    await recordIdempotentEntity(tx, 'transaction', txnId);
    const [existing] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update')
      .limit(1);

    // A transaction of another company is not found (as deleteTransaction).
    if (!existing || existing.status === 'deleted'
      || (companyId && existing.companyId && existing.companyId !== companyId)) {
      throw AppError.notFound('Transaction not found');
    }
    if (existing.status === 'void') throw AppError.badRequest('Cannot update a void transaction');

    // A bill, vendor credit or bill payment is edited only through its own
    // service (review B1): a generic edit (PUT /transactions/:id sent as an
    // expense against a bill id, say) would rewrite its lines and blank
    // balance_due behind its payments. 400 TXN_EDIT_UNSUPPORTED.
    if (AP_DOCUMENT_TYPES.includes(existing.txnType)
      && (!opts.apDocumentEdit || existing.txnType === 'bill_payment' || input.txnType !== existing.txnType)) {
      throw AppError.badRequest(
        'This is an accounts payable document; edit it from its own screen.',
        'TXN_EDIT_UNSUPPORTED',
        { txnType: existing.txnType },
      );
    }

    // Check lock date for both old and new dates (company-scoped).
    // AJEs are exempt (firm-only CRUD regardless of closing date — TB5)
    // unless the company has a closing-date password (U-15).
    {
      const ajeExempt = existing.txnType === 'aje' || input.txnType === 'aje';
      const oldSide = await checkLockDate(tx, tenantId, existing.txnDate, existing.companyId, undefined, { deferAudit: true, ajeExempt });
      // Only re-check when the date actually moves. Either side's override
      // is audited ONCE, with the old and the new date.
      const newSide = input.txnDate !== existing.txnDate
        ? await checkLockDate(tx, tenantId, input.txnDate, companyId ?? existing.companyId ?? null, undefined, { deferAudit: true, ajeExempt })
        : undefined;
      const override = oldSide ?? newSide;
      if (override) {
        await auditLockOverride(tx, tenantId, override, { txnId, oldDate: existing.txnDate, newDate: input.txnDate });
      }
    }

    // Validate the new lines' account ownership inside this tenant/company.
    await assertAccountsInScope(
      tx,
      tenantId,
      companyId ?? existing.companyId ?? null,
      input.lines.map((l) => l.accountId),
    );

    // An item a posted deposit settles keeps the amount the deposit took
    // (U-52): an edit that changes what it holds in Payments Clearing (or a
    // vendor credit's total) is refused with 409 TXN_DEPOSITED.
    await assertDepositedAmountKept(tx, tenantId, existing, input);

    // A check's own header tags, read before its lines change (U-80).
    const headerOnlyTags = await checkHeaderOnlyTags(tx, tenantId, existing,
      env.TAGS_SPLIT_LEVEL_V2 && existing.printStatus !== null
        ? await tx.select({ tagId: journalLines.tagId, isVoidReversal: journalLines.isVoidReversal }).from(journalLines)
          .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)))
        : []);

    // Lines already billed to a customer keep their billed state by
    // identity, or the edit is refused (409 LINE_BILLED) — U-50.
    const billedBefore = await loadBilledLines(tx, tenantId, txnId);
    const billableFor = planBillableColumns(input.lines, billedBefore);

    // Refuse to edit if any of this transaction's journal lines were
    // marked cleared inside a completed reconciliation. Allowing the edit
    // would silently decouple the reconciliation's cleared total from the
    // actual line amounts, which is an audit-trail integrity break that
    // isn't recoverable without re-doing the reconciliation.
    const clearedRows = await tx.execute(sql`
      SELECT DISTINCT jl.id AS journal_line_id
      FROM ${reconciliationLines} rl
      JOIN ${reconciliations} r ON r.id = rl.reconciliation_id
      JOIN ${journalLines} jl ON jl.id = rl.journal_line_id
      WHERE r.tenant_id = ${tenantId}
        AND r.status = 'complete'
        AND rl.is_cleared = true
        AND jl.transaction_id = ${txnId}
    `);
    const clearedLineIds = new Set((clearedRows.rows as Array<{ journal_line_id: string }>).map((r) => r.journal_line_id));

    if (clearedLineIds.size > 0) {
      // Reconciled transaction. The reconciliation cleared this txn's
      // balance-sheet line(s) (the bank / credit-card account). Those lines
      // must NOT change — their amount is the reconciled total, and their
      // journal_line ids are referenced by reconciliation_lines (no FK, so a
      // delete/recreate would leave dangling references and corrupt the rec).
      // The OTHER (income/expense) lines don't touch the reconciled balance,
      // so the user may recategorize / split / re-tag them freely — as long as
      // the balance-sheet lines and the date stay put.
      const existingLines = await tx.select().from(journalLines)
        .where(and(
          eq(journalLines.tenantId, tenantId),
          eq(journalLines.transactionId, txnId),
          eq(journalLines.isVoidReversal, false),
        ));
      const acctIds = Array.from(new Set([...existingLines.map((l) => l.accountId), ...input.lines.map((l) => l.accountId)]));
      const acctRows = acctIds.length
        ? await tx.select({ id: accounts.id, accountType: accounts.accountType })
            .from(accounts).where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, acctIds)))
        : [];
      const typeOf = new Map(acctRows.map((a) => [a.id, a.accountType]));
      const isBalanceSheet = (accountId: string) => {
        const t = typeOf.get(accountId);
        return t === 'asset' || t === 'liability' || t === 'equity';
      };
      const keyOf = (accountId: string, debit?: string | null, credit?: string | null) =>
        `${accountId}|${new Decimal(debit || '0').toFixed(4)}|${new Decimal(credit || '0').toFixed(4)}`;

      const existingBS = existingLines.filter((l) => isBalanceSheet(l.accountId));
      const existingPL = existingLines.filter((l) => !isBalanceSheet(l.accountId));

      // Match each existing balance-sheet line to an UNCHANGED input line.
      const inputPool = new Map<string, Array<{ idx: number; line: (typeof input.lines)[number] }>>();
      input.lines.forEach((line, idx) => {
        const k = keyOf(line.accountId, line.debit, line.credit);
        const b = inputPool.get(k) ?? []; b.push({ idx, line }); inputPool.set(k, b);
      });
      const preservedIdx = new Set<number>();
      const bsPairs: Array<{ lineId: string; input: (typeof input.lines)[number] }> = [];
      let ok = existing.txnDate === input.txnDate;
      if (ok) {
        for (const bs of existingBS) {
          const match = inputPool.get(keyOf(bs.accountId, bs.debit, bs.credit))?.shift();
          if (!match) { ok = false; break; }
          preservedIdx.add(match.idx);
          bsPairs.push({ lineId: bs.id, input: match.line });
        }
      }
      // Remaining input lines replace the P&L side; none may be a balance-sheet
      // account (that would add/alter the reconciled side).
      const newPLLines = ok ? input.lines.filter((_, idx) => !preservedIdx.has(idx)) : [];
      if (ok && newPLLines.some((l) => isBalanceSheet(l.accountId))) ok = false;

      if (!ok) {
        throw AppError.badRequest(
          'This transaction is part of a completed bank reconciliation, so its reconciled (balance-sheet) line and date can’t change. ' +
            'You can still recategorize or re-tag the income/expense lines. To change the reconciled amount, undo the reconciliation, or void and re-post.',
        );
      }

      const [contactDefaultTagId, itemDefaultTagMap] = await Promise.all([
        loadContactDefaultTagId(tx, tenantId, input.contactId),
        loadItemDefaultTagMap(tx, tenantId, input.lines),
      ]);
      const tagFor = (inLine: (typeof input.lines)[number]) => resolveDefaultTag({
        explicitUserTagId: inLine.tagId,
        bankRuleTagId: inLine.bankRuleTagId ?? undefined,
        aiSuggestedTagId: inLine.aiSuggestedTagId ?? undefined,
        itemDefaultTagId: inLine.itemId ? itemDefaultTagMap.get(inLine.itemId) ?? null : undefined,
        contactDefaultTagId,
      });

      // 1. Preserve balance-sheet lines: update tag/description IN PLACE (no
      //    amount/account change → reconciliation references untouched).
      for (const { lineId, input: inLine } of bsPairs) {
        await tx.update(journalLines).set({ tagId: tagFor(inLine), description: inLine.description || null, ...settlementColumns(inLine) })
          .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.id, lineId)));
      }
      // 2. Replace P&L lines: reverse old balances, delete, insert new, apply.
      if (existingPL.length > 0) {
        await updateAccountBalances(tx, tenantId, existingPL.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit })));
        await tx.delete(journalLines).where(and(
          eq(journalLines.tenantId, tenantId),
          inArray(journalLines.id, existingPL.map((l) => l.id)),
        ));
      }
      const newPLValues = newPLLines.map((line, i) => ({
        tenantId, companyId: companyId || null, transactionId: txnId,
        accountId: line.accountId, debit: line.debit || '0', credit: line.credit || '0',
        description: line.description || null, itemId: line.itemId || null,
        quantity: line.quantity || null, unitPrice: line.unitPrice || null,
        isTaxable: line.isTaxable || false, taxRate: line.taxRate || '0', taxAmount: line.taxAmount || '0',
        lineOrder: existingBS.length + i, contactId: line.contactId ?? null, tagId: tagFor(line),
        serviceDate: line.serviceDate || null,
        discountPercent: line.discountPercent ?? null,
        unitPriceSource: line.unitPriceSource ?? null,
        ...billableFor(line),
        ...settlementColumns(line),
      }));
      if (newPLValues.length > 0) {
        await tx.insert(journalLines).values(newPLValues);
        await updateAccountBalances(tx, tenantId, newPLLines);
      }
      // 3. Ledger-neutral header fields (memo / contact / basis / number /
      //    adjusting flag).
      await tx.update(transactions).set({
        memo: input.memo || null,
        contactId: input.contactId || null,
        ...(input.basis ? { basis: input.basis } : {}),
        ...(input.txnNumber !== undefined ? { txnNumber: input.txnNumber } : {}),
        ...(input.isAdjusting !== undefined ? { isAdjusting: input.isAdjusting } : {}),
        updatedAt: new Date(),
      }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));
      // 4. Rebuild transaction_tags from the full (preserved + new) line set;
      //    a check keeps its own header tags (U-80).
      const fullValues = [
        ...bsPairs.map(({ input: inLine }) => ({ accountId: inLine.accountId, tagId: tagFor(inLine) })),
        ...newPLValues,
      ];
      await syncTransactionTagsFromLines(tx, tenantId, existing.companyId ?? null, txnId, fullValues, headerOnlyTags);
      // Full before-image: header plus every line as it stood before the edit.
      await auditLog(tenantId, 'update', 'transaction', txnId, { ...existing, lines: existingLines }, { reconciledPartialEdit: true }, userId, tx);
      // Every billed cost still has its line (U-128 review B1); else 500, rolled back.
      if (billedBefore.length > 0) await assertSourceLinksIntact(tx, tenantId, txnId);
      const refreshed = await tx.select().from(journalLines)
        .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));
      const [updatedTxn] = await tx.select().from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId))).limit(1);
      return { ...updatedTxn, lines: refreshed };
    }

    // Get original lines and reverse their balances
    const originalLines = await tx.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));

    if (originalLines.length > 0 && existing.status === 'posted') {
      const reversingLines = originalLines.map((line) => ({
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
      }));
      await updateAccountBalances(tx, tenantId, reversingLines);
    }

    // Delete old lines (tenant_id scoped — defense in depth per CLAUDE.md #17)
    await tx.delete(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));

    // Update transaction
    await tx.update(transactions).set({
      txnDate: input.txnDate,
      dueDate: input.dueDate || null,
      // Editable on an invoice edit; callers that don't pass txnNumber leave
      // the existing number untouched (never nulled).
      ...(input.txnNumber !== undefined ? { txnNumber: input.txnNumber } : {}),
      // Editable on a JE edit; other callers omit basis so it's left as 'both'.
      ...(input.basis ? { basis: input.basis } : {}),
      // Adjusting flag (U-60): only a caller that sends it changes it.
      ...(input.isAdjusting !== undefined ? { isAdjusting: input.isAdjusting } : {}),
      contactId: input.contactId || null,
      memo: input.memo || null,
      subtotal: input.subtotal || null,
      taxAmount: input.taxAmount || '0',
      total: input.total || null,
      balanceDue: input.balanceDue || null,
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));

    // Resolve default tags for the new line set (ADR 0XY §3.2 as above).
    const [contactDefaultTagId, itemDefaultTagMap] = await Promise.all([
      loadContactDefaultTagId(tx, tenantId, input.contactId),
      loadItemDefaultTagMap(tx, tenantId, input.lines),
    ]);

    // Insert new lines
    const lineValues = input.lines.map((line, i) => ({
      tenantId,
      companyId: companyId || null,
      transactionId: txnId,
      accountId: line.accountId,
      debit: line.debit || '0',
      credit: line.credit || '0',
      description: line.description || null,
      itemId: line.itemId || null,
      quantity: line.quantity || null,
      unitPrice: line.unitPrice || null,
      isTaxable: line.isTaxable || false,
      taxRate: line.taxRate || '0',
      taxAmount: line.taxAmount || '0',
      lineOrder: i,
      contactId: line.contactId ?? null,
      serviceDate: line.serviceDate || null,
      discountPercent: line.discountPercent ?? null,
      unitPriceSource: line.unitPriceSource ?? null,
      ...billableFor(line),
      ...settlementColumns(line),
      tagId: resolveDefaultTag({
        explicitUserTagId: line.tagId,
        bankRuleTagId: line.bankRuleTagId ?? undefined,
        aiSuggestedTagId: line.aiSuggestedTagId ?? undefined,
        itemDefaultTagId: line.itemId ? itemDefaultTagMap.get(line.itemId) ?? null : undefined,
        contactDefaultTagId,
      }),
    }));

    const lines = await tx.insert(journalLines).values(lineValues).returning();

    await syncTransactionTagsFromLines(tx, tenantId, companyId ?? existing.companyId ?? null, txnId, lineValues, headerOnlyTags);

    // Apply new balances
    if (existing.status === 'posted') {
      await updateAccountBalances(tx, tenantId, input.lines);
    }

    // Full before-image: header plus the lines this edit deleted, so the
    // audit trail can show (and restore) what the transaction was.
    await auditLog(tenantId, 'update', 'transaction', txnId, { ...existing, lines: originalLines }, input, userId, tx);
    // Every billed cost still has its line (U-128 review B1); else 500, rolled back.
    if (billedBefore.length > 0) await assertSourceLinksIntact(tx, tenantId, txnId);

    const [updated] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .limit(1);
    return { ...updated, lines };
  });
}

async function updateAccountBalances(
  executor: DbOrTx,
  tenantId: string,
  lines: Array<{ accountId: string; debit?: string; credit?: string }>,
) {
  // The arithmetic is done SQL-side (`balance = balance + delta`) so the
  // UPDATE is atomic at the row level — Postgres serializes concurrent
  // updates on the same row and the read-modify-write is internal to the
  // statement. The lost-update race that would happen if we did
  // `read balance → compute new → write` from JS is not present here.
  //
  // The transaction wrapper around this helper exists to keep the balance
  // update atomic *with the journal_lines insert*, not to protect the
  // increment itself.
  for (const line of lines) {
    const delta = new Decimal(line.debit || '0').minus(line.credit || '0');

    if (!delta.isZero()) {
      await executor.update(accounts).set({
        balance: sql`${accounts.balance} + ${delta.toFixed(4)}::decimal`,
        updatedAt: new Date(),
      }).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, line.accountId)));
    }
  }
}

// ─── Automatic reversing entries (U-61, je-reversing-v1) ──────────
//
// A journal entry posted with reverseOn gets a second journal entry dated
// reverseOn: the same lines with debit and credit swapped, memo
// "Reverses JE <number>", transactions.reverses_transaction_id = the
// original. Both post in one database transaction and both dates go
// through the closing-date check. Voiding / deleting the original voids /
// deletes the reversal with it; editing the original deletes the reversal
// and posts a new one. Each of those refuses with 409 REVERSAL_EDITED when
// the reversal was changed after it was created.

type TxnRow = typeof transactions.$inferSelect;
type LineRow = typeof journalLines.$inferSelect;

/** The live (not void, not deleted) automatic reversal of a journal entry, row-locked. */
export async function findLiveReversal(executor: DbOrTx, tenantId: string, originalId: string): Promise<TxnRow | null> {
  const [row] = await executor.select().from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.reversesTransactionId, originalId),
      notInArray(transactions.status, ['void', 'deleted']),
    ))
    .orderBy(transactions.createdAt, transactions.id)
    .for('update')
    .limit(1);
  return row ?? null;
}

const reversalLineKey = (l: { accountId: string; debit: string | null; credit: string | null; contactId: string | null; tagId: string | null }) =>
  `${l.accountId}|${new Decimal(l.debit || '0').toFixed(4)}|${new Decimal(l.credit || '0').toFixed(4)}|${l.contactId ?? ''}|${l.tagId ?? ''}`;

/**
 * A reversal is unchanged when it is still posted, its header was never
 * updated (updated_at = created_at: every edit, payee change or void moves
 * updated_at) and its lines are exactly the original's lines with debit and
 * credit swapped (account, amounts, name and tag). Otherwise 409
 * REVERSAL_EDITED: the owner voids or deletes the reversal first.
 */
export async function assertReversalUnchanged(
  executor: DbOrTx,
  tenantId: string,
  reversal: TxnRow,
  originalLines: ReadonlyArray<LineRow>,
): Promise<void> {
  let unchanged = reversal.status === 'posted'
    && !!reversal.createdAt && !!reversal.updatedAt
    && reversal.createdAt.getTime() === reversal.updatedAt.getTime();
  if (unchanged) {
    const revLines = await executor.select().from(journalLines).where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, reversal.id),
      eq(journalLines.isVoidReversal, false),
    ));
    const expected = originalLines.filter((l) => !l.isVoidReversal)
      .map((l) => reversalLineKey({ ...l, debit: l.credit, credit: l.debit })).sort();
    const actual = revLines.map((l) => reversalLineKey(l)).sort();
    unchanged = expected.length === actual.length && expected.every((k, i) => k === actual[i]);
  }
  if (!unchanged) {
    throw AppError.conflict(
      `The reversing entry dated ${reversal.txnDate} was changed after it was created, so it can’t be changed automatically. ` +
        'Void or delete the reversing entry first, then try again.',
      'REVERSAL_EDITED',
      { reversalTransactionId: reversal.id, reverseOn: reversal.txnDate },
    );
  }
}

/** The reversal's memo: "Reverses JE <number>", or the entry's date when it has no number. */
export function reversalMemo(original: Pick<TxnRow, 'txnNumber' | 'txnDate'>): string {
  return original.txnNumber ? `Reverses JE ${original.txnNumber}` : `Reverses JE of ${original.txnDate}`;
}

const reversalContentKey = (l: { accountId: string; debit: string | null; credit: string | null; contactId: string | null; tagId: string | null; description: string | null }) =>
  `${reversalLineKey(l)}|${l.description ?? ''}`;

/**
 * True when `reversal` is exactly what postReversal would post for
 * `original` on `reverseOn`: same date, memo, basis, adjusting flag and
 * lines (account, swapped amounts, name, tag, description). The edit path
 * keeps such a reversal instead of re-posting it (U-61).
 */
export async function reversalMatches(
  executor: DbOrTx,
  tenantId: string,
  reversal: TxnRow,
  original: TxnRow & { lines: ReadonlyArray<LineRow> },
  reverseOn: string,
): Promise<boolean> {
  if (reversal.txnDate !== reverseOn || reversal.memo !== reversalMemo(original)
    || reversal.basis !== original.basis || reversal.isAdjusting !== original.isAdjusting) {
    return false;
  }
  const revLines = await executor.select().from(journalLines).where(and(
    eq(journalLines.tenantId, tenantId),
    eq(journalLines.transactionId, reversal.id),
    eq(journalLines.isVoidReversal, false),
  ));
  const expected = original.lines.filter((l) => !l.isVoidReversal)
    .map((l) => reversalContentKey({ ...l, debit: l.credit, credit: l.debit })).sort();
  const actual = revLines.map((l) => reversalContentKey(l)).sort();
  return expected.length === actual.length && expected.every((k, i) => k === actual[i]);
}

/**
 * Posts the automatic reversal of `original` dated `reverseOn` inside the
 * caller's database transaction (the closing-date check applies to
 * reverseOn). Lines: the original's lines, debit and credit swapped, same
 * account, description, name and tag; not billable. Basis and the
 * adjusting flag follow the original. The reversal has no number of its own
 * and always belongs to the original's company; a caller company that
 * differs is refused.
 */
export async function postReversal(
  tx: Tx,
  tenantId: string,
  original: TxnRow & { lines: ReadonlyArray<LineRow> },
  reverseOn: string,
  userId?: string,
  companyId?: string,
) {
  if (companyId && original.companyId && original.companyId !== companyId) {
    throw AppError.notFound('Transaction not found');
  }
  return postTransaction(tenantId, {
    txnType: 'journal_entry',
    txnDate: reverseOn,
    memo: reversalMemo(original),
    basis: (original.basis as 'cash' | 'accrual' | 'both') ?? 'both',
    isAdjusting: original.isAdjusting,
    reversesTransactionId: original.id,
    lines: original.lines.filter((l) => !l.isVoidReversal).map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      description: l.description ?? undefined,
      contactId: l.contactId,
      tagId: l.tagId,
    })),
  }, userId, original.companyId ?? companyId ?? undefined, tx);
}

// Cheap type probe for route guards (the TB module fences txn_type
// 'aje' off from the generic transaction routes — rule TB3).
export async function getTransactionType(tenantId: string, txnId: string): Promise<string | null> {
  const [row] = await db.select({ txnType: transactions.txnType }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
    .limit(1);
  return row?.txnType ?? null;
}

/**
 * A transaction with its lines. `companyId` (the reader's company, else the
 * transaction's own): a billed cost line names its invoice only when that
 * invoice is of this company (review S-5).
 */
export async function getTransaction(tenantId: string, txnId: string, companyId?: string | null) {
  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)),
  });
  if (!txn) throw AppError.notFound('Transaction not found');

  // Resolve the contact/vendor display name so detail views (e.g. the bill
  // detail page) can show the name rather than just a contactId.
  let contactName: string | null = null;
  if (txn.contactId) {
    const c = await db.query.contacts.findFirst({
      where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, txn.contactId)),
      columns: { displayName: true },
    });
    contactName = c?.displayName ?? null;
  }

  const rawLines = await db.select({
    id: journalLines.id,
    tenantId: journalLines.tenantId,
    transactionId: journalLines.transactionId,
    accountId: journalLines.accountId,
    accountName: accounts.name,
    accountNumber: accounts.accountNumber,
    debit: journalLines.debit,
    credit: journalLines.credit,
    description: journalLines.description,
    itemId: journalLines.itemId,
    quantity: journalLines.quantity,
    unitPrice: journalLines.unitPrice,
    isTaxable: journalLines.isTaxable,
    taxRate: journalLines.taxRate,
    taxAmount: journalLines.taxAmount,
    lineOrder: journalLines.lineOrder,
    tagId: journalLines.tagId,
    contactId: journalLines.contactId,
    isBillable: journalLines.isBillable,
    billedStatus: journalLines.billedStatus,
    sourceTransactionId: journalLines.sourceTransactionId,
    lineRole: journalLines.lineRole,
    serviceDate: journalLines.serviceDate,
    discountPercent: journalLines.discountPercent,
    unitPriceSource: journalLines.unitPriceSource,
    billableSourceLineId: journalLines.billableSourceLineId,
  }).from(journalLines)
    .leftJoin(accounts, eq(journalLines.accountId, accounts.id))
    // Exclude the persisted void-reversal rows (rule 23) so the detail
    // view keeps showing the document as entered; the reversal is a GL
    // artifact, visible in ledger exports.
    .where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, txnId),
      eq(journalLines.isVoidReversal, false),
    ))
    .orderBy(journalLines.lineOrder);

  // Billed cost lines (U-128): the invoice each is on (same company as the
  // source: a claim requires it).
  const billedIds = rawLines.filter((l) => l.billedStatus === 'billed').map((l) => l.id);
  const billedOn = await billedInvoicesForLines(db, tenantId, billedIds, companyId ?? txn.companyId ?? null);
  const lines: Array<(typeof rawLines)[number] & { billedInvoiceId?: string | null; billedInvoiceNumber?: string | null }> =
    rawLines.map((l) => {
      if (l.billedStatus !== 'billed') return l;
      const inv = billedOn.get(l.id);
      return { ...l, billedInvoiceId: inv?.invoiceId ?? null, billedInvoiceNumber: inv?.invoiceNumber ?? null };
    });

  // Journal entries (U-61): the live automatic reversal, if any.
  if (txn.txnType === 'journal_entry') {
    const [rev] = await db.select({ id: transactions.id, txnDate: transactions.txnDate }).from(transactions)
      .where(and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.reversesTransactionId, txn.id),
        notInArray(transactions.status, ['void', 'deleted']),
      ))
      .orderBy(transactions.createdAt, transactions.id)
      .limit(1);
    return { ...txn, contactName, lines, reversalTransactionId: rev?.id ?? null, reverseOn: rev?.txnDate ?? null };
  }

  // Deposits (U-53): the cash-back line, as the create body takes it.
  if (txn.txnType === 'deposit') {
    const cb = lines.find((l) => l.lineRole === 'cash_back');
    const cashBack = cb
      ? { accountId: cb.accountId, amount: new Decimal(cb.debit || '0').toFixed(4), memo: cb.description ?? null }
      : null;
    return { ...txn, contactName, lines, cashBack };
  }

  return { ...txn, contactName, lines };
}

export async function listTransactions(tenantId: string, filters: {
  txnType?: string; status?: string; contactId?: string | string[]; accountId?: string; startDate?: string; endDate?: string;
  /** Invoices list: keep these invoice statuses. */
  invoiceStatus?: string[];
  /**
   * Invoices list (U-126): false keeps the invoices never sent (no
   * document_send_events row, no sent_at, never marked sent or viewed) and
   * not void, whatever their payment status; true keeps the others.
   */
  invoiceSent?: boolean;
  // ADR 0XX §5.2 — header-level tag filter semantics: keep the
  // transaction if *any* of its journal_lines carries this tag.
  tagId?: string;
  /**
   * Filter by transactions.source — used by the bulk-import success
   * links to navigate to "the transactions I just imported" via tags
   * like 'accounting_power_import' / 'quickbooks_online_import' /
   * 'trial_balance_import'. Indexed (idx_txn_source) so this is cheap.
   */
  source?: string;
  /** Report-basis lens: 'cash' keeps transactions.basis in (both,cash);
   *  'accrual' keeps (both,accrual). Mirrors report inclusion per-transaction. */
  basis?: 'cash' | 'accrual';
  /** Adjusting-entry lens (U-60): include (default) / exclude / only. */
  adjusting?: 'include' | 'exclude' | 'only';
  search?: string;
  /** Exact total as a decimal string (U-95), compared as SQL numeric; never parsed here. */
  amount?: string;
  sortBy?: 'date' | 'type' | 'number' | 'payee' | 'memo' | 'category' | 'amount' | 'status' | 'dueDate' | 'balanceDue' | 'invoiceStatus';
  sortDir?: 'asc' | 'desc';
  limit?: number; offset?: number;
  /** List export (transaction-list-export.service): also return each
   *  transaction's category-side debit/credit sums. Not a query param. */
  withCategoryAmounts?: boolean;
  /** Soft-deleted transactions (txn-delete-v1) are hidden unless 'true'
   *  here or `status: 'deleted'` asks for them explicitly. */
  includeDeleted?: 'true' | 'false';
}, companyId?: string) {
  const conditions = [eq(transactions.tenantId, tenantId)];
  if (companyId) conditions.push(eq(transactions.companyId, companyId));

  if (filters.txnType) conditions.push(eq(transactions.txnType, filters.txnType));
  if (filters.status) conditions.push(eq(transactions.status, filters.status));
  else if (filters.includeDeleted !== 'true') conditions.push(sql`${transactions.status} <> 'deleted'`);
  if (Array.isArray(filters.contactId)) {
    if (filters.contactId.length > 0) conditions.push(inArray(transactions.contactId, filters.contactId));
  } else if (filters.contactId) {
    conditions.push(eq(transactions.contactId, filters.contactId));
  }
  if (filters.invoiceStatus && filters.invoiceStatus.length > 0) {
    conditions.push(inArray(transactions.invoiceStatus, filters.invoiceStatus));
  }
  if (filters.invoiceSent !== undefined) {
    const neverSent = sql`(NOT EXISTS (SELECT 1 FROM document_send_events dse
        WHERE dse.tenant_id = ${transactions.tenantId} AND dse.transaction_id = ${transactions.id})
      AND ${transactions.sentAt} IS NULL
      AND COALESCE(${transactions.invoiceStatus}, '') NOT IN ('sent', 'viewed'))`;
    conditions.push(filters.invoiceSent ? sql`NOT ${neverSent}` : sql`(${neverSent} AND ${transactions.status} <> 'void')`);
  }
  if (filters.source) conditions.push(eq(transactions.source, filters.source));
  // Report-basis lens: keep transactions whose basis flag affects the chosen
  // basis. 'both' shows on either; a basis-specific adjusting entry only shows
  // on its own basis. Mirrors report inclusion (report.service basis filter).
  if (filters.basis === 'cash') conditions.push(sql`${transactions.basis} IN ('both', 'cash')`);
  else if (filters.basis === 'accrual') conditions.push(sql`${transactions.basis} IN ('both', 'accrual')`);
  // Adjusting-entry lens (U-60), as the reports apply it.
  if (filters.adjusting === 'exclude') conditions.push(eq(transactions.isAdjusting, false));
  else if (filters.adjusting === 'only') conditions.push(eq(transactions.isAdjusting, true));
  if (filters.startDate) conditions.push(sql`${transactions.txnDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${transactions.txnDate} <= ${filters.endDate}`);
  // Exact total (U-95): numeric equality in SQL, so 10.1 = 10.10 and 10.01
  // does not match; a NULL total (journal entry, transfer) never matches.
  if (filters.amount !== undefined) conditions.push(sql`${transactions.total} = ${filters.amount}::numeric`);
  if (filters.accountId) {
    conditions.push(sql`${transactions.id} IN (SELECT transaction_id FROM journal_lines WHERE account_id = ${filters.accountId} AND tenant_id = ${tenantId})`);
  }
  if (filters.tagId) {
    conditions.push(sql`EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = ${transactions.id} AND jl.tenant_id = ${tenantId} AND jl.tag_id = ${filters.tagId})`);
  }
  if (filters.search) {
    const term = '%' + escapeLike(filters.search) + '%';
    // Amount match: compare against the DISPLAYED amount (total, or the
    // journal-line magnitude for NULL-total JEs/transfers) as text, and strip
    // '$', commas and spaces from the typed term so "$1,051.07" matches
    // "1051.07".
    const amountTerm = '%' + escapeLike(filters.search.replace(/[$,\s]/g, '')) + '%';
    conditions.push(sql`(${transactions.memo} ILIKE ${term}
      OR ${transactions.txnNumber} ILIKE ${term}
      OR ${contacts.displayName} ILIKE ${term}
      OR EXISTS (
          SELECT 1 FROM journal_lines jlm
          WHERE jlm.transaction_id = ${transactions.id} AND jlm.tenant_id = ${tenantId}
            AND jlm.description ILIKE ${term}
        )
      OR CAST(COALESCE(${transactions.total}, (
          SELECT SUM(jls.debit) FROM journal_lines jls
          WHERE jls.transaction_id = ${transactions.id} AND jls.tenant_id = ${tenantId}
        )) AS TEXT) ILIKE ${amountTerm})`);
  }

  const where = and(...conditions);

  // Category column predicate. The "category" is the account the money moved
  // to/from — everything EXCEPT the transaction's own cash / clearing /
  // control side. So instead of whitelisting P&L account types (which hid
  // deposits/payments whose offset is a loan, equity draw, fixed asset, etc.
  // — they showed a bare "—"), we exclude only the money/clearing accounts:
  // bank, A/R, A/P, credit cards, Payments Clearing / Undeposited Funds, and
  // the auto-managed Sales Tax Payable. `a2` is the joined accounts alias in
  // both the SELECT and the sort subquery below.
  const categoryAccountFilter = sql`
    COALESCE(a2.detail_type, '') NOT IN ('bank','accounts_receivable','accounts_payable','credit_card')
    AND COALESCE(a2.system_tag, '') NOT IN ('payments_clearing','undeposited_funds','sales_tax_payable')`;

  // Column sort. Whitelisted keys → a concrete SQL expression; everything else
  // falls back to date. CATEGORY sorts on the first category account name via
  // the same correlated subquery the SELECT uses. A stable createdAt
  // tiebreaker keeps pagination deterministic.
  const dir = filters.sortDir === 'asc' ? sql`ASC` : sql`DESC`;
  const sortExpr = (() => {
    switch (filters.sortBy) {
      case 'type': return sql`${transactions.txnType}`;
      case 'number': return sql`${transactions.txnNumber}`;
      case 'payee': return sql`${contacts.displayName}`;
      case 'memo': return sql`${transactions.memo}`;
      // Same COALESCE as the displayTotal select — NULL-total JEs and
      // transfers sort by their journal-line magnitude instead of
      // clumping at the end.
      case 'amount': return sql`COALESCE(${transactions.total}, (
        SELECT SUM(jl6.debit) FROM journal_lines jl6
        WHERE jl6.transaction_id = ${transactions.id}
          AND jl6.tenant_id = ${tenantId}
      ))`;
      case 'status': return sql`${transactions.status}`;
      // Invoices list columns.
      case 'dueDate': return sql`${transactions.dueDate}`;
      case 'balanceDue': return sql`CAST(${transactions.balanceDue} AS DECIMAL)`;
      case 'invoiceStatus': return sql`${transactions.invoiceStatus}`;
      case 'category': return sql`(
        SELECT min(a2.name) FROM journal_lines jl4
        JOIN accounts a2 ON a2.id = jl4.account_id
        WHERE jl4.transaction_id = ${transactions.id}
          AND jl4.tenant_id = ${tenantId}
          AND ${categoryAccountFilter}
      )`;
      case 'date':
      default: return sql`${transactions.txnDate}`;
    }
  })();
  const orderBy = sql`${sortExpr} ${dir} NULLS LAST, ${transactions.createdAt} DESC`;

  const [data, total, totalsRow] = await Promise.all([
    db.select({
      id: transactions.id,
      tenantId: transactions.tenantId,
      txnType: transactions.txnType,
      txnNumber: transactions.txnNumber,
      // TB module: the list badge shows AJE-nnn when present.
      ajeNumber: transactions.ajeNumber,
      // U-60 / U-61: adjusting flag and the entry a reversal reverses.
      isAdjusting: transactions.isAdjusting,
      reversesTransactionId: transactions.reversesTransactionId,
      txnDate: transactions.txnDate,
      dueDate: transactions.dueDate,
      status: transactions.status,
      contactId: transactions.contactId,
      contactName: contacts.displayName,
      memo: transactions.memo,
      subtotal: transactions.subtotal,
      taxAmount: transactions.taxAmount,
      total: transactions.total,
      // Amount column fallback: `total` is caller-supplied and NULL for
      // journal entries, transfers, and GL-imported entries (they have
      // no document total). The transaction's magnitude is the sum of
      // its debit legs (= sum of credits by rule 22), so the list can
      // always show an amount.
      displayTotal: sql<string | null>`COALESCE(${transactions.total}, (
        SELECT SUM(jl5.debit) FROM journal_lines jl5
        WHERE jl5.transaction_id = ${transactions.id}
          AND jl5.tenant_id = ${tenantId}
      ))`,
      // When the list is filtered to a specific account, expose that account's
      // debit and credit totals per transaction so the UI can render a
      // GL/register-style Debit | Credit split (from THIS account's
      // perspective). NULL when no account filter is active.
      accountDebit: filters.accountId
        ? sql<string | null>`(SELECT SUM(jl7.debit) FROM journal_lines jl7
            WHERE jl7.transaction_id = ${transactions.id}
              AND jl7.tenant_id = ${tenantId} AND jl7.account_id = ${filters.accountId})`
        : sql<string | null>`NULL`,
      accountCredit: filters.accountId
        ? sql<string | null>`(SELECT SUM(jl8.credit) FROM journal_lines jl8
            WHERE jl8.transaction_id = ${transactions.id}
              AND jl8.tenant_id = ${tenantId} AND jl8.account_id = ${filters.accountId})`
        : sql<string | null>`NULL`,
      // Export only: debit / credit posted to the transaction's category
      // account(s) — the same lines lineCategories names. Void-reversal
      // rows are excluded so a voided entry reports its original legs.
      categoryDebit: filters.withCategoryAmounts
        ? sql<string | null>`(SELECT SUM(jl9.debit) FROM journal_lines jl9
            JOIN accounts a2 ON a2.id = jl9.account_id
            WHERE jl9.transaction_id = ${transactions.id}
              AND jl9.tenant_id = ${tenantId} AND jl9.is_void_reversal = false
              AND ${categoryAccountFilter})`
        : sql<string | null>`NULL`,
      categoryCredit: filters.withCategoryAmounts
        ? sql<string | null>`(SELECT SUM(jl10.credit) FROM journal_lines jl10
            JOIN accounts a2 ON a2.id = jl10.account_id
            WHERE jl10.transaction_id = ${transactions.id}
              AND jl10.tenant_id = ${tenantId} AND jl10.is_void_reversal = false
              AND ${categoryAccountFilter})`
        : sql<string | null>`NULL`,
      amountPaid: transactions.amountPaid,
      balanceDue: transactions.balanceDue,
      invoiceStatus: transactions.invoiceStatus,
      source: transactions.source,
      sourceId: transactions.sourceId,
      aiCategorized: bankFeedItems.matchType,
      createdAt: transactions.createdAt,
      // ADR 0XX §4.1 — aggregate of distinct tag names from the
      // transaction's journal lines. Null when every line is untagged;
      // a one-element array when uniform; two+ elements when mixed.
      // Rendered in the list's Tag column as a pill / "Mixed" / "—".
      lineTags: sql<string[] | null>`(
        SELECT array_agg(DISTINCT t2.name ORDER BY t2.name)
        FROM journal_lines jl
        JOIN tags t2 ON t2.id = jl.tag_id
        WHERE jl.transaction_id = ${transactions.id}
          AND jl.tenant_id = ${tenantId}
          AND jl.tag_id IS NOT NULL
      )`,
      // Category column: distinct names of the "category" accounts on this
      // transaction's lines — the account(s) the money moved to/from,
      // excluding the transaction's own bank / A/R / A/P / credit-card /
      // clearing / sales-tax control side. One element → single category;
      // two+ → rendered as "— Split —"; null → "—".
      lineCategories: sql<string[] | null>`(
        SELECT array_agg(DISTINCT a2.name ORDER BY a2.name)
        FROM journal_lines jl3
        JOIN accounts a2 ON a2.id = jl3.account_id
        WHERE jl3.transaction_id = ${transactions.id}
          AND jl3.tenant_id = ${tenantId}
          AND ${categoryAccountFilter}
      )`,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .leftJoin(bankFeedItems, and(
        eq(transactions.source, 'bank_feed'),
        sql`${transactions.sourceId} = ${bankFeedItems.id}::text`,
      ))
      .where(where)
      .orderBy(orderBy)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    // Must mirror the data query's contacts join: the `search` filter
    // references contacts.displayName, so without this join the count query
    // throws ("missing FROM-clause entry for table contacts") and the whole
    // list 500s whenever a search term is present.
    db.select({ count: count() }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where),
    // Grand totals across the WHOLE filtered set (not just the page), so the
    // list can show a footer total. Void transactions are excluded — they net
    // to zero and display as 0. `amount` mirrors displayTotal; debit/credit are
    // the filtered account's legs (0 when no account filter).
    db.select({
      amount: sql<string>`COALESCE(SUM(COALESCE(${transactions.total}, (
        SELECT SUM(jlt.debit) FROM journal_lines jlt
        WHERE jlt.transaction_id = ${transactions.id} AND jlt.tenant_id = ${tenantId}
      ))), 0)`,
      debit: filters.accountId
        ? sql<string>`COALESCE(SUM((SELECT SUM(jld.debit) FROM journal_lines jld
            WHERE jld.transaction_id = ${transactions.id} AND jld.tenant_id = ${tenantId} AND jld.account_id = ${filters.accountId})), 0)`
        : sql<string>`'0'`,
      credit: filters.accountId
        ? sql<string>`COALESCE(SUM((SELECT SUM(jlc.credit) FROM journal_lines jlc
            WHERE jlc.transaction_id = ${transactions.id} AND jlc.tenant_id = ${tenantId} AND jlc.account_id = ${filters.accountId})), 0)`
        : sql<string>`'0'`,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(and(where, sql`${transactions.status} NOT IN ('void', 'deleted')`)),
  ]);

  return {
    data,
    total: total[0]?.count ?? 0,
    totals: {
      amount: totalsRow[0]?.amount ?? '0',
      debit: totalsRow[0]?.debit ?? '0',
      credit: totalsRow[0]?.credit ?? '0',
    },
  };
}

export async function getAccountBalance(tenantId: string, accountId: string, asOfDate?: string) {
  const conditions = [
    eq(journalLines.tenantId, tenantId),
    eq(journalLines.accountId, accountId),
  ];

  // Always restrict to POSTED transactions. Without a date bound this
  // used to sum every line — drafts, voids, and (now that rule 23
  // persists them) void-reversal lines — none of which belong in a
  // balance.
  if (asOfDate) {
    conditions.push(sql`${journalLines.transactionId} IN (
      SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND txn_date <= ${asOfDate} AND status = 'posted'
    )`);
  } else {
    conditions.push(sql`${journalLines.transactionId} IN (
      SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND status = 'posted'
    )`);
  }

  const result = await db.select({
    totalDebit: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)`,
    totalCredit: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)`,
  }).from(journalLines).where(and(...conditions));

  const row = result[0];
  // Sum through Decimal then round to 4-decimal precision once, so callers
  // get a clean `number` without the IEEE754 drift that repeated parseFloat
  // accumulation used to produce on large ledgers.
  const debit = new Decimal(row?.totalDebit || '0');
  const credit = new Decimal(row?.totalCredit || '0');
  const balance = debit.minus(credit);
  return {
    debit: Number(debit.toFixed(4)),
    credit: Number(credit.toFixed(4)),
    balance: Number(balance.toFixed(4)),
  };
}

export async function validateBalance(tenantId: string): Promise<{ valid: boolean; totalDebits: number; totalCredits: number; difference: number }> {
  // Only sum lines from posted transactions
  const result = await db.select({
    totalDebits: sql<string>`COALESCE(SUM(jl.debit), 0)`,
    totalCredits: sql<string>`COALESCE(SUM(jl.credit), 0)`,
  }).from(sql`journal_lines jl JOIN transactions t ON jl.transaction_id = t.id WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'`);

  const row = result[0];
  const totalDebits = new Decimal(row?.totalDebits || '0');
  const totalCredits = new Decimal(row?.totalCredits || '0');
  const difference = totalDebits.minus(totalCredits).abs();

  return {
    valid: difference.lessThan('0.01'),
    totalDebits: Number(totalDebits.toFixed(4)),
    totalCredits: Number(totalCredits.toFixed(4)),
    difference: Number(difference.toFixed(4)),
  };
}

// A "category" account is any account that is NOT the transaction's own
// money / control side. The money/control accounts — bank, A/R, A/P, credit
// cards, Payments Clearing / Undeposited Funds, and the auto-managed Sales
// Tax Payable — are the cash side of an entry, never the category. Defining
// "category" by EXCLUSION (rather than whitelisting P&L account types) lets a
// deposit/payment whose offset is equity (owner draw), a loan, a fixed asset,
// etc. be recategorized in bulk. Kept in sync with the Category-column filter
// used in listTransactions.
const NON_CATEGORY_DETAIL_TYPES = ['bank', 'accounts_receivable', 'accounts_payable', 'credit_card'];
const NON_CATEGORY_SYSTEM_TAGS = ['payments_clearing', 'undeposited_funds', 'sales_tax_payable'];

// Drizzle condition (over a query that joins `accounts`) selecting category
// lines — i.e. lines whose account is not a money/control account.
function categoryLineAccountCond() {
  return and(
    or(isNull(accounts.detailType), notInArray(accounts.detailType, NON_CATEGORY_DETAIL_TYPES)),
    or(isNull(accounts.systemTag), notInArray(accounts.systemTag, NON_CATEGORY_SYSTEM_TAGS)),
  );
}

/**
 * Bulk-edit Payee / Category / Tag across many transactions from the list
 * view. Atomic — the whole batch commits or rolls back together. Invariants:
 *   - Payee (transactions.contact_id) is header-level — always safe to set.
 *   - Tag sets journal_lines.tag_id on every line, then re-syncs the
 *     transaction_tags junction (no-op when TAGS_SPLIT_LEVEL_V2 is off).
 *   - Category re-points the transaction's SINGLE P&L line to a new account
 *     and moves the denormalised accounts.balance to match. Split
 *     transactions (0 or >1 category lines) are skipped, never collapsed.
 *   - Source move (moveFromAccountId → moveToAccountId) re-points every line
 *     posted to the FROM account onto the TO account — the money/source side,
 *     so splits work (their category lines are untouched). Transactions whose
 *     from-account line is cleared in a completed reconciliation are skipped
 *     (moving it would orphan the rec); A/R and A/P control accounts are
 *     rejected outright (aging and payment application depend on them).
 *   - Void, lock-dated, and reconciled (cleared in a completed rec)
 *     transactions are skipped for line-touching changes.
 * Returns counts so the UI can report "N updated, M skipped (splits, etc.)".
 */
export async function bulkUpdateTransactions(
  tenantId: string,
  input: BulkUpdateTransactionsInput,
  userId?: string,
  companyId?: string,
): Promise<BulkUpdateTransactionsResult> {
  const { txnIds, setPayeeContactId, setCategoryAccountId, setTagId, tagAccountId, moveFromAccountId, moveToAccountId } = input;
  const skipped: Array<{ id: string; reason: string }> = [];
  let updated = 0;

  return await db.transaction(async (tx) => {
    // Validate targets once up front — a bad account/contact id should 400
    // the whole batch rather than silently no-op per transaction.
    if (setCategoryAccountId !== undefined) {
      await assertAccountsInScope(tx, tenantId, companyId ?? null, [setCategoryAccountId]);
    }
    if (moveToAccountId !== undefined) {
      if (!moveFromAccountId || moveFromAccountId === moveToAccountId) {
        throw AppError.badRequest('A source-account move needs distinct from/to accounts.');
      }
      await assertAccountsInScope(tx, tenantId, companyId ?? null, [moveFromAccountId, moveToAccountId]);
      // A/R and A/P control lines drive aging + payment application; moving
      // them wholesale would corrupt both. Refuse the batch, don't skip rows.
      const moveAccounts = await tx.select({ id: accounts.id, detailType: accounts.detailType })
        .from(accounts)
        .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, [moveFromAccountId, moveToAccountId])));
      if (moveAccounts.some((a) => a.detailType === 'accounts_receivable' || a.detailType === 'accounts_payable')) {
        throw AppError.badRequest('Accounts Receivable / Accounts Payable lines cannot be bulk-moved.');
      }
    }
    if (setPayeeContactId) {
      const [contact] = await tx.select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, setPayeeContactId)))
        .limit(1);
      if (!contact) throw AppError.badRequest('Payee contact does not belong to this tenant');
    }

    // Per-company lock dates — loaded once. Each transaction is checked
    // against ITS company's lock; scope-less transactions fall back to
    // the strictest lock in the tenant (matches checkLockDate policy —
    // the old single-arbitrary-row load let one company's rows govern
    // every company in a multi-company tenant).
    const lockResult = await tx.execute(sql`SELECT id, lock_date FROM companies WHERE tenant_id = ${tenantId}`);
    const lockByCompany = new Map<string, string | null>();
    let maxLock: string | null = null;
    for (const row of lockResult.rows as Array<{ id: string; lock_date: string | null }>) {
      lockByCompany.set(row.id, row.lock_date);
      if (row.lock_date && (!maxLock || row.lock_date > maxLock)) maxLock = row.lock_date;
    }

    for (const txnId of txnIds) {
      const conds = [eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)];
      if (companyId) conds.push(eq(transactions.companyId, companyId));
      const [txn] = await tx.select().from(transactions).where(and(...conds)).for('update').limit(1);

      if (!txn || txn.status === 'deleted') { skipped.push({ id: txnId, reason: 'not_found' }); continue; }
      if (txn.status === 'void') { skipped.push({ id: txnId, reason: 'void' }); continue; }
      // TB3: AJE lifecycle is firm-only and runs through the tb router —
      // bulk recategorize/retag must never rewrite an adjusting entry.
      if (txn.txnType === 'aje') { skipped.push({ id: txnId, reason: 'aje' }); continue; }
      // A/P documents keep their sub-ledger in their own services (review
      // M5): a bulk payee change would move a bill to another vendor under
      // its payments, a category or source move would rewrite its lines.
      if (AP_DOCUMENT_TYPES.includes(txn.txnType)) { skipped.push({ id: txnId, reason: 'ap_document' }); continue; }
      const lockDate = txn.companyId ? (lockByCompany.get(txn.companyId) ?? null) : maxLock;
      if (lockDate && txn.txnDate <= lockDate) { skipped.push({ id: txnId, reason: 'locked' }); continue; }

      // Reconciled transactions are intentionally NOT skipped here. A completed
      // reconciliation only ever clears a txn's bank / credit-card line, and
      // every bulk operation below is neutral to that cleared line: a tag
      // change is ledger-neutral, a category move only ever relocates a
      // category line (bank / A/R / A/P / credit-card / clearing accounts are
      // excluded — so never the cleared line), and a payee change is
      // header-level. So the
      // reconciled total, the cleared-line amounts, and the journal_line ids
      // that reconciliation_lines references all stay put. This matches the
      // single-edit policy in updateTransaction ("you can still recategorize or
      // re-tag the income/expense lines"); the previous blanket skip wrongly
      // blocked ledger-neutral tag edits on reconciled rows.
      let changed = false;

      // Payee — header-level, always applicable.
      if (setPayeeContactId !== undefined) {
        await tx.update(transactions)
          .set({ contactId: setPayeeContactId, updatedAt: new Date() })
          .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));
        changed = true;
      }

      // Category — only when there's exactly one P&L line to move.
      if (setCategoryAccountId !== undefined) {
        const catLines = await tx.select({
          id: journalLines.id, accountId: journalLines.accountId,
          debit: journalLines.debit, credit: journalLines.credit, billedStatus: journalLines.billedStatus,
        })
          .from(journalLines)
          .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
          .where(and(
            eq(journalLines.tenantId, tenantId),
            eq(journalLines.transactionId, txnId),
            categoryLineAccountCond(),
          ));

        // A cost billed to a customer keeps its account (U-50, U-128 S11):
        // skipped as 'billed' when the category was the only change, else left.
        const billedMove = catLines.length === 1 && catLines[0]!.billedStatus === 'billed'
          && catLines[0]!.accountId !== setCategoryAccountId;
        if (billedMove && setPayeeContactId === undefined && setTagId === undefined) {
          skipped.push({ id: txnId, reason: 'billed' });
          continue;
        }
        if (catLines.length === 1 && !billedMove) {
          const line = catLines[0]!;
          if (line.accountId !== setCategoryAccountId) {
            if (txn.status === 'posted') {
              // Move the denormalised balance: reverse the line off its old
              // account, apply it to the new one. Amounts are unchanged so the
              // trial balance still balances; only the per-account split moves.
              await updateAccountBalances(tx, tenantId, [{ accountId: line.accountId, debit: line.credit, credit: line.debit }]);
              await updateAccountBalances(tx, tenantId, [{ accountId: setCategoryAccountId, debit: line.debit, credit: line.credit }]);
            }
            await tx.update(journalLines)
              .set({ accountId: setCategoryAccountId })
              .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.id, line.id)));
          }
          changed = true;
        } else if (setPayeeContactId === undefined && setTagId === undefined) {
          // Category was the sole requested change and this isn't a single-
          // category transaction — skip it so the caller can report it.
          skipped.push({ id: txnId, reason: catLines.length === 0 ? 'no_category_line' : 'split' });
          continue;
        }
        // else: payee/tag still apply below; the category just didn't move.
      }

      // Source-account move — re-point this transaction's line(s) on the FROM
      // account to the TO account. Splits are fine: only the source side moves.
      if (moveToAccountId !== undefined && moveFromAccountId !== undefined) {
        const soleChange =
          setPayeeContactId === undefined && setCategoryAccountId === undefined && setTagId === undefined;
        const moveLines = await tx.select({
          id: journalLines.id, debit: journalLines.debit, credit: journalLines.credit,
        })
          .from(journalLines)
          .where(and(
            eq(journalLines.tenantId, tenantId),
            eq(journalLines.transactionId, txnId),
            eq(journalLines.accountId, moveFromAccountId),
          ));

        if (moveLines.length === 0) {
          if (soleChange) { skipped.push({ id: txnId, reason: 'no_line_on_account' }); continue; }
        } else {
          // A from-account line cleared in a completed reconciliation must not
          // move — the rec's cleared total would no longer describe the account.
          const cleared = await tx.execute(sql`
            SELECT 1
            FROM ${reconciliationLines} rl
            JOIN ${reconciliations} r ON r.id = rl.reconciliation_id
            WHERE r.tenant_id = ${tenantId}
              AND r.status = 'complete'
              AND rl.is_cleared = true
              AND rl.journal_line_id IN (${sql.join(moveLines.map((l) => sql`${l.id}`), sql`, `)})
            LIMIT 1
          `);
          if ((cleared.rows as unknown[]).length > 0) {
            if (soleChange) { skipped.push({ id: txnId, reason: 'reconciled' }); continue; }
          } else {
            if (txn.status === 'posted') {
              // Shift the denormalised balances: reverse the lines off the from
              // account, apply them to the to account. Amounts are unchanged so
              // the trial balance still balances.
              let d = new Decimal('0');
              let c = new Decimal('0');
              for (const l of moveLines) { d = d.plus(l.debit || '0'); c = c.plus(l.credit || '0'); }
              await updateAccountBalances(tx, tenantId, [{ accountId: moveFromAccountId, debit: c.toFixed(4), credit: d.toFixed(4) }]);
              await updateAccountBalances(tx, tenantId, [{ accountId: moveToAccountId, debit: d.toFixed(4), credit: c.toFixed(4) }]);
            }
            await tx.update(journalLines)
              .set({ accountId: moveToAccountId })
              .where(and(
                eq(journalLines.tenantId, tenantId),
                inArray(journalLines.id, moveLines.map((l) => l.id)),
              ));
            changed = true;
          }
        }
      }

      // Tag — set (uuid) or clear (null). Scoped to the viewed account's
      // line(s) when tagAccountId is given, so a split / journal entry only
      // tags the account the operator is looking at rather than every line.
      if (setTagId !== undefined) {
        const tagConds = [eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)];
        if (tagAccountId) tagConds.push(eq(journalLines.accountId, tagAccountId));
        const touched = await tx.update(journalLines)
          .set({ tagId: setTagId })
          .where(and(...tagConds))
          .returning({ id: journalLines.id });
        if (touched.length > 0) {
          // Re-sync the header junction from the ACTUAL per-line tags — with
          // account scoping the lines can now carry mixed tags, so we can't
          // assume the whole transaction collapses to the single set tag.
          const postLines = await tx.select({ tagId: journalLines.tagId })
            .from(journalLines)
            .where(and(
              eq(journalLines.tenantId, tenantId),
              eq(journalLines.transactionId, txnId),
              eq(journalLines.isVoidReversal, false),
            ));
          await syncTransactionTagsFromLines(tx, tenantId, txn.companyId ?? null, txnId, postLines);
          changed = true;
        }
      }

      if (changed) {
        updated++;
        await auditLog(tenantId, 'update', 'transaction', txnId, null, {
          bulk: true,
          ...(setPayeeContactId !== undefined ? { contactId: setPayeeContactId } : {}),
          ...(setCategoryAccountId !== undefined ? { categoryAccountId: setCategoryAccountId } : {}),
          ...(setTagId !== undefined ? { tagId: setTagId } : {}),
          ...(moveToAccountId !== undefined ? { moveFromAccountId, moveToAccountId } : {}),
        }, userId, tx);
      } else {
        skipped.push({ id: txnId, reason: 'no_change' });
      }
    }

    return { updated, skipped };
  });
}
