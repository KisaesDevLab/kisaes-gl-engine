// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Daily Sales (POS X/Z report) templates + entries. A template maps Z-report
// lines to GL accounts/sides; a daily entry's totals build a balanced journal
// entry (auto Cash Over/Short absorbs any residual) that the user reviews and
// posts via ledger.postTransaction. See Build Plans/DAILY_SALES_POS_PLAN.md.

import { eq, and, desc } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import {
  BALANCE_TOLERANCE,
  DAILY_SALES_PRESETS,
  DAILY_SALES_SYSTEM_ACCOUNTS,
  type CreateDailySalesTemplateInput,
  type UpdateDailySalesTemplateInput,
  type DailySalesTemplateLineInput,
  type CreateDailySalesEntryInput,
  type UpdateDailySalesEntryInput,
  type PreviewDailySalesEntryInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  dailySalesTemplates,
  dailySalesTemplateLines,
  dailySalesEntries,
  dailySalesEntryValues,
  accounts,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';

const TOLERANCE = new Decimal(BALANCE_TOLERANCE);

// ── System accounts (lazy create) ───────────────────────────────
// Beyond payments_clearing / sales_tax_payable (in every COA template), the
// feature needs cash_over_short / tips_payable / gift_card_liability. Create
// them on first use so existing tenants don't need a COA re-seed.
async function getOrCreateSystemAccount(tenantId: string, systemTag: string, companyId?: string): Promise<string> {
  const existing = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, systemTag)),
  });
  if (existing) return existing.id;
  const spec = DAILY_SALES_SYSTEM_ACCOUNTS.find((s) => s.systemTag === systemTag);
  if (!spec) throw AppError.internal(`Unknown daily-sales system account '${systemTag}'.`);
  // (tenant_id, account_number) is unique — fall back to a null number on clash.
  const numTaken = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, spec.accountNumber)),
  });
  const [created] = await db.insert(accounts).values({
    tenantId,
    companyId: companyId ?? null,
    accountNumber: numTaken ? null : spec.accountNumber,
    name: spec.name,
    accountType: spec.accountType,
    detailType: spec.detailType,
    isSystem: true,
    systemTag: spec.systemTag,
    isActive: true,
  }).returning();
  return created!.id;
}

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

// Upsert the template's line definitions: update by id, insert new, soft-remove
// (is_active=false) any existing line not present — preserves provenance for
// entry values that referenced a removed line.
export async function replaceTemplateLines(tenantId: string, templateId: string, lines: DailySalesTemplateLineInput[], userId?: string) {
  await getTemplate(tenantId, templateId); // tenant-scope check
  const existing = await db.select({ id: dailySalesTemplateLines.id }).from(dailySalesTemplateLines)
    .where(and(eq(dailySalesTemplateLines.tenantId, tenantId), eq(dailySalesTemplateLines.templateId, templateId)));
  const incomingIds = new Set(lines.filter((l) => l.id).map((l) => l.id as string));

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    const row = {
      tenantId, templateId, section: l.section, label: l.label,
      accountId: l.accountId ?? null, normalSide: l.normalSide, sortOrder: l.sortOrder ?? i,
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
  templateLines: Array<{ id: string; section: string; label: string; accountId: string | null; normalSide: string; isActive: boolean }>,
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
      tagId: v.tagId ?? entryTagId ?? defaultTagId,
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

export async function listEntries(
  tenantId: string,
  filters: { status?: string; templateId?: string; from?: string; to?: string; limit?: number; offset?: number } = {},
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
  })
    .from(dailySalesEntries)
    .leftJoin(dailySalesTemplates, eq(dailySalesTemplates.id, dailySalesEntries.templateId))
    .where(and(...conds))
    .orderBy(desc(dailySalesEntries.businessDate))
    .limit(Math.min(Math.max(filters.limit ?? 100, 1), 200))
    .offset(Math.max(filters.offset ?? 0, 0));
  return rows;
}

export async function createDraft(tenantId: string, input: CreateDailySalesEntryInput, userId?: string, companyId?: string) {
  await getTemplate(tenantId, input.templateId); // validate + tenant scope
  const [entry] = await db.insert(dailySalesEntries).values({
    tenantId, companyId: companyId ?? null, templateId: input.templateId,
    businessDate: input.businessDate, status: 'draft',
    tagId: input.tagId ?? null, notes: input.notes ?? null, createdBy: userId ?? null,
  }).returning();
  await saveValues(tenantId, entry!.id, input.values);
  await auditLog(tenantId, 'create', 'daily_sales_entry', entry!.id, null, entry, userId);
  return getEntry(tenantId, entry!.id);
}

export async function updateDraft(tenantId: string, id: string, input: UpdateDailySalesEntryInput, userId?: string) {
  const entry = await db.query.dailySalesEntries.findFirst({
    where: and(eq(dailySalesEntries.tenantId, tenantId), eq(dailySalesEntries.id, id)),
  });
  if (!entry) throw AppError.notFound('Daily-sales entry not found');
  if (entry.status !== 'draft') throw AppError.badRequest('Only draft entries can be edited.');
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
  await auditLog(tenantId, 'delete', 'daily_sales_entry', id, entry, null, userId);
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

    await auditLog(tenantId, 'create', 'daily_sales_entry_post', id, null, { transactionId: posted.id, overShort: delta.toFixed(4) }, userId, tx);
    return posted;
  });

  return getEntry(tenantId, id);
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
