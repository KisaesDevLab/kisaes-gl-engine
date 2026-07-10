// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import { db } from '../db/index.js';
import { reconciliations, reconciliationLines, journalLines, transactions, accounts, bankStatements } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

export interface ContinuityWarning {
  expected: number; // prior completed reconciliation's ending balance
  actual: number;   // statement's opening balance
  delta: number;
}

// Statement opening balance vs the prior completed reconciliation's ending
// balance (the same derivation start() uses for beginningBalance). A
// mismatch means cleared transactions were changed/deleted since the last
// reconciliation — surfaced as a warning, never a block.
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

export async function start(
  tenantId: string,
  accountId: string | undefined,
  statementDate: string | undefined,
  statementEndingBalance: string | undefined,
  opts: { statementId?: string } = {},
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
  // Manual start (no driving statement): orient a liability's entered
  // balance the same way a statement-driven start does, so a user can type
  // the credit-card statement balance as printed (a positive amount owed)
  // and still tie out against the credit-normal GL balance. Asset balances
  // pass through unchanged.
  if (!opts.statementId) {
    const acct = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)),
    });
    statementAccountType = acct?.accountType ?? null;
    statementEndingBalance =
      glOrientedStatementBalance(statementEndingBalance, statementAccountType) ?? statementEndingBalance;
  }
  // Refuse to start a second reconciliation on an account that already
  // has one in progress. Two users opening the bank rec screen at the
  // same moment would otherwise create two parallel "in_progress"
  // reconciliations that both see the same uncleared lines — and then
  // both try to mark those same lines as cleared, corrupting the
  // running balance when the second one completes.
  const inProgress = await db.query.reconciliations.findFirst({
    where: and(
      eq(reconciliations.tenantId, tenantId),
      eq(reconciliations.accountId, accountId),
      eq(reconciliations.status, 'in_progress'),
    ),
  });
  if (inProgress) {
    throw AppError.conflict(
      `A reconciliation is already in progress for this account (started ${inProgress.createdAt?.toISOString?.() || inProgress.createdAt}). ` +
      `Finish or cancel it before starting a new one.`,
      'RECONCILIATION_IN_PROGRESS',
    );
  }

  // Get beginning balance (cleared balance from last reconciliation, or 0).
  // Ordered by statement date DESC so the MOST RECENT completed
  // reconciliation's ending balance chains forward (findFirst without an
  // order returned an arbitrary row once an account had several).
  const lastRecon = await db.query.reconciliations.findFirst({
    where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.accountId, accountId), eq(reconciliations.status, 'complete')),
    orderBy: (r, { desc }) => desc(r.statementDate),
  });
  const beginningBalance = lastRecon?.statementEndingBalance || '0';

  // Create the reconciliation header + load uncleared lines in one tx
  // so a partial failure doesn't leave a reconciliation row with no
  // lines to reconcile against.
  const recon = await db.transaction(async (tx) => {
    const [created] = await tx.insert(reconciliations).values({
      tenantId,
      accountId,
      statementDate,
      statementEndingBalance,
      beginningBalance,
      status: 'in_progress',
    }).returning();

    if (!created) throw AppError.internal('Failed to create reconciliation');

    const unclearedLines = await tx.execute(sql`
      SELECT jl.id FROM journal_lines jl
      JOIN transactions t ON t.id = jl.transaction_id
      WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
        AND t.status = 'posted' AND t.txn_date <= ${statementDate}
        AND jl.id NOT IN (
          SELECT rl.journal_line_id FROM reconciliation_lines rl
          JOIN reconciliations r ON r.id = rl.reconciliation_id
          WHERE r.tenant_id = ${tenantId} AND r.account_id = ${accountId}
            AND r.status = 'complete' AND rl.is_cleared = true
        )
    `);

    if ((unclearedLines.rows as any[]).length > 0) {
      await tx.insert(reconciliationLines).values(
        (unclearedLines.rows as any[]).map((row: any) => ({
          reconciliationId: created.id,
          journalLineId: row.id,
          isCleared: false,
        })),
      );
    }

    // Link the driving statement to its reconciliation.
    if (statement) {
      await tx.update(bankStatements).set({
        reconciliationId: created.id,
        updatedAt: new Date(),
      }).where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, statement.id)));
    }

    return created;
  });

  // Opening-balance continuity check (statement-driven starts only) —
  // informational, never blocking.
  const continuityWarning = statement
    ? continuityOf(
        glOrientedStatementBalance(statement.openingBalance, statementAccountType),
        lastRecon?.statementEndingBalance,
      )
    : null;

  return { ...recon, statementId: statement?.id ?? null, continuityWarning };
}

// Pull transactions posted AFTER the reconciliation was started into the
// worksheet. start() snapshots the uncleared lines at start time, so a
// transaction the user adds mid-reconciliation (a "missing" one they just
// entered) has no reconciliation_line and never appears. This adds a
// worksheet row for every posted, on-or-before-statement-date line for the
// account that isn't already on this worksheet and isn't cleared in a prior
// completed reconciliation — the same eligibility rule start() uses.
export async function refreshLines(tenantId: string, reconciliationId: string): Promise<{ added: number }> {
  return await db.transaction(async (tx) => {
    const [recon] = await tx.select().from(reconciliations)
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
      .for('update')
      .limit(1);
    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status === 'complete') throw AppError.badRequest('Reconciliation is already complete');

    const newLines = await tx.execute(sql`
      SELECT jl.id FROM journal_lines jl
      JOIN transactions t ON t.id = jl.transaction_id
      WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${recon.accountId}
        AND t.status = 'posted' AND t.txn_date <= ${recon.statementDate}
        AND jl.id NOT IN (
          SELECT rl.journal_line_id FROM reconciliation_lines rl
          WHERE rl.reconciliation_id = ${reconciliationId}
        )
        AND jl.id NOT IN (
          SELECT rl.journal_line_id FROM reconciliation_lines rl
          JOIN reconciliations r ON r.id = rl.reconciliation_id
          WHERE r.tenant_id = ${tenantId} AND r.account_id = ${recon.accountId}
            AND r.status = 'complete' AND rl.is_cleared = true
        )
    `);
    const rows = newLines.rows as Array<{ id: string }>;
    if (rows.length > 0) {
      await tx.insert(reconciliationLines).values(
        rows.map((r) => ({ reconciliationId, journalLineId: r.id, isCleared: false })),
      );
    }
    return { added: rows.length };
  });
}

export async function getReconciliation(tenantId: string, reconciliationId: string) {
  const recon = await db.query.reconciliations.findFirst({
    where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)),
  });
  if (!recon) throw AppError.notFound('Reconciliation not found');

  // Get lines with transaction details. Check number / payee / contact are
  // additive fields consumed by the Statement Match Engine UI (wave 1).
  const lines = await db.execute(sql`
    SELECT rl.id, rl.journal_line_id, rl.is_cleared, rl.cleared_at,
      jl.debit, jl.credit, jl.description,
      t.txn_date, t.txn_type, t.txn_number, t.memo,
      t.check_number, t.payee_name_on_check, t.contact_id,
      c.display_name AS contact_name
    FROM reconciliation_lines rl
    JOIN journal_lines jl ON jl.id = rl.journal_line_id
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE rl.reconciliation_id = ${reconciliationId}
    ORDER BY t.txn_date, t.created_at
  `);

  // Cleared-balance arithmetic runs through Decimal so the difference
  // shown to users is an exact penny figure. Float drift here is what
  // makes reconciliations that should tie out show $0.01 difference.
  let cleared = new Decimal(recon.beginningBalance);
  for (const line of lines.rows as any[]) {
    if (line.is_cleared) {
      cleared = cleared.plus(new Decimal(line.debit).minus(line.credit));
    }
  }
  const clearedTotal = Number(cleared.toFixed(4));
  const difference = Number(new Decimal(recon.statementEndingBalance).minus(cleared).toFixed(4));

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
      orderBy: (r, { desc }) => desc(r.statementDate),
    });
    // Liability statement balances print positive-owed — compare in GL
    // orientation (same convention as the stored reconciliation balances).
    const acct = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, recon.accountId)),
    });
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

  return {
    ...recon,
    lines: lines.rows,
    clearedBalance: clearedTotal,
    difference,
    statement: statement ? { ...statement, lineCount: statementLineCount } : null,
    continuityWarning,
  };
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

export async function updateLines(tenantId: string, reconciliationId: string, lineUpdates: Array<{ journalLineId: string; isCleared: boolean }>) {
  // Lock the reconciliation row FOR UPDATE so concurrent updateLines
  // calls serialize. Otherwise two users each toggling different line
  // checkboxes at the same moment could complete() while one of the
  // updates is mid-flight, leaving the reconciliation with a stale
  // cleared balance.
  await db.transaction(async (tx) => {
    const [recon] = await tx.select().from(reconciliations)
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
      .for('update')
      .limit(1);

    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status === 'complete') throw AppError.badRequest('Reconciliation is already complete');

    for (const update of lineUpdates) {
      await tx.update(reconciliationLines).set({
        isCleared: update.isCleared,
        clearedAt: update.isCleared ? new Date() : null,
      }).where(and(
        eq(reconciliationLines.reconciliationId, reconciliationId),
        eq(reconciliationLines.journalLineId, update.journalLineId),
      ));
    }

    // Statement Match Engine (wave 1): un-clearing a worksheet line that an
    // auto/confirmed statement-line match had cleared must also reset that
    // statement line, or the match table and the worksheet drift apart.
    // Wave 2: a confirmed GROUP match records only its primary journal line
    // in matched_journal_line_id — the full set lives in
    // score_breakdown.group.journalLineIds, so un-clearing ANY member must
    // reset the statement line too.
    const unclearedJlIds = lineUpdates.filter((u) => !u.isCleared).map((u) => u.journalLineId);
    if (unclearedJlIds.length > 0) {
      const idList = sql.join(unclearedJlIds.map((id) => sql`${id}::uuid`), sql`, `);
      const textList = sql.join(unclearedJlIds.map((id) => sql`${id}::text`), sql`, `);
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
          AND (matched_journal_line_id IN (${idList})
            OR jsonb_exists_any(COALESCE(score_breakdown->'group'->'journalLineIds', '[]'::jsonb), ARRAY[${textList}]))
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

  return getReconciliation(tenantId, reconciliationId);
}

export async function complete(tenantId: string, reconciliationId: string, userId?: string) {
  // Lock + read + compute + write, all in one transaction. Previously
  // the read and the write were on the default connection with no
  // locking, so two concurrent complete() calls could both pass the
  // "difference < 0.01" check and both flip the status.
  await db.transaction(async (tx) => {
    const [recon] = await tx.select().from(reconciliations)
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
      .for('update')
      .limit(1);

    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status === 'complete') throw AppError.badRequest('Reconciliation is already complete');

    // Recompute cleared balance inside the lock so it reflects the
    // latest updateLines results rather than a possibly-stale snapshot.
    const linesResult = await tx.execute(sql`
      SELECT rl.is_cleared, jl.debit, jl.credit
      FROM reconciliation_lines rl
      JOIN journal_lines jl ON jl.id = rl.journal_line_id
      WHERE rl.reconciliation_id = ${reconciliationId}
    `);
    let cleared = new Decimal(recon.beginningBalance);
    for (const line of linesResult.rows as any[]) {
      if (line.is_cleared) {
        cleared = cleared.plus(new Decimal(line.debit).minus(line.credit));
      }
    }
    const difference = new Decimal(recon.statementEndingBalance).minus(cleared);
    if (difference.abs().greaterThan('0.01')) {
      throw AppError.badRequest(`Cannot complete: difference is $${difference.toFixed(2)}, must be $0.00`);
    }

    await tx.update(reconciliations).set({
      status: 'complete',
      clearedBalance: cleared.toFixed(4),
      difference: '0',
      completedAt: new Date(),
      completedBy: userId || null,
      updatedAt: new Date(),
    }).where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)));
  });
}

export async function undo(tenantId: string, reconciliationId: string) {
  // Same locking pattern as complete(). Preventing interleaved undo
  // and complete() calls keeps the status transitions deterministic.
  await db.transaction(async (tx) => {
    const [recon] = await tx.select().from(reconciliations)
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
      .for('update')
      .limit(1);

    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status !== 'complete') throw AppError.badRequest('Only a completed reconciliation can be undone.');

    // Only the MOST RECENT completed reconciliation for this account may be
    // undone — undoing an older period would corrupt the beginning-balance
    // chain of every reconciliation completed after it.
    const [latestComplete] = await tx.select({ id: reconciliations.id }).from(reconciliations)
      .where(and(
        eq(reconciliations.tenantId, tenantId),
        eq(reconciliations.accountId, recon.accountId),
        eq(reconciliations.status, 'complete'),
      ))
      .orderBy(sql`${reconciliations.statementDate} DESC`)
      .limit(1);
    if (!latestComplete || latestComplete.id !== reconciliationId) {
      throw AppError.badRequest('Only the most recent completed reconciliation can be undone — undo newer periods first.');
    }

    await tx.update(reconciliations).set({
      status: 'in_progress',
      completedAt: null,
      completedBy: null,
      updatedAt: new Date(),
    }).where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)));

    // Unmark all cleared lines
    await tx.update(reconciliationLines).set({
      isCleared: false,
      clearedAt: null,
    }).where(eq(reconciliationLines.reconciliationId, reconciliationId));

    // Statement Match Engine (wave 1): the undo un-clears every worksheet
    // line, so any auto/confirmed statement-line matches for this
    // reconciliation's statement must reset too.
    await tx.execute(sql`
      UPDATE bank_statement_lines bsl
      SET match_status = 'unmatched', matched_journal_line_id = NULL,
          match_score = NULL, score_breakdown = NULL, updated_at = now()
      FROM bank_statements bs
      WHERE bs.id = bsl.statement_id AND bs.reconciliation_id = ${reconciliationId}
        AND bsl.tenant_id = ${tenantId}
        AND bsl.match_status IN ('auto', 'confirmed')
    `);
  });
}

export async function getHistory(tenantId: string, accountId: string) {
  return db.select().from(reconciliations)
    .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.accountId, accountId)))
    .orderBy(sql`${reconciliations.statementDate} DESC`);
}

// Edit header fields on an in-progress reconciliation. Today that's just the
// statement ending balance — the figure the cleared balance ties out against.
// Same lock/guard pattern as updateLines/complete: lock FOR UPDATE and refuse
// once the reconciliation is complete (a completed period's ending balance is
// the immutable anchor for the next period's beginning balance). The updated
// value feeds straight into getReconciliation's difference recompute.
export async function updateHeader(
  tenantId: string,
  reconciliationId: string,
  input: { statementEndingBalance: string },
  userId?: string,
) {
  let before: string | null = null;
  await db.transaction(async (tx) => {
    const [recon] = await tx.select().from(reconciliations)
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
      .for('update')
      .limit(1);

    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status === 'complete') throw AppError.badRequest('Reconciliation is already complete');
    before = recon.statementEndingBalance;

    await tx.update(reconciliations).set({
      statementEndingBalance: input.statementEndingBalance,
      updatedAt: new Date(),
    }).where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)));
  });

  await auditLog(
    tenantId,
    'update',
    'reconciliation',
    reconciliationId,
    { statementEndingBalance: before },
    { statementEndingBalance: input.statementEndingBalance },
    userId,
  );

  return getReconciliation(tenantId, reconciliationId);
}

// Cancel (discard) an in-progress reconciliation so the account is free to
// start a fresh one. An in-progress reconciliation posts nothing to the ledger
// — it only tracks which lines are cleared — so a hard delete has no accounting
// impact. Completed reconciliations cannot be canceled (use undo instead); they
// anchor the next period's beginning balance.
//
// Teardown mirrors undo(): reset any auto/confirmed statement-line matches and
// unlink the driving statement so it can be reconciled again, then delete the
// worksheet lines and the header.
export async function cancel(tenantId: string, reconciliationId: string, userId?: string) {
  await db.transaction(async (tx) => {
    const [recon] = await tx.select().from(reconciliations)
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
      .for('update')
      .limit(1);

    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status === 'complete') {
      throw AppError.badRequest('A completed reconciliation cannot be canceled — use Undo instead.');
    }

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
  });

  await auditLog(tenantId, 'delete', 'reconciliation', reconciliationId, null, null, userId);
}
