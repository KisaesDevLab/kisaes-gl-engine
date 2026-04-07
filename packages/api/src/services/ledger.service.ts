import { eq, and, sql, lte, count } from 'drizzle-orm';
import type { JournalLineInput, TxnType, TxnStatus } from '@kis-books/shared';
import { db, type DbOrTx } from '../db/index.js';
import { transactions, journalLines, accounts, companies, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

async function checkLockDate(executor: DbOrTx, tenantId: string, txnDate: string) {
  const result = await executor.execute(sql`
    SELECT lock_date FROM companies WHERE tenant_id = ${tenantId} LIMIT 1
  `);
  const lockDate = (result.rows as any[])[0]?.lock_date;
  if (lockDate && txnDate <= lockDate) {
    throw AppError.badRequest(`Cannot create or modify transactions on or before the lock date (${lockDate}). Adjust the lock date in Settings to make changes.`);
  }
}

interface PostTransactionInput {
  txnType: TxnType;
  txnDate: string;
  txnNumber?: string;
  dueDate?: string;
  status?: TxnStatus;
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
  appliedToInvoiceId?: string;
  sourceEstimateId?: string;
  lines: JournalLineInput[];
}

export async function postTransaction(tenantId: string, input: PostTransactionInput, userId?: string) {
  // Validate debits = credits BEFORE opening a database transaction —
  // there's no point holding a tx open while we add up two numbers in
  // memory, and a fast-fail on bad input avoids unnecessary lock churn.
  let totalDebits = 0;
  let totalCredits = 0;
  for (const line of input.lines) {
    totalDebits += parseFloat(line.debit || '0');
    totalCredits += parseFloat(line.credit || '0');
  }

  if (Math.abs(totalDebits - totalCredits) > 0.0001) {
    throw AppError.badRequest(
      `Transaction does not balance: debits (${totalDebits.toFixed(4)}) != credits (${totalCredits.toFixed(4)})`,
    );
  }

  if (totalDebits === 0 && totalCredits === 0) {
    throw AppError.badRequest('Transaction must have non-zero amounts');
  }

  // Wrap the transaction header insert + lines insert + balance updates +
  // audit log in a single database transaction. Without this, a crash or
  // error between any two of these steps leaves torn state — a transaction
  // missing its lines, or lines whose accounts.balance was never updated.
  return await db.transaction(async (tx) => {
    await checkLockDate(tx, tenantId, input.txnDate);

    // Insert transaction header
    const [txn] = await tx.insert(transactions).values({
      tenantId,
      txnType: input.txnType,
      txnNumber: input.txnNumber || null,
      txnDate: input.txnDate,
      dueDate: input.dueDate || null,
      status: input.status || 'posted',
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
      appliedToInvoiceId: input.appliedToInvoiceId || null,
      sourceEstimateId: input.sourceEstimateId || null,
    }).returning();

    if (!txn) throw AppError.internal('Failed to create transaction');

    // Insert journal lines
    const lineValues = input.lines.map((line, i) => ({
      tenantId,
      transactionId: txn.id,
      accountId: line.accountId,
      debit: line.debit || '0',
      credit: line.credit || '0',
      description: line.description || null,
      quantity: line.quantity || null,
      unitPrice: line.unitPrice || null,
      isTaxable: line.isTaxable || false,
      taxRate: line.taxRate || '0',
      taxAmount: line.taxAmount || '0',
      lineOrder: i,
    }));

    const lines = await tx.insert(journalLines).values(lineValues).returning();

    // Update account balances (only for posted transactions)
    if (txn.status === 'posted') {
      await updateAccountBalances(tx, tenantId, input.lines);
    }

    await auditLog(tenantId, 'create', 'transaction', txn.id, null, { txnType: txn.txnType, total: input.total }, userId, tx);

    return { ...txn, lines };
  });
}

export async function voidTransaction(tenantId: string, txnId: string, reason: string, userId?: string) {
  // Wrap in a database transaction AND lock the row up front. Without the
  // row lock, two concurrent void calls on the same transaction can both
  // observe status='posted', both pass the check below, and both call
  // updateAccountBalances — double-reversing the balances and corrupting
  // the trial balance. SELECT … FOR UPDATE serializes the void path so
  // the second caller blocks until the first commits, then reads the
  // already-voided state and throws "already void" cleanly.
  return await db.transaction(async (tx) => {
    const [txn] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update')
      .limit(1);

    if (!txn) throw AppError.notFound('Transaction not found');
    if (txn.status === 'void') throw AppError.badRequest('Transaction is already void');

    // Check lock date against the transaction's date
    await checkLockDate(tx, tenantId, txn.txnDate);

    // Get original lines
    const originalLines = await tx.select().from(journalLines)
      .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)));

    // Mark as void. Tenant_id is included in the WHERE clause for
    // defense-in-depth (CLAUDE.md rule #17) — even though we already
    // confirmed the row belongs to this tenant via the locked SELECT.
    await tx.update(transactions).set({
      status: 'void',
      voidReason: reason,
      voidedAt: new Date(),
      updatedAt: new Date(),
      invoiceStatus: txn.txnType === 'invoice' ? 'void' : txn.invoiceStatus,
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));

    // Create reversing journal lines (swap debits and credits)
    if (originalLines.length > 0) {
      const reversingLines = originalLines.map((line) => ({
        accountId: line.accountId,
        debit: line.credit,
        credit: line.debit,
        description: `Void: ${line.description || ''}`.trim(),
      }));

      // Reverse account balances
      await updateAccountBalances(tx, tenantId, reversingLines);
    }

    await auditLog(tenantId, 'void', 'transaction', txnId, txn, { reason }, userId, tx);
  });
}

export async function updateTransaction(tenantId: string, txnId: string, input: PostTransactionInput, userId?: string) {
  // Validate the new lines balance up front (in-memory, no DB access).
  let totalDebits = 0;
  let totalCredits = 0;
  for (const line of input.lines) {
    totalDebits += parseFloat(line.debit || '0');
    totalCredits += parseFloat(line.credit || '0');
  }
  if (Math.abs(totalDebits - totalCredits) > 0.0001) {
    throw AppError.badRequest('Transaction does not balance');
  }

  // Wrap in a database transaction AND lock the row. Without the lock,
  // two concurrent updates of the same transaction can interleave their
  // reverse-old-balances → delete-lines → insert-new-lines → apply-new
  // balances steps and corrupt account balances + leave duplicated /
  // missing journal lines. SELECT … FOR UPDATE serializes them.
  return await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
      .for('update')
      .limit(1);

    if (!existing) throw AppError.notFound('Transaction not found');
    if (existing.status === 'void') throw AppError.badRequest('Cannot update a void transaction');

    // Check lock date for both old and new dates
    await checkLockDate(tx, tenantId, existing.txnDate);
    await checkLockDate(tx, tenantId, input.txnDate);

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
      contactId: input.contactId || null,
      memo: input.memo || null,
      subtotal: input.subtotal || null,
      taxAmount: input.taxAmount || '0',
      total: input.total || null,
      balanceDue: input.balanceDue || null,
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));

    // Insert new lines
    const lineValues = input.lines.map((line, i) => ({
      tenantId,
      transactionId: txnId,
      accountId: line.accountId,
      debit: line.debit || '0',
      credit: line.credit || '0',
      description: line.description || null,
      quantity: line.quantity || null,
      unitPrice: line.unitPrice || null,
      isTaxable: line.isTaxable || false,
      taxRate: line.taxRate || '0',
      taxAmount: line.taxAmount || '0',
      lineOrder: i,
    }));

    const lines = await tx.insert(journalLines).values(lineValues).returning();

    // Apply new balances
    if (existing.status === 'posted') {
      await updateAccountBalances(tx, tenantId, input.lines);
    }

    await auditLog(tenantId, 'update', 'transaction', txnId, existing, input, userId, tx);

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
    const debit = parseFloat(line.debit || '0');
    const credit = parseFloat(line.credit || '0');
    const delta = debit - credit;

    if (delta !== 0) {
      await executor.update(accounts).set({
        balance: sql`${accounts.balance} + ${delta.toFixed(4)}::decimal`,
        updatedAt: new Date(),
      }).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, line.accountId)));
    }
  }
}

export async function getTransaction(tenantId: string, txnId: string) {
  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)),
  });
  if (!txn) throw AppError.notFound('Transaction not found');

  const lines = await db.select({
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
  }).from(journalLines)
    .leftJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, txnId)))
    .orderBy(journalLines.lineOrder);

  return { ...txn, lines };
}

export async function listTransactions(tenantId: string, filters: {
  txnType?: string; status?: string; contactId?: string; accountId?: string; startDate?: string; endDate?: string;
  search?: string; limit?: number; offset?: number;
}) {
  const conditions = [eq(transactions.tenantId, tenantId)];

  if (filters.txnType) conditions.push(eq(transactions.txnType, filters.txnType));
  if (filters.status) conditions.push(eq(transactions.status, filters.status));
  if (filters.contactId) conditions.push(eq(transactions.contactId, filters.contactId));
  if (filters.startDate) conditions.push(sql`${transactions.txnDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${transactions.txnDate} <= ${filters.endDate}`);
  if (filters.accountId) {
    conditions.push(sql`${transactions.id} IN (SELECT transaction_id FROM journal_lines WHERE account_id = ${filters.accountId} AND tenant_id = ${tenantId})`);
  }
  if (filters.search) {
    conditions.push(sql`(${transactions.memo} ILIKE ${'%' + filters.search + '%'} OR ${transactions.txnNumber} ILIKE ${'%' + filters.search + '%'} OR ${contacts.displayName} ILIKE ${'%' + filters.search + '%'})`);
  }

  const where = and(...conditions);

  const [data, total] = await Promise.all([
    db.select({
      id: transactions.id,
      tenantId: transactions.tenantId,
      txnType: transactions.txnType,
      txnNumber: transactions.txnNumber,
      txnDate: transactions.txnDate,
      dueDate: transactions.dueDate,
      status: transactions.status,
      contactId: transactions.contactId,
      contactName: contacts.displayName,
      memo: transactions.memo,
      subtotal: transactions.subtotal,
      taxAmount: transactions.taxAmount,
      total: transactions.total,
      amountPaid: transactions.amountPaid,
      balanceDue: transactions.balanceDue,
      invoiceStatus: transactions.invoiceStatus,
      createdAt: transactions.createdAt,
    }).from(transactions)
      .leftJoin(contacts, eq(transactions.contactId, contacts.id))
      .where(where)
      .orderBy(sql`${transactions.txnDate} DESC`, sql`${transactions.createdAt} DESC`)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db.select({ count: count() }).from(transactions).where(where),
  ]);

  return { data, total: total[0]?.count ?? 0 };
}

export async function getAccountBalance(tenantId: string, accountId: string, asOfDate?: string) {
  const conditions = [
    eq(journalLines.tenantId, tenantId),
    eq(journalLines.accountId, accountId),
  ];

  if (asOfDate) {
    conditions.push(sql`${journalLines.transactionId} IN (
      SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND txn_date <= ${asOfDate} AND status = 'posted'
    )`);
  }

  const result = await db.select({
    totalDebit: sql<string>`COALESCE(SUM(${journalLines.debit}), 0)`,
    totalCredit: sql<string>`COALESCE(SUM(${journalLines.credit}), 0)`,
  }).from(journalLines).where(and(...conditions));

  const row = result[0];
  const debit = parseFloat(row?.totalDebit || '0');
  const credit = parseFloat(row?.totalCredit || '0');
  return { debit, credit, balance: debit - credit };
}

export async function validateBalance(tenantId: string): Promise<{ valid: boolean; totalDebits: number; totalCredits: number; difference: number }> {
  // Only sum lines from posted transactions
  const result = await db.select({
    totalDebits: sql<string>`COALESCE(SUM(jl.debit), 0)`,
    totalCredits: sql<string>`COALESCE(SUM(jl.credit), 0)`,
  }).from(sql`journal_lines jl JOIN transactions t ON jl.transaction_id = t.id WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'`);

  const row = result[0];
  const totalDebits = parseFloat(row?.totalDebits || '0');
  const totalCredits = parseFloat(row?.totalCredits || '0');
  const difference = Math.abs(totalDebits - totalCredits);

  return {
    valid: difference < 0.01,
    totalDebits,
    totalCredits,
    difference,
  };
}
