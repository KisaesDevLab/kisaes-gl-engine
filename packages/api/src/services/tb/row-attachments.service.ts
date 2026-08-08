// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Per-row leadsheet PDF attachments. Each upload takes an immutable
// ref code — the leadsheet's code plus a per-(company, taxYear,
// grouping) sequence, zero-padded (A001, A002, B001) — unique per
// company + tax year. File bytes ride the polymorphic attachments
// table (attachable_type 'tb_leadsheet'); this table adds the TB
// dimensions. Tickmark annotations are DATA ({page, xPct, yPct,
// symbol, color, note}) burned onto the PDF only when the file is
// served, so the stored original stays pristine and stamps remain
// removable forever.

import { randomUUID } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  accounts, attachments, tbGroupings, tbRowAttachments, tbTickmarks,
} from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import * as attachmentService from '../attachment.service.js';

export interface RowAttachmentAnnotation {
  id: string;
  page: number;   // 1-based
  xPct: number;   // 0..1 from left
  yPct: number;   // 0..1 from TOP (converted to PDF bottom-origin at stamp time)
  symbol: string;
  color: string | null;
  note: string | null;
}

// Chip tones map to print colors for the burn-in.
const STAMP_COLORS: Record<string, [number, number, number]> = {
  gray: [0.35, 0.35, 0.35],
  green: [0.09, 0.55, 0.27],
  blue: [0.12, 0.38, 0.85],
  purple: [0.49, 0.23, 0.83],
  yellow: [0.79, 0.5, 0.05],
  red: [0.86, 0.15, 0.15],
};

async function loadGrouping(tenantId: string, companyId: string, groupingId: string) {
  const [g] = await db.select().from(tbGroupings)
    .where(and(eq(tbGroupings.id, groupingId), eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)))
    .limit(1);
  if (!g) throw AppError.notFound('Leadsheet grouping not found');
  return g;
}

export async function attachRowPdf(
  tenantId: string,
  companyId: string,
  input: { groupingId: string; accountId: string; taxYear: number; filename: string; buffer: Buffer },
  userId?: string,
) {
  const grouping = await loadGrouping(tenantId, companyId, input.groupingId);
  const [acct] = await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.companyId, companyId), eq(accounts.id, input.accountId)))
    .limit(1);
  if (!acct) throw AppError.notFound('Account not found');

  const prefix = (grouping.leadsheetCode ?? 'LS').toUpperCase();

  // Ref code allocation with unique-index retry (same 23505 pattern as
  // the RJE numbering) — two concurrent uploads can't share a code.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [latest] = await db.select({ refCode: tbRowAttachments.refCode }).from(tbRowAttachments)
      .where(and(
        eq(tbRowAttachments.companyId, companyId),
        eq(tbRowAttachments.taxYear, input.taxYear),
        eq(tbRowAttachments.groupingId, input.groupingId),
      ))
      .orderBy(desc(tbRowAttachments.createdAt));
    const lastN = latest?.refCode?.startsWith(prefix)
      ? Number.parseInt(latest.refCode.slice(prefix.length), 10) || 0
      : 0;
    const refCode = `${prefix}${String(lastN + 1).padStart(3, '0')}`;

    // Store the file first (size/MIME checks, UUID filename, provider
    // upload, audit) under the ref-code display name.
    const uploaded = await attachmentService.upload(tenantId, {
      originalname: `${refCode}.pdf`,
      mimetype: 'application/pdf',
      buffer: input.buffer,
      size: input.buffer.length,
    }, 'tb_leadsheet', input.groupingId);
    if (!uploaded) throw AppError.internal('Attachment upload failed');

    try {
      const [row] = await db.insert(tbRowAttachments).values({
        tenantId, companyId,
        groupingId: input.groupingId,
        accountId: input.accountId,
        taxYear: input.taxYear,
        refCode,
        attachmentId: uploaded.id,
        sourceFileName: input.filename,
        createdBy: userId ?? null,
      }).returning();
      await auditLog(tenantId, 'create', 'tb_row_attachment', row!.id, null,
        { refCode, groupingId: input.groupingId, accountId: input.accountId, taxYear: input.taxYear, sourceFileName: input.filename }, userId);
      return { ...row!, fileName: `${refCode}.pdf`, fileSize: input.buffer.length };
    } catch (err) {
      // Undo the stored file, then retry on a ref-code race.
      await attachmentService.remove(tenantId, uploaded.id).catch(() => undefined);
      if ((err as { code?: string }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') {
        continue;
      }
      throw err;
    }
  }
  throw AppError.conflict('Could not allocate an attachment reference — try again', 'TB_REF_RACE');
}

export async function listRowAttachments(tenantId: string, companyId: string, taxYear: number) {
  const rows = await db.select({
    r: tbRowAttachments,
    fileName: attachments.fileName,
    fileSize: attachments.fileSize,
  }).from(tbRowAttachments)
    .leftJoin(attachments, eq(tbRowAttachments.attachmentId, attachments.id))
    .where(and(
      eq(tbRowAttachments.tenantId, tenantId),
      eq(tbRowAttachments.companyId, companyId),
      eq(tbRowAttachments.taxYear, taxYear),
    ))
    .orderBy(tbRowAttachments.refCode);
  return rows.map(({ r, fileName, fileSize }) => ({
    id: r.id,
    groupingId: r.groupingId,
    accountId: r.accountId,
    taxYear: r.taxYear,
    refCode: r.refCode,
    sourceFileName: r.sourceFileName,
    annotations: (r.annotations as RowAttachmentAnnotation[]) ?? [],
    fileName: fileName ?? `${r.refCode}.pdf`,
    fileSize: fileSize ?? null,
    createdAt: r.createdAt,
  }));
}

async function loadRow(tenantId: string, companyId: string, id: string) {
  const [row] = await db.select().from(tbRowAttachments)
    .where(and(
      eq(tbRowAttachments.id, id),
      eq(tbRowAttachments.tenantId, tenantId),
      eq(tbRowAttachments.companyId, companyId),
    ))
    .limit(1);
  if (!row) throw AppError.notFound('Attachment not found');
  return row;
}

export async function removeRowAttachment(tenantId: string, companyId: string, id: string, userId?: string) {
  const row = await loadRow(tenantId, companyId, id);
  await db.delete(tbRowAttachments).where(eq(tbRowAttachments.id, row.id));
  // Underlying file + attachments row (also removes provider bytes).
  await attachmentService.remove(tenantId, row.attachmentId).catch(() => undefined);
  await auditLog(tenantId, 'delete', 'tb_row_attachment', row.id, row, null, userId);
  return { deleted: true as const };
}

export async function addAnnotation(
  tenantId: string,
  companyId: string,
  id: string,
  input: { page: number; xPct: number; yPct: number; tickmarkId: string; note?: string | null },
  userId?: string,
) {
  const row = await loadRow(tenantId, companyId, id);
  const [mark] = await db.select().from(tbTickmarks)
    .where(and(eq(tbTickmarks.id, input.tickmarkId), eq(tbTickmarks.tenantId, tenantId)))
    .limit(1);
  if (!mark) throw AppError.notFound('Tickmark not found');
  const annotation: RowAttachmentAnnotation = {
    id: randomUUID(),
    page: input.page,
    xPct: input.xPct,
    yPct: input.yPct,
    symbol: mark.symbol,
    color: mark.color,
    note: input.note?.trim() ? input.note.trim() : null,
  };
  const next = [...((row.annotations as RowAttachmentAnnotation[]) ?? []), annotation];
  await db.update(tbRowAttachments).set({ annotations: next }).where(eq(tbRowAttachments.id, row.id));
  await auditLog(tenantId, 'update', 'tb_row_attachment', row.id,
    { annotations: row.annotations }, { annotations: next }, userId);
  return annotation;
}

export async function removeAnnotation(tenantId: string, companyId: string, id: string, annotationId: string, userId?: string) {
  const row = await loadRow(tenantId, companyId, id);
  const current = (row.annotations as RowAttachmentAnnotation[]) ?? [];
  const next = current.filter((a) => a.id !== annotationId);
  if (next.length === current.length) throw AppError.notFound('Annotation not found');
  await db.update(tbRowAttachments).set({ annotations: next }).where(eq(tbRowAttachments.id, row.id));
  await auditLog(tenantId, 'update', 'tb_row_attachment', row.id,
    { annotations: current }, { annotations: next }, userId);
  return { deleted: true as const };
}

// Serve the PDF — stamped by default. Stamps draw the tickmark symbol
// (and optional note) at the stored percent coordinates; yPct is
// measured from the top of the page (screen convention) and converted
// to pdf-lib's bottom-origin space here.
export async function renderRowAttachmentPdf(tenantId: string, companyId: string, id: string, stamped = true) {
  const row = await loadRow(tenantId, companyId, id);
  const { stream } = await attachmentService.download(tenantId, row.attachmentId);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const original = Buffer.concat(chunks);
  const annotations = (row.annotations as RowAttachmentAnnotation[]) ?? [];
  if (!stamped || annotations.length === 0) {
    return { buffer: original, fileName: `${row.refCode}.pdf` };
  }
  const doc = await PDFDocument.load(original);
  const font = await doc.embedFont(StandardFonts.HelveticaBold);
  const noteFont = await doc.embedFont(StandardFonts.Helvetica);
  const pages = doc.getPages();
  for (const a of annotations) {
    const page = pages[a.page - 1];
    if (!page) continue;
    const { width, height } = page.getSize();
    const [cr, cg, cb] = STAMP_COLORS[a.color ?? 'red'] ?? STAMP_COLORS['red']!;
    const x = Math.min(Math.max(a.xPct, 0), 1) * width;
    const y = height - Math.min(Math.max(a.yPct, 0), 1) * height;
    page.drawText(a.symbol, { x, y, size: 16, font, color: rgb(cr, cg, cb) });
    if (a.note) {
      page.drawText(a.note.slice(0, 80), { x: x + 14, y: y + 2, size: 8, font: noteFont, color: rgb(cr, cg, cb) });
    }
  }
  return { buffer: Buffer.from(await doc.save()), fileName: `${row.refCode}.pdf` };
}

// Ref codes per account for the leadsheet report's Attach column.
export async function refCodesByAccount(tenantId: string, companyId: string, taxYear: number, groupingIds?: string[]) {
  const conds = [
    eq(tbRowAttachments.tenantId, tenantId),
    eq(tbRowAttachments.companyId, companyId),
    eq(tbRowAttachments.taxYear, taxYear),
  ];
  if (groupingIds && groupingIds.length > 0) conds.push(inArray(tbRowAttachments.groupingId, groupingIds));
  const rows = await db.select({
    accountId: tbRowAttachments.accountId,
    refCode: tbRowAttachments.refCode,
    groupingId: tbRowAttachments.groupingId,
  }).from(tbRowAttachments).where(and(...conds)).orderBy(tbRowAttachments.refCode);
  const byAccount = new Map<string, string[]>();
  const byGrouping = new Map<string, number>();
  for (const r of rows) {
    const list = byAccount.get(r.accountId) ?? [];
    list.push(r.refCode);
    byAccount.set(r.accountId, list);
    byGrouping.set(r.groupingId, (byGrouping.get(r.groupingId) ?? 0) + 1);
  }
  return { byAccount, byGrouping };
}
