// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Forms print queue (U-113, forms-print-queue-v1): invoices, cash sales
 * and credit memos marked printLater (transactions.print_later, migration
 * 0240) wait here until a client prints them and marks them printed. Checks
 * have their own queue (print_status); the two never mix.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/index.js';
import { transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

export const PRINTABLE_FORM_TYPES = ['invoice', 'cash_sale', 'credit_memo'] as const;
export type PrintableFormType = (typeof PRINTABLE_FORM_TYPES)[number];

export function isPrintableFormType(t: unknown): t is PrintableFormType {
  return typeof t === 'string' && (PRINTABLE_FORM_TYPES as readonly string[]).includes(t);
}

/**
 * Set or clear the print-later mark of a form (edit path; the create path
 * posts it with the transaction). Runs in the edit's transaction; scoped to
 * the company (rows without a company included), 404 when no form matches.
 */
export async function setPrintLater(
  executor: DbOrTx, tenantId: string, txnId: string, value: boolean, companyId: string | undefined,
) {
  const updated = await executor.update(transactions).set({ printLater: value })
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.id, txnId),
      inArray(transactions.txnType, [...PRINTABLE_FORM_TYPES]),
      ...(companyId ? [sql`(${transactions.companyId} = ${companyId} OR ${transactions.companyId} IS NULL)`] : []),
    ))
    .returning({ id: transactions.id });
  if (updated.length === 0) throw AppError.notFound('Form not found');
}

/**
 * GET /forms/print-queue?type=: the company's forms waiting to be printed
 * (rows without a company included), oldest first; void and deleted left out.
 */
export async function getQueue(tenantId: string, type?: PrintableFormType, companyId?: string) {
  const conds = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.print_later = true`,
    sql`t.status NOT IN ('void', 'deleted')`,
    type ? sql`t.txn_type = ${type}` : sql`t.txn_type IN ('invoice', 'cash_sale', 'credit_memo')`,
  ];
  if (companyId) conds.push(sql`(t.company_id = ${companyId} OR t.company_id IS NULL)`);
  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.total, c.display_name AS contact_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = t.tenant_id
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY t.txn_date ASC, t.created_at ASC, t.id ASC
  `);
  return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
    id: r['id'] as string,
    type: r['txn_type'] as PrintableFormType,
    txnNumber: (r['txn_number'] as string | null) ?? null,
    txnDate: r['txn_date'] instanceof Date ? (r['txn_date'] as Date).toISOString().slice(0, 10) : (r['txn_date'] as string),
    contactName: (r['contact_name'] as string | null) ?? null,
    total: (r['total'] as string | null) ?? null,
  }));
}

/**
 * POST /forms/mark-printed {ids}: clear the print-later mark of each form,
 * one audit row per form. Every id must be an invoice, cash sale or credit
 * memo of the company (404 otherwise, nothing changes). A form that is not
 * marked is left as it is (counted in alreadyPrinted).
 */
export async function markPrinted(tenantId: string, ids: string[], userId?: string, companyId?: string) {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { marked: 0, alreadyPrinted: 0 };
  return await db.transaction(async (tx) => {
    const rows = await tx.select({
      id: transactions.id, txnType: transactions.txnType, companyId: transactions.companyId,
      printLater: transactions.printLater, status: transactions.status,
    }).from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, unique)))
      .orderBy(transactions.id)
      .for('update');
    const ok = rows.filter((r) => isPrintableFormType(r.txnType) && r.status !== 'deleted'
      && !(companyId && r.companyId !== null && r.companyId !== companyId));
    if (ok.length !== unique.length) throw AppError.notFound('Form not found');
    let marked = 0;
    for (const r of ok) {
      if (!r.printLater) continue;
      await tx.update(transactions).set({ printLater: false, updatedAt: new Date() })
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, r.id)));
      await auditLog(tenantId, 'update', 'form_print', r.id, { printLater: true }, { printLater: false, txnType: r.txnType }, userId, tx);
      marked++;
    }
    return { marked, alreadyPrinted: ok.length - marked };
  });
}
