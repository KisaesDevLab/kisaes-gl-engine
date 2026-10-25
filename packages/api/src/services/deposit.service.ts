// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bank deposits.
//
//   DR deposit-to account      (line total − cash back)
//   CR each line               (a negative line amount posts as a debit:
//                               fees, Q-84)
//   DR cash-back account       (U-53, line_role 'cash_back')
//
// A line may name the document it deposits (sourceTransactionId):
//   - U-52 deposit grouping: an item sitting in Payments Clearing. The line
//     account must be Payments Clearing and the amount must equal the item's
//     undeposited amount exactly; an item goes into one posted deposit only
//     (409 ALREADY_DEPOSITED). The source rows are locked FOR UPDATE inside
//     the posting transaction, so two deposits racing for one payment
//     serialize and the second gets the 409.
//   - U-54 vendor refund: a posted vendor credit. The line account must be
//     A/P and the line contact the credit's vendor; the amount reduces the
//     credit's open balance and may not exceed it (409
//     VENDOR_CREDIT_EXCEEDED). The credit's balance_due follows.
// Links live in deposit_lines (written in the same transaction) and on the
// journal line (journal_lines.source_transaction_id). Voiding, deleting or
// editing the deposit releases them (ledger.service / releaseDepositLinks).
//
// Lines without a source post exactly as before, so callers that deposit
// plain Payments Clearing lines (MCP, batch entry, API v2) keep working.
// Grouping trusts the links: an unlinked Payments Clearing line clears no
// particular item, so the items it was meant for still read as pending.
// The web Bank Deposit page sends the links; the POST / PUT /transactions
// response carries clearingWouldGoNegative so a caller sees when Payments
// Clearing went below zero (more deposited than ever came in: usually an
// item deposited twice, once without its link).
//
// strictAmounts: true (the desktop app sends it) makes every line amount an
// exact decimal string (at most 4 places, no exponent), as linked lines and
// cash back always are; without it plain lines keep the old leniency.
//
// Cash back may not go to the deposit-to account or to a control account
// (Payments Clearing, A/R, A/P, Sales Tax Payable): 400 VALIDATION_ERROR.
//
// An edit may not silently drop a link (U-80, ledger-guards-v1): when a
// linked line comes back without its sourceTransactionId while an unlinked
// line on the same account stays (the shape of an edit made by a form that
// never knew about the links), the edit is 409 DEPOSIT_LINKS_DROPPED and
// nothing changes. Removing the line itself still takes the item out of the
// deposit, as before.

import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type { CreateDepositInput, JournalLineInput } from '@kis-books/shared';
import { db, type Tx } from '../db/index.js';
import { accounts, depositLines, journalLines, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { exactAmount } from '../utils/money.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import {
  liveDepositsForSource, recomputeVendorCreditBalance, releaseDepositLinks, type DepositLinkRow,
} from './deposit-links.service.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;

interface SourceRef {
  /** Index into input.lines. */
  index: number;
  sourceTransactionId: string;
  amount: DecimalValue;
  /** journal line_order of the line (bank line is 0). */
  lineOrder: number;
}

export interface DepositPlan {
  payload: ledger.PostTransactionInput;
  sources: SourceRef[];
}

/**
 * A plain line amount: any finite decimal, as before (the database keeps 4
 * places). Non-numeric input is a 400 instead of a 500.
 */
function plainAmount(value: unknown, field: string): DecimalValue {
  try {
    const d = new Decimal(typeof value === 'number' ? String(value) : String(value ?? '').trim());
    if (!d.isFinite()) throw new Error('not finite');
    return new Decimal(d.toFixed(4));
  } catch {
    throw AppError.badRequest(`${field} must be a decimal amount`, 'VALIDATION_ERROR');
  }
}

export function planDeposit(input: CreateDepositInput): DepositPlan {
  const sources: SourceRef[] = [];
  const seen = new Set<string>();
  let lineTotal = new Decimal(0);

  const strict = input.strictAmounts === true;
  const lines: JournalLineInput[] = input.lines.map((line, i) => {
    const field = `lines[${i}].amount`;
    const amount = line.sourceTransactionId || strict ? exactAmount(line.amount, field) : plainAmount(line.amount, field);
    if (line.sourceTransactionId) {
      if (!amount.greaterThan(0)) {
        throw AppError.badRequest(`${field} must be greater than zero for a line that deposits an item`, 'VALIDATION_ERROR');
      }
      if (seen.has(line.sourceTransactionId)) {
        throw AppError.badRequest('The same item appears on two deposit lines.', 'DEPOSIT_SOURCE_DUPLICATE');
      }
      seen.add(line.sourceTransactionId);
      sources.push({ index: i, sourceTransactionId: line.sourceTransactionId, amount, lineOrder: i + 1 });
    }
    lineTotal = lineTotal.plus(amount);
    const neg = amount.isNegative();
    return {
      accountId: line.accountId,
      // Q-84: a negative amount (a fee taken out of the deposit) is a debit.
      debit: neg ? amount.abs().toFixed(4) : '0',
      credit: neg ? '0' : amount.toFixed(4),
      description: line.description,
      tagId: line.tagId,
      contactId: line.contactId,
      ...(line.sourceTransactionId ? { sourceTransactionId: line.sourceTransactionId } : {}),
    };
  });

  let cashBack: DecimalValue = new Decimal(0);
  const cashBackLines: JournalLineInput[] = [];
  if (input.cashBack) {
    if (input.cashBack.accountId === input.depositToAccountId) {
      throw AppError.badRequest('Cash back can’t go to the account the deposit goes into.', 'VALIDATION_ERROR');
    }
    cashBack = exactAmount(input.cashBack.amount, 'cashBack.amount');
    if (!cashBack.greaterThan(0)) {
      throw AppError.badRequest('cashBack.amount must be greater than zero', 'VALIDATION_ERROR');
    }
    cashBackLines.push({
      accountId: input.cashBack.accountId,
      debit: cashBack.toFixed(4),
      credit: '0',
      description: input.cashBack.memo,
      lineRole: 'cash_back',
    });
  }

  const bank = lineTotal.minus(cashBack);
  if (!bank.greaterThan(0)) {
    throw AppError.badRequest(
      `The deposit total must be greater than zero (lines ${lineTotal.toFixed(2)}, cash back ${cashBack.toFixed(2)}).`,
      'DEPOSIT_TOTAL_NOT_POSITIVE',
    );
  }
  const totalStr = bank.toFixed(4);
  return {
    payload: {
      txnType: 'deposit',
      txnDate: input.txnDate,
      memo: input.memo,
      total: totalStr,
      lines: [
        { accountId: input.depositToAccountId, debit: totalStr, credit: '0' },
        ...lines,
        ...cashBackLines,
      ],
    },
    sources,
  };
}

async function systemAccountId(tx: Tx, tenantId: string, tag: string): Promise<string | null> {
  const [row] = await tx.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, tag)))
    .limit(1);
  return row?.id ?? null;
}

/** Control accounts cash back may not be taken into. */
const CASH_BACK_REFUSED_TAGS = ['payments_clearing', 'accounts_receivable', 'accounts_payable', 'sales_tax_payable'];

export async function validateCashBackAccount(tx: Tx, tenantId: string, input: CreateDepositInput) {
  if (!input.cashBack) return;
  const [acct] = await tx.select({ systemTag: accounts.systemTag }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, input.cashBack.accountId)))
    .limit(1);
  // A missing or foreign account is left to the ledger's scope check.
  if (acct?.systemTag && CASH_BACK_REFUSED_TAGS.includes(acct.systemTag)) {
    throw AppError.badRequest(
      'Cash back can’t go to Payments Clearing, Accounts Receivable, Accounts Payable or Sales Tax Payable. Choose a cash or expense account.',
      'VALIDATION_ERROR',
    );
  }
}

/**
 * True when Payments Clearing (the active company's items and those without
 * a company, as the pending list counts them) holds a net credit after this
 * posting. Only checked when the deposit has a Payments Clearing line.
 */
async function clearingWentNegative(
  tx: Tx, tenantId: string, companyId: string | undefined, input: CreateDepositInput,
): Promise<boolean> {
  const clearingId = await systemAccountId(tx, tenantId, 'payments_clearing');
  if (!clearingId || !input.lines.some((l) => l.accountId === clearingId)) return false;
  const companyCond = companyId ? sql`AND (t.company_id = ${companyId} OR t.company_id IS NULL)` : sql``;
  const res = await tx.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS net
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${clearingId}
      AND t.status = 'posted' AND jl.is_void_reversal = false ${companyCond}
  `);
  return new Decimal(String((res.rows as Array<{ net: string | number }>)[0]?.net ?? '0')).isNegative();
}

function sourceInvalid(message: string, sourceTransactionId: string) {
  return new AppError(400, message, 'DEPOSIT_SOURCE_INVALID', { sourceTransactionId });
}

/**
 * Locks every source row (sorted, so two deposits lock in the same order)
 * and checks each line against its source. `depositId` is the deposit being
 * edited (its own links were released just before).
 */
async function lockAndValidateSources(
  tx: Tx,
  tenantId: string,
  companyId: string | undefined,
  input: CreateDepositInput,
  plan: DepositPlan,
  depositId: string | null,
) {
  if (plan.sources.length === 0) return;
  const ids = [...plan.sources.map((s) => s.sourceTransactionId)].sort();
  const rows = await tx.select({
    id: transactions.id,
    companyId: transactions.companyId,
    txnType: transactions.txnType,
    status: transactions.status,
    contactId: transactions.contactId,
    total: transactions.total,
  }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, ids)))
    .orderBy(transactions.id)
    .for('update');
  const byId = new Map(rows.map((r) => [r.id, r]));

  const clearingId = await systemAccountId(tx, tenantId, 'payments_clearing');
  const apId = await systemAccountId(tx, tenantId, 'accounts_payable');

  for (const src of plan.sources) {
    const line = input.lines[src.index]!;
    const row = byId.get(src.sourceTransactionId);
    // Another tenant's id, another company's item and a missing id all read
    // the same, so nothing about the other company leaks.
    if (!row || (companyId && row.companyId && row.companyId !== companyId)) {
      throw sourceInvalid('The item on this deposit line was not found in this company.', src.sourceTransactionId);
    }
    if (row.status !== 'posted') {
      throw sourceInvalid('The item on this deposit line is void, deleted or not posted.', src.sourceTransactionId);
    }

    if (row.txnType === 'vendor_credit') {
      // U-54 vendor refund.
      if (!apId || line.accountId !== apId) {
        throw AppError.badRequest('A vendor refund line must use the Accounts Payable account.', 'VENDOR_REFUND_ACCOUNT');
      }
      if (line.contactId && line.contactId !== row.contactId) {
        throw AppError.badRequest('A vendor refund line must name the vendor of the credit.', 'VENDOR_REFUND_CONTACT');
      }
      // The A/P line carries the vendor, so A/P by vendor stays right.
      const jl = plan.payload.lines[src.lineOrder]!;
      jl.contactId = row.contactId ?? null;
      const open = await vendorCreditOpenBalance(tx, tenantId, row.id, row.total, depositId);
      if (src.amount.greaterThan(open)) {
        throw AppError.conflict(
          `The refund (${src.amount.toFixed(2)}) is more than the credit’s open balance (${open.toFixed(2)}).`,
          'VENDOR_CREDIT_EXCEEDED',
          { sourceTransactionId: row.id, openBalance: open.toFixed(4) },
        );
      }
      continue;
    }

    // U-52 deposit grouping.
    if (!clearingId || line.accountId !== clearingId) {
      throw AppError.badRequest(
        'A line that deposits a payment must use the Payments Clearing account.',
        'DEPOSIT_SOURCE_ACCOUNT',
      );
    }
    const live = await liveDepositsForSource(tx, tenantId, row.id, depositId ?? undefined);
    if (live.length > 0) {
      throw AppError.conflict(
        'This payment is already in another bank deposit.',
        'ALREADY_DEPOSITED',
        { sourceTransactionId: row.id, depositId: live[0]!.depositId },
      );
    }
    const pending = await clearingAmount(tx, tenantId, row.id, clearingId);
    if (!pending.greaterThan(0)) {
      throw sourceInvalid('The item on this deposit line has nothing waiting in Payments Clearing.', row.id);
    }
    if (!src.amount.equals(pending)) {
      throw new AppError(400,
        `The deposit line (${src.amount.toFixed(4)}) must equal the payment’s undeposited amount (${pending.toFixed(4)}).`,
        'DEPOSIT_SOURCE_AMOUNT_MISMATCH',
        { sourceTransactionId: row.id, expected: pending.toFixed(4) },
      );
    }
  }
}

/** Net Payments Clearing debit an item holds (its undeposited amount). */
async function clearingAmount(tx: Tx, tenantId: string, txnId: string, clearingId: string): Promise<DecimalValue> {
  const res = await tx.execute(sql`
    SELECT COALESCE(SUM(debit - credit), 0) AS net
    FROM journal_lines
    WHERE tenant_id = ${tenantId} AND transaction_id = ${txnId}
      AND account_id = ${clearingId} AND is_void_reversal = false
  `);
  return new Decimal(String((res.rows as Array<{ net: string | number }>)[0]?.net ?? '0'));
}

async function vendorCreditOpenBalance(
  tx: Tx, tenantId: string, creditId: string, total: string | null, exceptDepositId: string | null,
): Promise<DecimalValue> {
  const except = exceptDepositId ? sql` AND d.id <> ${exceptDepositId}` : sql``;
  const res = await tx.execute(sql`
    SELECT
      COALESCE((SELECT SUM(amount) FROM vendor_credit_applications
                WHERE credit_id = ${creditId} AND tenant_id = ${tenantId}), 0) AS applied,
      COALESCE((SELECT SUM(dl.amount) FROM deposit_lines dl
                JOIN transactions d ON d.id = dl.deposit_id
                WHERE dl.source_transaction_id = ${creditId}
                  AND d.tenant_id = ${tenantId} AND d.status = 'posted' ${except}), 0) AS refunded
  `);
  const row = (res.rows as Array<{ applied: string | number; refunded: string | number }>)[0];
  const open = new Decimal(total || '0').minus(String(row?.applied ?? 0)).minus(String(row?.refunded ?? 0));
  return open.isNegative() ? new Decimal(0) : open;
}

async function writeLinks(
  tx: Tx, tenantId: string, depositId: string, plan: DepositPlan, released: DepositLinkRow[], userId?: string,
) {
  if (plan.sources.length > 0) {
    await tx.insert(depositLines).values(plan.sources.map((s) => ({
      depositId,
      sourceTransactionId: s.sourceTransactionId,
      amount: s.amount.toFixed(4),
      sortOrder: s.lineOrder,
    })));
  }
  const touched = [...new Set(plan.sources.map((s) => s.sourceTransactionId))];
  if (touched.length > 0) {
    // id order, like releaseDepositLinks (these rows are already locked by
    // lockAndValidateSources; the order keeps the recompute deterministic).
    const credits = await tx.select({ id: transactions.id }).from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.txnType, 'vendor_credit'), inArray(transactions.id, touched)))
      .orderBy(transactions.id)
      .for('update');
    for (const c of credits) await recomputeVendorCreditBalance(tx, tenantId, c.id);
  }
  if (plan.sources.length > 0 || released.length > 0) {
    await auditLog(tenantId, 'update', 'deposit_links', depositId,
      released.length > 0 ? { links: released } : null,
      { links: plan.sources.map((s) => ({ sourceTransactionId: s.sourceTransactionId, amount: s.amount.toFixed(4) })) },
      userId, tx);
  }
}

export interface DepositResult {
  transaction: Awaited<ReturnType<typeof ledger.postTransaction>>;
  /** Payments Clearing holds a net credit after this deposit (see header). */
  clearingWouldGoNegative: boolean;
}

/**
 * Create, with the Payments Clearing warning (POST /transactions).
 * `outerTx` (templates, U-62): post inside the caller's transaction.
 */
export async function createDepositWithWarnings(
  tenantId: string, input: CreateDepositInput, userId?: string, companyId?: string, outerTx?: Tx,
): Promise<DepositResult> {
  const plan = planDeposit(input);
  const post = async (tx: Tx): Promise<DepositResult> => {
    await validateCashBackAccount(tx, tenantId, input);
    await lockAndValidateSources(tx, tenantId, companyId, input, plan, null);
    const posted = await ledger.postTransaction(tenantId, plan.payload, userId, companyId, tx);
    await writeLinks(tx, tenantId, posted.id, plan, [], userId);
    return { transaction: posted, clearingWouldGoNegative: await clearingWentNegative(tx, tenantId, companyId, input) };
  };
  return outerTx ? post(outerTx) : db.transaction(post);
}

export async function createDeposit(tenantId: string, input: CreateDepositInput, userId?: string, companyId?: string) {
  return (await createDepositWithWarnings(tenantId, input, userId, companyId)).transaction;
}

/**
 * Refuses an edit that drops a link while keeping its line (U-80): a linked
 * line of the deposit (payments-clearing item or vendor refund) whose source
 * the edit no longer sends, while the edit still has an unlinked line on that
 * line's account. Without the guard the item would read as pending (or the
 * vendor credit as open) again although the deposit still holds its money.
 * 409 DEPOSIT_LINKS_DROPPED, details.sourceTransactionIds.
 */
async function assertLinksNotDropped(
  tx: Tx, tenantId: string, depositId: string, input: CreateDepositInput, plan: DepositPlan,
) {
  const linked = await tx.select({ accountId: journalLines.accountId, sourceTransactionId: journalLines.sourceTransactionId })
    .from(journalLines)
    .where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, depositId),
      eq(journalLines.isVoidReversal, false),
      isNotNull(journalLines.sourceTransactionId),
    ));
  if (linked.length === 0) return;
  const kept = new Set(plan.sources.map((s) => s.sourceTransactionId));
  const unlinkedAccounts = new Set(input.lines.filter((l) => !l.sourceTransactionId).map((l) => l.accountId));
  const dropped = [...new Set(linked
    .filter((l) => !kept.has(l.sourceTransactionId!) && unlinkedAccounts.has(l.accountId))
    .map((l) => l.sourceTransactionId!))];
  if (dropped.length === 0) return;
  throw AppError.conflict(
    'This deposit includes payments or vendor refunds, and this change would leave them out while keeping their lines. ' +
      'Edit it as a bank deposit: send each of those lines with its sourceTransactionId, or remove the line to take the item out of the deposit.',
    'DEPOSIT_LINKS_DROPPED',
    { sourceTransactionIds: dropped },
  );
}

/** Edit, with the Payments Clearing warning (PUT /transactions/:id). */
export async function updateDepositWithWarnings(
  tenantId: string, txnId: string, input: CreateDepositInput, userId?: string, companyId?: string,
) {
  const plan = planDeposit(input);
  return db.transaction(async (tx) => {
    // Deposit row first, then its sources (create locks sources only), so
    // an edit and a create never wait on each other in opposite orders.
    const [existing] = await tx.select({
      id: transactions.id, companyId: transactions.companyId, status: transactions.status, txnType: transactions.txnType,
    })
      .from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update')
      .limit(1);
    // Only a deposit can be rewritten as a deposit: anything else (a payment,
    // an invoice...) reads as not found, before any of its links are touched.
    if (!existing || existing.txnType !== 'deposit' || existing.status === 'deleted'
      || (companyId && existing.companyId && existing.companyId !== companyId)) {
      throw AppError.notFound('Transaction not found');
    }
    await validateCashBackAccount(tx, tenantId, input);
    // A void deposit is refused by updateTransaction; its links were
    // released when it was voided.
    if (existing.status !== 'void') await assertLinksNotDropped(tx, tenantId, txnId, input, plan);
    const released = existing.status === 'void' ? [] : await releaseDepositLinks(tx, tenantId, txnId);
    await lockAndValidateSources(tx, tenantId, companyId, input, plan, txnId);
    const updated = await ledger.updateTransaction(tenantId, txnId, plan.payload, userId, companyId, tx);
    await writeLinks(tx, tenantId, txnId, plan, released, userId);
    return { transaction: updated, clearingWouldGoNegative: await clearingWentNegative(tx, tenantId, companyId, input) };
  });
}

export async function updateDeposit(tenantId: string, txnId: string, input: CreateDepositInput, userId?: string, companyId?: string) {
  return (await updateDepositWithWarnings(tenantId, txnId, input, userId, companyId)).transaction;
}
