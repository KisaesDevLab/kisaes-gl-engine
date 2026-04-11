import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { reconciliations, reconciliationLines, journalLines, transactions, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

export async function start(tenantId: string, accountId: string, statementDate: string, statementEndingBalance: string) {
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

  // Get beginning balance (cleared balance from last reconciliation, or 0)
  const lastRecon = await db.query.reconciliations.findFirst({
    where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.accountId, accountId), eq(reconciliations.status, 'complete')),
  });
  const beginningBalance = lastRecon?.statementEndingBalance || '0';

  // Create the reconciliation header + load uncleared lines in one tx
  // so a partial failure doesn't leave a reconciliation row with no
  // lines to reconcile against.
  return await db.transaction(async (tx) => {
    const [recon] = await tx.insert(reconciliations).values({
      tenantId,
      accountId,
      statementDate,
      statementEndingBalance,
      beginningBalance,
      status: 'in_progress',
    }).returning();

    if (!recon) throw AppError.internal('Failed to create reconciliation');

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
          reconciliationId: recon.id,
          journalLineId: row.id,
          isCleared: false,
        })),
      );
    }

    return recon;
  });
}

export async function getReconciliation(tenantId: string, reconciliationId: string) {
  const recon = await db.query.reconciliations.findFirst({
    where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)),
  });
  if (!recon) throw AppError.notFound('Reconciliation not found');

  // Get lines with transaction details
  const lines = await db.execute(sql`
    SELECT rl.id, rl.journal_line_id, rl.is_cleared, rl.cleared_at,
      jl.debit, jl.credit, jl.description,
      t.txn_date, t.txn_type, t.txn_number, t.memo
    FROM reconciliation_lines rl
    JOIN journal_lines jl ON jl.id = rl.journal_line_id
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE rl.reconciliation_id = ${reconciliationId}
    ORDER BY t.txn_date, t.created_at
  `);

  // Calculate cleared balance
  let clearedTotal = parseFloat(recon.beginningBalance);
  for (const line of lines.rows as any[]) {
    if (line.is_cleared) {
      clearedTotal += parseFloat(line.debit) - parseFloat(line.credit);
    }
  }

  const difference = parseFloat(recon.statementEndingBalance) - clearedTotal;

  return { ...recon, lines: lines.rows, clearedBalance: clearedTotal, difference };
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
    let clearedTotal = parseFloat(recon.beginningBalance);
    for (const line of linesResult.rows as any[]) {
      if (line.is_cleared) {
        clearedTotal += parseFloat(line.debit) - parseFloat(line.credit);
      }
    }
    const difference = parseFloat(recon.statementEndingBalance) - clearedTotal;
    if (Math.abs(difference) > 0.01) {
      throw AppError.badRequest(`Cannot complete: difference is $${difference.toFixed(2)}, must be $0.00`);
    }

    await tx.update(reconciliations).set({
      status: 'complete',
      clearedBalance: clearedTotal.toFixed(4),
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
  });
}

export async function getHistory(tenantId: string, accountId: string) {
  return db.select().from(reconciliations)
    .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.accountId, accountId)))
    .orderBy(sql`${reconciliations.statementDate} DESC`);
}
