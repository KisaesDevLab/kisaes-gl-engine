// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Adjusting journal entries (Phase 5, D10/D17, rule TB3). AJEs are
// REAL GL transactions (txn_type 'aje') posted through the ledger
// choke point — they appear in every register, report, and the client
// portal's published reports, read-only. CRUD is firm-only (the tb
// router is the sole path that reaches this service) and independent
// of the closing date (ledger.service exempts 'aje' from the lock).
//
// Numbering (D17): AJE-001 per company per fiscal year, claimed
// atomically from tb_aje_sequences inside the posting transaction via
// an upsert bump — concurrent posts serialize on the sequence row, and
// a rolled-back post at worst burns a gap (uniqueness is what matters).

import { and, desc, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../../db/index.js';
import { companies, journalLines, transactions } from '../../db/schema/index.js';
import type { z } from 'zod';
import type { createAjeSchema } from '@kis-books/shared';
import * as ledger from '../ledger.service.js';
import { taxYearOf } from './tax-profile.service.js';
import { AppError } from '../../utils/errors.js';

type AjeInput = z.infer<typeof createAjeSchema>;

export function formatAjeNumber(n: number): string {
  return `AJE-${String(n).padStart(3, '0')}`;
}

async function fiscalYearFor(tenantId: string, companyId: string, dateIso: string): Promise<number> {
  const [c] = await db.select({ m: companies.fiscalYearStartMonth }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
  if (!c) throw AppError.notFound('Company not found');
  return taxYearOf(dateIso, c.m ?? 1);
}

// Atomic number claim: insert-or-bump returns the claimed value.
async function claimAjeNumber(tx: Tx, tenantId: string, companyId: string, fiscalYear: number): Promise<number> {
  const res = await tx.execute(sql`
    INSERT INTO tb_aje_sequences (tenant_id, company_id, fiscal_year, next_number)
    VALUES (${tenantId}, ${companyId}, ${fiscalYear}, 2)
    ON CONFLICT (company_id, fiscal_year)
    DO UPDATE SET next_number = tb_aje_sequences.next_number + 1
    RETURNING next_number
  `);
  const next = Number((res.rows as Array<{ next_number: number }>)[0]?.next_number ?? 0);
  if (!next) throw AppError.internal('AJE number claim failed');
  return next - 1;
}

export async function createAje(tenantId: string, companyId: string, input: AjeInput, userId?: string) {
  const fiscalYear = await fiscalYearFor(tenantId, companyId, input.txnDate);
  return db.transaction(async (tx) => {
    const ajeNumber = await claimAjeNumber(tx, tenantId, companyId, fiscalYear);
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'aje',
      txnDate: input.txnDate,
      memo: input.memo,
      basis: input.basis ?? 'both',
      lines: input.lines,
    }, userId, companyId, tx);
    await tx.update(transactions).set({ ajeNumber })
      .where(eq(transactions.id, txn.id));
    return { ...txn, ajeNumber, ajeNumberLabel: formatAjeNumber(ajeNumber) };
  });
}

export async function updateAje(tenantId: string, companyId: string, txnId: string, input: AjeInput, userId?: string) {
  await assertIsAje(tenantId, txnId);
  const txn = await ledger.updateTransaction(tenantId, txnId, {
    txnType: 'aje',
    txnDate: input.txnDate,
    memo: input.memo,
    basis: input.basis ?? 'both',
    lines: input.lines,
  }, userId, companyId);
  return txn;
}

export async function voidAje(tenantId: string, txnId: string, reason: string, userId?: string) {
  await assertIsAje(tenantId, txnId);
  return ledger.voidTransaction(tenantId, txnId, reason, userId);
}

async function loadAje(tenantId: string, txnId: string) {
  const [txn] = await db.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)))
    .limit(1);
  if (!txn || txn.txnType !== 'aje') throw AppError.notFound('AJE not found');
  return txn;
}

async function assertIsAje(tenantId: string, txnId: string) {
  await loadAje(tenantId, txnId);
}

async function loadLines(tenantId: string, txnId: string) {
  return db.select().from(journalLines)
    .where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, txnId),
      eq(journalLines.isVoidReversal, false),
    ))
    .orderBy(journalLines.lineOrder);
}

// First day of the month after the AJE's date — the accountant's
// standard auto-reversing date (plan 5.5).
export function firstOfNextMonth(dateIso: string): string {
  const d = new Date(dateIso + 'T00:00:00Z');
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return next.toISOString().slice(0, 10);
}

export async function reverseAje(tenantId: string, companyId: string, txnId: string, userId?: string) {
  const original = await loadAje(tenantId, txnId);
  if (original.status === 'void') throw AppError.badRequest('Cannot reverse a void AJE');
  const lines = await loadLines(tenantId, txnId);
  const label = original.ajeNumber ? formatAjeNumber(original.ajeNumber) : 'AJE';
  return createAje(tenantId, companyId, {
    txnDate: firstOfNextMonth(original.txnDate),
    memo: `Reversal of ${label}${original.memo ? ` — ${original.memo}` : ''}`,
    basis: (original.basis as 'cash' | 'accrual' | 'both') ?? 'both',
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit ?? '0',
      credit: l.debit ?? '0',
      description: l.description ?? undefined,
      tagId: l.tagId,
      isTaxable: false,
      taxRate: '0',
      taxAmount: '0',
    })),
  }, userId);
}

export async function duplicateAje(tenantId: string, companyId: string, txnId: string, userId?: string) {
  const original = await loadAje(tenantId, txnId);
  const lines = await loadLines(tenantId, txnId);
  return createAje(tenantId, companyId, {
    txnDate: original.txnDate,
    memo: original.memo ?? undefined,
    basis: (original.basis as 'cash' | 'accrual' | 'both') ?? 'both',
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit ?? '0',
      credit: l.credit ?? '0',
      description: l.description ?? undefined,
      tagId: l.tagId,
      isTaxable: false,
      taxRate: '0',
      taxAmount: '0',
    })),
  }, userId);
}

export interface AjeListFilters {
  fiscalYear?: number;
  includeVoid?: boolean;
  limit: number;
  offset: number;
}

export async function listAjes(tenantId: string, companyId: string, f: AjeListFilters) {
  const conds = [
    eq(transactions.tenantId, tenantId),
    eq(transactions.companyId, companyId),
    eq(transactions.txnType, 'aje'),
  ];
  if (!f.includeVoid) conds.push(eq(transactions.status, 'posted'));
  if (f.fiscalYear) {
    const [c] = await db.select({ m: companies.fiscalYearStartMonth }).from(companies)
      .where(eq(companies.id, companyId)).limit(1);
    const m = c?.m ?? 1;
    const start = m === 1 ? `${f.fiscalYear}-01-01` : `${f.fiscalYear - 1}-${String(m).padStart(2, '0')}-01`;
    const endMonth = m === 1 ? 12 : m - 1;
    const endDay = new Date(Date.UTC(f.fiscalYear, endMonth, 0)).getUTCDate();
    const end = `${f.fiscalYear}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
    conds.push(sql`${transactions.txnDate} >= ${start}`);
    conds.push(sql`${transactions.txnDate} <= ${end}`);
  }
  const where = and(...conds);
  const [rows, countRows] = await Promise.all([
    db.select().from(transactions).where(where)
      .orderBy(desc(transactions.txnDate), desc(transactions.ajeNumber))
      .limit(f.limit).offset(f.offset),
    db.select({ count: sql<number>`count(*)::int` }).from(transactions).where(where),
  ]);
  // Attach lines for register display (bounded by pagination).
  const ids = rows.map((r) => r.id);
  const lines = ids.length
    ? await db.select().from(journalLines)
      .where(and(
        eq(journalLines.tenantId, tenantId),
        sql`${journalLines.transactionId} IN ${ids}`,
        eq(journalLines.isVoidReversal, false),
      ))
      .orderBy(journalLines.lineOrder)
    : [];
  const byTxn = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = byTxn.get(l.transactionId) ?? [];
    arr.push(l);
    byTxn.set(l.transactionId, arr);
  }
  return {
    ajes: rows.map((r) => ({
      ...r,
      ajeNumberLabel: r.ajeNumber ? formatAjeNumber(r.ajeNumber) : null,
      lines: byTxn.get(r.id) ?? [],
    })),
    total: countRows[0]?.count ?? 0,
  };
}
