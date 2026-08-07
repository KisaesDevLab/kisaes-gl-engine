// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax RJEs (Phase 8, ADR-TB-03, rule TB4): tax-basis-only entries that
// NEVER touch the GL — they exist only in the TB tax columns, M-1/M-2,
// and exports. Double-entry enforced (lines net to zero), numbered
// RJE-001 per (company, taxYear), firm-only by router construction.
//
// Every mutation bumps gl_version_stamps directly: RJEs are invisible
// to the GL triggers, but the workpaper cache key and leadsheet
// sign-off staleness both ride the stamp and MUST move on RJE edits
// (STATE.md Phase-7 note).

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import { db, type Tx } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, activityUnits, firmTaxCodes, taxCodes, tbTaxEntries, tbTaxEntryLines,
} from '../../db/schema/index.js';
import type { z } from 'zod';
import type { createTaxEntrySchema } from '@kis-books/shared';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { resolveSeedVersionId } from './assignments.service.js';

type TaxEntryInput = z.infer<typeof createTaxEntrySchema>;

export function formatRjeNumber(n: number): string {
  return `RJE-${String(n).padStart(3, '0')}`;
}

async function bumpStamp(tx: Tx, tenantId: string, companyId: string) {
  await tx.execute(sql`
    INSERT INTO gl_version_stamps (tenant_id, company_id, counter, updated_at)
    VALUES (${tenantId}, ${companyId}, 1, now())
    ON CONFLICT (tenant_id, company_id)
    DO UPDATE SET counter = gl_version_stamps.counter + 1, updated_at = now()
  `);
}

function assertBalanced(lines: TaxEntryInput['lines']) {
  let dr = new Decimal(0);
  let cr = new Decimal(0);
  for (const l of lines) {
    dr = dr.plus(l.debit || 0);
    cr = cr.plus(l.credit || 0);
  }
  if (!dr.eq(cr)) {
    throw AppError.unprocessableEntity(
      `Tax entry must net to zero: debits ${dr.toFixed(2)} ≠ credits ${cr.toFixed(2)}`,
      'TB_UNBALANCED',
    );
  }
  if (dr.isZero()) throw AppError.unprocessableEntity('Tax entry has no amounts', 'TB_UNBALANCED');
}

async function assertLineRefs(tenantId: string, companyId: string, lines: TaxEntryInput['lines']) {
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const owned = await db.select({ id: accounts.id }).from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      sql`${accounts.id} IN ${accountIds}`,
      sql`(${accounts.companyId} = ${companyId} OR ${accounts.companyId} IS NULL)`,
    ));
  if (owned.length !== accountIds.length) {
    throw AppError.badRequest('One or more accounts do not belong to this company', 'TB_NOT_ASSIGNABLE');
  }
  const unitIds = [...new Set(lines.map((l) => l.activityUnitId).filter((x): x is string => !!x))];
  if (unitIds.length) {
    const units = await db.select({ id: activityUnits.id }).from(activityUnits)
      .where(and(
        eq(activityUnits.tenantId, tenantId),
        eq(activityUnits.companyId, companyId),
        sql`${activityUnits.id} IN ${unitIds}`,
      ));
    if (units.length !== unitIds.length) {
      throw AppError.badRequest('One or more activity units do not belong to this company', 'TB_UNIT_IN_USE');
    }
  }
}

export async function createTaxEntry(tenantId: string, companyId: string, input: TaxEntryInput, userId?: string, retried = false): Promise<Awaited<ReturnType<typeof insertTaxEntry>>> {
  assertBalanced(input.lines);
  await assertLineRefs(tenantId, companyId, input.lines);
  try {
    return await insertTaxEntry(tenantId, companyId, input, userId);
  } catch (err) {
    // Concurrent creates race MAX(entry_number)+1 into the unique
    // index — retry once with a fresh number instead of surfacing 500.
    const pgCode = (err as { cause?: { code?: string }; code?: string });
    const code = pgCode.code ?? pgCode.cause?.code;
    if (code === '23505' && !retried) {
      return createTaxEntry(tenantId, companyId, input, userId, true);
    }
    throw err;
  }
}

async function insertTaxEntry(tenantId: string, companyId: string, input: TaxEntryInput, userId?: string) {
  return db.transaction(async (tx) => {
    const [max] = await tx.select({ n: sql<number>`COALESCE(MAX(${tbTaxEntries.entryNumber}), 0)::int` })
      .from(tbTaxEntries)
      .where(and(eq(tbTaxEntries.companyId, companyId), eq(tbTaxEntries.taxYear, input.taxYear)));
    const entryNumber = (max?.n ?? 0) + 1;
    const [entry] = await tx.insert(tbTaxEntries).values({
      tenantId, companyId,
      taxYear: input.taxYear,
      entryNumber,
      memo: input.memo ?? null,
      createdBy: userId ?? null,
    }).returning();
    if (!entry) throw AppError.internal('Tax entry insert failed');
    await tx.insert(tbTaxEntryLines).values(input.lines.map((l, i) => ({
      tenantId,
      entryId: entry.id,
      accountId: l.accountId,
      activityUnitId: l.activityUnitId ?? null,
      debit: l.debit || '0',
      credit: l.credit || '0',
      description: l.description ?? null,
      lineOrder: i,
    })));
    await bumpStamp(tx, tenantId, companyId);
    await auditLog(tenantId, 'create', 'tb_tax_entry', entry.id, null, { ...entry, lines: input.lines }, userId, tx);
    return { ...entry, entryNumberLabel: formatRjeNumber(entryNumber) };
  });
}

export async function updateTaxEntry(tenantId: string, companyId: string, id: string, input: TaxEntryInput, userId?: string) {
  assertBalanced(input.lines);
  await assertLineRefs(tenantId, companyId, input.lines);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(tbTaxEntries)
      .where(and(eq(tbTaxEntries.id, id), eq(tbTaxEntries.tenantId, tenantId), eq(tbTaxEntries.companyId, companyId)))
      .limit(1);
    if (!before) throw AppError.notFound('Tax entry not found');
    const beforeLines = await tx.select().from(tbTaxEntryLines).where(eq(tbTaxEntryLines.entryId, id));
    const [after] = await tx.update(tbTaxEntries).set({
      taxYear: input.taxYear,
      memo: input.memo ?? null,
      updatedAt: new Date(),
    }).where(eq(tbTaxEntries.id, id)).returning();
    await tx.delete(tbTaxEntryLines).where(eq(tbTaxEntryLines.entryId, id));
    await tx.insert(tbTaxEntryLines).values(input.lines.map((l, i) => ({
      tenantId,
      entryId: id,
      accountId: l.accountId,
      activityUnitId: l.activityUnitId ?? null,
      debit: l.debit || '0',
      credit: l.credit || '0',
      description: l.description ?? null,
      lineOrder: i,
    })));
    await bumpStamp(tx, tenantId, companyId);
    await auditLog(tenantId, 'update', 'tb_tax_entry', id,
      { ...before, lines: beforeLines }, { ...after, lines: input.lines }, userId, tx);
    return after;
  });
}

export async function deleteTaxEntry(tenantId: string, companyId: string, id: string, userId?: string) {
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(tbTaxEntries)
      .where(and(eq(tbTaxEntries.id, id), eq(tbTaxEntries.tenantId, tenantId), eq(tbTaxEntries.companyId, companyId)))
      .limit(1);
    if (!before) throw AppError.notFound('Tax entry not found');
    const beforeLines = await tx.select().from(tbTaxEntryLines).where(eq(tbTaxEntryLines.entryId, id));
    await tx.delete(tbTaxEntries).where(eq(tbTaxEntries.id, id)); // lines cascade
    await bumpStamp(tx, tenantId, companyId);
    await auditLog(tenantId, 'delete', 'tb_tax_entry', id, { ...before, lines: beforeLines }, null, userId, tx);
  });
}

// Register listing (8.2) with per-entry M-1 flag (8.3): an entry is
// M-1-relevant when any line's account resolves to a code flagged
// is_m1_adjustment (unit-specific assignment first, then account-level).
export async function listTaxEntries(tenantId: string, companyId: string, taxYear: number) {
  const entries = await db.select().from(tbTaxEntries)
    .where(and(
      eq(tbTaxEntries.tenantId, tenantId),
      eq(tbTaxEntries.companyId, companyId),
      eq(tbTaxEntries.taxYear, taxYear),
    ))
    .orderBy(desc(tbTaxEntries.entryNumber));
  const ids = entries.map((e) => e.id);
  const lines = ids.length
    ? await db.select().from(tbTaxEntryLines)
      .where(sql`${tbTaxEntryLines.entryId} IN ${ids}`)
      .orderBy(asc(tbTaxEntryLines.lineOrder))
    : [];

  const m1Accounts = await m1FlaggedAccountIds(tenantId, companyId);
  const byEntry = new Map<string, typeof lines>();
  for (const l of lines) {
    const arr = byEntry.get(l.entryId) ?? [];
    arr.push(l);
    byEntry.set(l.entryId, arr);
  }
  return {
    entries: entries.map((e) => {
      const entryLines = byEntry.get(e.id) ?? [];
      return {
        ...e,
        entryNumberLabel: formatRjeNumber(e.entryNumber),
        lines: entryLines,
        isM1: entryLines.some((l) => m1Accounts.has(l.accountId)),
      };
    }),
  };
}

// Accounts whose resolved tax code carries is_m1_adjustment (Phase 9
// consumes this too).
export async function m1FlaggedAccountIds(tenantId: string, companyId: string): Promise<Set<string>> {
  const assignments = await db.select().from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));
  if (assignments.length === 0) return new Set();

  const versionId = await resolveSeedVersionId(tenantId, companyId);
  const m1SeedCodes = versionId
    ? await db.select({ code: taxCodes.code, activityType: taxCodes.activityType }).from(taxCodes)
      .where(and(eq(taxCodes.versionId, versionId), eq(taxCodes.isM1Adjustment, true)))
    : [];
  const m1Seed = new Set(m1SeedCodes.map((c) => `${c.activityType}|${c.code}`));
  const firmIds = assignments.map((a) => a.firmCodeId).filter((x): x is string => !!x);
  const m1Firm = new Set<string>();
  if (firmIds.length) {
    const firmRows = await db.select({ id: firmTaxCodes.id }).from(firmTaxCodes)
      .where(and(sql`${firmTaxCodes.id} IN ${firmIds}`, eq(firmTaxCodes.isM1Adjustment, true)));
    for (const r of firmRows) m1Firm.add(r.id);
  }

  const flagged = new Set<string>();
  // Prefer unit-specific rows but any M-1 hit flags the account.
  for (const a of assignments) {
    const isM1 = a.seedCode
      ? m1Seed.has(`${a.seedActivityType}|${a.seedCode}`)
      : a.firmCodeId ? m1Firm.has(a.firmCodeId) : false;
    if (isM1) flagged.add(a.accountId);
  }
  return flagged;
}
