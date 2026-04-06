import { eq, and, sql, count } from 'drizzle-orm';
import type { WriteCheckInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, companies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { auditLog } from '../middleware/audit.js';
import crypto from 'crypto';

export async function createCheck(tenantId: string, input: WriteCheckInput, userId?: string) {
  // Build journal lines: DR each expense line, CR bank
  const totalAmount = input.lines.reduce((s, l) => s + parseFloat(l.amount), 0);
  if (Math.abs(totalAmount - parseFloat(input.amount)) > 0.01) {
    throw AppError.badRequest('Line items do not sum to check amount');
  }

  const journalLines = [
    ...input.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.amount,
      credit: '0',
      description: l.description,
    })),
    { accountId: input.bankAccountId, debit: '0', credit: input.amount },
  ];

  // Determine check number
  let checkNumber: number | null = null;
  let printStatus: string;

  if (input.printLater) {
    printStatus = 'queue';
  } else {
    // Hand-written: assign next check number
    const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
    const settings = (company?.checkSettings as Record<string, unknown>) || {};
    checkNumber = (settings['nextCheckNumber'] as number) || 1001;
    printStatus = 'hand_written';

    // Update next check number
    await db.update(companies).set({
      checkSettings: { ...settings, nextCheckNumber: checkNumber + 1 },
    }).where(eq(companies.tenantId, tenantId));
  }

  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'expense',
    txnDate: input.txnDate,
    contactId: input.contactId,
    memo: input.memo,
    total: input.amount,
    lines: journalLines,
  }, userId);

  // Update with check-specific fields
  await db.update(transactions).set({
    checkNumber,
    printStatus,
    payeeNameOnCheck: input.payeeNameOnCheck,
    payeeAddress: input.payeeAddress || null,
    printedMemo: input.printedMemo || null,
  }).where(eq(transactions.id, txn.id));

  // Apply tags if provided
  if (input.tagIds && input.tagIds.length > 0) {
    const { transactionTags } = await import('../db/schema/index.js');
    for (const tagId of input.tagIds) {
      await db.insert(transactionTags).values({ transactionId: txn.id, tagId, tenantId }).onConflictDoNothing();
    }
  }

  return { ...txn, checkNumber, printStatus, payeeNameOnCheck: input.payeeNameOnCheck };
}

export async function listChecks(tenantId: string, filters?: {
  bankAccountId?: string; printStatus?: string; startDate?: string; endDate?: string; limit?: number; offset?: number;
}) {
  const conds = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.txn_type = 'expense'`,
    sql`t.print_status IS NOT NULL`,
  ];
  if (filters?.bankAccountId) conds.push(sql`EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.transaction_id = t.id AND jl2.account_id = ${filters.bankAccountId} AND jl2.credit > 0)`);
  if (filters?.printStatus) conds.push(sql`t.print_status = ${filters.printStatus}`);
  if (filters?.startDate) conds.push(sql`t.txn_date >= ${filters.startDate}`);
  if (filters?.endDate) conds.push(sql`t.txn_date <= ${filters.endDate}`);

  const rows = await db.execute(sql`
    SELECT DISTINCT t.id, t.txn_date, t.total, t.memo, t.status,
      t.check_number, t.print_status, t.payee_name_on_check, t.printed_memo,
      c.display_name as contact_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY t.txn_date DESC, t.check_number DESC
    LIMIT ${filters?.limit || 50} OFFSET ${filters?.offset || 0}
  `);

  return { data: (rows.rows as any[]).map((r) => ({
    id: r.id,
    txnDate: r.txn_date,
    amount: r.total,
    memo: r.memo,
    status: r.status,
    checkNumber: r.check_number,
    printStatus: r.print_status,
    payeeNameOnCheck: r.payee_name_on_check,
    printedMemo: r.printed_memo,
    contactName: r.contact_name,
  }))};
}

export async function getPrintQueue(tenantId: string, bankAccountId?: string) {
  const pqConds = [sql`t.tenant_id = ${tenantId}`, sql`t.print_status = 'queue'`];
  if (bankAccountId) {
    pqConds.push(sql`t.id IN (SELECT transaction_id FROM journal_lines WHERE account_id = ${bankAccountId} AND credit > 0)`);
  }

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_date, t.total, t.memo, t.payee_name_on_check, t.printed_memo,
      c.display_name as contact_name, t.created_at
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE ${sql.join(pqConds, sql` AND `)}
    ORDER BY t.created_at ASC
  `);

  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    txnDate: r.txn_date,
    amount: r.total,
    memo: r.memo,
    payeeNameOnCheck: r.payee_name_on_check,
    printedMemo: r.printed_memo,
    contactName: r.contact_name,
    createdAt: r.created_at,
  }));
}

export async function printChecks(tenantId: string, bankAccountId: string, checkIds: string[], startingNumber: number, format: string, userId?: string) {
  const batchId = crypto.randomUUID();

  for (let i = 0; i < checkIds.length; i++) {
    const checkId = checkIds[i]!;
    const txn = await db.query.transactions.findFirst({
      where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)),
    });
    if (!txn) throw AppError.notFound(`Check ${checkId} not found`);
    if (txn.printStatus !== 'queue') throw AppError.badRequest(`Check ${checkId} is not in the print queue`);

    await db.update(transactions).set({
      checkNumber: startingNumber + i,
      printStatus: 'printed',
      printedAt: new Date(),
      printBatchId: batchId,
      updatedAt: new Date(),
    }).where(eq(transactions.id, checkId));
  }

  // Update company next check number
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  const settings = (company?.checkSettings as Record<string, unknown>) || {};
  await db.update(companies).set({
    checkSettings: { ...settings, nextCheckNumber: startingNumber + checkIds.length },
  }).where(eq(companies.tenantId, tenantId));

  await auditLog(tenantId, 'create', 'check_print', batchId, null, {
    checkCount: checkIds.length,
    range: `${startingNumber}-${startingNumber + checkIds.length - 1}`,
    format,
  }, userId);

  return {
    batchId,
    checksPrinted: checkIds.length,
    checkNumberRange: `${startingNumber}–${startingNumber + checkIds.length - 1}`,
  };
}

export async function requeueChecks(tenantId: string, checkIds: string[]) {
  for (const id of checkIds) {
    await db.update(transactions).set({
      printStatus: 'queue',
      checkNumber: null,
      printedAt: null,
      printBatchId: null,
      updatedAt: new Date(),
    }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id)));
  }
}

export async function reprintBatch(tenantId: string, batchId: string) {
  await db.update(transactions).set({
    printStatus: 'queue',
    printedAt: null,
    updatedAt: new Date(),
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.printBatchId, batchId)));
}
