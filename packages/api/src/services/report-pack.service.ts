// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report Packs — pack CRUD, run creation, and transient-artifact reads.
// Tenant-scoped and audit-logged. Company is pinned on the pack.

import { and, eq, isNull, asc, desc, sql } from 'drizzle-orm';
import {
  PACK_MAX_COUNT,
  getReportDef,
  resolvePreset,
  reportPackItemOptionsSchema,
  type PeriodPreset,
  type ReportPackItemOptions,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { reportPacks, reportPackItems, reportPackRuns } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { enqueueReportPack } from './extraction/queue.js';
import { getProviderForTenant } from './storage/storage-provider.factory.js';
import { tenantStorageKey } from './storage/storage-keys.js';

// Transient PDF artifacts live for 60 minutes after a successful render.
const ARTIFACT_TTL_MS = 60 * 60 * 1000;

// How long to wait for the Redis queue to accept a job before falling back to
// inline generation. A healthy local Redis enqueues in well under this.
const ENQUEUE_TIMEOUT_MS = 2500;

export interface PackItemInput {
  reportId: string;
  options?: ReportPackItemOptions;
}

export interface CreatePackInput {
  name: string;
  description?: string | null;
  periodPreset?: PeriodPreset;
  customRangeStart?: string | null;
  customRangeEnd?: string | null;
  asOfMode?: 'range-end' | 'custom';
  asOfCustom?: string | null;
  defaultBasis?: 'accrual' | 'cash';
  defaultTagId?: string | null;
  coverPage?: boolean;
  toc?: boolean;
  pageNumbers?: boolean;
  pageFooter?: string | null;
  filenameTemplate?: string;
  onError?: 'skip' | 'fail';
  /** Optional SSARS-21 engagement letter rendered as the first pack section. */
  letterId?: string | null;
  items: PackItemInput[];
}

export type UpdatePackInput = CreatePackInput;

export interface CreateRunInput {
  rangeStart?: string;
  rangeEnd?: string;
  asOfDate?: string;
}

type PackRow = typeof reportPacks.$inferSelect;
type PackItemRow = typeof reportPackItems.$inferSelect;
type PackRunRow = typeof reportPackRuns.$inferSelect;

/** Validate + normalize incoming pack items (membership, options, cap). */
function normalizeItems(items: PackItemInput[]): Array<{ reportId: string; options: ReportPackItemOptions }> {
  if (items.length > PACK_MAX_COUNT) {
    throw AppError.badRequest(`A report pack can contain at most ${PACK_MAX_COUNT} reports`, 'PACK_TOO_MANY_ITEMS');
  }
  return items.map((item) => {
    if (!getReportDef(item.reportId)) {
      throw AppError.badRequest(`Unknown report id: ${item.reportId}`, 'PACK_UNKNOWN_REPORT');
    }
    return { reportId: item.reportId, options: reportPackItemOptionsSchema.parse(item.options ?? {}) };
  });
}

export async function listPacks(
  tenantId: string,
  companyId: string,
): Promise<Array<PackRow & { itemCount: number }>> {
  const rows = await db
    .select({
      pack: reportPacks,
      itemCount: sql<number>`count(${reportPackItems.id})::int`,
    })
    .from(reportPacks)
    .leftJoin(reportPackItems, eq(reportPackItems.packId, reportPacks.id))
    .where(and(
      eq(reportPacks.tenantId, tenantId),
      eq(reportPacks.companyId, companyId),
      isNull(reportPacks.deletedAt),
    ))
    .groupBy(reportPacks.id)
    .orderBy(desc(reportPacks.updatedAt));
  return rows.map((r) => ({ ...r.pack, itemCount: r.itemCount }));
}

async function loadPackOrThrow(tenantId: string, id: string): Promise<PackRow> {
  const pack = await db.query.reportPacks.findFirst({
    where: and(eq(reportPacks.id, id), eq(reportPacks.tenantId, tenantId), isNull(reportPacks.deletedAt)),
  });
  if (!pack) throw AppError.notFound('Report pack not found');
  return pack;
}

export async function getPack(
  tenantId: string,
  id: string,
): Promise<PackRow & { items: PackItemRow[] }> {
  const pack = await loadPackOrThrow(tenantId, id);
  const items = await db.select().from(reportPackItems)
    .where(eq(reportPackItems.packId, id))
    .orderBy(asc(reportPackItems.sortOrder));
  return { ...pack, items };
}

function packValues(companyId: string, input: CreatePackInput) {
  return {
    companyId,
    name: input.name,
    description: input.description ?? null,
    periodPreset: input.periodPreset ?? 'this-month',
    customRangeStart: input.customRangeStart ?? null,
    customRangeEnd: input.customRangeEnd ?? null,
    asOfMode: input.asOfMode ?? 'range-end',
    asOfCustom: input.asOfCustom ?? null,
    defaultBasis: input.defaultBasis ?? 'accrual',
    defaultTagId: input.defaultTagId ?? null,
    coverPage: input.coverPage ?? true,
    toc: input.toc ?? true,
    pageNumbers: input.pageNumbers ?? true,
    pageFooter: (input.pageFooter && input.pageFooter.trim()) ? input.pageFooter.trim() : null,
    filenameTemplate: input.filenameTemplate ?? '{pack}-{date}',
    onError: input.onError ?? 'skip',
    letterId: input.letterId ?? null,
  };
}

async function insertItems(packId: string, items: Array<{ reportId: string; options: ReportPackItemOptions }>): Promise<void> {
  if (items.length === 0) return;
  await db.insert(reportPackItems).values(
    items.map((it, i) => ({ packId, sortOrder: i, reportId: it.reportId, optionsJson: it.options })),
  );
}

export async function createPack(
  tenantId: string,
  companyId: string,
  userId: string,
  input: CreatePackInput,
): Promise<PackRow & { items: PackItemRow[] }> {
  const items = normalizeItems(input.items);
  const [pack] = await db.insert(reportPacks).values({
    tenantId,
    createdBy: userId,
    ...packValues(companyId, input),
  }).returning();
  await insertItems(pack!.id, items);
  await auditLog(tenantId, 'create', 'report_pack', pack!.id, null, pack, userId);
  return getPack(tenantId, pack!.id);
}

export async function updatePack(
  tenantId: string,
  id: string,
  userId: string,
  input: UpdatePackInput,
): Promise<PackRow & { items: PackItemRow[] }> {
  const before = await loadPackOrThrow(tenantId, id);
  const items = normalizeItems(input.items);
  const [updated] = await db.update(reportPacks)
    .set({ ...packValues(before.companyId, input), updatedAt: new Date() })
    .where(and(eq(reportPacks.id, id), eq(reportPacks.tenantId, tenantId)))
    .returning();
  // Replace items (reorder) — delete then re-insert in the new order.
  await db.delete(reportPackItems).where(eq(reportPackItems.packId, id));
  await insertItems(id, items);
  await auditLog(tenantId, 'update', 'report_pack', id, before, updated, userId);
  return getPack(tenantId, id);
}

export async function softDeletePack(tenantId: string, id: string, userId: string): Promise<void> {
  const before = await loadPackOrThrow(tenantId, id);
  await db.update(reportPacks)
    .set({ deletedAt: new Date() })
    .where(and(eq(reportPacks.id, id), eq(reportPacks.tenantId, tenantId)));
  await auditLog(tenantId, 'delete', 'report_pack', id, before, null, userId);
}

export async function duplicatePack(
  tenantId: string,
  id: string,
  userId: string,
): Promise<PackRow & { items: PackItemRow[] }> {
  const source = await getPack(tenantId, id);
  const [pack] = await db.insert(reportPacks).values({
    tenantId,
    createdBy: userId,
    companyId: source.companyId,
    name: `${source.name} (copy)`,
    description: source.description,
    periodPreset: source.periodPreset,
    customRangeStart: source.customRangeStart,
    customRangeEnd: source.customRangeEnd,
    asOfMode: source.asOfMode,
    asOfCustom: source.asOfCustom,
    defaultBasis: source.defaultBasis,
    defaultTagId: source.defaultTagId,
    coverPage: source.coverPage,
    toc: source.toc,
    pageNumbers: source.pageNumbers,
    pageFooter: source.pageFooter,
    filenameTemplate: source.filenameTemplate,
    onError: source.onError,
    letterId: source.letterId,
  }).returning();
  if (source.items.length > 0) {
    await db.insert(reportPackItems).values(
      source.items.map((it) => ({
        packId: pack!.id,
        sortOrder: it.sortOrder,
        reportId: it.reportId,
        optionsJson: it.optionsJson,
      })),
    );
  }
  await auditLog(tenantId, 'create', 'report_pack', pack!.id, null, pack, userId);
  return getPack(tenantId, pack!.id);
}

/** Resolve the concrete {rangeStart,rangeEnd,asOfDate} a run will use. */
function resolveRunDates(pack: PackRow, input: CreateRunInput): { rangeStart: string; rangeEnd: string; asOfDate: string } {
  let rangeStart = input.rangeStart;
  let rangeEnd = input.rangeEnd;
  if (!rangeStart || !rangeEnd) {
    if (pack.periodPreset === 'custom') {
      rangeStart = rangeStart ?? pack.customRangeStart ?? '';
      rangeEnd = rangeEnd ?? pack.customRangeEnd ?? '';
    } else {
      const resolved = resolvePreset(pack.periodPreset as PeriodPreset);
      rangeStart = rangeStart ?? resolved.start;
      rangeEnd = rangeEnd ?? resolved.end;
    }
  }
  if (!rangeStart || !rangeEnd) {
    throw AppError.badRequest('Report pack has no resolvable date range; supply rangeStart/rangeEnd', 'PACK_NO_RANGE');
  }
  const asOfDate = input.asOfDate
    ?? (pack.asOfMode === 'custom' ? (pack.asOfCustom ?? rangeEnd) : rangeEnd);
  return { rangeStart, rangeEnd, asOfDate };
}

export async function createRun(
  tenantId: string,
  companyId: string,
  packId: string,
  userId: string,
  input: CreateRunInput,
): Promise<PackRunRow> {
  const pack = await loadPackOrThrow(tenantId, packId);
  const { rangeStart, rangeEnd, asOfDate } = resolveRunDates(pack, input);
  const [run] = await db.insert(reportPackRuns).values({
    packId,
    tenantId,
    companyId,
    rangeStart,
    rangeEnd,
    asOfDate,
    status: 'queued',
    progress: 0,
  }).returning();
  // Prefer the background worker (Redis-backed queue) so the heavy multi-render
  // stays off the request path. But appliance deployments may not run a
  // separate worker/Redis — if the queue can't be reached within a short
  // window, fall back to generating inline in THIS API process (fire-and-
  // forget; the client polls run status) so the run still completes instead of
  // dead-ending on "worker/Redis unavailable".
  let queued = false;
  try {
    await Promise.race([
      enqueueReportPack({ runId: run!.id, tenantId }),
      new Promise((_, reject) => {
        const t = setTimeout(() => reject(new Error('enqueue timeout')), ENQUEUE_TIMEOUT_MS);
        t.unref?.();
      }),
    ]);
    queued = true;
  } catch (err) {
    console.warn(`[report-pack] queue unavailable for run ${run!.id}; generating inline:`, err instanceof Error ? err.message : err);
  }
  if (!queued) {
    void (async () => {
      try {
        const { generateReportPackRun } = await import('./report-pack-generate.service.js');
        await generateReportPackRun(run!.id);
      } catch (genErr) {
        // generateReportPackRun marks the run failed on throw; log for ops.
        console.error(`[report-pack] inline generation failed for run ${run!.id}:`, genErr);
      }
    })();
  }
  await auditLog(tenantId, 'create', 'report_pack_run', run!.id, null, run, userId);
  return run!;
}

export async function getRun(tenantId: string, runId: string): Promise<PackRunRow> {
  const run = await db.query.reportPackRuns.findFirst({
    where: and(eq(reportPackRuns.id, runId), eq(reportPackRuns.tenantId, tenantId)),
  });
  if (!run) throw AppError.notFound('Report pack run not found');
  return run;
}

function sanitizeFilenamePart(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'report-pack';
}

/** Read the transient PDF for download. Throws 410 if expired/swept. */
export async function readRunArtifact(
  tenantId: string,
  runId: string,
): Promise<{ buffer: Buffer; filename: string; pageCount: number | null }> {
  const run = await getRun(tenantId, runId);
  if (run.status !== 'succeeded' && run.status !== 'partial') {
    throw AppError.badRequest(`Report pack run is not ready (status: ${run.status})`, 'PACK_RUN_NOT_READY');
  }
  if (!run.transientKey || !run.expiresAt || run.expiresAt.getTime() <= Date.now()) {
    throw new AppError(410, 'Report pack PDF has expired; regenerate it', 'PACK_ARTIFACT_EXPIRED');
  }
  const pack = await db.query.reportPacks.findFirst({ where: eq(reportPacks.id, run.packId) });
  const provider = await getProviderForTenant(tenantId);
  const buffer = await provider.download(run.transientKey);
  const packName = sanitizeFilenamePart(pack?.name ?? 'report-pack');
  const template = pack?.filenameTemplate ?? '{pack}-{date}';
  const filename = `${template
    .replace(/\{pack\}/g, packName)
    .replace(/\{date\}/g, run.rangeEnd ?? run.asOfDate ?? '')}`
    .replace(/[^A-Za-z0-9._-]+/g, '_') + '.pdf';
  return { buffer, filename, pageCount: run.pageCount };
}

/** Storage key for a run's transient artifact (shared with the worker). */
export function reportPackArtifactKey(tenantId: string, runId: string): string {
  return tenantStorageKey(tenantId, 'reports', 'packs', 'transient', `${runId}.pdf`);
}

export { ARTIFACT_TTL_MS };
