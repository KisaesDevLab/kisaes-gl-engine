import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transactions, duplicateDismissals } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';

export async function findDuplicates(tenantId: string, transactionId: string) {
  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, transactionId)),
  });
  if (!txn) throw AppError.notFound('Transaction not found');
  if (!txn.total || txn.txnType === 'journal_entry' || txn.txnType === 'transfer') return [];

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.total, t.memo, t.status,
      c.display_name as contact_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId}
      AND t.id != ${transactionId}
      AND t.status != 'void'
      AND t.txn_type NOT IN ('journal_entry', 'transfer')
      AND CAST(t.total AS DECIMAL) = CAST(${txn.total} AS DECIMAL)
      AND ABS(t.txn_date::date - ${txn.txnDate}::date) <= 3
      ${txn.contactId ? sql`AND t.contact_id = ${txn.contactId}` : sql`AND t.contact_id IS NULL`}
      AND NOT EXISTS (
        SELECT 1 FROM duplicate_dismissals dd
        WHERE dd.tenant_id = ${tenantId}
          AND ((dd.transaction_id_a = ${transactionId} AND dd.transaction_id_b = t.id)
            OR (dd.transaction_id_a = t.id AND dd.transaction_id_b = ${transactionId}))
      )
  `);

  return rows.rows;
}

export async function scanDateRange(tenantId: string, startDate: string, endDate: string) {
  const rows = await db.execute(sql`
    SELECT t1.id as id_a, t2.id as id_b,
      t1.txn_type as type_a, t2.txn_type as type_b,
      t1.txn_date as date_a, t2.txn_date as date_b,
      t1.total as amount,
      c1.display_name as contact_a, c2.display_name as contact_b,
      t1.memo as memo_a, t2.memo as memo_b
    FROM transactions t1
    JOIN transactions t2 ON t2.tenant_id = t1.tenant_id
      AND t2.id > t1.id
      AND CAST(t2.total AS DECIMAL) = CAST(t1.total AS DECIMAL)
      AND ABS(t2.txn_date::date - t1.txn_date::date) <= 3
      AND (t1.contact_id = t2.contact_id OR (t1.contact_id IS NULL AND t2.contact_id IS NULL))
    LEFT JOIN contacts c1 ON c1.id = t1.contact_id
    LEFT JOIN contacts c2 ON c2.id = t2.contact_id
    WHERE t1.tenant_id = ${tenantId}
      AND t1.status != 'void' AND t2.status != 'void'
      AND t1.txn_type NOT IN ('journal_entry', 'transfer')
      AND t2.txn_type NOT IN ('journal_entry', 'transfer')
      AND t1.txn_date >= ${startDate} AND t1.txn_date <= ${endDate}
      AND NOT EXISTS (
        SELECT 1 FROM duplicate_dismissals dd
        WHERE dd.tenant_id = ${tenantId}
          AND ((dd.transaction_id_a = t1.id AND dd.transaction_id_b = t2.id)
            OR (dd.transaction_id_a = t2.id AND dd.transaction_id_b = t1.id))
      )
    ORDER BY t1.txn_date DESC
    LIMIT 100
  `);

  return rows.rows;
}

export async function dismissDuplicate(tenantId: string, txnIdA: string, txnIdB: string, userId?: string) {
  await db.insert(duplicateDismissals).values({
    tenantId,
    transactionIdA: txnIdA,
    transactionIdB: txnIdB,
    dismissedBy: userId || null,
  });
}

export async function mergeDuplicate(tenantId: string, keepTxnId: string, voidTxnId: string, userId?: string) {
  await ledger.voidTransaction(tenantId, voidTxnId, 'Merged as duplicate', userId);
  // Dismiss the pair so it doesn't show again
  await dismissDuplicate(tenantId, keepTxnId, voidTxnId, userId);
}
