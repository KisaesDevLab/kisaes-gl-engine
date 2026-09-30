// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Issuance: finalize (freeze numbers + layout + style + resolved letter +
// the rendered PDF into an immutable fs_report_versions row), reopen (new
// version on the next finalize), staleness / impact against the live GL,
// exports, and publishing a final to the client portal (Financials page)
// through the existing report_instances path.

import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import {
  computeFsReport, fsClientLayoutSchema, fsFrontMatterSchema, fsReportSettingsSchema, fsStyleSchema,
  type FsDraftOverrides, type FsLetterhead, type FsRenderedReport,
} from '@kis-books/shared';
import { db } from '../../../db/index.js';
import { fsReports, fsReportVersions, reportInstances } from '../../../db/schema/index.js';
import { AppError } from '../../../utils/errors.js';
import { auditLog } from '../../../middleware/audit.js';
import { getProviderForTenant } from '../../storage/storage-provider.factory.js';
import { tenantStorageKey } from '../../storage/storage-keys.js';
import { getGlVersionStamp } from '../balance-engine.service.js';
import * as library from './fs-library.service.js';
import { computeDraft, getReportRow, letterheadOf, resolveLetter } from './fs-reports.service.js';
import { loadFsSource } from './fs-source.service.js';
import { renderFsPdf } from './fs-render.service.js';
import { buildFsDocx } from './fs-docx.service.js';
import { buildFsXlsx } from './fs-xlsx.service.js';

type VersionRow = typeof fsReportVersions.$inferSelect;

// Hash of everything a reader sees as a number or caption — "did the
// statements change?" independent of GL stamp churn.
export function numbersHash(model: FsRenderedReport): string {
  const payload = [...model.statements, ...model.schedules].map((s) => [s.title, s.dateLine, s.columns.map((c) => c.label), s.rows.map((r) => [r.caption, r.values])]);
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function getVersion(tenantId: string, companyId: string, reportId: string, versionNo: number): Promise<VersionRow> {
  const [v] = await db.select().from(fsReportVersions)
    .where(and(eq(fsReportVersions.tenantId, tenantId), eq(fsReportVersions.companyId, companyId), eq(fsReportVersions.reportId, reportId), eq(fsReportVersions.versionNo, versionNo)))
    .limit(1);
  if (!v) throw AppError.notFound('Version not found');
  return v;
}

export async function finalize(
  tenantId: string, companyId: string, reportId: string,
  input: { overrideValidation?: boolean; reason?: string },
  userId?: string,
) {
  const report = await getReportRow(tenantId, companyId, reportId);
  if (report.status === 'final') throw AppError.locked('These statements are already final.', 'TB_FS_FINAL_LOCKED');
  const draft = await computeDraft(tenantId, companyId, reportId);
  const errors = draft.model.checks.filter((c) => c.severity === 'error');
  if (errors.length && !input.overrideValidation) {
    throw AppError.unprocessableEntity('Resolve the validation errors or finalize with an override reason.', 'TB_FS_VALIDATION', { checks: errors });
  }
  const letterhead = letterheadOf(await library.getLetterhead(tenantId));
  const letter = await resolveLetter(tenantId, companyId, draft, draft.source);
  const pdf = await renderFsPdf({ report: draft.model, style: draft.style, frontMatter: draft.frontMatter, letterhead, letter });

  const [{ n }] = await db.select({ n: max(fsReportVersions.versionNo) }).from(fsReportVersions).where(eq(fsReportVersions.reportId, reportId)) as [{ n: number | null }];
  const versionNo = (n ?? 0) + 1;
  const key = tenantStorageKey(tenantId, 'reports', 'fs', reportId, `v${versionNo}.pdf`);
  const provider = await getProviderForTenant(tenantId);
  await provider.upload(key, pdf.bytes, { fileName: `financial-statements-v${versionNo}.pdf`, mimeType: 'application/pdf', sizeBytes: pdf.bytes.length });

  const version = await db.transaction(async (tx) => {
    // Re-check under the transaction: a concurrent finalize loses.
    const [fresh] = await tx.select({ status: fsReports.status }).from(fsReports).where(eq(fsReports.id, reportId)).for('update');
    if (fresh?.status === 'final') throw AppError.locked('These statements were finalized by someone else.', 'TB_FS_FINAL_LOCKED');
    await tx.update(fsReportVersions).set({ status: 'superseded', supersededAt: new Date() })
      .where(and(eq(fsReportVersions.reportId, reportId), eq(fsReportVersions.status, 'final')));
    const [v] = await tx.insert(fsReportVersions).values({
      tenantId, companyId, reportId, versionNo, status: 'final',
      periodEnd: draft.settings.periodEnd, framework: draft.settings.framework, bookBasis: draft.settings.bookBasis,
      glVersionStamp: draft.model.meta.glVersionStamp,
      modelJson: draft.model, layoutJson: draft.layout, styleJson: draft.style, settingsJson: draft.settings,
      frontMatterJson: draft.frontMatter, letterJson: letter, letterheadJson: letterhead,
      numbersHash: numbersHash(draft.model),
      pdfStorageKey: key, pdfSha256: createHash('sha256').update(pdf.bytes).digest('hex'), pdfBytes: pdf.bytes.length, pageCount: pdf.pageCount,
      validationOverride: errors.length > 0, overrideReason: errors.length ? (input.reason ?? null) : null,
      finalizedBy: userId ?? null,
    }).returning();
    await tx.update(fsReports).set({ status: 'final', currentVersionId: v!.id, updatedBy: userId ?? null, updatedAt: new Date() }).where(eq(fsReports.id, reportId));
    await auditLog(tenantId, errors.length ? 'override' : 'update', 'fs_report_finalize', reportId, { status: report.status },
      { status: 'final', versionNo, pageCount: pdf.pageCount, overriddenChecks: errors.map((e) => e.code), reason: input.reason ?? null }, userId, tx);
    return v!;
  });
  return { versionNo: version.versionNo, pageCount: version.pageCount, validationOverride: version.validationOverride };
}

export async function reopen(tenantId: string, companyId: string, reportId: string, userId?: string) {
  const report = await getReportRow(tenantId, companyId, reportId);
  if (report.status !== 'final') throw AppError.badRequest('Only final statements can be reopened.', 'TB_FS_NOT_FINAL');
  await db.transaction(async (tx) => {
    if (report.currentVersionId) {
      await tx.update(fsReportVersions).set({ reopenedBy: userId ?? null, reopenedAt: new Date() }).where(eq(fsReportVersions.id, report.currentVersionId));
    }
    await tx.update(fsReports).set({ status: 'draft', updatedBy: userId ?? null, updatedAt: new Date() }).where(eq(fsReports.id, reportId));
    await auditLog(tenantId, 'update', 'fs_report_reopen', reportId, { status: 'final' }, { status: 'draft' }, userId, tx);
  });
}

export async function versionDetail(tenantId: string, companyId: string, reportId: string, versionNo: number) {
  const v = await getVersion(tenantId, companyId, reportId, versionNo);
  const stamp = await getGlVersionStamp(tenantId, companyId);
  return {
    versionNo: v.versionNo, status: v.status, finalizedAt: v.finalizedAt, finalizedBy: v.finalizedBy,
    validationOverride: v.validationOverride, overrideReason: v.overrideReason, pageCount: v.pageCount,
    stale: v.glVersionStamp !== stamp, model: v.modelJson as FsRenderedReport,
    publishedAt: v.publishedAt, publishedInstanceId: v.publishedInstanceId,
  };
}

// Recompute live with the frozen settings / layout / style: a newer GL
// stamp may or may not have moved these statements' numbers.
export async function impact(tenantId: string, companyId: string, reportId: string, versionNo: number) {
  const v = await getVersion(tenantId, companyId, reportId, versionNo);
  const stamp = await getGlVersionStamp(tenantId, companyId);
  if (stamp === v.glVersionStamp) return { stale: false, changed: false };
  const settings = fsReportSettingsSchema.parse(v.settingsJson);
  const source = await loadFsSource(tenantId, companyId, settings);
  const live = computeFsReport(settings, fsClientLayoutSchema.parse(v.layoutJson), fsStyleSchema.parse(v.styleJson), source);
  return { stale: true, changed: numbersHash(live) !== v.numbersHash };
}

export type FsExportFormat = 'pdf' | 'docx' | 'xlsx';

export async function exportReport(
  tenantId: string, companyId: string, reportId: string,
  format: FsExportFormat, versionNo: number | null, overrides: FsDraftOverrides = {},
): Promise<{ buffer: Buffer; fileName: string; mimeType: string }> {
  const report = await getReportRow(tenantId, companyId, reportId);
  const base = `${report.name.replace(/[^\w .-]+/g, '').trim() || 'financial-statements'}`;
  const mime = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }[format];
  if (versionNo !== null) {
    const v = await getVersion(tenantId, companyId, reportId, versionNo);
    const fileName = `${base} v${v.versionNo}.${format}`;
    if (format === 'pdf') {
      const provider = await getProviderForTenant(tenantId);
      return { buffer: await provider.download(v.pdfStorageKey), fileName, mimeType: mime };
    }
    const model = v.modelJson as FsRenderedReport;
    const style = fsStyleSchema.parse(v.styleJson);
    if (format === 'xlsx') return { buffer: await buildFsXlsx(model, style), fileName, mimeType: mime };
    return {
      buffer: await buildFsDocx({ report: model, style, frontMatter: fsFrontMatterSchema.parse(v.frontMatterJson), letterhead: v.letterheadJson as FsLetterhead | null, letter: v.letterJson as { title: string; bodyHtml: string } | null }),
      fileName, mimeType: mime,
    };
  }
  const draft = await computeDraft(tenantId, companyId, reportId, overrides);
  const fileName = `${base} (draft).${format}`;
  if (format === 'xlsx') return { buffer: await buildFsXlsx(draft.model, draft.style), fileName, mimeType: mime };
  const letterhead = letterheadOf(await library.getLetterhead(tenantId));
  const letter = await resolveLetter(tenantId, companyId, draft, draft.source);
  if (format === 'docx') {
    return { buffer: await buildFsDocx({ report: draft.model, style: draft.style, frontMatter: draft.frontMatter, letterhead, letter }), fileName, mimeType: mime };
  }
  const pdf = await renderFsPdf({ report: draft.model, style: draft.style, frontMatter: draft.frontMatter, letterhead, letter, draft: report.status !== 'final' });
  return { buffer: pdf.bytes, fileName, mimeType: mime };
}

// ─── Portal publish ────────────────────────────────────────────────

export async function publish(
  tenantId: string, companyId: string, reportId: string, versionNo: number,
  input: { title?: string; archivePrevious?: boolean },
  userId: string,
) {
  const report = await getReportRow(tenantId, companyId, reportId);
  const v = await getVersion(tenantId, companyId, reportId, versionNo);
  if (v.status !== 'final' || report.currentVersionId !== v.id) {
    throw AppError.badRequest('Only the current final version can be published.', 'TB_FS_NOT_CURRENT');
  }
  const model = v.modelJson as FsRenderedReport;
  // The portal gets its own copy: portal-side instance deletes clean up
  // their PDF, and the frozen original must never be touched.
  const provider = await getProviderForTenant(tenantId);
  const bytes = await provider.download(v.pdfStorageKey);
  const key = tenantStorageKey(tenantId, 'reports', 'fs', reportId, `v${v.versionNo}-portal-${Date.now()}.pdf`);
  await provider.upload(key, bytes, { fileName: `financial-statements-v${v.versionNo}.pdf`, mimeType: 'application/pdf', sizeBytes: bytes.length });
  const title = input.title?.trim() || report.name;

  return db.transaction(async (tx) => {
    if (input.archivePrevious !== false) {
      const priorVersionIds = (await tx.select({ id: fsReportVersions.id }).from(fsReportVersions).where(eq(fsReportVersions.reportId, reportId))).map((r) => r.id);
      if (priorVersionIds.length) {
        await tx.update(reportInstances).set({ status: 'archived' })
          .where(and(eq(reportInstances.tenantId, tenantId), eq(reportInstances.source, 'financial_statements'),
            eq(reportInstances.status, 'published'), inArray(reportInstances.fsReportVersionId, priorVersionIds)));
      }
    }
    const [inst] = await tx.insert(reportInstances).values({
      tenantId, companyId,
      periodStart: model.meta.fyStart, periodEnd: model.meta.periodEnd,
      status: 'published', layoutSnapshotJsonb: [], dataSnapshotJsonb: { kind: 'financial_statements', title },
      pdfUrl: key, version: v.versionNo, createdBy: userId, publishedAt: new Date(),
      source: 'financial_statements', fsReportVersionId: v.id,
    }).returning();
    await tx.update(fsReportVersions).set({ publishedInstanceId: inst!.id, publishedBy: userId, publishedAt: new Date() }).where(eq(fsReportVersions.id, v.id));
    await auditLog(tenantId, 'update', 'fs_report_publish', reportId, null, { versionNo: v.versionNo, instanceId: inst!.id, title }, userId, tx);
    return { instanceId: inst!.id };
  });
}

export async function unpublish(tenantId: string, companyId: string, reportId: string, versionNo: number, userId?: string) {
  const v = await getVersion(tenantId, companyId, reportId, versionNo);
  if (!v.publishedInstanceId) throw AppError.badRequest('This version is not published.', 'TB_FS_NOT_PUBLISHED');
  await db.transaction(async (tx) => {
    await tx.update(reportInstances).set({ status: 'archived' })
      .where(and(eq(reportInstances.id, v.publishedInstanceId!), eq(reportInstances.tenantId, tenantId)));
    await tx.update(fsReportVersions).set({ publishedAt: null, publishedBy: null, publishedInstanceId: null }).where(eq(fsReportVersions.id, v.id));
    await auditLog(tenantId, 'update', 'fs_report_unpublish', reportId, { instanceId: v.publishedInstanceId }, null, userId, tx);
  });
}

export async function listVersions(tenantId: string, companyId: string, reportId: string) {
  return db.select({
    versionNo: fsReportVersions.versionNo, status: fsReportVersions.status, finalizedAt: fsReportVersions.finalizedAt,
    publishedAt: fsReportVersions.publishedAt, pageCount: fsReportVersions.pageCount, validationOverride: fsReportVersions.validationOverride,
  }).from(fsReportVersions)
    .where(and(eq(fsReportVersions.tenantId, tenantId), eq(fsReportVersions.companyId, companyId), eq(fsReportVersions.reportId, reportId)))
    .orderBy(desc(fsReportVersions.versionNo));
}
