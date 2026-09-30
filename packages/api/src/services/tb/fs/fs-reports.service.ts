// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Company layouts + financial-statement reports (drafts). A report points
// at a company layout (reused year to year); drafts compute live off the
// GL; finals are frozen in fs_report_versions (fs-issuance.service.ts).

import { and, asc, count, desc, eq, isNull } from 'drizzle-orm';
import {
  bindLayout, buildDefaultLayout, computeFsReport, fsClientLayoutSchema, fsCompanyEntityKind, fsFrontMatterSchema,
  fsIncludedTitlesPhrase, fsReportSettingsSchema, fsShiftYear, fsStyleSchema, fsTemplateLayoutSchema, renderLetterBody,
  sanitizeFsLetterHtml, toPortableLayout, FS_DEFAULT_FRONT_MATTER, REPORT_LETTER_TITLES,
  type FsCreateReportInput, type FsDraftOverrides, type FsEntityKind, type FsFrontMatter, type FsLayout,
  type FsLetterhead, type FsRenderedReport, type FsReportSettings, type FsSourceData, type FsStyle, type FsUpdateReportInput,
  type ReportLetterType,
} from '@kis-books/shared';
import { db } from '../../../db/index.js';
import { companies, fsCompanyLayouts, fsReports, fsReportVersions } from '../../../db/schema/index.js';
import { AppError } from '../../../utils/errors.js';
import { auditLog } from '../../../middleware/audit.js';
import { listGroupings, seedDefaultGroupings } from '../groupings.service.js';
import { getGlVersionStamp } from '../balance-engine.service.js';
import { resolveLetterVariables } from '../../report-letter.service.js';
import * as library from './fs-library.service.js';
import { loadFsSource } from './fs-source.service.js';

type ReportRow = typeof fsReports.$inferSelect;
type LayoutRow = typeof fsCompanyLayouts.$inferSelect;

// ─── Company layouts ───────────────────────────────────────────────

async function entityKindOf(tenantId: string, companyId: string): Promise<FsEntityKind> {
  const [c] = await db.select({ t: companies.entityType }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
  if (!c) throw AppError.notFound('Company not found');
  return fsCompanyEntityKind(c.t);
}

async function clientGroupings(tenantId: string, companyId: string, userId?: string) {
  await seedDefaultGroupings(tenantId, companyId, userId);
  const { groupings } = await listGroupings(tenantId, companyId);
  return groupings.map((g) => ({ id: g.id, code: g.leadsheetCode ?? null, name: g.name }));
}

export async function listLayouts(tenantId: string, companyId: string) {
  return db.select({
    id: fsCompanyLayouts.id, name: fsCompanyLayouts.name, updatedAt: fsCompanyLayouts.updatedAt,
    sourceTemplateId: fsCompanyLayouts.sourceTemplateId,
  }).from(fsCompanyLayouts)
    .where(and(eq(fsCompanyLayouts.tenantId, tenantId), eq(fsCompanyLayouts.companyId, companyId), isNull(fsCompanyLayouts.archivedAt)))
    .orderBy(asc(fsCompanyLayouts.name));
}

export async function getLayout(tenantId: string, companyId: string, id: string): Promise<LayoutRow> {
  const [row] = await db.select().from(fsCompanyLayouts)
    .where(and(eq(fsCompanyLayouts.id, id), eq(fsCompanyLayouts.tenantId, tenantId), eq(fsCompanyLayouts.companyId, companyId))).limit(1);
  if (!row) throw AppError.notFound('Layout not found');
  return row;
}

export async function bindPreview(tenantId: string, companyId: string, templateId: string | null, userId?: string) {
  const groupings = await clientGroupings(tenantId, companyId, userId);
  const template = templateId
    ? fsTemplateLayoutSchema.parse((await library.getTemplate(tenantId, templateId)).layoutJson)
    : buildDefaultLayout(await entityKindOf(tenantId, companyId));
  const { unresolved } = bindLayout(template, groupings);
  return { unresolved, groupings };
}

export async function createLayout(
  tenantId: string, companyId: string,
  src: { templateId?: string | null; resolutions?: Record<string, string | null>; name?: string; stylePresetId?: string | null },
  userId?: string,
): Promise<LayoutRow> {
  const groupings = await clientGroupings(tenantId, companyId, userId);
  const template: FsLayout = src.templateId
    ? fsTemplateLayoutSchema.parse((await library.getTemplate(tenantId, src.templateId)).layoutJson)
    : buildDefaultLayout(await entityKindOf(tenantId, companyId));
  const { layout } = bindLayout(template, groupings, src.resolutions ?? {});
  const style: FsStyle = src.stylePresetId
    ? fsStyleSchema.parse((await library.getPreset(tenantId, src.stylePresetId)).styleJson)
    : (await library.getDefaultStyle(tenantId)).style;
  const [row] = await db.insert(fsCompanyLayouts).values({
    tenantId, companyId,
    name: src.name || 'Financial statements',
    layoutJson: fsClientLayoutSchema.parse(layout),
    styleJson: style,
    sourceTemplateId: src.templateId ?? null,
    sourceStylePresetId: src.stylePresetId ?? null,
    createdBy: userId ?? null,
    updatedBy: userId ?? null,
  }).returning();
  await auditLog(tenantId, 'create', 'fs_company_layout', row!.id, null, { name: row!.name, sourceTemplateId: row!.sourceTemplateId }, userId);
  return row!;
}

export async function updateLayout(
  tenantId: string, companyId: string, id: string,
  input: { name?: string; layout?: FsLayout; style?: FsStyle; expectedUpdatedAt?: string },
  userId?: string,
): Promise<LayoutRow> {
  const before = await getLayout(tenantId, companyId, id);
  if (input.expectedUpdatedAt && new Date(input.expectedUpdatedAt).getTime() !== before.updatedAt.getTime()) {
    throw AppError.conflict('This layout was changed by someone else. Reload to see their changes.', 'TB_FS_CONFLICT', { updatedAt: before.updatedAt.toISOString() });
  }
  const [row] = await db.update(fsCompanyLayouts).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.layout !== undefined ? { layoutJson: fsClientLayoutSchema.parse(input.layout) } : {}),
    ...(input.style !== undefined ? { styleJson: fsStyleSchema.parse(input.style) } : {}),
    updatedBy: userId ?? null,
    updatedAt: new Date(),
  }).where(eq(fsCompanyLayouts.id, id)).returning();
  await auditLog(tenantId, 'update', 'fs_company_layout', id, { name: before.name, layout: before.layoutJson, style: before.styleJson }, { name: row!.name, layout: row!.layoutJson, style: row!.styleJson }, userId);
  return row!;
}

export async function saveLayoutAsTemplate(
  tenantId: string, companyId: string, id: string,
  input: { name: string; description?: string | null; entityKind?: FsEntityKind | 'any' },
  userId?: string,
) {
  const layoutRow = await getLayout(tenantId, companyId, id);
  const groupings = await clientGroupings(tenantId, companyId, userId);
  const portable = toPortableLayout(fsClientLayoutSchema.parse(layoutRow.layoutJson), groupings);
  return library.createTemplate(tenantId, {
    name: input.name,
    description: input.description ?? null,
    entityKind: input.entityKind ?? (await entityKindOf(tenantId, companyId)),
    layout: portable,
  }, userId);
}

// ─── Reports ───────────────────────────────────────────────────────

export function settingsOf(r: ReportRow): FsReportSettings {
  return fsReportSettingsSchema.parse({
    periodEnd: r.periodEnd,
    framework: r.framework,
    bookBasis: r.bookBasis,
    columns: r.columnsJson,
    tagId: r.tagId,
  });
}

export function frontMatterOf(r: ReportRow): FsFrontMatter {
  const parsed = fsFrontMatterSchema.safeParse(r.frontMatterJson);
  return parsed.success ? parsed.data : FS_DEFAULT_FRONT_MATTER;
}

export async function listReports(tenantId: string, companyId: string, opts: { limit: number; offset: number }) {
  const where = and(eq(fsReports.tenantId, tenantId), eq(fsReports.companyId, companyId), isNull(fsReports.archivedAt));
  const [{ total }] = await db.select({ total: count() }).from(fsReports).where(where) as [{ total: number }];
  const rows = await db.select().from(fsReports).where(where)
    .orderBy(desc(fsReports.periodEnd), desc(fsReports.updatedAt)).limit(opts.limit).offset(opts.offset);
  const stamp = await getGlVersionStamp(tenantId, companyId);
  const versionIds = rows.map((r) => r.currentVersionId).filter((x): x is string => !!x);
  const versions = versionIds.length
    ? await db.select({ id: fsReportVersions.id, versionNo: fsReportVersions.versionNo, glVersionStamp: fsReportVersions.glVersionStamp, finalizedAt: fsReportVersions.finalizedAt, publishedAt: fsReportVersions.publishedAt })
      .from(fsReportVersions).where(and(eq(fsReportVersions.tenantId, tenantId), eq(fsReportVersions.companyId, companyId)))
    : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  return {
    total: Number(total),
    reports: rows.map((r) => {
      const v = r.currentVersionId ? byId.get(r.currentVersionId) : undefined;
      return {
        id: r.id, name: r.name, periodEnd: r.periodEnd, framework: r.framework, bookBasis: r.bookBasis,
        columns: r.columnsJson, status: r.status, updatedAt: r.updatedAt,
        currentVersion: v ? { versionNo: v.versionNo, finalizedAt: v.finalizedAt, publishedAt: v.publishedAt, stale: v.glVersionStamp !== stamp } : null,
      };
    }),
  };
}

export async function getReportRow(tenantId: string, companyId: string, id: string): Promise<ReportRow> {
  const [row] = await db.select().from(fsReports)
    .where(and(eq(fsReports.id, id), eq(fsReports.tenantId, tenantId), eq(fsReports.companyId, companyId))).limit(1);
  if (!row) throw AppError.notFound('Financial statements not found');
  return row;
}

export async function getReport(tenantId: string, companyId: string, id: string) {
  const report = await getReportRow(tenantId, companyId, id);
  const layout = await getLayout(tenantId, companyId, report.companyLayoutId);
  const versions = await db.select({
    id: fsReportVersions.id, versionNo: fsReportVersions.versionNo, status: fsReportVersions.status,
    glVersionStamp: fsReportVersions.glVersionStamp, finalizedAt: fsReportVersions.finalizedAt, finalizedBy: fsReportVersions.finalizedBy,
    validationOverride: fsReportVersions.validationOverride, overrideReason: fsReportVersions.overrideReason,
    pageCount: fsReportVersions.pageCount, publishedAt: fsReportVersions.publishedAt, publishedInstanceId: fsReportVersions.publishedInstanceId,
    supersededAt: fsReportVersions.supersededAt,
  }).from(fsReportVersions).where(eq(fsReportVersions.reportId, id)).orderBy(desc(fsReportVersions.versionNo));
  const stamp = await getGlVersionStamp(tenantId, companyId);
  return {
    report: {
      id: report.id, name: report.name, status: report.status, currentVersionId: report.currentVersionId,
      settings: settingsOf(report), frontMatter: frontMatterOf(report), updatedAt: report.updatedAt,
    },
    layout: { id: layout.id, name: layout.name, layout: layout.layoutJson as FsLayout, style: layout.styleJson as FsStyle, updatedAt: layout.updatedAt },
    versions: versions.map((v) => ({ ...v, stale: v.glVersionStamp !== stamp })),
    glVersionStamp: stamp,
  };
}

export async function createReport(tenantId: string, companyId: string, input: FsCreateReportInput, userId?: string) {
  let layoutId: string;
  if (input.layoutSource.kind === 'company_layout') {
    layoutId = (await getLayout(tenantId, companyId, input.layoutSource.companyLayoutId)).id;
  } else {
    const src = input.layoutSource;
    const layout = await createLayout(tenantId, companyId, {
      templateId: src.kind === 'template' ? src.templateId : null,
      resolutions: src.kind === 'template' ? src.resolutions : undefined,
      name: src.layoutName,
      stylePresetId: input.stylePresetId ?? null,
    }, userId);
    layoutId = layout.id;
  }
  const defaultLetter = await library.getDefaultLetter(tenantId);
  const frontMatter: FsFrontMatter = input.frontMatter ?? {
    ...FS_DEFAULT_FRONT_MATTER,
    letter: { ...FS_DEFAULT_FRONT_MATTER.letter, letterId: defaultLetter?.id ?? null },
  };
  const s = input.settings;
  const [row] = await db.insert(fsReports).values({
    tenantId, companyId, companyLayoutId: layoutId, name: input.name,
    periodEnd: s.periodEnd, framework: s.framework, bookBasis: s.framework === 'cash' ? 'cash' : s.bookBasis,
    columnsJson: s.columns, tagId: s.tagId ?? null, frontMatterJson: frontMatter,
    createdBy: userId ?? null, updatedBy: userId ?? null,
  }).returning();
  await auditLog(tenantId, 'create', 'fs_report', row!.id, null, row, userId);
  return row!;
}

function assertDraft(r: ReportRow) {
  if (r.status === 'final') {
    throw AppError.locked('These statements are final. Reopen them to make changes (a new version will be created).', 'TB_FS_FINAL_LOCKED');
  }
}

export async function updateReport(tenantId: string, companyId: string, id: string, input: FsUpdateReportInput, userId?: string) {
  const before = await getReportRow(tenantId, companyId, id);
  assertDraft(before);
  const s = input.settings;
  const [row] = await db.update(fsReports).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(s ? {
      periodEnd: s.periodEnd, framework: s.framework, bookBasis: s.framework === 'cash' ? 'cash' : s.bookBasis,
      columnsJson: s.columns, tagId: s.tagId ?? null,
    } : {}),
    ...(input.frontMatter !== undefined ? {
      frontMatterJson: {
        ...input.frontMatter,
        letter: {
          ...input.frontMatter.letter,
          bodyHtmlOverride: input.frontMatter.letter.bodyHtmlOverride ? sanitizeFsLetterHtml(input.frontMatter.letter.bodyHtmlOverride) : input.frontMatter.letter.bodyHtmlOverride ?? null,
        },
      },
    } : {}),
    updatedBy: userId ?? null,
    updatedAt: new Date(),
  }).where(eq(fsReports.id, id)).returning();
  await auditLog(tenantId, 'update', 'fs_report', id, before, row, userId);
  return row!;
}

export async function archiveReport(tenantId: string, companyId: string, id: string, userId?: string) {
  const before = await getReportRow(tenantId, companyId, id);
  const [row] = await db.update(fsReports).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(fsReports.id, id)).returning();
  await auditLog(tenantId, 'delete', 'fs_report', id, before, row, userId);
}

// Next period's draft with the same layout (layouts are reused year to year).
export async function rollForward(tenantId: string, companyId: string, id: string, input: { periodEnd?: string; name?: string }, userId?: string) {
  const src = await getReportRow(tenantId, companyId, id);
  const periodEnd = input.periodEnd ?? fsShiftYear(src.periodEnd, 1);
  const [row] = await db.insert(fsReports).values({
    tenantId, companyId, companyLayoutId: src.companyLayoutId,
    name: input.name ?? src.name.replace(/\b(19|20)\d{2}\b/, periodEnd.slice(0, 4)),
    periodEnd, framework: src.framework, bookBasis: src.bookBasis, columnsJson: src.columnsJson, tagId: src.tagId,
    frontMatterJson: { ...frontMatterOf(src), letter: { ...frontMatterOf(src).letter, reportDate: null, bodyHtmlOverride: null } },
    createdBy: userId ?? null, updatedBy: userId ?? null,
  }).returning();
  await auditLog(tenantId, 'create', 'fs_report', row!.id, null, { ...row, rolledFrom: id }, userId);
  return row!;
}

// ─── Compute + front matter resolution ─────────────────────────────

export interface ResolvedDraft {
  settings: FsReportSettings;
  layout: FsLayout;
  style: FsStyle;
  frontMatter: FsFrontMatter;
}

export async function resolveDraft(tenantId: string, companyId: string, id: string, overrides: FsDraftOverrides = {}): Promise<ResolvedDraft & { report: ReportRow; layoutRow: LayoutRow }> {
  const report = await getReportRow(tenantId, companyId, id);
  const layoutRow = await getLayout(tenantId, companyId, report.companyLayoutId);
  return {
    report,
    layoutRow,
    settings: overrides.settings ?? settingsOf(report),
    layout: overrides.layout ?? fsClientLayoutSchema.parse(layoutRow.layoutJson),
    style: overrides.style ?? fsStyleSchema.parse(layoutRow.styleJson),
    frontMatter: overrides.frontMatter ?? frontMatterOf(report),
  };
}

export function letterheadOf(row: Awaited<ReturnType<typeof library.getLetterhead>>): FsLetterhead | null {
  if (!row) return null;
  return {
    displayName: row.displayName, addressLine1: row.addressLine1, addressLine2: row.addressLine2, city: row.city, state: row.state,
    postalCode: row.postalCode, phone: row.phone, email: row.email, website: row.website, logoDataUri: row.logoDataUri,
    letterheadAlign: row.letterheadAlign === 'center' ? 'center' : 'left',
  };
}

export async function resolveLetter(
  tenantId: string, companyId: string, draft: ResolvedDraft, source: FsSourceData,
): Promise<{ title: string; bodyHtml: string } | null> {
  const fm = draft.frontMatter.letter;
  if (!fm.enabled) return null;
  const letter = fm.letterId ? await library.getLetter(tenantId, fm.letterId).catch(() => null) : await library.getDefaultLetter(tenantId);
  if (!letter && !fm.bodyHtmlOverride) return null;
  const letterType = (letter?.letterType ?? 'compilation') as ReportLetterType;
  const profile = await library.getLetterhead(tenantId);
  const base = await resolveLetterVariables(tenantId, companyId, {
    periodStart: source.fyStart,
    periodEnd: draft.settings.periodEnd,
    basis: draft.settings.framework === 'gaap' ? 'accrual' : draft.settings.framework,
    reportDate: fm.reportDate ?? new Date().toISOString().slice(0, 10),
    letterType,
  });
  const tagged = !!draft.settings.tagId;
  const kinds = draft.layout.statements.filter((s) => s.enabled && !(tagged && (s.kind === 'equity' || s.kind === 'cash_flows'))).map((s) => s.kind);
  const values: Record<string, string> = {
    ...base,
    financial_statement_titles: fsIncludedTitlesPhrase(kinds, {
      framework: draft.settings.framework, entityKind: source.entityKind, comparative: draft.settings.columns.mode === 'cy_py',
    }),
  };
  if (profile?.displayName) values['firm_name'] = profile.displayName;
  if (profile?.city) values['firm_city'] = profile.city;
  if (profile?.state) values['firm_state'] = profile.state;
  if (profile?.city || profile?.state) values['firm_city_state'] = [profile.city, profile.state].filter(Boolean).join(', ');
  if (profile?.accountantSignature) values['accountant_signature'] = profile.accountantSignature;
  const body = fm.bodyHtmlOverride ?? letter?.bodyHtml ?? '';
  const title = (fm.titleOverride && fm.titleOverride.trim()) || (letter?.title && letter.title.trim()) || REPORT_LETTER_TITLES[letterType] || 'Accountant’s Report';
  return { title, bodyHtml: sanitizeFsLetterHtml(renderLetterBody(body, values)) };
}

export async function previewData(tenantId: string, companyId: string, id: string, overrides: FsDraftOverrides = {}) {
  const draft = await resolveDraft(tenantId, companyId, id, overrides);
  const source = await loadFsSource(tenantId, companyId, draft.settings);
  const letterhead = letterheadOf(await library.getLetterhead(tenantId));
  const letter = await resolveLetter(tenantId, companyId, draft, source);
  return { source, letterhead, letter };
}

export async function computeDraft(tenantId: string, companyId: string, id: string, overrides: FsDraftOverrides = {}): Promise<{ model: FsRenderedReport } & ResolvedDraft & { source: FsSourceData }> {
  const draft = await resolveDraft(tenantId, companyId, id, overrides);
  const source = await loadFsSource(tenantId, companyId, draft.settings);
  const model = computeFsReport(draft.settings, draft.layout, draft.style, source);
  return { ...draft, source, model };
}
