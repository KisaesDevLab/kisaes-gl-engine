import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { reconciliations, reconciliationLines, journalLines, transactions, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

export async function start(tenantId: string, accountId: string, statementDate: string, statementEndingBalance: string) {
  // Get beginning balance (cleared balance from last reconciliation, or 0)
  const lastRecon = await db.query.reconciliations.findFirst({
    where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.accountId, accountId), eq(reconciliations.status, 'complete')),
  });
  const beginningBalance = lastRecon?.statementEndingBalance || '0';

  const [recon] = await db.insert(reconciliations).values({
    tenantId,
    accountId,
    statementDate,
    statementEndingBalance,
    beginningBalance,
    status: 'in_progress',
  }).returning();

  if (!recon) throw AppError.internal('Failed to create reconciliation');

  // Load uncleared journal lines for this account
  const unclearedLines = await db.execute(sql`
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
    await db.insert(reconciliationLines).values(
      (unclearedLines.rows as any[]).map((row: any) => ({
        reconciliationId: recon.id,
        journalLineId: row.id,
        isCleared: false,
      })),
    );
  }

  return recon;
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
  const recon = await db.query.reconciliations.findFirst({
    where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)),
  });
  if (!recon) throw AppError.notFound('Reconciliation not found');
  if (recon.status === 'complete') throw AppError.badRequest('Reconciliation is already complete');

  for (const update of lineUpdates) {
    await db.update(reconciliationLines).set({
      isCleared: update.isCleared,
      clearedAt: update.isCleared ? new Date() : null,
    }).where(and(
      eq(reconciliationLines.reconciliationId, reconciliationId),
      eq(reconciliationLines.journalLineId, update.journalLineId),
    ));
  }

  return getReconciliation(tenantId, reconciliationId);
}

export async function complete(tenantId: string, reconciliationId: string, userId?: string) {
  const recon = await getReconciliation(tenantId, reconciliationId);
  if (Math.abs(recon.difference) > 0.01) {
    throw AppError.badRequest(`Cannot complete: difference is $${recon.difference.toFixed(2)}, must be $0.00`);
  }

  await db.update(reconciliations).set({
    status: 'complete',
    clearedBalance: recon.clearedBalance.toFixed(4),
    difference: '0',
    completedAt: new Date(),
    completedBy: userId || null,
    updatedAt: new Date(),
  }).where(eq(reconciliations.id, reconciliationId));
}

export async function undo(tenantId: string, reconciliationId: string) {
  const recon = await db.query.reconciliations.findFirst({
    where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)),
  });
  if (!recon) throw AppError.notFound('Reconciliation not found');

  await db.update(reconciliations).set({
    status: 'in_progress',
    completedAt: null,
    completedBy: null,
    updatedAt: new Date(),
  }).where(eq(reconciliations.id, reconciliationId));

  // Unmark all cleared lines
  await db.update(reconciliationLines).set({
    isCleared: false,
    clearedAt: null,
  }).where(eq(reconciliationLines.reconciliationId, reconciliationId));
}

export async function getHistory(tenantId: string, accountId: string) {
  return db.select().from(reconciliations)
    .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.accountId, accountId)))
    .orderBy(sql`${reconciliations.statementDate} DESC`);
}
