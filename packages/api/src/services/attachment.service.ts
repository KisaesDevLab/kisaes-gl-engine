// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import archiver from 'archiver';
import { eq, and, or, isNull, count, inArray, desc, sql, type SQL } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { attachments, systemSettings } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { tenantStorageKey } from './storage/storage-keys.js';
import { keyBelongsToTenant } from '../utils/contained-path.js';
import { SystemSettingsKeys } from '../constants/system-settings-keys.js';
import { isDesktop } from '../desktop/profile.js';

/**
 * Whether an upload may start OCR / AI processing on its own (U-89).
 *
 * - Desktop mode: never. AI runs only when the owner asks for it
 *   (POST /bills/extract-from-attachment/:id, POST /attachments/:id/ocr).
 * - Elsewhere: the `attachments.autoOcr` system setting; absent or any value
 *   other than 'false' / '0' keeps today's behavior (on).
 *
 * A caller can only turn it off further (POST /attachments?autoOcr=0); it
 * can never turn it on where this returns false.
 */
export async function autoOcrOnUploadAllowed(): Promise<boolean> {
  if (isDesktop()) return false;
  try {
    const row = await db.query.systemSettings.findFirst({
      where: eq(systemSettings.key, SystemSettingsKeys.ATTACHMENTS_AUTO_OCR),
    });
    const v = row?.value?.trim().toLowerCase();
    return !(v === 'false' || v === '0');
  } catch {
    // Settings unreadable: keep the server's historical default.
    return true;
  }
}

/**
 * The companies of the record(s) an attachment is filed on, as a SQL row
 * source with one column `company_id`: the transaction, contact (also a
 * W-9's vendor_1099_profile), daily-sales entry, tax entry, TB lead sheet
 * (grouping), Bill Capture, bank-feed item or portal receipt whose id is
 * `attachableId`. Matched by id in each table (ids are UUIDs, so at most one
 * table answers), which also covers every attachable type that names a
 * transaction. Contacts, transactions, daily-sales entries and feed items
 * may be tenant-wide (company NULL).
 */
function parentCompanyRows(tenantId: SQL | typeof attachments.tenantId | string, attachableId: SQL | typeof attachments.attachableId | string): SQL {
  return sql`SELECT company_id FROM transactions WHERE tenant_id = ${tenantId} AND id = ${attachableId}
    UNION ALL SELECT company_id FROM contacts WHERE tenant_id = ${tenantId} AND id = ${attachableId}
    UNION ALL SELECT company_id FROM daily_sales_entries WHERE tenant_id = ${tenantId} AND id = ${attachableId}
    UNION ALL SELECT company_id FROM tb_tax_entries WHERE tenant_id = ${tenantId} AND id = ${attachableId}
    UNION ALL SELECT company_id FROM tb_groupings WHERE tenant_id = ${tenantId} AND id = ${attachableId}
    UNION ALL SELECT company_id FROM bill_captures WHERE tenant_id = ${tenantId} AND id = ${attachableId}
    UNION ALL SELECT company_id FROM bank_feed_items WHERE tenant_id = ${tenantId} AND id = ${attachableId}
    UNION ALL SELECT company_id FROM portal_receipts WHERE tenant_id = ${tenantId} AND id = ${attachableId}`;
}

/**
 * U-90: which attachments a request working in `companyId` may see or
 * change. An attachment is visible when
 *   - it is stamped with that company, or
 *   - it has no company (tenant-wide files) AND the record it is filed on
 *     (parentCompanyRows: transaction, contact, daily-sales entry, tax
 *     entry, TB lead sheet, Bill Capture, feed item, portal receipt) is not
 *     another company's.
 * So an accountant excluded from company A (companyContext) can't list,
 * read, download, delete, OCR or link A's files from company B.
 *
 * Migration 0231 copies the parent's company onto existing rows, so the
 * fallback matters only for rows whose parent is tenant-wide or not there
 * (drafts, receipts, files of a deleted record): those stay tenant-wide.
 *
 * `companyId` absent (a caller with no company context, e.g. an internal
 * job): no extra filter — the tenant check still applies.
 */
export function companyScope(companyId: string | null | undefined): SQL | undefined {
  if (!companyId) return undefined;
  return or(
    eq(attachments.companyId, companyId),
    and(
      isNull(attachments.companyId),
      sql`NOT EXISTS (SELECT 1 FROM (${parentCompanyRows(attachments.tenantId, attachments.attachableId)}) att_parent
        WHERE att_parent.company_id IS NOT NULL
          AND att_parent.company_id <> ${companyId})`,
    ),
  );
}

// Attachable types that name a transaction (its txn_type): an upload or a
// link to one checks the transaction exists in the tenant (and company).
export const TXN_ATTACHABLE_TYPES = new Set([
  'invoice', 'customer_payment', 'cash_sale', 'expense', 'deposit', 'transfer', 'journal_entry',
  'credit_memo', 'customer_refund', 'bill', 'vendor_credit', 'bill_payment', 'daily_sales', 'aje', 'returned_payment',
]);

/**
 * U-90 review M3: the record a file is uploaded or linked to must be one the
 * request's company may use (404 otherwise, nothing written).
 *   - A transaction type (TXN_ATTACHABLE_TYPES): the transaction exists in
 *     the tenant with that type, is not deleted, and is tenant-wide or this
 *     company's.
 *   - Any other type (draft, receipt, contact, …): if `attachableId` names a
 *     record that has a company (parentCompanyRows), it is this company.
 * `companyId` absent: only the transaction existence check.
 */
export async function assertAttachTarget(
  tenantId: string, attachableType: unknown, attachableId: unknown, companyId?: string | null,
): Promise<void> {
  const isUuid = typeof attachableId === 'string' && UUID_RE.test(attachableId);
  if (typeof attachableType === 'string' && TXN_ATTACHABLE_TYPES.has(attachableType)) {
    const rows = isUuid
      ? (await db.execute(sql`SELECT company_id, status FROM transactions
          WHERE tenant_id = ${tenantId} AND id = ${attachableId} AND txn_type = ${attachableType} LIMIT 1`)).rows
      : [];
    const target = rows[0] as { company_id: string | null; status: string | null } | undefined;
    if (!target || target.status === 'deleted' || (companyId && target.company_id && target.company_id !== companyId)) {
      throw AppError.notFound('The transaction to attach to was not found');
    }
    return;
  }
  if (!companyId || !isUuid) return;
  const other = await db.execute(sql`SELECT 1 FROM (${parentCompanyRows(tenantId, attachableId as string)}) p
    WHERE p.company_id IS NOT NULL AND p.company_id <> ${companyId} LIMIT 1`);
  if (other.rows.length > 0) throw AppError.notFound('The record to attach to was not found');
}

/**
 * The company of the record `attachableId` names (parentCompanyRows), or
 * null when it has none or there is no such record.
 */
export async function parentCompanyId(tenantId: string, attachableId: string): Promise<string | null> {
  if (!UUID_RE.test(attachableId)) return null;
  const r = await db.execute(sql`SELECT company_id FROM (${parentCompanyRows(tenantId, attachableId)}) p
    WHERE p.company_id IS NOT NULL LIMIT 1`);
  return (r.rows[0] as { company_id: string } | undefined)?.company_id ?? null;
}

/**
 * U-90 review M4: when a file is filed somewhere in a company, record the
 * company on the row if it has none yet; a company already on the row wins.
 * Without `companyId`, the row is left as it is.
 */
function fillCompany(companyId: string | null | undefined) {
  return companyId ? { companyId: sql`coalesce(${attachments.companyId}, ${companyId}::uuid)` } : {};
}

function withScope(base: SQL | undefined, companyId: string | null | undefined): SQL | undefined {
  const scope = companyScope(companyId);
  return scope ? and(base, scope) : base;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Resolves a filePath (stored in the DB as "/uploads/<tenant>/attachments/<uuid>.ext",
// or "/uploads/attachments/<tenant>/<uuid>.ext" for pre-layout-change rows)
// to an absolute path under UPLOAD_DIR and refuses anything that escapes the
// root via "..", symlinks, or absolute overrides, or that names another
// tenant's folder (utils/contained-path.ts keyBelongsToTenant). A stored
// path is data (an imported archive can write one), never an instruction.
function resolveUploadPath(tenantId: string, filePath: string): string {
  const rel = filePath.replace(/^\/uploads\//, '');
  if (!keyBelongsToTenant(rel, tenantId)) throw AppError.notFound('File not found');
  const root = path.resolve(env.UPLOAD_DIR);
  const resolved = path.resolve(root, rel);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw AppError.notFound('File not found');
  }
  return resolved;
}

export async function upload(
  tenantId: string,
  file: { originalname: string; buffer: Buffer; mimetype: string; size: number },
  attachableType: string,
  attachableId: string,
  // Optional provenance. `uploadedByContactId` is set only by the PORTAL
  // (migration 0165) so the client can list back its own files without
  // seeing the firm's; `companyId` scopes the row when the caller knows it.
  // Both default to null, which is exactly what every staff caller wrote
  // before, so this is additive for them.
  // `skipAutoClassify` is for callers that run their own extraction on the
  // file (Bill Capture): the generic receipt-OCR/classifier must not also
  // fire and spend AI twice or route the bill into the receipts inbox.
  opts: { uploadedByContactId?: string | null; companyId?: string | null; skipAutoClassify?: boolean } = {},
) {
  if (file.size > env.MAX_FILE_SIZE_MB * 1024 * 1024) {
    throw AppError.badRequest(`File exceeds maximum size of ${env.MAX_FILE_SIZE_MB}MB`);
  }

  const ext = path.extname(file.originalname);
  const uuid = crypto.randomUUID();
  const storageKey = tenantStorageKey(tenantId, 'attachments', `${uuid}${ext}`);

  // Upload via storage provider (local or cloud)
  let providerFileId: string | undefined;
  let storageProviderName = 'local';
  try {
    const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
    const provider = await getProviderForTenant(tenantId);
    storageProviderName = provider.name;
    const result = await provider.upload(storageKey, file.buffer, {
      fileName: file.originalname, mimeType: file.mimetype, sizeBytes: file.size,
    });
    providerFileId = result.providerFileId;
  } catch {
    // Fallback to direct local write if provider resolution fails.
    // Mirror LocalProvider's layout (UPLOAD_DIR/<storageKey>) so the
    // stored key resolves the same file either way.
    const fallbackPath = path.join(env.UPLOAD_DIR, storageKey);
    ensureDir(path.dirname(fallbackPath));
    fs.writeFileSync(fallbackPath, file.buffer);
  }

  const [attachment] = await db.insert(attachments).values({
    tenantId,
    fileName: file.originalname,
    filePath: `/uploads/${storageKey}`,
    fileSize: file.size,
    mimeType: file.mimetype,
    attachableType,
    attachableId,
    uploadedByContactId: opts.uploadedByContactId ?? null,
    companyId: opts.companyId ?? null,
    storageKey,
    storageProvider: storageProviderName,
    providerFileId: providerFileId || null,
  }).returning();

  // Auto-trigger AI classification + OCR for images. Never in desktop mode
  // and never when the `attachments.autoOcr` setting is off (U-89).
  if (
    attachment && file.mimetype.startsWith('image/') && !opts.skipAutoClassify
    && await autoOcrOnUploadAllowed()
  ) {
    triggerAutoClassify(tenantId, attachment.id).catch(() => {});
  }

  return attachment;
}

async function triggerAutoClassify(tenantId: string, attachmentId: string) {
  try {
    const { getConfig } = await import('./ai-config.service.js');
    const config = await getConfig();
    if (!config.isEnabled || !config.autoOcrOnUpload) return;

    const { classifyAndRoute } = await import('./ai-document-classifier.service.js');
    await classifyAndRoute(tenantId, attachmentId);
  } catch {
    // AI processing is best-effort — don't fail the upload
  }
}

export async function list(tenantId: string, filters?: { attachableType?: string; attachableId?: string; limit?: number; offset?: number; companyId?: string | null }) {
  const conditions: SQL[] = [eq(attachments.tenantId, tenantId)];
  if (filters?.attachableType) conditions.push(eq(attachments.attachableType, filters.attachableType));
  if (filters?.attachableId) conditions.push(eq(attachments.attachableId, filters.attachableId));
  const scope = companyScope(filters?.companyId);
  if (scope) conditions.push(scope);

  const [data, total] = await Promise.all([
    db.select().from(attachments).where(and(...conditions))
      .limit(filters?.limit ?? 50).offset(filters?.offset ?? 0),
    db.select({ count: count() }).from(attachments).where(and(...conditions)),
  ]);

  return { data, total: total[0]?.count ?? 0 };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One attachment of the tenant. With `companyId` (U-90) it must also be
 * visible to that company (companyScope); otherwise 404, the same answer as
 * an id that does not exist.
 */
export async function getById(tenantId: string, id: string, companyId?: string | null) {
  if (!UUID_RE.test(id)) throw AppError.notFound('Attachment not found');
  const [attachment] = await db.select().from(attachments)
    .where(withScope(and(eq(attachments.tenantId, tenantId), eq(attachments.id, id)), companyId))
    .limit(1);
  if (!attachment) throw AppError.notFound('Attachment not found');
  return attachment;
}

export async function download(tenantId: string, id: string, companyId?: string | null) {
  const attachment = await getById(tenantId, id, companyId);

  // Use storage provider for download
  try {
    const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
    const provider = await getProviderForTenant(tenantId);
    const key = attachment.providerFileId || attachment.storageKey || attachment.filePath;
    if (!key) throw new Error('No storage key');
    const data = await provider.download(key);
    const { Readable } = await import('stream');
    return { stream: Readable.from(data), attachment };
  } catch {
    // Fallback to direct filesystem for backward compatibility
    const fullPath = resolveUploadPath(tenantId, attachment.filePath);
    if (!fs.existsSync(fullPath)) throw AppError.notFound('File not found');
    return { stream: fs.createReadStream(fullPath), attachment };
  }
}

// Fetch an attachment's raw bytes — provider-first with the same
// direct-filesystem fallback as download() above. Kept in lockstep with
// download(): storage key preference is providerFileId > storageKey >
// filePath, and any provider failure falls back to UPLOAD_DIR.
export async function readAttachmentBytes(
  tenantId: string,
  attachment: { providerFileId: string | null; storageKey: string | null; filePath: string },
): Promise<Buffer> {
  try {
    const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
    const provider = await getProviderForTenant(tenantId);
    const key = attachment.providerFileId || attachment.storageKey || attachment.filePath;
    if (!key) throw new Error('No storage key');
    return await provider.download(key);
  } catch {
    const fullPath = resolveUploadPath(tenantId, attachment.filePath);
    if (!fs.existsSync(fullPath)) throw AppError.notFound('File not found');
    return fs.readFileSync(fullPath);
  }
}

// Zip entry names must be unique or extractors silently overwrite; collide
// on "receipt.pdf" twice and the second becomes "receipt (1).pdf".
function zipEntryName(used: Set<string>, fileName: string | null): string {
  // Flatten path separators — entries are plain file names, never nested.
  const base = (fileName || 'file').replace(/[\\/]+/g, '_');
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export interface BulkDownloadSkipped {
  id: string;
  fileName: string;
  reason: string;
}

export interface BulkDownloadResult {
  archive: ReturnType<typeof archiver>;
  done: Promise<{ included: number; skipped: BulkDownloadSkipped[] }>;
}

/**
 * Build a ZIP of several attachments. Every id must belong to `tenantId`
 * (404 otherwise, matching the single-download behavior). Returns the
 * archiver stream (pipe it to the response before awaiting `done`) plus a
 * `done` promise that resolves once every entry has been appended and the
 * archive finalized. A file whose bytes can't be fetched never fails the
 * whole zip — it's recorded in `skipped` and listed in a manifest.txt entry.
 */
export async function bulkDownload(tenantId: string, attachmentIds: string[], companyId?: string | null): Promise<BulkDownloadResult> {
  const uniqueIds = Array.from(new Set(attachmentIds));
  const rows = await db.select().from(attachments)
    .where(withScope(and(eq(attachments.tenantId, tenantId), inArray(attachments.id, uniqueIds)), companyId));
  if (rows.length !== uniqueIds.length) throw AppError.notFound('Attachment not found');

  const archive = archiver('zip', { zlib: { level: 6 } });
  const skipped: BulkDownloadSkipped[] = [];

  // Total-bytes ceiling: each file is buffered before appending, and
  // archiver queues appends faster than a slow client drains them — an
  // unbounded selection of large scans can hold GBs in RAM per request.
  // Files past the cap are recorded in the manifest, never silently lost.
  const BULK_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024; // 1 GB
  let totalBytes = 0;
  // Count appended entries, NOT bytes — a legitimately zero-byte first file
  // must still arm the cap for everything after it (a byte counter stays 0).
  let appendedCount = 0;

  const done = (async () => {
    const usedNames = new Set<string>();
    for (const att of rows) {
      try {
        // Pre-check with the stored size so the file that would CROSS the
        // cap is skipped before buffering. Only once something is ALREADY in
        // the archive — never pre-skip the first file on a possibly stale
        // fileSize, or a single legitimately-requested file could be dropped
        // for a metadata value that no longer reflects reality; the post-read
        // backstop still bounds actual memory in that case.
        const expected = Number(att.fileSize ?? 0);
        if (appendedCount > 0 && totalBytes + expected > BULK_DOWNLOAD_MAX_BYTES) {
          skipped.push({ id: att.id, fileName: att.fileName || att.id, reason: 'total size cap (1 GB) reached — download in smaller batches' });
          continue;
        }
        const bytes = await readAttachmentBytes(tenantId, att);
        // Post-read backstop: overflow only when something already made it in
        // (a lone oversized file is still delivered rather than yielding an
        // empty ZIP).
        if (appendedCount > 0 && totalBytes + bytes.length > BULK_DOWNLOAD_MAX_BYTES) {
          skipped.push({ id: att.id, fileName: att.fileName || att.id, reason: 'total size cap (1 GB) reached — download in smaller batches' });
          continue;
        }
        totalBytes += bytes.length;
        appendedCount += 1;
        archive.append(bytes, { name: zipEntryName(usedNames, att.fileName) });
      } catch (err) {
        skipped.push({
          id: att.id,
          fileName: att.fileName || att.id,
          reason: err instanceof Error ? err.message : 'File could not be read',
        });
      }
    }
    if (skipped.length > 0) {
      const lines = [
        'Some files could not be included in this archive:',
        '',
        ...skipped.map((s) => `- ${s.fileName} (${s.id}): ${s.reason}`),
      ];
      archive.append(Buffer.from(lines.join('\n') + '\n', 'utf8'), { name: 'manifest.txt' });
    }
    await archive.finalize();
    return { included: rows.length - skipped.length, skipped };
  })();

  return { archive, done };
}

/** Test hooks: only honoured when NODE_ENV is 'test'. */
export const __attachmentTestHooks: {
  /** Inside remove()'s transaction, after the row lock and the live-draft check, before the row is deleted. */
  afterInUseCheck?: (info: { attachmentId: string }) => void | Promise<void>;
  /** Inside a draft-key relink (U-95 guard), after the key's rows are locked, before the live drafts are read. */
  afterKeyLock?: (info: { draftKey: string; attachmentIds: string[] }) => void | Promise<void>;
  /** Inside linkAttachment()'s transaction, after the row lock, before the live-draft check. */
  afterLinkLock?: (info: { attachmentId: string }) => void | Promise<void>;
} = {};

const testHook = <K extends keyof typeof __attachmentTestHooks>(k: K) =>
  (process.env['NODE_ENV'] === 'test' ? __attachmentTestHooks[k] : undefined);

/** Document draft statuses that still read their file (U-92: new, ready, failed). */
const LIVE_DRAFT_STATUSES_SQL = sql`('new', 'ready', 'failed')`;

/**
 * U-95 guard (review M2): the ids among `attachmentIds` (files on draft key
 * `draftKey`) that a live document draft of the tenant reads, other than
 * `exceptDraftId` (the draft that is itself converting or attaching). Run it
 * after the rows are locked FOR UPDATE: a claim locks the same row first, so
 * a claim either committed before (and this statement, a fresh READ
 * COMMITTED snapshot, sees it) or waits and then finds the file moved.
 */
export async function liveDraftFileIds(
  exec: DbOrTx, tenantId: string, draftKey: string, exceptDraftId?: string | null,
  attachmentIds?: readonly string[],
): Promise<string[]> {
  if (attachmentIds && attachmentIds.length === 0) return [];
  const r = await exec.execute(sql`SELECT DISTINCT d.attachment_id FROM document_drafts d
    WHERE d.tenant_id = ${tenantId} AND d.attachment_id IS NOT NULL
      AND d.status IN ${LIVE_DRAFT_STATUSES_SQL}
      ${exceptDraftId ? sql`AND d.id <> ${exceptDraftId}` : sql``}
      AND d.attachment_id IN (SELECT a.id FROM attachments a
        WHERE a.tenant_id = ${tenantId} AND a.attachable_type = 'draft' AND a.attachable_id = ${draftKey})
      ${attachmentIds ? sql`AND d.attachment_id IN (${sql.join(attachmentIds.map((id) => sql`${id}`), sql`, `)})` : sql``}`);
  return (r.rows as Array<{ attachment_id: string }>).map((x) => x.attachment_id);
}

/** Options of the draft-key relinks (U-95 guard). */
export interface DraftRelinkGuard {
  /** The document draft doing the relink (convert, attach): its own file moves. Plain callers pass none. */
  exceptDraftId?: string | null;
}

/**
 * Moves the files on draft key `draftKey` to (`newType`, `newId`) on `tx`,
 * except the ones a live document draft other than `guard.exceptDraftId`
 * reads (U-95, review M2): those stay on the key, so the draft can still be
 * converted with its file. The key's rows are locked FOR UPDATE, the live
 * drafts read in the next statement, then exactly the locked rows minus
 * those are updated. Returns the moved ids.
 */
async function moveDraftKeyFiles(
  tx: Tx, tenantId: string, draftKey: string, newType: string, newId: string,
  companyId: string | null | undefined, guard: DraftRelinkGuard,
): Promise<string[]> {
  const locked = await tx.select({ id: attachments.id }).from(attachments)
    .where(and(
      eq(attachments.tenantId, tenantId),
      eq(attachments.attachableType, 'draft'),
      eq(attachments.attachableId, draftKey),
      ...(companyId ? [or(isNull(attachments.companyId), eq(attachments.companyId, companyId))] : []),
    ))
    .orderBy(attachments.id)
    .for('update');
  const lockedIds = locked.map((r) => r.id);
  if (lockedIds.length === 0) return [];
  const hook = testHook('afterKeyLock');
  if (hook) await hook({ draftKey, attachmentIds: lockedIds });
  const inUse = new Set(await liveDraftFileIds(tx, tenantId, draftKey, guard.exceptDraftId, lockedIds));
  const moving = lockedIds.filter((id) => !inUse.has(id));
  if (moving.length === 0) return [];
  const rows = await tx.update(attachments)
    .set({ attachableType: newType, attachableId: newId, ...fillCompany(companyId) })
    .where(and(eq(attachments.tenantId, tenantId), inArray(attachments.id, moving)))
    .returning({ id: attachments.id });
  return rows.map((r) => r.id);
}

/** A locked attachment row of a document draft's file (lockDraftFile). */
export interface LockedDraftFile {
  attachableType: string;
  attachableId: string;
  companyId: string | null;
}

/**
 * Locks a document draft's file on `tx` for a convert or an attach (U-95,
 * review L-3). When the file is on a draft key, every row of that key is
 * locked first, in id order (the order moveDraftKeyFiles locks them), and
 * the file is read from that locked set; so two drafts of one key that
 * convert or attach at once lock the same rows in the same order and never
 * deadlock. A file that is not (or no longer) on a draft key is locked
 * alone. Undefined when the file is gone.
 */
export async function lockDraftFile(tx: Tx, tenantId: string, attachmentId: string): Promise<LockedDraftFile | undefined> {
  const peek = await tx.select({ attachableType: attachments.attachableType, attachableId: attachments.attachableId })
    .from(attachments)
    .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)));
  const seen = peek[0];
  if (seen && seen.attachableType === 'draft') {
    const keyRows = await tx.select({
      id: attachments.id, attachableType: attachments.attachableType, attachableId: attachments.attachableId, companyId: attachments.companyId,
    }).from(attachments)
      .where(and(eq(attachments.tenantId, tenantId), eq(attachments.attachableType, 'draft'), eq(attachments.attachableId, seen.attachableId)))
      .orderBy(attachments.id)
      .for('update');
    const own = keyRows.find((r) => r.id === attachmentId);
    if (own) return { attachableType: own.attachableType, attachableId: own.attachableId, companyId: own.companyId };
    // Moved off the key between the read and the lock: lock it where it is now.
  }
  const [row] = await tx.select({
    attachableType: attachments.attachableType, attachableId: attachments.attachableId, companyId: attachments.companyId,
  }).from(attachments)
    .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)))
    .for('update');
  return row;
}

/** Whether `executor` is the pool (else it is a transaction). */
function isPool(executor: DbOrTx): executor is typeof db {
  return executor === db;
}

/** Runs `fn` on `executor` when it is a transaction, else in a new one (row locks need a transaction). */
function inTx<T>(executor: DbOrTx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return isPool(executor) ? db.transaction(fn) : fn(executor);
}

/**
 * Deletes an attachment: the row, then storage. One transaction locks the
 * row (FOR UPDATE), checks for a live document draft and deletes the row; a
 * claim (POST /document-drafts) locks the same row, so the two run one after
 * the other. A file a live draft of the company reads (U-92: status new,
 * ready or failed) is 409 ATTACHMENT_IN_USE with details.draftId and nothing
 * is deleted; discard the draft first. A converted or discarded draft's file
 * is deleted as usual and the draft's link is nulled (ON DELETE SET NULL);
 * the draft keeps its content hash, so the file stays claimed. A row another
 * table still requires (bill_captures, ON DELETE RESTRICT) fails the delete
 * and leaves the file in storage. Storage is deleted only after the commit,
 * best effort: a failure leaves an orphaned file, never a row without one.
 */
export async function remove(tenantId: string, id: string, companyId?: string | null) {
  await getById(tenantId, id, companyId);
  const attachment = await db.transaction(async (tx) => {
    const [row] = await tx.select().from(attachments)
      .where(withScope(and(eq(attachments.tenantId, tenantId), eq(attachments.id, id)), companyId))
      .for('update');
    if (!row) throw AppError.notFound('Attachment not found');
    const draftCompany = companyId ?? row.companyId;
    const inUse = await tx.execute(sql`SELECT id FROM document_drafts
      WHERE tenant_id = ${tenantId} AND attachment_id = ${row.id} AND status IN ('new', 'ready', 'failed')
      ${draftCompany ? sql`AND company_id = ${draftCompany}` : sql``}
      LIMIT 1`);
    const draftId = (inUse.rows[0] as { id: string } | undefined)?.id;
    if (draftId) {
      throw AppError.conflict('This file is being read as a document. Discard the document first.', 'ATTACHMENT_IN_USE', { draftId });
    }
    const hook = process.env['NODE_ENV'] === 'test' ? __attachmentTestHooks.afterInUseCheck : undefined;
    if (hook) await hook({ attachmentId: row.id });
    await tx.delete(attachments).where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, row.id)));
    return row;
  });

  // Storage after the commit, best effort (use the storage provider first).
  try {
    const { getProviderForTenant } = await import('./storage/storage-provider.factory.js');
    const provider = await getProviderForTenant(tenantId);
    const key = attachment.providerFileId || attachment.storageKey || attachment.filePath;
    if (key) await provider.delete(key);
  } catch {
    // Fallback to direct filesystem
    try {
      const fullPath = resolveUploadPath(tenantId, attachment.filePath);
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    } catch {
      // Path didn't resolve under UPLOAD_DIR — the row is already gone, so
      // a poisoned filePath can't block attachment cleanup.
    }
  }
}

export async function updateOcrResults(tenantId: string, id: string, results: {
  ocrStatus: string; ocrVendor?: string; ocrDate?: string; ocrTotal?: string; ocrTax?: string;
}) {
  await db.update(attachments).set(results)
    .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, id)));
}

/**
 * Moves a draft's attachments onto a new document. `companyId` (U-90): a
 * draft file stamped with another company is left alone. A file a live
 * document draft reads (other than `guard.exceptDraftId`) stays on the
 * draft key (U-95, review M2). Given `db`, it runs in its own transaction
 * (the guard locks the key's rows).
 */
export async function reassignDraftAttachments(
  tenantId: string, draftId: string, newType: string, newId: string, executor: DbOrTx = db,
  companyId?: string | null, guard: DraftRelinkGuard = {},
): Promise<number> {
  const moved = await inTx(executor, (tx) => moveDraftKeyFiles(tx, tenantId, draftId, newType, newId, companyId, guard));
  return moved.length;
}

/**
 * Relinks a draft's attachments to a document on the caller's executor (a
 * posting's own transaction, so the document and its files commit
 * together), with one audit row per attachment (`update` / `attachment`,
 * before `{attachableType: 'draft', attachableId: draftId}`, after the new
 * link). Returns the relinked attachment ids.
 *
 * `companyId` (the request's company, review M3): a draft attachment stamped
 * with another company is left alone; tenant-wide ones (company null, every
 * upload today) are relinked.
 *
 * Files a live document draft reads stay on the draft key (U-92 review
 * L-8, U-95 review M2), except the files of `guard.exceptDraftId`: convert
 * and attach pass their own draft, plain callers pass none. Given `db`, it
 * runs in its own transaction (the guard locks the key's rows).
 */
export async function relinkDraftAttachments(
  executor: DbOrTx,
  tenantId: string,
  draftId: string,
  newType: string,
  newId: string,
  userId?: string,
  companyId?: string | null,
  guard: DraftRelinkGuard = {},
): Promise<string[]> {
  return inTx(executor, async (tx) => {
    const ids = await moveDraftKeyFiles(tx, tenantId, draftId, newType, newId, companyId, guard);
    for (const id of ids) {
      await auditLog(tenantId, 'update', 'attachment', id,
        { attachableType: 'draft', attachableId: draftId },
        { attachableType: newType, attachableId: newId },
        userId, tx);
    }
    return ids;
  });
}

export async function listUnlinked(tenantId: string, companyId?: string | null) {
  return db.select().from(attachments)
    .where(withScope(and(
      eq(attachments.tenantId, tenantId),
      inArray(attachments.attachableType, ['draft', 'receipt']),
    ), companyId))
    .orderBy(desc(attachments.createdAt))
    .limit(50);
}

/**
 * Files an attachment on (`newType`, `newId`). One transaction locks the row
 * (FOR UPDATE, within companyScope, else 404), refuses a file a live
 * document draft of the company reads with 409 ATTACHMENT_IN_USE
 * (details.draftId; U-95, review M2: attach the draft with POST
 * /document-drafts/:id/attach or discard it first), then updates it. A claim
 * locks the same row, so the two run one after the other.
 */
export async function linkAttachment(
  tenantId: string, attachmentId: string, newType: string, newId: string, companyId?: string | null,
) {
  if (!UUID_RE.test(attachmentId)) throw AppError.notFound('Attachment not found');
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(attachments)
      .where(withScope(and(eq(attachments.tenantId, tenantId), eq(attachments.id, attachmentId)), companyId))
      .for('update');
    if (!row) throw AppError.notFound('Attachment not found');
    const hook = testHook('afterLinkLock');
    if (hook) await hook({ attachmentId: row.id });
    const draftCompany = companyId ?? row.companyId;
    const inUse = await tx.execute(sql`SELECT id FROM document_drafts
      WHERE tenant_id = ${tenantId} AND attachment_id = ${row.id} AND status IN ${LIVE_DRAFT_STATUSES_SQL}
      ${draftCompany ? sql`AND company_id = ${draftCompany}` : sql``}
      LIMIT 1`);
    const draftId = (inUse.rows[0] as { id: string } | undefined)?.id;
    if (draftId) {
      throw AppError.conflict('This file is being read as a document. Enter or attach the document, or discard it first.', 'ATTACHMENT_IN_USE', { draftId });
    }
    // The row already passed companyScope; fillCompany keeps a company it has.
    await tx.update(attachments)
      .set({ attachableType: newType, attachableId: newId, ...fillCompany(companyId) })
      .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, row.id)));
    return row;
  });
}
