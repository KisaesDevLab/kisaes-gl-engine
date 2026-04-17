// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, count } from 'drizzle-orm';
import type { WriteCheckInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { transactions, companies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { auditLog } from '../middleware/audit.js';
import crypto from 'crypto';

export async function createCheck(tenantId: string, input: WriteCheckInput, userId?: string, companyId?: string) {
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
    // Hand-written: atomically allocate the next check number.
    //
    // The previous implementation read `nextCheckNumber` from the JSONB
    // settings, used it, and wrote back the incremented value as separate
    // statements. Two concurrent createCheck calls would both read the
    // same value and assign IT to two different checks — and checks are
    // literal payment instruments. Banks reject duplicates.
    //
    // Fix: a single UPDATE … RETURNING statement using jsonb_set to
    // atomically increment the counter. Postgres serializes UPDATEs on
    // the same row so each caller gets a distinct number, even with no
    // application-level locking.
    const result = await db.execute(sql`
      UPDATE companies
      SET check_settings = jsonb_set(
        COALESCE(check_settings, '{}'::jsonb),
        '{nextCheckNumber}',
        to_jsonb(COALESCE((check_settings->>'nextCheckNumber')::int, 1001) + 1)
      )
      WHERE tenant_id = ${tenantId}
      RETURNING (check_settings->>'nextCheckNumber')::int - 1 AS assigned_number
    `);
    const assigned = (result.rows[0] as { assigned_number: number | null } | undefined)?.assigned_number;
    if (assigned === null || assigned === undefined) {
      throw AppError.internal('Failed to allocate check number for tenant');
    }
    checkNumber = Number(assigned);
    printStatus = 'hand_written';
  }

  const txn = await ledger.postTransaction(tenantId, {
    txnType: 'expense',
    txnDate: input.txnDate,
    contactId: input.contactId,
    memo: input.memo,
    total: input.amount,
    lines: journalLines,
  }, userId, companyId);

  // Update with check-specific fields. Tenant_id in WHERE for defense in
  // depth (CLAUDE.md rule #17), even though `txn` was returned from
  // ledger.postTransaction which already scoped by tenant.
  await db.update(transactions).set({
    checkNumber,
    printStatus,
    payeeNameOnCheck: input.payeeNameOnCheck,
    payeeAddress: input.payeeAddress || null,
    printedMemo: input.printedMemo || null,
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txn.id)));

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
}, companyId?: string) {
  const conds = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.txn_type = 'expense'`,
    sql`t.print_status IS NOT NULL`,
  ];
  if (companyId) conds.push(sql`t.company_id = ${companyId}`);
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

export async function getPrintQueue(tenantId: string, bankAccountId?: string, companyId?: string) {
  const pqConds = [sql`t.tenant_id = ${tenantId}`, sql`t.print_status = 'queue'`];
  if (companyId) pqConds.push(sql`t.company_id = ${companyId}`);
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

  // Wrap the entire batch in a single database transaction. Without this,
  // a partial print run leaves some checks marked 'printed' with new
  // numbers and others still in 'queue', and the next print's starting
  // number is left in an indeterminate state. Locking each check row
  // serializes concurrent print runs that overlap on a check id.
  return await db.transaction(async (tx) => {
    for (let i = 0; i < checkIds.length; i++) {
      const checkId = checkIds[i]!;

      // Lock the check row before reading its status, so two concurrent
      // print operations on the same set of checks can't both observe
      // status='queue' and both assign different numbers to it.
      const [txn] = await tx.select().from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)))
        .for('update')
        .limit(1);

      if (!txn) throw AppError.notFound(`Check ${checkId} not found`);
      if (txn.printStatus !== 'queue') throw AppError.badRequest(`Check ${checkId} is not in the print queue`);

      await tx.update(transactions).set({
        checkNumber: startingNumber + i,
        printStatus: 'printed',
        printedAt: new Date(),
        printBatchId: batchId,
        updatedAt: new Date(),
      }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)));
    }

    // Update company next check number atomically via jsonb_set so we
    // don't clobber concurrent updates to other settings keys. We use
    // GREATEST() to make this safe under concurrent print runs that
    // happen to specify overlapping starting numbers — the larger value
    // always wins, so we never roll the counter backwards.
    const newNext = startingNumber + checkIds.length;
    await tx.execute(sql`
      UPDATE companies
      SET check_settings = jsonb_set(
        COALESCE(check_settings, '{}'::jsonb),
        '{nextCheckNumber}',
        to_jsonb(GREATEST(
          COALESCE((check_settings->>'nextCheckNumber')::int, 1001),
          ${newNext}
        ))
      )
      WHERE tenant_id = ${tenantId}
    `);

    await auditLog(tenantId, 'create', 'check_print', batchId, null, {
      checkCount: checkIds.length,
      range: `${startingNumber}-${startingNumber + checkIds.length - 1}`,
      format,
    }, userId, tx);

    return {
      batchId,
      checksPrinted: checkIds.length,
      checkNumberRange: `${startingNumber}–${startingNumber + checkIds.length - 1}`,
    };
  });
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
