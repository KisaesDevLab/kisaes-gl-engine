// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Daily Sales (POS X/Z report) templates + entries. A template maps Z-report
// lines to GL accounts/sides; a daily entry's totals build a balanced journal
// entry (auto Cash Over/Short absorbs any residual) that the user reviews and
// posts via ledger.postTransaction. See Build Plans/DAILY_SALES_POS_PLAN.md.

import { eq, and, desc, count, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import {
  BALANCE_TOLERANCE,
  DAILY_SALES_PRESETS,
  type CreateDailySalesTemplateInput,
  type UpdateDailySalesTemplateInput,
  type DuplicateDailySalesTemplateInput,
  type DailySalesTemplateLineInput,
  type CreateDailySalesEntryInput,
  type UpdateDailySalesEntryInput,
  type PreviewDailySalesEntryInput,
} from '@kis-books/shared';
import { db, type DbOrTx } from '../db/index.js';
import {
  dailySalesTemplates,
  dailySalesTemplateLines,
  dailySalesEntries,
  dailySalesEntryValues,
  accounts,
  attachments,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
// Get-or-create for role accounts now lives in system-accounts.service.ts so
// banking, imports and the Practice surfaces share one implementation.
import { getOrCreateSystemAccount } from './system-accounts.service.js';
import { assertTagsInTenant } from './tags.service.js';
import { reassignDraftAttachments } from './attachment.service.js';

const TOLERANCE = new Decimal(BALANCE_TOLERANCE);

// Attachment homes. An unposted (draft) entry has no transaction yet, so its
// files live on the entry itself; posting moves them onto the journal entry
// under the transaction's own txn_type ('daily_sales') — the convention
// TransactionDetail, the Transaction Report and the attachment library use —
// so after posting they are ordinary transaction attachments.
export const DAILY_SALES_ENTRY_ATTACHABLE = 'daily_sales_entry';
export const DAILY_SALES_TXN_ATTACHABLE = 'daily_sales';

// ── Templates ───────────────────────────────────────────────────
export async function getTemplate(tenantId: string, id: string) {
  const tpl = await db.query.dailySalesTemplates.findFirst({
    where: and(eq(dailySalesTemplates.tenantId, tenantId), eq(dailySalesTemplates.id, id)),
  });
  if (!tpl) throw AppError.notFound('Daily-sales template not found');
  const lines = await db.select().from(dailySalesTemplateLines)
    .where(and(eq(dailySalesTemplateLines.tenantId, tenantId), eq(dailySalesTemplateLines.templateId, id)))
    .orderBy(dailySalesTemplateLines.sortOrder);
  return { ...tpl, lines };
}

export async function listTemplates(tenantId: string) {
  const rows = await db.select().from(dailySalesTemplates)
    .where(and(eq(dailySalesTemplates.tenantId, tenantId), eq(dailySalesTemplates.isActive, true)))
    .orderBy(dailySalesTemplates.name);
  return rows;
}

export async function createTemplate(tenantId: string, input: CreateDailySalesTemplateInput, userId?: string, companyId?: string) {
  if (input.defaultTagId) await assertTagsInTenant(tenantId, [input.defaultTagId]);
  const [tpl] = await db.insert(dailySalesTemplates).values({
    tenantId,
    companyId: companyId ?? null,
    name: input.name,
    presetType: input.presetType ?? 'custom',
    defaultTagId: input.defaultTagId ?? null,
  }).returning();

  if (input.presetType && input.presetType !== 'custom') {
    const preset = DAILY_SALES_PRESETS.find((p) => p.key === input.presetType);
    if (preset) {
      const lineRows = [];
      for (let i = 0; i < preset.lines.length; i += 1) {
        const pl = preset.lines[i]!;
        let accountId: string | null = null;
        if (pl.systemTag) {
          accountId = await getOrCreateSystemAccount(tenantId, pl.systemTag, companyId);
        } else if (pl.suggestedType) {
          const acct = await db.query.accounts.findFirst({
            where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, pl.suggestedType), eq(accounts.isActive, true)),
          });
          accountId = acct?.id ?? null;
        }
        lineRows.push({
          tenantId, templateId: tpl!.id, section: pl.section, label: pl.label,
          accountId, normalSide: pl.normalSide, sortOrder: i,
          isRequired: pl.required ?? false, allowTag: pl.allowTag ?? false,
        });
      }
      if (lineRows.length) await db.insert(dailySalesTemplateLines).values(lineRows);
    }
  }

  await auditLog(tenantId, 'create', 'daily_sales_template', tpl!.id, null, tpl, userId);
  return getTemplate(tenantId, tpl!.id);
}

export async function updateTemplate(tenantId: string, id: string, input: UpdateDailySalesTemplateInput, userId?: string) {
  const before = await getTemplate(tenantId, id);
  if (input.defaultTagId) await assertTagsInTenant(tenantId, [input.defaultTagId]);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates['name'] = input.name;
  if (input.defaultTagId !== undefined) updates['defaultTagId'] = input.defaultTagId;
  if (input.isActive !== undefined) updates['isActive'] = input.isActive;
  await db.update(dailySalesTemplates).set(updates)
    .where(and(eq(dailySalesTemplates.tenantId, tenantId), eq(dailySalesTemplates.id, id)));
  await auditLog(tenantId, 'update', 'daily_sales_template', id, before, updates, userId);
  return getTemplate(tenantId, id);
}

export async function deleteTemplate(tenantId: string, id: string, userId?: string) {
  await db.update(dailySalesTemplates).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(dailySalesTemplates.tenantId, tenantId), eq(dailySalesTemplates.id, id)));
  await auditLog(tenantId, 'delete', 'daily_sales_template', id, null, null, userId);
}

export async function duplicateTemplate(tenantId: string, id: string, input: DuplicateDailySalesTemplateInput, userId?: string) {
  const src = await getTemplate(tenantId, id); // tenant-scope + existence check
  const newId = await db.transaction(async (tx) => {
    const [tpl] = await tx.insert(dailySalesTemplates).values({
      tenantId, companyId: src.companyId, name: input.name?.trim() || `${src.name} (copy)`,
      presetType: src.presetType, defaultTagId: src.defaultTagId,
    }).returning();
    // Active lines only — soft-removed lines exist for old entries' provenance.
    const lines = src.lines.filter((l) => l.isActive);
    if (lines.length) {
      await tx.insert(dailySalesTemplateLines).values(lines.map((l, i) => ({
        tenantId, templateId: tpl!.id, section: l.section, label: l.label, accountId: l.accountId,
        tagId: l.tagId, normalSide: l.normalSide, sortOrder: i, isRequired: l.isRequired,
        allowTag: l.allowTag, isActive: true,
      })));
    }
    return tpl!.id;
  });
  await auditLog(tenantId, 'create', 'daily_sales_template', newId, null, { duplicatedFrom: id }, userId);
  return getTemplate(tenantId, newId);
}

// Upsert the template's line definitions: update by id, insert new, soft-remove
// (is_active=false) any existing line not present — preserves provenance for
// entry values that referenced a removed line.
export async function replaceTemplateLines(tenantId: string, templateId: string, lines: DailySalesTemplateLineInput[], userId?: string) {
  await getTemplate(tenantId, templateId); // tenant-scope check
  await assertTagsInTenant(tenantId, lines.flatMap((l) => (l.tagId ? [l.tagId] : [])));
  const existing = await db.select({ id: dailySalesTemplateLines.id }).from(dailySalesTemplateLines)
    .where(and(eq(dailySalesTemplateLines.tenantId, tenantId), eq(dailySalesTemplateLines.templateId, templateId)));
  const incomingIds = new Set(lines.filter((l) => l.id).map((l) => l.id as string));

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    const row = {
      tenantId, templateId, section: l.section, label: l.label,
      accountId: l.accountId ?? null, tagId: l.tagId ?? null, normalSide: l.normalSide, sortOrder: l.sortOrder ?? i,
      isRequired: l.isRequired ?? false, allowTag: l.allowTag ?? false, isActive: l.isActive ?? true,
    };
    if (l.id) {
      await db.update(dailySalesTemplateLines).set(row)
        .where(and(eq(dailySalesTemplateLines.tenantId, tenantId), eq(dailySalesTemplateLines.id, l.id)));
    } else {
      await db.insert(dailySalesTemplateLines).values(row);
    }
  }
  for (const e of existing) {
    if (!incomingIds.has(e.id)) {
      await db.update(dailySalesTemplateLines).set({ isActive: false })
        .where(and(eq(dailySalesTemplateLines.tenantId, tenantId), eq(dailySalesTemplateLines.id, e.id)));
    }
  }
  await auditLog(tenantId, 'update', 'daily_sales_template_lines', templateId, null, { count: lines.length }, userId);
  return getTemplate(tenantId, templateId);
}

// ── Compute (shared by preview + post) ──────────────────────────
interface ComputedLine { accountId: string; debit: string; credit: string; description: string; tagId: string | null }
interface Computed {
  journalLines: ComputedLine[];
  totalDebits: string;
  totalCredits: string;
  overShort: string; // signed: debits - credits (positive = overage)
  totalSales: string;
  totalTax: string;
  totalPayments: string;
  unmappedLabels: string[];
}

export function computeEntry(
  templateLines: Array<{ id: string; section: string; label: string; accountId: string | null; tagId?: string | null; normalSide: string; isActive: boolean }>,
  values: Array<{ templateLineId: string; amount: string; tagId: string | null }>,
  entryTagId: string | null,
  defaultTagId: string | null,
): Computed {
  const byLine = new Map(values.map((v) => [v.templateLineId, v]));
  let debits = new Decimal('0');
  let credits = new Decimal('0');
  let sales = new Decimal('0');
  let tax = new Decimal('0');
  let payments = new Decimal('0');
  const journalLines: ComputedLine[] = [];
  const unmappedLabels: string[] = [];

  for (const line of templateLines) {
    if (!line.isActive) continue;
    const v = byLine.get(line.id);
    if (!v) continue;
    const amount = new Decimal(v.amount || '0');
    if (amount.isZero()) continue;
    if (!line.accountId) { unmappedLabels.push(line.label); continue; }

    const isDebit = line.normalSide === 'debit';
    if (isDebit) debits = debits.plus(amount); else credits = credits.plus(amount);
    if (line.section === 'sales') sales = sales.plus(amount);
    else if (line.section === 'tax') tax = tax.plus(amount);
    else if (line.section === 'payment') payments = payments.plus(amount);

    journalLines.push({
      accountId: line.accountId,
      debit: isDebit ? amount.toFixed(4) : '0',
      credit: isDebit ? '0' : amount.toFixed(4),
      description: line.label,
      // Most specific wins: a per-value tag, then the template line's own
      // tag, then the entry's tag, then the template default.
      tagId: v.tagId ?? line.tagId ?? entryTagId ?? defaultTagId,
    });
  }

  const delta = debits.minus(credits); // >0 means need a credit to balance
  return {
    journalLines,
    totalDebits: debits.toFixed(4),
    totalCredits: credits.toFixed(4),
    overShort: delta.toFixed(4),
    totalSales: sales.toFixed(4),
    totalTax: tax.toFixed(4),
    totalPayments: payments.toFixed(4),
    unmappedLabels,
  };
}

// ── Entries ─────────────────────────────────────────────────────
function entryTagIds(input: { tagId?: string | null; values?: Array<{ tagId?: string | null }> }): string[] {
  return [input.tagId, ...(input.values ?? []).map((v) => v.tagId)].filter((t): t is string => !!t);
}

async function saveValues(tenantId: string, entryId: string, values: CreateDailySalesEntryInput['values']) {
  await db.delete(dailySalesEntryValues)
    .where(and(eq(dailySalesEntryValues.tenantId, tenantId), eq(dailySalesEntryValues.entryId, entryId)));
  if (values && values.length) {
    await db.insert(dailySalesEntryValues).values(values.map((v) => ({
      tenantId, entryId, templateLineId: v.templateLineId,
      amount: new Decimal(String(v.amount ?? 0)).toFixed(4), tagId: v.tagId ?? null,
    })));
  }
}

export async function getEntry(tenantId: string, id: string) {
  const entry = await db.query.dailySalesEntries.findFirst({
    where: and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)),
  });
  if (!entry) throw AppError.notFound('Daily-sales entry not found');
  const values = await db.select().from(dailySalesEntryValues)
    .where(and(eq(dailySalesEntryValues.tenantId, tenantId), eq(dailySalesEntryValues.entryId, id)));
  const template = await getTemplate(tenantId, entry.templateId);
  return { ...entry, values, template };
}

export type DailySalesEntrySortKey = 'businessDate' | 'templateName' | 'totalSales' | 'totalTax' | 'overShortAmount' | 'status';

function entryOrderExpr(key: DailySalesEntrySortKey) {
  switch (key) {
    case 'templateName': return sql`LOWER(${dailySalesTemplates.name})`;
    case 'totalSales': return sql`CAST(${dailySalesEntries.totalSales} AS DECIMAL)`;
    case 'totalTax': return sql`CAST(${dailySalesEntries.totalTax} AS DECIMAL)`;
    case 'overShortAmount': return sql`CAST(${dailySalesEntries.overShortAmount} AS DECIMAL)`;
    case 'status': return sql`${dailySalesEntries.status}`;
    case 'businessDate':
    default: return sql`${dailySalesEntries.businessDate}`;
  }
}

export async function listEntries(
  tenantId: string,
  filters: {
    status?: string; templateId?: string; from?: string; to?: string; limit?: number; offset?: number;
    // Server-side column sort (the list paginates). Default: business date desc.
    sortBy?: DailySalesEntrySortKey; sortDir?: 'asc' | 'desc';
  } = {},
) {
  const conds = [eq(dailySalesEntries.tenantId, tenantId)];
  if (filters.status) conds.push(eq(dailySalesEntries.status, filters.status));
  if (filters.templateId) conds.push(eq(dailySalesEntries.templateId, filters.templateId));
  const rows = await db.select({
    id: dailySalesEntries.id,
    templateId: dailySalesEntries.templateId,
    templateName: dailySalesTemplates.name,
    businessDate: dailySalesEntries.businessDate,
    status: dailySalesEntries.status,
    transactionId: dailySalesEntries.transactionId,
    overShortAmount: dailySalesEntries.overShortAmount,
    totalSales: dailySalesEntries.totalSales,
    totalTax: dailySalesEntries.totalTax,
    totalPayments: dailySalesEntries.totalPayments,
    postedAt: dailySalesEntries.postedAt,
    createdAt: dailySalesEntries.createdAt,
    // Files on the entry (draft) or, once posted, on its journal entry
    // (same type set the Transaction Report reads for a transaction).
    attachmentCount: sql<number>`(
      SELECT COUNT(*) FROM attachments a
      WHERE a.tenant_id = ${dailySalesEntries.tenantId}
        AND (
          (a.attachable_type = ${DAILY_SALES_ENTRY_ATTACHABLE} AND a.attachable_id = ${dailySalesEntries.id})
          OR (${dailySalesEntries.transactionId} IS NOT NULL
              AND a.attachable_id = ${dailySalesEntries.transactionId}
              AND a.attachable_type IN (${DAILY_SALES_TXN_ATTACHABLE}, 'transaction', 'journal_entry'))
        )
    )::int`.mapWith(Number),
  })
    .from(dailySalesEntries)
    .leftJoin(dailySalesTemplates, eq(dailySalesTemplates.id, dailySalesEntries.templateId))
    .where(and(...conds))
    .orderBy(
      sql`${entryOrderExpr(filters.sortBy ?? 'businessDate')} ${(filters.sortDir ?? 'desc') === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`,
      desc(dailySalesEntries.businessDate),
      desc(dailySalesEntries.createdAt),
      desc(dailySalesEntries.id),
    )
    .limit(Math.min(Math.max(filters.limit ?? 100, 1), 500))
    .offset(Math.max(filters.offset ?? 0, 0));
  const [countRow] = await db.select({ total: count() })
    .from(dailySalesEntries)
    .where(and(...conds));
  return { entries: rows, total: countRow?.total ?? 0 };
}

export async function createDraft(tenantId: string, input: CreateDailySalesEntryInput, userId?: string, companyId?: string) {
  await getTemplate(tenantId, input.templateId); // validate + tenant scope
  await assertTagsInTenant(tenantId, entryTagIds(input));
  const [entry] = await db.insert(dailySalesEntries).values({
    tenantId, companyId: companyId ?? null, templateId: input.templateId,
    businessDate: input.businessDate, status: 'draft',
    tagId: input.tagId ?? null, notes: input.notes ?? null, createdBy: userId ?? null,
  }).returning();
  await saveValues(tenantId, entry!.id, input.values);
  // Files attached on the new-entry screen before this draft existed.
  const attachmentsLinked = input.draftAttachmentId
    ? await reassignDraftAttachments(tenantId, input.draftAttachmentId, DAILY_SALES_ENTRY_ATTACHABLE, entry!.id)
    : 0;
  await auditLog(tenantId, 'create', 'daily_sales_entry', entry!.id, null,
    attachmentsLinked ? { ...entry, attachmentsLinked } : entry, userId);
  return getEntry(tenantId, entry!.id);
}

export async function updateDraft(tenantId: string, id: string, input: UpdateDailySalesEntryInput, userId?: string) {
  const entry = await db.query.dailySalesEntries.findFirst({
    where: and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)),
  });
  if (!entry) throw AppError.notFound('Daily-sales entry not found');
  if (entry.status !== 'draft') throw AppError.badRequest('Only draft entries can be edited.');
  await assertTagsInTenant(tenantId, entryTagIds(input));
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.businessDate !== undefined) updates['businessDate'] = input.businessDate;
  if (input.tagId !== undefined) updates['tagId'] = input.tagId;
  if (input.notes !== undefined) updates['notes'] = input.notes;
  await db.update(dailySalesEntries).set(updates)
    .where(and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)));
  if (input.values !== undefined) await saveValues(tenantId, id, input.values);
  await auditLog(tenantId, 'update', 'daily_sales_entry', id, entry, updates, userId);
  return getEntry(tenantId, id);
}

export async function deleteEntry(tenantId: string, id: string, userId?: string) {
  const entry = await db.query.dailySalesEntries.findFirst({
    where: and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)),
  });
  if (!entry) throw AppError.notFound('Daily-sales entry not found');
  if (entry.status === 'posted') throw AppError.badRequest('Void a posted entry instead of deleting it.');
  await db.delete(dailySalesEntryValues).where(and(eq(dailySalesEntryValues.tenantId, tenantId), eq(dailySalesEntryValues.entryId, id)));
  await db.delete(dailySalesEntries).where(and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)));
  // Don't strand the entry's files: return them to the unfiled pool
  // ('draft', same as an unsaved form's uploads) so they stay in the
  // attachment library and can be attached elsewhere.
  const attachmentsUnfiled = await moveEntryAttachments(db, tenantId, id, 'draft', id);
  await auditLog(tenantId, 'delete', 'daily_sales_entry', id, entry,
    attachmentsUnfiled ? { attachmentsUnfiled } : null, userId);
}

// Live balance / over-short for unsaved values (UI preview, no writes).
export async function previewEntry(tenantId: string, input: PreviewDailySalesEntryInput) {
  const tpl = await getTemplate(tenantId, input.templateId);
  const values = input.values.map((v) => ({ templateLineId: v.templateLineId, amount: new Decimal(String(v.amount ?? 0)).toFixed(4), tagId: v.tagId ?? null }));
  const c = computeEntry(tpl.lines, values, null, tpl.defaultTagId ?? null);
  const overShort = new Decimal(c.overShort);
  return {
    totalDebits: c.totalDebits,
    totalCredits: c.totalCredits,
    overShort: c.overShort,
    balanced: overShort.abs().lessThanOrEqualTo(TOLERANCE),
    totalSales: c.totalSales,
    totalTax: c.totalTax,
    totalPayments: c.totalPayments,
    unmappedLabels: c.unmappedLabels,
  };
}

export async function postEntry(tenantId: string, id: string, userId?: string, companyId?: string) {
  const entry = await db.query.dailySalesEntries.findFirst({
    where: and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)),
  });
  if (!entry) throw AppError.notFound('Daily-sales entry not found');
  if (entry.status !== 'draft') throw AppError.badRequest('This entry has already been posted or voided.');

  const tpl = await getTemplate(tenantId, entry.templateId);
  const values = await db.select().from(dailySalesEntryValues)
    .where(and(eq(dailySalesEntryValues.tenantId, tenantId), eq(dailySalesEntryValues.entryId, id)));

  const c = computeEntry(
    tpl.lines,
    values.map((v) => ({ templateLineId: v.templateLineId, amount: v.amount, tagId: v.tagId })),
    entry.tagId ?? null,
    tpl.defaultTagId ?? null,
  );
  if (c.unmappedLabels.length) {
    throw AppError.badRequest(`Map an account for these lines before posting: ${c.unmappedLabels.join(', ')}.`);
  }
  if (c.journalLines.length === 0) throw AppError.badRequest('Enter at least one amount before posting.');

  // Auto Cash Over/Short absorbs the residual so the entry always balances.
  const lines = [...c.journalLines];
  const delta = new Decimal(c.overShort); // debits - credits
  if (delta.abs().greaterThan(TOLERANCE)) {
    const overShortAccountId = await getOrCreateSystemAccount(tenantId, 'cash_over_short', companyId);
    lines.push({
      accountId: overShortAccountId,
      debit: delta.lessThan(0) ? delta.abs().toFixed(4) : '0',
      credit: delta.greaterThan(0) ? delta.toFixed(4) : '0',
      description: 'Cash Over/Short',
      tagId: entry.tagId ?? tpl.defaultTagId ?? null,
    });
  }

  const result = await db.transaction(async (tx) => {
    const posted = await ledger.postTransaction(tenantId, {
      txnType: 'daily_sales',
      txnDate: String(entry.businessDate),
      status: 'posted',
      memo: `Daily sales — ${tpl.name} — ${String(entry.businessDate)}`,
      lines,
    }, userId, companyId, tx);

    await tx.update(dailySalesEntries).set({
      status: 'posted',
      transactionId: posted.id,
      overShortAmount: delta.toFixed(4),
      totalSales: c.totalSales,
      totalTax: c.totalTax,
      totalPayments: c.totalPayments,
      postedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)));

    // The draft's files follow it onto the posted journal entry (same
    // transaction, so a failed post leaves them on the draft).
    const attachmentsMoved = await moveEntryAttachments(tx, tenantId, id, DAILY_SALES_TXN_ATTACHABLE, posted.id);

    await auditLog(tenantId, 'create', 'daily_sales_entry_post', id, null, {
      transactionId: posted.id, overShort: delta.toFixed(4),
      ...(attachmentsMoved ? { attachmentsMoved } : {}),
    }, userId, tx);
    return posted;
  });

  return getEntry(tenantId, id);
}

async function moveEntryAttachments(
  conn: DbOrTx, tenantId: string, entryId: string, newType: string, newId: string,
): Promise<number> {
  const moved = await conn.update(attachments)
    .set({ attachableType: newType, attachableId: newId })
    .where(and(
      eq(attachments.tenantId, tenantId),
      eq(attachments.attachableType, DAILY_SALES_ENTRY_ATTACHABLE),
      eq(attachments.attachableId, entryId),
    ))
    .returning({ id: attachments.id });
  return moved.length;
}

export async function voidEntry(tenantId: string, id: string, userId?: string) {
  const entry = await db.query.dailySalesEntries.findFirst({
    where: and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)),
  });
  if (!entry) throw AppError.notFound('Daily-sales entry not found');
  if (entry.status !== 'posted' || !entry.transactionId) throw AppError.badRequest('Only a posted entry can be voided.');

  await ledger.voidTransaction(tenantId, entry.transactionId, 'Daily sales entry voided', userId);
  await db.update(dailySalesEntries).set({ status: 'void', updatedAt: new Date() })
    .where(and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)));
  await auditLog(tenantId, 'void', 'daily_sales_entry', id, entry, null, userId);
  return getEntry(tenantId, id);
}
