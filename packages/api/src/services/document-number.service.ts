// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Document numbering per company and type (U-111, document-numbers-v1).
 *
 * Invoices keep their counter in companies.invoice_prefix /
 * invoice_next_number (the settings page writes them); cash sales, credit
 * memos and statements keep theirs in companies.document_numbers
 * ({type: {prefix, next}}, migration 0240; absent: prefix '' and 1001).
 * Every counter moves only the request's company row: the invoice counter
 * used to advance every company of the tenant.
 *
 * Numbers are claimed with one UPDATE ... RETURNING, so concurrent creates
 * get distinct numbers. A number typed by the user leaves the counter alone.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/index.js';
import { companies, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

export const DOCUMENT_NUMBER_TYPES = ['invoice', 'cash_sale', 'credit_memo', 'statement'] as const;
export type DocumentNumberType = (typeof DOCUMENT_NUMBER_TYPES)[number];

/** Default next number for a type that was never configured. */
export const DEFAULT_NEXT_NUMBER = 1001;

export interface DocumentNumberSetting {
  type: DocumentNumberType;
  prefix: string;
  nextNumber: number;
  /** The number the next document of this type would get: prefix + nextNumber. */
  next: string;
}

export function isDocumentNumberType(t: unknown): t is DocumentNumberType {
  return typeof t === 'string' && (DOCUMENT_NUMBER_TYPES as readonly string[]).includes(t);
}

// The companies row holding the counters: the request's company when known,
// else the tenant's first company (legacy callers without a company context).
async function companyRow(executor: DbOrTx, tenantId: string, companyId: string | undefined) {
  const [row] = await executor.select({
    id: companies.id,
    invoicePrefix: companies.invoicePrefix,
    invoiceNextNumber: companies.invoiceNextNumber,
    documentNumbers: companies.documentNumbers,
  }).from(companies)
    .where(companyId ? and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)) : eq(companies.tenantId, tenantId))
    .orderBy(companies.createdAt)
    .limit(1);
  if (!row) throw AppError.notFound('Company not found');
  return row;
}

function settingFrom(type: DocumentNumberType, row: Awaited<ReturnType<typeof companyRow>>): DocumentNumberSetting {
  if (type === 'invoice') {
    const prefix = row.invoicePrefix ?? 'INV-';
    const nextNumber = row.invoiceNextNumber ?? DEFAULT_NEXT_NUMBER;
    return { type, prefix, nextNumber, next: `${prefix}${nextNumber}` };
  }
  const entry = (row.documentNumbers ?? {})[type] ?? {};
  const prefix = typeof entry.prefix === 'string' ? entry.prefix : '';
  const nextNumber = Number.isInteger(entry.next) ? entry.next! : DEFAULT_NEXT_NUMBER;
  return { type, prefix, nextNumber, next: `${prefix}${nextNumber}` };
}

/** GET /document-numbers/next?type= (and the list): what the next document would get, nothing taken. */
export async function peek(
  tenantId: string, type: DocumentNumberType, companyId?: string, executor: DbOrTx = db,
): Promise<DocumentNumberSetting> {
  return settingFrom(type, await companyRow(executor, tenantId, companyId));
}

export async function list(tenantId: string, companyId?: string): Promise<DocumentNumberSetting[]> {
  const row = await companyRow(db, tenantId, companyId);
  return DOCUMENT_NUMBER_TYPES.map((t) => settingFrom(t, row));
}

/** PUT /document-numbers/:type: set the prefix and/or the next number of one type for the company. */
export async function update(
  tenantId: string, type: DocumentNumberType, input: { prefix?: string; nextNumber?: number }, companyId?: string,
): Promise<DocumentNumberSetting> {
  return await db.transaction(async (tx) => {
    const row = await companyRow(tx, tenantId, companyId);
    if (type === 'invoice') {
      await tx.update(companies).set({
        ...(input.prefix !== undefined ? { invoicePrefix: input.prefix } : {}),
        ...(input.nextNumber !== undefined ? { invoiceNextNumber: input.nextNumber } : {}),
        updatedAt: new Date(),
      }).where(and(eq(companies.tenantId, tenantId), eq(companies.id, row.id)));
    } else {
      const current = settingFrom(type, row);
      const entry = {
        prefix: input.prefix ?? current.prefix,
        next: input.nextNumber ?? current.nextNumber,
      };
      await tx.execute(sql`
        UPDATE companies
        SET document_numbers = COALESCE(document_numbers, '{}'::jsonb) || jsonb_build_object(${type}::text, ${JSON.stringify(entry)}::jsonb),
            updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${row.id}
      `);
    }
    return settingFrom(type, await companyRow(tx, tenantId, row.id));
  });
}

/**
 * Take the next number of a type for the company (atomic). Returns the full
 * document number (prefix + number) and the integer that was taken.
 */
export async function claim(
  tenantId: string, type: DocumentNumberType, companyId?: string, executor: DbOrTx = db,
): Promise<{ type: DocumentNumberType; number: number; txnNumber: string }> {
  const row = await companyRow(executor, tenantId, companyId);
  if (type === 'invoice') {
    const [updated] = await executor.update(companies)
      .set({ invoiceNextNumber: sql`COALESCE(${companies.invoiceNextNumber}, ${DEFAULT_NEXT_NUMBER}) + 1`, updatedAt: new Date() })
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, row.id)))
      .returning({ newNext: companies.invoiceNextNumber, prefix: companies.invoicePrefix });
    if (!updated || updated.newNext === null) throw AppError.internal('Invoice counter not initialized for this company');
    const number = updated.newNext - 1;
    return { type, number, txnNumber: `${updated.prefix ?? 'INV-'}${number}` };
  }
  const res = await executor.execute(sql`
    UPDATE companies
    SET document_numbers = jsonb_set(
      COALESCE(document_numbers, '{}'::jsonb),
      ARRAY[${type}::text],
      COALESCE(document_numbers->${type}, '{}'::jsonb) || jsonb_build_object(
        'next', COALESCE((document_numbers->${type}->>'next')::int, ${DEFAULT_NEXT_NUMBER}) + 1
      )
    )
    WHERE tenant_id = ${tenantId} AND id = ${row.id}
    RETURNING (document_numbers->${type}->>'next')::int - 1 AS number,
      COALESCE(document_numbers->${type}->>'prefix', '') AS prefix
  `);
  const r = res.rows[0] as { number: number; prefix: string } | undefined;
  if (!r) throw AppError.internal('Failed to claim a document number');
  const number = Number(r.number);
  return { type, number, txnNumber: `${r.prefix}${number}` };
}

/** A duplicate document number: refused (409) unless the caller passed warnOnly. */
export interface DocumentNumberWarning {
  code: 'DOCUMENT_NUMBER_IN_USE';
  txnNumber: string;
  transactionId: string;
  message: string;
}

/**
 * Duplicate check for a document number of one type in the company (rows
 * without a company included; deleted documents ignored). Without warnOnly
 * a clash is 409 DOCUMENT_NUMBER_IN_USE (details {txnNumber, transactionId});
 * with warnOnly it is returned as a warning and the caller goes on.
 */
export async function checkDuplicate(
  tenantId: string, type: Exclude<DocumentNumberType, 'statement'>, txnNumber: string, opts: {
    companyId?: string; excludeId?: string; warnOnly?: boolean; executor?: DbOrTx;
  } = {},
): Promise<DocumentNumberWarning[]> {
  const exec = opts.executor ?? db;
  const [clash] = await exec.select({ id: transactions.id }).from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.txnType, type),
      eq(transactions.txnNumber, txnNumber),
      ne(transactions.status, 'deleted'),
      ...(opts.companyId ? [sql`(${transactions.companyId} = ${opts.companyId} OR ${transactions.companyId} IS NULL)`] : []),
      ...(opts.excludeId ? [ne(transactions.id, opts.excludeId)] : []),
    ))
    .limit(1);
  if (!clash) return [];
  const label = type === 'invoice' ? 'Invoice' : type === 'cash_sale' ? 'Sales receipt' : 'Credit memo';
  const message = `${label} number "${txnNumber}" is already in use`;
  if (!opts.warnOnly) {
    throw AppError.conflict(message, 'DOCUMENT_NUMBER_IN_USE', { txnNumber, transactionId: clash.id });
  }
  return [{ code: 'DOCUMENT_NUMBER_IN_USE', txnNumber, transactionId: clash.id, message }];
}

/**
 * The number for a new document: a typed one (checked for duplicates, the
 * counter untouched) or the next from the company's counter.
 */
export async function numberForNew(
  tenantId: string, type: Exclude<DocumentNumberType, 'statement'>, typed: string | undefined, opts: {
    companyId?: string; warnOnly?: boolean;
  },
): Promise<{ txnNumber: string; warnings: DocumentNumberWarning[] }> {
  const manual = typed?.trim();
  if (manual) {
    const warnings = await checkDuplicate(tenantId, type, manual, opts);
    return { txnNumber: manual, warnings };
  }
  const { txnNumber } = await claim(tenantId, type, opts.companyId);
  return { txnNumber, warnings: [] };
}
