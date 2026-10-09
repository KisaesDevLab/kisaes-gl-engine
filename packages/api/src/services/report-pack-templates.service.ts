// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report pack templates (migration 0200). A super admin saves one of their
// packs as an install-wide template; staff apply a template to create an
// ordinary pack in the client they are working in. Templates carry only
// portable settings: per-client ids (default tag, a report's tag filter,
// the Transaction Report's account filter) are stripped on save.

import { and, asc, eq, isNull } from 'drizzle-orm';
import { reportPackItemOptionsSchema, type PeriodPreset, type ReportPackItemOptions } from '@kis-books/shared';
import { db } from '../db/index.js';
import { reportPackTemplates, reportLetters } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as packService from './report-pack.service.js';

export interface PackTemplateSettings {
  periodPreset: PeriodPreset;
  customRangeStart: string | null;
  customRangeEnd: string | null;
  asOfMode: 'range-end' | 'custom';
  asOfCustom: string | null;
  defaultBasis: 'accrual' | 'cash';
  coverPage: boolean;
  toc: boolean;
  pageNumbers: boolean;
  pageFooter: string | null;
  filenameTemplate: string;
  onError: 'skip' | 'fail';
  letterId: string | null;
}

export interface PackTemplateItem { reportId: string; options: ReportPackItemOptions }

export interface PackTemplateSummary {
  id: string;
  name: string;
  description: string | null;
  reportCount: number;
  reportIds: string[];
  createdAt: string;
  updatedAt: string;
}

type TemplateRow = typeof reportPackTemplates.$inferSelect;

/** Drop the options that point at one client's data. */
export function portableOptions(options: ReportPackItemOptions): ReportPackItemOptions {
  const { tagId: _tag, accountId: _account, ...rest } = options;
  return rest;
}

function toSummary(row: TemplateRow): PackTemplateSummary {
  const items = (row.items as PackTemplateItem[]) ?? [];
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    reportCount: items.length,
    reportIds: items.map((i) => i.reportId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function loadOrThrow(id: string): Promise<TemplateRow> {
  const row = await db.query.reportPackTemplates.findFirst({
    where: and(eq(reportPackTemplates.id, id), isNull(reportPackTemplates.deletedAt)),
  });
  if (!row) throw AppError.notFound('Report pack template not found');
  return row;
}

/** Super admin: snapshot one of their packs as an install-wide template. */
export async function saveAsTemplate(
  tenantId: string,
  packId: string,
  userId: string,
  input: { name?: string; description?: string | null },
): Promise<PackTemplateSummary> {
  const pack = await packService.getPack(tenantId, packId);
  const settings: PackTemplateSettings = {
    periodPreset: pack.periodPreset as PeriodPreset,
    customRangeStart: pack.customRangeStart,
    customRangeEnd: pack.customRangeEnd,
    asOfMode: pack.asOfMode === 'custom' ? 'custom' : 'range-end',
    asOfCustom: pack.asOfCustom,
    defaultBasis: pack.defaultBasis === 'cash' ? 'cash' : 'accrual',
    coverPage: pack.coverPage,
    toc: pack.toc,
    pageNumbers: pack.pageNumbers,
    pageFooter: pack.pageFooter,
    filenameTemplate: pack.filenameTemplate,
    onError: pack.onError === 'fail' ? 'fail' : 'skip',
    letterId: pack.letterId,
  };
  const items: PackTemplateItem[] = [...pack.items]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((it) => ({
      reportId: it.reportId,
      options: portableOptions(reportPackItemOptionsSchema.parse(it.optionsJson ?? {})),
    }));
  const [row] = await db.insert(reportPackTemplates).values({
    name: (input.name?.trim() || pack.name).slice(0, 200),
    description: input.description?.trim() || pack.description || null,
    settings,
    items,
    sourcePackId: pack.id,
    createdBy: userId,
  }).returning();
  await auditLog(tenantId, 'create', 'report_pack_template', row!.id, null, { name: row!.name, sourcePackId: pack.id, reportCount: items.length }, userId);
  return toSummary(row!);
}

export async function listTemplates(): Promise<PackTemplateSummary[]> {
  const rows = await db.select().from(reportPackTemplates)
    .where(isNull(reportPackTemplates.deletedAt))
    .orderBy(asc(reportPackTemplates.name));
  return rows.map(toSummary);
}

export async function updateTemplate(
  tenantId: string,
  id: string,
  userId: string,
  input: { name?: string; description?: string | null },
): Promise<PackTemplateSummary> {
  const before = await loadOrThrow(id);
  const [row] = await db.update(reportPackTemplates)
    .set({
      ...(input.name?.trim() ? { name: input.name.trim().slice(0, 200) } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(reportPackTemplates.id, id))
    .returning();
  await auditLog(tenantId, 'update', 'report_pack_template', id, { name: before.name }, { name: row!.name }, userId);
  return toSummary(row!);
}

export async function deleteTemplate(tenantId: string, id: string, userId: string): Promise<void> {
  const before = await loadOrThrow(id);
  await db.update(reportPackTemplates).set({ deletedAt: new Date() }).where(eq(reportPackTemplates.id, id));
  await auditLog(tenantId, 'delete', 'report_pack_template', id, { name: before.name }, null, userId);
}

/** Staff: create an ordinary pack in this client from a template. */
export async function applyTemplate(
  tenantId: string,
  companyId: string,
  userId: string,
  templateId: string,
  input: { name?: string } = {},
) {
  const tpl = await loadOrThrow(templateId);
  const s = (tpl.settings as Partial<PackTemplateSettings>) ?? {};
  // A letter that was deactivated or removed since the template was made
  // is dropped rather than failing the new pack.
  let letterId = s.letterId ?? null;
  if (letterId) {
    const letter = await db.query.reportLetters.findFirst({ where: eq(reportLetters.id, letterId) });
    if (!letter || !letter.isActive) letterId = null;
  }
  return packService.createPack(tenantId, companyId, userId, {
    name: (input.name?.trim() || tpl.name).slice(0, 200),
    description: tpl.description,
    periodPreset: s.periodPreset,
    customRangeStart: s.customRangeStart ?? null,
    customRangeEnd: s.customRangeEnd ?? null,
    asOfMode: s.asOfMode,
    asOfCustom: s.asOfCustom ?? null,
    defaultBasis: s.defaultBasis,
    coverPage: s.coverPage,
    toc: s.toc,
    pageNumbers: s.pageNumbers,
    pageFooter: s.pageFooter ?? null,
    filenameTemplate: s.filenameTemplate,
    onError: s.onError,
    letterId,
    items: ((tpl.items as PackTemplateItem[]) ?? []).map((i) => ({ reportId: i.reportId, options: portableOptions(i.options ?? {}) })),
  });
}
