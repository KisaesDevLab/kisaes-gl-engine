// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { eq, and, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
type Dec = InstanceType<typeof Decimal>;
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { reconciliations, reconciliationLines, journalLines, accounts, bankStatements, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { invalidateForReopen } from './reconciliation-signoff.service.js';
import { postTransaction, checkLockDate } from './ledger.service.js';

type ReconRow = typeof reconciliations.$inferSelect;

export interface ContinuityWarning {
  expected: number; // prior completed reconciliation's ending balance
  actual: number;   // statement's opening balance
  delta: number;
}

/** Service charge or interest entered at Begin (U-189). */
export interface ReconcileChargeInput {
  amount: string;
  date: string;
  accountId: string;
}

export type ReconcileChargeKind = 'serviceCharge' | 'interest';

export interface StartReconciliationOptions {
  statementId?: string;
  serviceCharge?: ReconcileChargeInput | null;
  interest?: ReconcileChargeInput | null;
  includeLaterLines?: boolean;
  precheck?: 'bank_feed';
  userId?: string;
}

export type ReconciliationView = 'full' | 'summary';

export type UndoMode = 'clear_checks' | 'keep_checks' | 'discard';

// Bank statements print liability balances (credit cards, lines of credit)
// as positive amounts OWED, but on the books a liability is credit-normal:
// the reconciliation's cleared-balance arithmetic (beginning + Σ(debit −
// credit)) produces the NEGATIVE of the printed figure. Flip statement
// balances into GL orientation for liability accounts so a statement-driven
// reconciliation can actually tie out; asset accounts pass through.
export function glOrientedStatementBalance(
  value: string | null,
  accountType: string | null | undefined,
): string | null {
  if (value == null) return null;
  return accountType === 'liability' ? new Decimal(value).negated().toFixed(4) : value;
}

// Statement opening balance vs the prior completed reconciliation's ending
// balance (the same derivation start() uses for beginningBalance). A
// mismatch means cleared transactions were changed/deleted since the last
// reconciliation — surfaced as a warning, never a block. Numbers are kept
// for existing clients; beginningBalanceDrift (U-189) carries exact strings.
function continuityOf(
  statementOpening: string | null,
  priorEnding: string | null | undefined,
): ContinuityWarning | null {
  if (statementOpening == null || priorEnding == null) return null;
  const expected = parseFloat(priorEnding);
  const actual = parseFloat(statementOpening);
  const delta = Number(new Decimal(actual).minus(expected).toFixed(4));
  return Math.abs(delta) > 0.005 ? { expected, actual, delta } : null;
}

// ─── Shared guards ──────────────────────────────────────────────

/** 409 for any change to a reconciliation that is not in progress (U-188). */
function notInProgress(status: string | null, completeMessage = 'Reconciliation is already complete'): AppError {
  return AppError.conflict(
    status === 'complete' ? completeMessage : 'Reconciliation is not in progress',
    'RECONCILIATION_NOT_IN_PROGRESS',
    { status },
  );
}

/** Locks the header FOR UPDATE and requires status in_progress. */
async function lockInProgress(tx: Tx, tenantId: string, reconciliationId: string, completeMessage?: string): Promise<ReconRow> {
  const [recon] = await tx.select().from(reconciliations)
    .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
    .for('update')
    .limit(1);
  if (!recon) throw AppError.notFound('Reconciliation not found');
  if (recon.status !== 'in_progress') throw notInProgress(recon.status, completeMessage);
  return recon;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

function inProgressConflict(reconciliationId: string | null, startedAt?: unknown): AppError {
  const when = startedAt instanceof Date ? startedAt.toISOString() : startedAt ? String(startedAt) : null;
  return AppError.conflict(
    `A reconciliation is already in progress for this account${when ? ` (started ${when})` : ''}. `
      + 'Finish or cancel it before starting a new one.',
    'RECONCILIATION_IN_PROGRESS',
    { reconciliationId },
  );
}

async function inProgressFor(executor: DbOrTx, tenantId: string, accountId: string, exceptId?: string) {
  const rows = await executor.select({ id: reconciliations.id, createdAt: reconciliations.createdAt })
    .from(reconciliations)
    .where(and(
      eq(reconciliations.tenantId, tenantId),
      eq(reconciliations.accountId, accountId),
      eq(reconciliations.status, 'in_progress'),
      exceptId ? sql`${reconciliations.id} <> ${exceptId}` : sql`true`,
    ))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The account's most recent completed reconciliation: latest statement date,
 * then latest finish (U-193). Its ending balance is the next one's beginning
 * balance and only it can be undone.
 */
async function latestCompletedOf(executor: DbOrTx, tenantId: string, accountId: string): Promise<ReconRow | null> {
  const [row] = await executor.select().from(reconciliations)
    .where(and(
      eq(reconciliations.tenantId, tenantId),
      eq(reconciliations.accountId, accountId),
      eq(reconciliations.status, 'complete'),
    ))
    .orderBy(sql`${reconciliations.statementDate} DESC`, sql`${reconciliations.completedAt} DESC NULLS LAST`)
    .limit(1);
  return row ?? null;
}

/**
 * A statement date must fall after the latest completed reconciliation's
 * (U-193): an earlier or equal one would begin from a later period's ending
 * balance. 409 RECONCILE_STATEMENT_DATE_ORDER {latestReconciliationId,
 * latestStatementDate}.
 */
function assertStatementDateAfter(latest: ReconRow | null, statementDate: string): void {
  if (!latest) return;
  const latestDay = isoDay(latest.statementDate);
  if (isoDay(statementDate) > latestDay) return;
  throw AppError.conflict(
    `The statement date must be after ${latestDay}, the date of the last finished reconciliation of this account.`,
    'RECONCILE_STATEMENT_DATE_ORDER',
    { latestReconciliationId: latest.id, latestStatementDate: latestDay },
  );
}

async function accountOf(executor: DbOrTx, tenantId: string, accountId: string) {
  const [acct] = await executor.select({
    id: accounts.id, companyId: accounts.companyId, accountType: accounts.accountType, isActive: accounts.isActive,
  }).from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))).limit(1);
  return acct ?? null;
}

/** YYYY-MM-DD of a date column, whether the driver gave a string or a Date. */
function isoDay(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

/** Postgres uuid[] literal for `= ANY(...::uuid[])` (ids are zod-validated uuids). */
function uuidArray(ids: readonly string[]): string {
  return `{${ids.join(',')}}`;
}

// ─── Charges entered at Begin (U-189) ───────────────────────────

const CHARGE_COLUMNS = {
  serviceCharge: { amount: 'serviceChargeAmount', date: 'serviceChargeDate', accountId: 'serviceChargeAccountId', txnId: 'serviceChargeTxnId' },
  interest: { amount: 'interestAmount', date: 'interestDate', accountId: 'interestAccountId', txnId: 'interestTxnId' },
} as const;

interface ChargeState {
  amount: string;
  date: string;
  accountId: string;
  txnId: string | null;
}

function chargeOf(recon: ReconRow, kind: ReconcileChargeKind): ChargeState | null {
  const cols = CHARGE_COLUMNS[kind];
  const amount = recon[cols.amount];
  const date = recon[cols.date];
  const accountId = recon[cols.accountId];
  if (amount == null || date == null || accountId == null) return null;
  return { amount, date, accountId, txnId: recon[cols.txnId] ?? null };
}

/** A charge entered at Begin that Finish has not posted yet. */
function pendingCharge(recon: ReconRow, kind: ReconcileChargeKind): ChargeState | null {
  const c = chargeOf(recon, kind);
  return c && !c.txnId ? c : null;
}

function chargeColumnsFor(kind: ReconcileChargeKind, input: ReconcileChargeInput | null) {
  const cols = CHARGE_COLUMNS[kind];
  return {
    [cols.amount]: input ? new Decimal(input.amount).toFixed(4) : null,
    [cols.date]: input ? input.date : null,
    [cols.accountId]: input ? input.accountId : null,
  } as Partial<typeof reconciliations.$inferInsert>;
}

/**
 * The charge (or income) account must be in the tenant, in the reconciled
 * account's company (or tenant-wide), active, and not the reconciled
 * account itself. 400 RECONCILE_CHARGE_ACCOUNT_INVALID {kind, reason}.
 */
async function assertChargeAccount(
  executor: DbOrTx,
  tenantId: string,
  reconAccount: { id: string; companyId: string | null },
  kind: ReconcileChargeKind,
  accountId: string,
): Promise<void> {
  const fail = (reason: string) => AppError.badRequest(
    `The ${kind === 'serviceCharge' ? 'service charge' : 'interest'} account can't be used: ${reason}.`,
    'RECONCILE_CHARGE_ACCOUNT_INVALID',
    { kind, reason },
  );
  if (accountId === reconAccount.id) throw fail('it is the account being reconciled');
  const acct = await accountOf(executor, tenantId, accountId);
  if (!acct) throw fail('account not found');
  if (reconAccount.companyId && acct.companyId && acct.companyId !== reconAccount.companyId) {
    throw fail('account belongs to a different company');
  }
  if (acct.isActive === false) throw fail('account is inactive');
}

// ─── Worksheet loading and the bank-file pre-check ──────────────

/**
 * Posted lines on the account that are not on this worksheet and not cleared
 * in a completed reconciliation; on or before the statement date unless
 * later lines are included.
 */
async function eligibleNewLineIds(
  executor: DbOrTx,
  tenantId: string,
  recon: Pick<ReconRow, 'id' | 'accountId' | 'statementDate' | 'includeLaterLines'>,
): Promise<string[]> {
  const res = await executor.execute(sql`
    SELECT jl.id FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${recon.accountId}
      AND t.status = 'posted'
      AND (${recon.includeLaterLines === true} OR t.txn_date <= ${recon.statementDate})
      AND NOT EXISTS (
        SELECT 1 FROM reconciliation_lines rl
        WHERE rl.reconciliation_id = ${recon.id} AND rl.journal_line_id = jl.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM reconciliation_lines rl
        JOIN reconciliations r ON r.id = rl.reconciliation_id
        WHERE rl.journal_line_id = jl.id AND r.tenant_id = ${tenantId} AND r.account_id = ${recon.accountId}
          AND r.status = 'complete' AND rl.is_cleared = true
      )
  `);
  return (res.rows as Array<{ id: string }>).map((r) => r.id);
}

/**
 * Bank-file pre-check (Q-100): of `lineIds`, the lines an accepted bank-file
 * row stands behind, the bank having posted it on or before the statement
 * date (feed_date, not the entry date), entry not voided. The row names the
 * line (matched_journal_line_id, migration 0265) or, for rows from before
 * it, the entry, when the row's own bank account is the reconciled account.
 */
async function bankFeedPrecheckIds(
  executor: DbOrTx,
  tenantId: string,
  recon: Pick<ReconRow, 'accountId' | 'statementDate'>,
  lineIds: readonly string[],
): Promise<string[]> {
  if (lineIds.length === 0) return [];
  const res = await executor.execute(sql`
    SELECT jl.id FROM journal_lines jl
    WHERE jl.id = ANY(${uuidArray(lineIds)}::uuid[])
      AND (
        EXISTS (
          SELECT 1 FROM bank_feed_items b
          WHERE b.tenant_id = ${tenantId} AND b.matched_journal_line_id = jl.id
            AND b.status IN ('matched', 'categorized')
            AND b.entry_voided_at IS NULL AND b.feed_date <= ${recon.statementDate}
        )
        OR EXISTS (
          SELECT 1 FROM bank_feed_items b
          JOIN bank_connections bc ON bc.id = b.bank_connection_id
          WHERE b.tenant_id = ${tenantId} AND b.matched_journal_line_id IS NULL
            AND b.matched_transaction_id = jl.transaction_id
            AND jl.account_id = ${recon.accountId} AND bc.account_id = ${recon.accountId}
            AND b.status IN ('matched', 'categorized')
            AND b.entry_voided_at IS NULL AND b.feed_date <= ${recon.statementDate}
        )
      )
  `);
  return (res.rows as Array<{ id: string }>).map((r) => r.id);
}

/** Adds `lineIds` to the worksheet, pre-checking bank-file lines when asked. */
async function addWorksheetLines(
  tx: Tx,
  tenantId: string,
  recon: Pick<ReconRow, 'id' | 'accountId' | 'statementDate'>,
  lineIds: readonly string[],
  precheck: 'bank_feed' | undefined,
): Promise<number> {
  if (lineIds.length === 0) return 0;
  const ticked = new Set(precheck === 'bank_feed' ? await bankFeedPrecheckIds(tx, tenantId, recon, lineIds) : []);
  const now = new Date();
  for (let i = 0; i < lineIds.length; i += 1000) {
    await tx.insert(reconciliationLines).values(
      lineIds.slice(i, i + 1000).map((id) => ({
        reconciliationId: recon.id,
        journalLineId: id,
        isCleared: ticked.has(id),
        clearedAt: ticked.has(id) ? now : null,
      })),
    );
  }
  return ticked.size;
}

// ─── Totals ─────────────────────────────────────────────────────

interface ClearedTotals {
  cleared: Dec;
  difference: Dec;
  deposits: { count: number; total: Dec };
  payments: { count: number; total: Dec };
}

/**
 * The one cleared-balance rule (GET and complete): beginning balance + Σ
 * (debit − credit) of the ticked lines + interest − service charge not yet
 * posted. Deposits are amounts > 0, payments the rest (zero included), in
 * the account's books sign.
 */
function clearedTotals(recon: ReconRow, lines: ReadonlyArray<{ is_cleared: boolean | null; debit: string; credit: string }>): ClearedTotals {
  const deposits = { count: 0, total: new Decimal(0) };
  const payments = { count: 0, total: new Decimal(0) };
  const add = (amount: Dec) => {
    const pane = amount.greaterThan(0) ? deposits : payments;
    pane.count += 1;
    pane.total = pane.total.plus(amount);
  };
  for (const line of lines) {
    if (line.is_cleared) add(new Decimal(line.debit).minus(line.credit));
  }
  const interest = pendingCharge(recon, 'interest');
  if (interest) add(new Decimal(interest.amount));
  const serviceCharge = pendingCharge(recon, 'serviceCharge');
  if (serviceCharge) add(new Decimal(serviceCharge.amount).negated());
  const cleared = new Decimal(recon.beginningBalance).plus(deposits.total).plus(payments.total);
  const difference = new Decimal(recon.statementEndingBalance).minus(cleared);
  return { cleared, difference, deposits, payments };
}

/**
 * Drift of the prior completed reconciliation (U-189): its stored ending
 * balance against its beginning balance plus the lines it cleared that are
 * still posted. Nonzero means a reconciled entry was voided, deleted or
 * changed since; null when there is no prior or no drift.
 */
async function beginningBalanceDriftOf(executor: DbOrTx, tenantId: string, recon: ReconRow) {
  const [prior] = await executor.select().from(reconciliations)
    .where(and(
      eq(reconciliations.tenantId, tenantId),
      eq(reconciliations.accountId, recon.accountId),
      eq(reconciliations.status, 'complete'),
      sql`${reconciliations.id} <> ${recon.id}`,
      recon.status === 'complete' ? sql`${reconciliations.statementDate} < ${recon.statementDate}` : sql`true`,
    ))
    .orderBy(sql`${reconciliations.statementDate} DESC`, sql`${reconciliations.completedAt} DESC NULLS LAST`)
    .limit(1);
  if (!prior) return null;
  return driftOfCompleted(executor, prior);
}

/** Drift of one completed reconciliation (null when none). */
async function driftOfCompleted(executor: DbOrTx, prior: ReconRow) {
  const res = await executor.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS net
    FROM reconciliation_lines rl
    JOIN journal_lines jl ON jl.id = rl.journal_line_id
    JOIN transactions t ON t.id = jl.transaction_id AND t.status = 'posted'
    WHERE rl.reconciliation_id = ${prior.id} AND rl.is_cleared = true
  `);
  const net = (res.rows as Array<{ net: string }>)[0]?.net ?? '0';
  const expected = new Decimal(prior.statementEndingBalance);
  const actual = new Decimal(prior.beginningBalance).plus(net);
  const difference = actual.minus(expected);
  if (difference.isZero()) return null;
  return {
    reconciliationId: prior.id,
    expected: expected.toFixed(4),
    actual: actual.toFixed(4),
    difference: difference.toFixed(4),
  };
}

/**
 * Drift of the account's latest completed reconciliation (U-191's report):
 * its stored ending balance against its beginning balance plus the lines it
 * cleared that are still posted. Null when none or no drift.
 */
export async function latestCompletedDrift(tenantId: string, accountId: string) {
  const latest = await latestCompletedOf(db, tenantId, accountId);
  return latest ? driftOfCompleted(db, latest) : null;
}

/** A pending charge dated on or before the closing date: Finish needs the password. */
async function postingLockedFor(executor: DbOrTx, tenantId: string, companyId: string | null, recon: ReconRow): Promise<boolean> {
  const dates = (['serviceCharge', 'interest'] as const)
    .map((k) => pendingCharge(recon, k)?.date)
    .filter((d): d is string => !!d);
  if (dates.length === 0) return false;
  const res = companyId
    ? await executor.execute(sql`SELECT lock_date::text AS lock_date FROM companies WHERE tenant_id = ${tenantId} AND id = ${companyId}`)
    : await executor.execute(sql`SELECT MAX(lock_date)::text AS lock_date FROM companies WHERE tenant_id = ${tenantId}`);
  const lockDate = (res.rows as Array<{ lock_date: string | null }>)[0]?.lock_date;
  if (!lockDate) return false;
  return dates.some((d) => d <= lockDate);
}

/** The entry exists and is posted (not voided, not deleted). */
async function postedEntryExists(executor: DbOrTx, tenantId: string, txnId: string): Promise<boolean> {
  const [row] = await executor.select({ status: transactions.status }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
    .limit(1);
  return row?.status === 'posted';
}

function chargeView(c: ChargeState | null) {
  return c ? { amount: c.amount, date: c.date, accountId: c.accountId } : null;
}

// ─── Start ──────────────────────────────────────────────────────

export async function start(
  tenantId: string,
  accountId: string | undefined,
  statementDate: string | undefined,
  statementEndingBalance: string | undefined,
  opts: StartReconciliationOptions = {},
) {
  // Statement-driven start: derive account / date / ending balance from the
  // stored bank_statements row, then link the reconciliation back to it.
  let statement: typeof bankStatements.$inferSelect | null = null;
  let statementAccountType: string | null = null;
  if (opts.statementId) {
    statement = await db.query.bankStatements.findFirst({
      where: and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, opts.statementId)),
    }) ?? null;
    if (!statement) throw AppError.notFound('Bank statement not found');
    if (statement.reconciliationId) {
      const linked = await db.query.reconciliations.findFirst({
        where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, statement.reconciliationId)),
      });
      if (linked) {
        throw AppError.conflict(
          `This statement is already linked to a ${linked.status === 'complete' ? 'completed' : 'in-progress'} reconciliation.`,
          'STATEMENT_ALREADY_RECONCILED',
        );
      }
    }
    // Liability statements (credit cards / LOCs) print balances as positive
    // amounts owed — flip them into GL orientation or the reconciliation
    // can never reach a $0.00 difference (see glOrientedStatementBalance).
    const stmtAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, statement.accountId)),
    });
    statementAccountType = stmtAccount?.accountType ?? null;
    accountId = statement.accountId;
    statementDate = statement.periodEnd;
    statementEndingBalance = glOrientedStatementBalance(statement.closingBalance, statementAccountType) ?? undefined;
  }
  if (!accountId || !statementDate || !statementEndingBalance) {
    throw AppError.badRequest('accountId, statementDate and statementEndingBalance are required');
  }
  const acct = await accountOf(db, tenantId, accountId);
  if (!acct) throw AppError.notFound('Account not found');
  // Manual start (no driving statement): orient a liability's entered
  // balance the same way a statement-driven start does, so a user can type
  // the credit-card statement balance as printed (a positive amount owed)
  // and still tie out against the credit-normal GL balance. Asset balances
  // pass through unchanged.
  if (!opts.statementId) {
    statementAccountType = acct.accountType ?? null;
    statementEndingBalance =
      glOrientedStatementBalance(statementEndingBalance, statementAccountType) ?? statementEndingBalance;
  }
  // Refuse to start a second reconciliation on an account that already
  // has one in progress (two would both clear the same lines). The read
  // gives the friendly answer; the partial unique index (migration 0272)
  // settles two starts at the same moment.
  const existing = await inProgressFor(db, tenantId, accountId);
  if (existing) throw inProgressConflict(existing.id, existing.createdAt);

  for (const kind of ['serviceCharge', 'interest'] as const) {
    const charge = opts[kind];
    if (charge) await assertChargeAccount(db, tenantId, acct, kind, charge.accountId);
  }

  // Create the reconciliation header + load uncleared lines in one tx
  // so a partial failure doesn't leave a reconciliation row with no
  // lines to reconcile against.
  let recon: ReconRow;
  let priorEnding: string | null = null;
  try {
    [recon, priorEnding] = await db.transaction(async (tx): Promise<[ReconRow, string | null]> => {
      const [inserted] = await tx.insert(reconciliations).values({
        tenantId,
        accountId: accountId!,
        statementDate: statementDate!,
        statementEndingBalance: statementEndingBalance!,
        beginningBalance: '0',
        status: 'in_progress',
        includeLaterLines: opts.includeLaterLines === true,
        ...(opts.serviceCharge ? chargeColumnsFor('serviceCharge', opts.serviceCharge) : {}),
        ...(opts.interest ? chargeColumnsFor('interest', opts.interest) : {}),
      }).returning();
      if (!inserted) throw AppError.internal('Failed to create reconciliation');

      // Beginning balance: the most recent completed reconciliation's ending
      // balance, or 0. Read after the insert, inside the transaction (U-193):
      // the one-in-progress index made the insert wait for a Finish of the
      // account's previous worksheet, so its completion is seen here. The
      // statement date must fall after it.
      const lastRecon = await latestCompletedOf(tx, tenantId, accountId!);
      assertStatementDateAfter(lastRecon, statementDate!);
      let created = inserted;
      if (lastRecon) {
        const [withBeginning] = await tx.update(reconciliations)
          .set({ beginningBalance: lastRecon.statementEndingBalance })
          .where(eq(reconciliations.id, inserted.id))
          .returning();
        created = withBeginning!;
      }

      const lineIds = await eligibleNewLineIds(tx, tenantId, created);
      await addWorksheetLines(tx, tenantId, created, lineIds, opts.precheck);

      // Link the driving statement to its reconciliation.
      if (statement) {
        await tx.update(bankStatements).set({
          reconciliationId: created.id,
          updatedAt: new Date(),
        }).where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, statement.id)));
      }
      return [created, lastRecon?.statementEndingBalance ?? null];
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await inProgressFor(db, tenantId, accountId);
      throw inProgressConflict(winner?.id ?? null, winner?.createdAt);
    }
    throw err;
  }

  // Opening-balance continuity check (statement-driven starts only) —
  // informational, never blocking.
  const continuityWarning = statement
    ? continuityOf(
        glOrientedStatementBalance(statement.openingBalance, statementAccountType),
        priorEnding,
      )
    : null;

  const summary = await getReconciliationSummary(tenantId, recon.id);
  return { ...summary, statementId: statement?.id ?? null, continuityWarning };
}

// Sync the worksheet with the ledger as it stands NOW — both directions.
// start() snapshots the uncleared lines at start time, so a transaction the
// user adds mid-reconciliation has no reconciliation_line and never appears;
// conversely a transaction VOIDED mid-reconciliation keeps its snapshot row.
// Adds a worksheet row for every eligible line not on the worksheet (the
// same rule start() uses, pre-checking bank-file lines when asked), and
// removes rows whose transaction is no longer posted, rows whose journal
// line no longer exists (U-189), and — when later lines are not included —
// unticked rows dated after the statement date.
export async function refreshLines(
  tenantId: string,
  reconciliationId: string,
  opts: { includeLaterLines?: boolean; precheck?: 'bank_feed' } = {},
): Promise<{ added: number; removed: number; prechecked: number }> {
  return await db.transaction(async (tx) => {
    let recon = await lockInProgress(tx, tenantId, reconciliationId);
    if (opts.includeLaterLines !== undefined && opts.includeLaterLines !== recon.includeLaterLines) {
      const [updated] = await tx.update(reconciliations)
        .set({ includeLaterLines: opts.includeLaterLines, updatedAt: new Date() })
        .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
        .returning();
      recon = updated!;
    }

    // Rows whose transaction has been voided (or otherwise left 'posted')
    // can never clear against the statement; cleared ones would corrupt the
    // cleared balance. Rows whose journal line is gone (an edit replaced the
    // entry's lines) point at nothing.
    const removedRes = await tx.execute(sql`
      DELETE FROM reconciliation_lines rl
      WHERE rl.reconciliation_id = ${reconciliationId}
        AND (
          NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.id = rl.journal_line_id)
          OR EXISTS (
            SELECT 1 FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
            WHERE jl.id = rl.journal_line_id
              AND (t.status <> 'posted' OR (${recon.includeLaterLines !== true} AND rl.is_cleared IS NOT TRUE
                AND t.txn_date > ${recon.statementDate}))
          )
        )
      RETURNING rl.id
    `);
    const removed = (removedRes.rows as unknown[]).length;

    const lineIds = await eligibleNewLineIds(tx, tenantId, recon);
    const prechecked = await addWorksheetLines(tx, tenantId, recon, lineIds, opts.precheck);
    return { added: lineIds.length, removed, prechecked };
  });
}

// ─── Read ───────────────────────────────────────────────────────

/** The worksheet with its lines (GET /banking/reconciliations/:id). */
export async function getReconciliation(tenantId: string, reconciliationId: string) {
  const { header, rows } = await loadReconciliation(tenantId, reconciliationId, true);
  return { ...header, lines: rows! };
}

/** The header and totals without lines (view=summary, U-188). */
export async function getReconciliationSummary(tenantId: string, reconciliationId: string) {
  return (await loadReconciliation(tenantId, reconciliationId, false)).header;
}

/** getReconciliation or getReconciliationSummary by view. */
export async function getReconciliationView(tenantId: string, reconciliationId: string, view?: ReconciliationView) {
  return view === 'summary' ? getReconciliationSummary(tenantId, reconciliationId) : getReconciliation(tenantId, reconciliationId);
}

async function loadReconciliation(tenantId: string, reconciliationId: string, withLines: boolean) {
  const recon = await db.query.reconciliations.findFirst({
    where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)),
  });
  if (!recon) throw AppError.notFound('Reconciliation not found');

  // Lines with transaction details. Check number / payee / contact are
  // consumed by the Statement Match Engine UI (wave 1); source, source_id
  // and from_bank_feed (an accepted bank-file row stands behind the line,
  // the rule of the pre-check without its date) by U-189. An in-progress
  // worksheet leaves out rows whose entry is no longer posted (voided after
  // the worksheet loaded it): complete() ignores them too and refresh
  // removes them (U-193). A completed reconciliation shows what it cleared.
  const lines = await db.execute(sql`
    SELECT rl.id, rl.journal_line_id, rl.is_cleared, rl.cleared_at,
      jl.transaction_id,
      jl.debit, jl.credit, jl.description,
      t.txn_date, t.txn_type, t.txn_number, t.memo,
      t.check_number, t.payee_name_on_check, t.contact_id,
      t.source, t.source_id,
      c.display_name AS contact_name,
      (EXISTS (
        SELECT 1 FROM bank_feed_items b
        WHERE b.tenant_id = ${tenantId} AND b.matched_journal_line_id = jl.id
          AND b.status IN ('matched', 'categorized')
      ) OR EXISTS (
        SELECT 1 FROM bank_feed_items b
        JOIN bank_connections bc ON bc.id = b.bank_connection_id
        WHERE b.tenant_id = ${tenantId} AND b.matched_journal_line_id IS NULL
          AND b.matched_transaction_id = jl.transaction_id AND bc.account_id = jl.account_id
          AND b.status IN ('matched', 'categorized')
      )) AS from_bank_feed
    FROM reconciliation_lines rl
    JOIN journal_lines jl ON jl.id = rl.journal_line_id
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE rl.reconciliation_id = ${reconciliationId}
      AND (${recon.status !== 'in_progress'} OR t.status = 'posted')
    ORDER BY t.txn_date, t.created_at
  `);
  const rows = lines.rows as any[];

  // Cleared-balance arithmetic runs through Decimal so the difference
  // shown to users is an exact penny figure.
  const totals = clearedTotals(recon, rows);
  const acct = await accountOf(db, tenantId, recon.accountId);

  // Statement linkage (statement-driven reconciliation): the driving
  // statement, plus the opening-balance continuity warning so the
  // worksheet can surface it on every load (not just at start).
  const statement = await db.query.bankStatements.findFirst({
    where: and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.reconciliationId, reconciliationId)),
  });
  let continuityWarning: ContinuityWarning | null = null;
  if (statement) {
    const prior = await db.query.reconciliations.findFirst({
      where: and(
        eq(reconciliations.tenantId, tenantId),
        eq(reconciliations.accountId, recon.accountId),
        eq(reconciliations.status, 'complete'),
        sql`${reconciliations.statementDate} < ${recon.statementDate}`,
      ),
      orderBy: (r, { desc }) => [desc(r.statementDate), sql`${r.completedAt} DESC NULLS LAST`],
    });
    // Liability statement balances print positive-owed — compare in GL
    // orientation (same convention as the stored reconciliation balances).
    continuityWarning = continuityOf(
      glOrientedStatementBalance(statement.openingBalance, acct?.accountType),
      prior?.statementEndingBalance,
    );
  }

  // Statement Match Engine (wave 1): how many stored statement lines exist —
  // the UI shows the "Match statement" button only when there are lines.
  let statementLineCount = 0;
  if (statement) {
    const cnt = await db.execute(sql`
      SELECT count(*)::int AS count FROM bank_statement_lines
      WHERE tenant_id = ${tenantId} AND statement_id = ${statement.id}
    `);
    statementLineCount = Number((cnt.rows as Array<{ count: number }>)[0]?.count ?? 0);
  }

  const beginningBalanceDrift = await beginningBalanceDriftOf(db, tenantId, recon);
  const postingLocked = recon.status === 'in_progress'
    ? await postingLockedFor(db, tenantId, acct?.companyId ?? null, recon)
    : false;

  const header = {
    ...recon,
    // Legacy JSON numbers (kept for existing clients); the *Exact strings
    // are the exact figures (U-188).
    clearedBalance: Number(totals.cleared.toFixed(4)),
    difference: Number(totals.difference.toFixed(4)),
    clearedBalanceExact: totals.cleared.toFixed(4),
    differenceExact: totals.difference.toFixed(4),
    clearedDeposits: { count: totals.deposits.count, total: totals.deposits.total.toFixed(4) },
    clearedPayments: { count: totals.payments.count, total: totals.payments.total.toFixed(4) },
    pending: {
      serviceCharge: chargeView(pendingCharge(recon, 'serviceCharge')),
      interest: chargeView(pendingCharge(recon, 'interest')),
    },
    beginningBalanceDrift,
    postingLocked,
    statement: statement ? { ...statement, lineCount: statementLineCount } : null,
    continuityWarning,
  };
  if (!withLines) return { header, rows: null };

  // Likely-duplicate detection: an UNCLEARED row whose CLEARED twin has the
  // same amount on the same side and either the same check number or a date
  // within ±3 days is almost certainly a double entry (manual + bank-feed,
  // or a check keyed twice) — the cleared one matched the statement, the
  // twin never will. Flag it so the UI can offer a one-click void. Human
  // confirms — two identical legitimate charges do exist, so nothing is
  // voided automatically.
  const clearedByAmount = new Map<string, any[]>();
  for (const row of rows) {
    if (!row.is_cleared) continue;
    const key = new Decimal(row.debit).minus(row.credit).toFixed(4);
    const list = clearedByAmount.get(key);
    if (list) list.push(row); else clearedByAmount.set(key, [row]);
  }
  const dayMs = 86400000;
  for (const row of rows) {
    const amt = new Decimal(row.debit).minus(row.credit);
    row.amount = amt.toFixed(4);
    row.afterStatementDate = isoDay(row.txn_date) > isoDay(recon.statementDate);
    row.fromBankFeed = row.from_bank_feed === true;
    row.sourceId = row.source_id ?? null;
    delete row.from_bank_feed;
    row.likely_duplicate = false;
    row.duplicate_of = null;
    if (row.is_cleared) continue;
    if (amt.isZero()) continue;
    const twin = (clearedByAmount.get(row.amount) ?? []).find((c: any) => {
      if (row.check_number != null && c.check_number != null) return Number(row.check_number) === Number(c.check_number);
      const dd = Math.abs(new Date(String(c.txn_date)).getTime() - new Date(String(row.txn_date)).getTime()) / dayMs;
      return dd <= 3;
    });
    if (twin) {
      row.likely_duplicate = true;
      row.duplicate_of = {
        txn_date: twin.txn_date,
        txn_type: twin.txn_type,
        check_number: twin.check_number,
        description: twin.description ?? twin.memo ?? null,
      };
    }
  }

  return { header, rows };
}

/**
 * Auto-clear the linked statement's transactions on a reconciliation
 * worksheet. Traces the statement's bank_feed_items (matched OR
 * categorized — both stamp matchedTransactionId) to that transaction's
 * journal lines on the reconciliation account, and marks the matching
 * reconciliation_lines cleared. Row-locked like updateLines so concurrent
 * toggles/completes serialize.
 *
 * Returns per-item counts: cleared (newly cleared), alreadyCleared,
 * unmatched (no posted transaction, or its journal line isn't on this
 * worksheet — e.g. dated after the statement date).
 */
export async function autoClearStatement(tenantId: string, reconciliationId: string, userId?: string) {
  return await db.transaction(async (tx) => {
    const [recon] = await tx.select().from(reconciliations)
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
      .for('update')
      .limit(1);
    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status === 'complete') throw AppError.badRequest('Reconciliation is already complete');

    const [statement] = await tx.select().from(bankStatements)
      .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.reconciliationId, reconciliationId)))
      .limit(1);
    if (!statement) throw AppError.badRequest('This reconciliation is not linked to a bank statement.');

    // One row per (feed item × its bank-account journal line on this
    // worksheet). LEFT JOINs keep items with no posted transaction / no
    // worksheet line so they can be counted as unmatched.
    const rows = await tx.execute(sql`
      SELECT bfi.id AS item_id, rl.id AS rec_line_id, rl.is_cleared
      FROM bank_feed_items bfi
      LEFT JOIN journal_lines jl ON jl.transaction_id = bfi.matched_transaction_id
        AND jl.tenant_id = ${tenantId} AND jl.account_id = ${recon.accountId}
      LEFT JOIN reconciliation_lines rl ON rl.journal_line_id = jl.id
        AND rl.reconciliation_id = ${reconciliationId}
      WHERE bfi.tenant_id = ${tenantId} AND bfi.statement_id = ${statement.id}
    `);

    // Aggregate per feed item: an item counts as cleared if ANY of its
    // worksheet lines gets newly cleared.
    const perItem = new Map<string, { toClear: string[]; already: number; matched: boolean }>();
    for (const r of rows.rows as Array<{ item_id: string; rec_line_id: string | null; is_cleared: boolean | null }>) {
      const entry = perItem.get(r.item_id) ?? { toClear: [], already: 0, matched: false };
      if (r.rec_line_id) {
        entry.matched = true;
        if (r.is_cleared) entry.already += 1;
        else entry.toClear.push(r.rec_line_id);
      }
      perItem.set(r.item_id, entry);
    }

    let cleared = 0;
    let alreadyCleared = 0;
    let unmatched = 0;
    const lineIdsToClear: string[] = [];
    for (const entry of perItem.values()) {
      if (!entry.matched) { unmatched += 1; continue; }
      if (entry.toClear.length > 0) { cleared += 1; lineIdsToClear.push(...entry.toClear); }
      else alreadyCleared += 1;
    }

    if (lineIdsToClear.length > 0) {
      const idList = sql.join(lineIdsToClear.map((id) => sql`${id}::uuid`), sql`, `);
      await tx.execute(sql`
        UPDATE reconciliation_lines SET is_cleared = true, cleared_at = now()
        WHERE id IN (${idList})
      `);
    }

    await auditLog(
      tenantId, 'update', 'reconciliation', reconciliationId,
      null, { autoClearStatement: { statementId: statement.id, cleared, alreadyCleared, unmatched } },
      userId, tx,
    );

    return { cleared, alreadyCleared, unmatched };
  });
}

// ─── Ticks ──────────────────────────────────────────────────────

/**
 * Ticks and unticks worksheet lines (up to 10,000 per call, U-188) in at
 * most two UPDATE statements. The header row lock serializes concurrent
 * calls with each other and with complete(). The last entry for a line
 * wins; ids not on the worksheet are ignored.
 */
export async function updateLines(
  tenantId: string,
  reconciliationId: string,
  lineUpdates: Array<{ journalLineId: string; isCleared: boolean }>,
) {
  await applyLineUpdates(tenantId, reconciliationId, lineUpdates);
  return getReconciliation(tenantId, reconciliationId);
}

/** updateLines without the read-back (the route picks the view). */
export async function applyLineUpdates(
  tenantId: string,
  reconciliationId: string,
  lineUpdates: Array<{ journalLineId: string; isCleared: boolean }>,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockInProgress(tx, tenantId, reconciliationId);

    const wanted = new Map<string, boolean>();
    for (const u of lineUpdates) wanted.set(u.journalLineId, u.isCleared);
    const clearIds = [...wanted].filter(([, v]) => v).map(([id]) => id);
    const unclearIds = [...wanted].filter(([, v]) => !v).map(([id]) => id);

    if (clearIds.length > 0) {
      await tx.execute(sql`
        UPDATE reconciliation_lines SET is_cleared = true, cleared_at = now()
        WHERE reconciliation_id = ${reconciliationId}
          AND journal_line_id = ANY(${uuidArray(clearIds)}::uuid[])
      `);
    }
    if (unclearIds.length > 0) {
      await tx.execute(sql`
        UPDATE reconciliation_lines SET is_cleared = false, cleared_at = NULL
        WHERE reconciliation_id = ${reconciliationId}
          AND journal_line_id = ANY(${uuidArray(unclearIds)}::uuid[])
      `);
    }

    // Statement Match Engine (wave 1): un-clearing a worksheet line that an
    // auto/confirmed statement-line match had cleared must also reset that
    // statement line, or the match table and the worksheet drift apart.
    // Wave 2: a confirmed GROUP match records only its primary journal line
    // in matched_journal_line_id — the full set lives in
    // score_breakdown.group.journalLineIds, so un-clearing ANY member must
    // reset the statement line too.
    if (unclearIds.length > 0) {
      // Scoped to THIS reconciliation's linked statement: matches for these
      // journal lines can only have been made from it, and an unscoped
      // update would let arbitrary journalLineIds in the request body reset
      // statement lines of OTHER reconciliations (same tenant) whose
      // worksheets remain cleared — drifting the two apart. Score +
      // breakdown are cleared with the status: a reset line's persisted
      // tier ('auto'/'confirmed', possibly with a stale group) no longer
      // describes anything real.
      const reset = await tx.execute(sql`
        UPDATE bank_statement_lines
        SET match_status = 'unmatched', matched_journal_line_id = NULL,
            match_score = NULL, score_breakdown = NULL, updated_at = now()
        WHERE tenant_id = ${tenantId}
          AND statement_id IN (
            SELECT id FROM bank_statements
            WHERE tenant_id = ${tenantId} AND reconciliation_id = ${reconciliationId}
          )
          AND match_status IN ('auto', 'confirmed')
          AND (matched_journal_line_id = ANY(${uuidArray(unclearIds)}::uuid[])
            OR jsonb_exists_any(COALESCE(score_breakdown->'group'->'journalLineIds', '[]'::jsonb), ${uuidArray(unclearIds)}::text[]))
        RETURNING id
      `);
      // Wave 2 many-to-one: member statement lines carry a back-pointer to
      // their primary — when the primary resets, reset the members with it.
      const resetIds = (reset.rows as Array<{ id: string }>).map((r) => r.id);
      if (resetIds.length > 0) {
        const primaryList = sql.join(resetIds.map((id) => sql`${id}`), sql`, `);
        await tx.execute(sql`
          UPDATE bank_statement_lines
          SET match_status = 'unmatched', matched_journal_line_id = NULL,
              match_score = NULL, score_breakdown = NULL, updated_at = now()
          WHERE tenant_id = ${tenantId} AND match_status = 'confirmed'
            AND score_breakdown->'group'->>'primaryStatementLineId' IN (${primaryList})
        `);
      }
    }
  });
}

// ─── Finish ─────────────────────────────────────────────────────

/** Posts a pending charge through the ledger; returns its id and its line on the reconciled account. */
async function postCharge(
  tx: Tx,
  tenantId: string,
  recon: ReconRow,
  companyId: string | null,
  kind: ReconcileChargeKind,
  charge: ChargeState,
  userId: string | undefined,
): Promise<{ txnId: string; lineId: string }> {
  const amount = new Decimal(charge.amount).toFixed(4);
  const reconLine = kind === 'serviceCharge'
    ? { accountId: recon.accountId, debit: '0', credit: amount }
    : { accountId: recon.accountId, debit: amount, credit: '0' };
  const otherLine = kind === 'serviceCharge'
    ? { accountId: charge.accountId, debit: amount, credit: '0' }
    : { accountId: charge.accountId, debit: '0', credit: amount };
  const txn = await postTransaction(tenantId, {
    txnType: kind === 'serviceCharge' ? 'expense' : 'deposit',
    txnDate: charge.date,
    memo: kind === 'serviceCharge' ? 'Service charge' : 'Interest earned',
    total: amount,
    source: 'reconciliation',
    sourceId: recon.id,
    lines: kind === 'serviceCharge' ? [otherLine, reconLine] : [reconLine, otherLine],
  }, userId, companyId ?? undefined, tx);
  const [line] = await tx.select({ id: journalLines.id }).from(journalLines)
    .where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, txn.id),
      eq(journalLines.accountId, recon.accountId),
    ))
    .limit(1);
  if (!line) throw AppError.internal('Posted charge has no line on the reconciled account');
  return { txnId: txn.id, lineId: line.id };
}

/**
 * Finish (U-188, U-189): only at a difference of exactly zero. In one
 * transaction: post the pending service charge (expense) and interest
 * (deposit) through the ledger — closing date enforced, closingPassword via
 * the request's lock context — add their lines to the worksheet as cleared,
 * mark the reconciliation complete and write one audit row.
 */
export async function complete(tenantId: string, reconciliationId: string, userId?: string) {
  await db.transaction(async (tx) => {
    const recon = await lockInProgress(tx, tenantId, reconciliationId);

    // Rows whose entry is no longer posted (voided since the worksheet loaded
    // it) or whose journal line is gone can never clear against the
    // statement: drop them, the rule refreshLines applies and GET shows, so
    // the completed reconciliation never holds a voided line (U-193).
    const droppedRes = await tx.execute(sql`
      DELETE FROM reconciliation_lines rl
      WHERE rl.reconciliation_id = ${reconciliationId}
        AND (
          NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.id = rl.journal_line_id)
          OR EXISTS (
            SELECT 1 FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
            WHERE jl.id = rl.journal_line_id AND t.status <> 'posted'
          )
        )
      RETURNING rl.journal_line_id
    `);
    const droppedLineIds = (droppedRes.rows as Array<{ journal_line_id: string }>).map((r) => r.journal_line_id);

    // Recompute inside the lock so it reflects the latest updateLines.
    const linesResult = await tx.execute(sql`
      SELECT rl.journal_line_id, rl.is_cleared, jl.debit, jl.credit
      FROM reconciliation_lines rl
      JOIN journal_lines jl ON jl.id = rl.journal_line_id
      JOIN transactions t ON t.id = jl.transaction_id AND t.status = 'posted'
      WHERE rl.reconciliation_id = ${reconciliationId}
    `);
    const lines = linesResult.rows as Array<{ journal_line_id: string; is_cleared: boolean | null; debit: string; credit: string }>;
    const totals = clearedTotals(recon, lines);
    if (!totals.difference.isZero()) {
      throw AppError.badRequest(
        `Cannot complete: the difference is ${totals.difference.toFixed(2)}; it must be exactly 0.00`,
        'RECONCILE_DIFFERENCE_NOT_ZERO',
        { difference: totals.difference.toFixed(4) },
      );
    }

    const acct = await accountOf(tx, tenantId, recon.accountId);
    const companyId = acct?.companyId ?? null;
    const posted: { serviceChargeTxnId: string | null; interestTxnId: string | null } = { serviceChargeTxnId: null, interestTxnId: null };
    const clearedLineIds = lines.filter((l) => l.is_cleared).map((l) => l.journal_line_id);
    for (const kind of ['serviceCharge', 'interest'] as const) {
      const charge = pendingCharge(recon, kind);
      if (!charge) continue;
      await assertChargeAccount(tx, tenantId, { id: recon.accountId, companyId }, kind, charge.accountId);
      const { txnId, lineId } = await postCharge(tx, tenantId, recon, companyId, kind, charge, userId);
      await tx.insert(reconciliationLines).values({
        reconciliationId, journalLineId: lineId, isCleared: true, clearedAt: new Date(),
      });
      clearedLineIds.push(lineId);
      if (kind === 'serviceCharge') posted.serviceChargeTxnId = txnId;
      else posted.interestTxnId = txnId;
    }

    await tx.update(reconciliations).set({
      status: 'complete',
      clearedBalance: totals.cleared.toFixed(4),
      difference: totals.difference.toFixed(4),
      completedAt: new Date(),
      completedBy: userId || null,
      updatedAt: new Date(),
      ...(posted.serviceChargeTxnId ? { serviceChargeTxnId: posted.serviceChargeTxnId } : {}),
      ...(posted.interestTxnId ? { interestTxnId: posted.interestTxnId } : {}),
    }).where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)));

    await auditLog(
      tenantId, 'update', 'reconciliation', reconciliationId,
      { status: 'in_progress' },
      {
        status: 'complete',
        clearedBalance: totals.cleared.toFixed(4),
        clearedLineIds,
        postedCharges: posted,
        ...(droppedLineIds.length > 0 ? { droppedLineIds: droppedLineIds.sort() } : {}),
      },
      userId, tx,
    );
  });
}

// ─── Undo ───────────────────────────────────────────────────────

/**
 * Undo the most recent completed reconciliation of its account (U-190).
 *   clear_checks (default): reopen with every line unticked (the behavior
 *                before U-190).
 *   keep_checks:  reopen with the ticks exactly as they were at finish.
 *   discard:      reopen and discard in one step (the cancel teardown).
 * Posted service charge / interest entries stay in the books in every mode
 * (keep_checks keeps their txn ids, so the next finish never re-posts them).
 * A statement date on or before the closing date needs the closing-date
 * password (or the staff override where allowed); the override is audited.
 * One audit row: action update, before {status, accountId, statementDate,
 * clearedLineIds}, after {undo: {mode}}.
 * Callers gate it to the company owner (route).
 */
export async function undo(
  tenantId: string,
  reconciliationId: string,
  userId?: string,
  opts: { mode?: UndoMode } = {},
) {
  const mode: UndoMode = opts.mode ?? 'clear_checks';
  try {
    await db.transaction(async (tx) => {
      const [recon] = await tx.select().from(reconciliations)
        .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
        .for('update')
        .limit(1);

      if (!recon) throw AppError.notFound('Reconciliation not found');
      if (recon.status !== 'complete') {
        throw AppError.conflict('Only a completed reconciliation can be undone.', 'RECONCILIATION_NOT_COMPLETE', { status: recon.status });
      }

      // Only the MOST RECENT completed reconciliation for this account may be
      // undone — undoing an older period would corrupt the beginning-balance
      // chain of every reconciliation completed after it.
      // Same statement date: the later finish is the most recent (U-193).
      const latestComplete = await latestCompletedOf(tx, tenantId, recon.accountId);
      if (!latestComplete || latestComplete.id !== reconciliationId) {
        throw AppError.conflict(
          'Only the most recent completed reconciliation can be undone — undo newer periods first.',
          'RECONCILIATION_NOT_LATEST',
          { latestReconciliationId: latestComplete?.id ?? null },
        );
      }

      // A reconciliation in progress on the account began from this one's
      // ending balance; undoing under it would leave it on a stale anchor.
      const other = await inProgressFor(tx, tenantId, recon.accountId, reconciliationId);
      if (other) throw inProgressConflict(other.id, other.createdAt);

      // Closed period: the statement date is the date the undo changes.
      const acct = await accountOf(tx, tenantId, recon.accountId);
      await checkLockDate(tx, tenantId, recon.statementDate, acct?.companyId ?? null);

      const clearedRes = await tx.execute(sql`
        SELECT journal_line_id FROM reconciliation_lines
        WHERE reconciliation_id = ${reconciliationId} AND is_cleared = true
        ORDER BY journal_line_id
      `);
      const clearedLineIds = (clearedRes.rows as Array<{ journal_line_id: string }>).map((r) => r.journal_line_id);

      // Reopening voids every electronic sign-off on this reconciliation
      // (migration 0214) — in the same transaction, so a rolled-back undo
      // leaves the signatures intact.
      await invalidateForReopen(tenantId, reconciliationId, userId ?? null, tx);

      if (mode !== 'keep_checks') {
        // Statement Match Engine (wave 1): the lines are un-cleared (or the
        // worksheet goes), so auto/confirmed statement-line matches reset.
        await tx.execute(sql`
          UPDATE bank_statement_lines bsl
          SET match_status = 'unmatched', matched_journal_line_id = NULL,
              match_score = NULL, score_breakdown = NULL, updated_at = now()
          FROM bank_statements bs
          WHERE bs.id = bsl.statement_id AND bs.reconciliation_id = ${reconciliationId}
            AND bsl.tenant_id = ${tenantId}
            AND bsl.match_status IN ('auto', 'confirmed')
        `);
      }

      if (mode === 'discard') {
        await tx.update(bankStatements)
          .set({ reconciliationId: null })
          .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.reconciliationId, reconciliationId)));
        await tx.delete(reconciliationLines).where(eq(reconciliationLines.reconciliationId, reconciliationId));
        await tx.delete(reconciliations).where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)));
      } else {
        await tx.update(reconciliations).set({
          status: 'in_progress',
          completedAt: null,
          completedBy: null,
          updatedAt: new Date(),
        }).where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)));
        if (mode === 'clear_checks') {
          await tx.update(reconciliationLines).set({
            isCleared: false,
            clearedAt: null,
          }).where(eq(reconciliationLines.reconciliationId, reconciliationId));
        }
      }

      await auditLog(
        tenantId, 'update', 'reconciliation', reconciliationId,
        { status: 'complete', accountId: recon.accountId, statementDate: recon.statementDate, clearedLineIds },
        { undo: { mode } },
        userId, tx,
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw inProgressConflict(null);
    throw err;
  }
  return { mode };
}

export async function getHistory(tenantId: string, accountId: string) {
  return db.select().from(reconciliations)
    .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.accountId, accountId)))
    .orderBy(sql`${reconciliations.statementDate} DESC`);
}

// ─── Header edits ───────────────────────────────────────────────

export interface UpdateReconciliationHeaderInput {
  statementEndingBalance?: string;
  statementDate?: string;
  serviceCharge?: ReconcileChargeInput | null;
  interest?: ReconcileChargeInput | null;
}

function sameCharge(current: ChargeState | null, next: ReconcileChargeInput | null): boolean {
  if (!current || !next) return !current && !next;
  return new Decimal(current.amount).equals(next.amount) && current.date === next.date && current.accountId === next.accountId;
}

// Edit header fields on an in-progress reconciliation: the statement ending
// balance (oriented like start(): a liability's printed figure is flipped,
// U-188), the statement date and the Begin charges (U-189). Same lock/guard
// pattern as updateLines/complete. A charge Finish already posted can't
// change (409 RECONCILE_CHARGE_POSTED); sending it unchanged is a no-op. Once
// that entry is voided or deleted the charge is pending again (U-193). The
// statement date stays after the latest completed reconciliation's (409
// RECONCILE_STATEMENT_DATE_ORDER).
export async function updateHeader(
  tenantId: string,
  reconciliationId: string,
  input: UpdateReconciliationHeaderInput,
  userId?: string,
) {
  await applyHeaderUpdate(tenantId, reconciliationId, input, userId);
  return getReconciliation(tenantId, reconciliationId);
}

/** updateHeader without the read-back (the route picks the view). */
export async function applyHeaderUpdate(
  tenantId: string,
  reconciliationId: string,
  input: UpdateReconciliationHeaderInput,
  userId?: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const recon = await lockInProgress(tx, tenantId, reconciliationId);
    const acct = await accountOf(tx, tenantId, recon.accountId);
    const set: Partial<typeof reconciliations.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (input.statementEndingBalance !== undefined) {
      const oriented = glOrientedStatementBalance(input.statementEndingBalance, acct?.accountType) ?? input.statementEndingBalance;
      set.statementEndingBalance = oriented;
      before['statementEndingBalance'] = recon.statementEndingBalance;
      after['statementEndingBalance'] = new Decimal(oriented).toFixed(4);
    }
    if (input.statementDate !== undefined) {
      // Resending the current date is never refused (rows started before
      // the order rule may already be out of order).
      if (isoDay(input.statementDate) !== isoDay(recon.statementDate)) {
        assertStatementDateAfter(await latestCompletedOf(tx, tenantId, recon.accountId), input.statementDate);
      }
      set.statementDate = input.statementDate;
      before['statementDate'] = recon.statementDate;
      after['statementDate'] = input.statementDate;
    }
    for (const kind of ['serviceCharge', 'interest'] as const) {
      const next = input[kind];
      if (next === undefined) continue;
      const current = chargeOf(recon, kind);
      // A posted charge whose entry was since voided or deleted is no longer
      // in the books: the charge is pending again and may change, and is
      // posted again by the next finish (U-193).
      const postedGone = !!current?.txnId && !(await postedEntryExists(tx, tenantId, current.txnId));
      if (postedGone) {
        set[CHARGE_COLUMNS[kind].txnId] = null;
        before[kind] = { ...chargeView(current), transactionId: current!.txnId };
        after[kind] = next ? { amount: new Decimal(next.amount).toFixed(4), date: next.date, accountId: next.accountId } : null;
        if (next) await assertChargeAccount(tx, tenantId, { id: recon.accountId, companyId: acct?.companyId ?? null }, kind, next.accountId);
        Object.assign(set, chargeColumnsFor(kind, next));
        continue;
      }
      if (sameCharge(current, next)) continue;
      if (current?.txnId) {
        throw AppError.conflict(
          'This charge was already entered in the books. Change or delete it in the register.',
          'RECONCILE_CHARGE_POSTED',
          { kind, transactionId: current.txnId },
        );
      }
      if (next) await assertChargeAccount(tx, tenantId, { id: recon.accountId, companyId: acct?.companyId ?? null }, kind, next.accountId);
      Object.assign(set, chargeColumnsFor(kind, next));
      before[kind] = chargeView(current);
      after[kind] = next ? { amount: new Decimal(next.amount).toFixed(4), date: next.date, accountId: next.accountId } : null;
    }
    if (Object.keys(set).length === 0) return;

    await tx.update(reconciliations).set({ ...set, updatedAt: new Date() })
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)));
    await auditLog(tenantId, 'update', 'reconciliation', reconciliationId, before, after, userId, tx);
  });
}

// Cancel (discard) an in-progress reconciliation so the account is free to
// start a fresh one. An in-progress reconciliation posts nothing to the ledger
// — it only tracks which lines are cleared — so a hard delete has no accounting
// impact. Completed reconciliations cannot be canceled (use undo instead); they
// anchor the next period's beginning balance.
//
// Teardown mirrors undo(): reset any auto/confirmed statement-line matches and
// unlink the driving statement so it can be reconciled again, then delete the
// worksheet lines and the header. The audit row is written in the same
// transaction (U-188).
export async function cancel(tenantId: string, reconciliationId: string, userId?: string) {
  await db.transaction(async (tx) => {
    const recon = await lockInProgress(tx, tenantId, reconciliationId,
      'A completed reconciliation cannot be canceled — use Undo instead.');

    // Reset statement lines this reconciliation had matched (same as undo).
    await tx.execute(sql`
      UPDATE bank_statement_lines bsl
      SET match_status = 'unmatched', matched_journal_line_id = NULL,
          match_score = NULL, score_breakdown = NULL, updated_at = now()
      FROM bank_statements bs
      WHERE bs.id = bsl.statement_id AND bs.reconciliation_id = ${reconciliationId}
        AND bsl.tenant_id = ${tenantId}
        AND bsl.match_status IN ('auto', 'confirmed')
    `);

    // Unlink the driving statement so it returns to the "reconcile" pool.
    await tx.update(bankStatements)
      .set({ reconciliationId: null })
      .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.reconciliationId, reconciliationId)));

    // Delete worksheet lines, then the header.
    await tx.delete(reconciliationLines).where(eq(reconciliationLines.reconciliationId, reconciliationId));
    await tx.delete(reconciliations).where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)));

    await auditLog(tenantId, 'delete', 'reconciliation', reconciliationId,
      { status: recon.status, accountId: recon.accountId, statementDate: recon.statementDate }, null, userId, tx);
  });
}
