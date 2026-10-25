// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { eq, and, or, isNull, sql, count } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.js';
import { requireResource, requirePermission } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { auditLog } from '../middleware/audit.js';
import { db } from '../db/index.js';
import { attachments, transactions, contacts } from '../db/schema/index.js';
import * as attachmentService from '../services/attachment.service.js';
import * as ocrService from '../services/ocr.service.js';
import { billOcrAvailability, type BillOcrUnavailableReason } from '../services/ai-bill-ocr.service.js';
import { isDesktop } from '../desktop/profile.js';
import { AppError } from '../utils/errors.js';
import { parseLimit, parseOffset } from '../utils/pagination.js';
import { log } from '../utils/logger.js';
import { describe } from '../middleware/describe.js';

const ALLOWED_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff', 'image/bmp',
  'application/pdf',
  'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // xlsx
  'application/vnd.ms-excel', // xls
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // docx
];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed. Accepted: images, PDFs, spreadsheets, documents.`));
    }
  },
});

// Magic-byte sniff against the claimed MIME type. The fileFilter above only
// sees the client-supplied `file.mimetype`, so a `malicious.exe` claiming
// `application/pdf` sails through. After upload we inspect the buffer's
// leading bytes and refuse anything whose content clearly doesn't match.
// Text/CSV formats have no reliable magic, so we only reject them if they
// start with bytes that are plainly a zip/OLE/PE/ELF binary.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]);
const PE_MAGIC = Buffer.from([0x4d, 0x5a]); // MZ
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]); // 0x7F ELF
const MACHO_MAGICS = [
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
];

function startsWith(buf: Buffer, magic: Buffer): boolean {
  if (buf.length < magic.length) return false;
  return buf.subarray(0, magic.length).equals(magic);
}

export function verifyAttachmentContent(mime: string, buf: Buffer): void {
  const err = () => { throw new Error('Uploaded file content does not match its declared type.'); };

  if (mime === 'image/heic') {
    // ISO base media file format: 'ftyp' box at offset 4.
    if (buf.length < 12 || buf.subarray(4, 8).toString('ascii') !== 'ftyp') err();
    return;
  }

  if (mime === 'application/pdf') {
    if (!startsWith(buf, Buffer.from('%PDF-'))) err();
    return;
  }
  if (mime === 'image/jpeg') {
    if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) err();
    return;
  }
  if (mime === 'image/png') {
    if (!startsWith(buf, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) err();
    return;
  }
  if (mime === 'image/gif') {
    if (!(startsWith(buf, Buffer.from('GIF87a')) || startsWith(buf, Buffer.from('GIF89a')))) err();
    return;
  }
  if (mime === 'image/webp') {
    if (!(startsWith(buf, Buffer.from('RIFF')) && buf.length > 12 && buf.subarray(8, 12).equals(Buffer.from('WEBP')))) err();
    return;
  }
  if (mime === 'image/bmp') {
    if (!startsWith(buf, Buffer.from('BM'))) err();
    return;
  }
  if (mime === 'image/tiff') {
    if (!(startsWith(buf, Buffer.from([0x49, 0x49, 0x2a, 0x00])) || startsWith(buf, Buffer.from([0x4d, 0x4d, 0x00, 0x2a])))) err();
    return;
  }
  if (
    mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    if (!startsWith(buf, ZIP_MAGIC)) err();
    return;
  }
  if (mime === 'application/vnd.ms-excel') {
    if (!startsWith(buf, OLE_MAGIC)) err();
    return;
  }
  if (mime === 'text/csv' || mime === 'text/plain') {
    // No reliable magic for text — refuse anything that's clearly a binary
    // executable or archive masquerading as text.
    if (
      startsWith(buf, ZIP_MAGIC) ||
      startsWith(buf, OLE_MAGIC) ||
      startsWith(buf, PE_MAGIC) ||
      startsWith(buf, ELF_MAGIC) ||
      MACHO_MAGICS.some((m) => startsWith(buf, m))
    ) err();
    return;
  }
}

export const attachmentsRouter = Router();

// Download route supports two auth modes, both through authenticate():
//   1. Authorization: Bearer <JWT> — standard API call from the SPA fetch
//      client, with the full session-shape and active-user checks.
//   2. ?_dl=<download-token> — a ~60-second signed token issued by
//      /api/v1/downloads/token, suitable for <a>/<img>/<iframe> where
//      custom headers can't be set (replayable within its TTL; see
//      utils/download-token.ts). Its company wins over X-Company-Id.
// The legacy `?token=<JWT>` path is deliberately removed: putting a full
// 15-minute access token in a URL leaks it into server logs, browser
// history, referer headers, and proxy logs. Clients that were using it
// should switch to /api/v1/downloads/token + ?_dl=.
//
// U-90 review M5: the attachments read permission and the session checks
// run first, then the company is resolved (X-Company-Id or the token's
// company, else the first company the user may open, with the exclusion
// checks of every company-scoped router), then only a file that company may
// see is downloaded.
attachmentsRouter.get('/:id/download', authenticate, requirePermission('attachments', 'read'), companyContext, async (req, res) => {
  const tenantId = req.tenantId;
  const { stream, attachment } = await attachmentService.download(tenantId, req.params['id']!, req.companyId);
  res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
  const disposition = req.query['inline'] === '1' ? 'inline' : 'attachment';
  // Content-Disposition filename escapement — quote any internal quote so a
  // malicious fileName can't break out of the header (defense-in-depth; file
  // names are tenant-scoped and sanitized at upload, but the header is on
  // an auth-less path so we err cautious).
  const safeName = (attachment.fileName || 'download').replace(/[\r\n"]/g, '_');
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  stream.pipe(res);
});

const bulkDownloadSchema = z.object({
  attachmentIds: z.array(z.string().uuid()).min(1).max(200),
});

// Bulk download as a single ZIP. Declared ahead of the router-level
// requireResource guard (which maps POST to the 'update' action) with an
// explicit 'read' permission — downloading is semantically a read, same as
// GET /:id/download.
attachmentsRouter.post('/bulk-download', authenticate, requirePermission('attachments', 'read'), companyContext, async (req, res) => {
  const parsed = bulkDownloadSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'attachmentIds must be an array of 1-200 attachment UUIDs' } });
    return;
  }

  // Throws 404 before any headers are sent if any id isn't this tenant's —
  // same behavior as the single download route's tenant-scoped lookup.
  const { archive, done } = await attachmentService.bulkDownload(req.tenantId, parsed.data.attachmentIds, req.companyId);

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="attachments-${stamp}.zip"`);
  archive.on('error', (err) => {
    log.error({
      component: 'attachments',
      event: 'bulk_download_stream_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    res.destroy(err instanceof Error ? err : new Error(String(err)));
  });
  archive.pipe(res);

  const { included, skipped } = await done;

  await auditLog(
    req.tenantId,
    'download',
    'attachment',
    null,
    null,
    {
      bulk: true,
      attachmentIds: parsed.data.attachmentIds,
      included,
      skipped: skipped.map((s) => ({ id: s.id, fileName: s.fileName, reason: s.reason })),
    },
    req.userId,
  );
});

attachmentsRouter.use(authenticate);
attachmentsRouter.use(requireResource('attachments'));
// U-90: every route below works in one company. Uploads are stamped with it
// and reads/writes see only that company's files plus tenant-wide ones
// (attachmentService.companyScope), so an accountant excluded from a company
// can't list, read, download, delete, OCR or link its files from another.
attachmentsRouter.use(companyContext);

attachmentsRouter.post('/', describe({
  summary: 'Upload an attachment',
  query: z.object({
    autoOcr: z.enum(['0', '1', 'false', 'true']).optional()
      .describe('0 / false: start no OCR or AI processing for this upload. It never turns OCR on: desktop mode and the attachments.autoOcr server setting decide that (bill-ocr-v2).'),
  }),
}), upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: { message: 'No file uploaded' } }); return; }

  const { attachableType, attachableId } = req.body;
  if (!attachableType || !attachableId) {
    res.status(400).json({ error: { message: 'attachableType and attachableId required' } });
    return;
  }

  try {
    verifyAttachmentContent(req.file.mimetype, req.file.buffer);
  } catch (err: any) {
    res.status(400).json({ error: { message: err.message || 'Invalid upload' } });
    return;
  }

  // U-89: OCR / AI on upload only where the server allows it (never in
  // desktop mode; the `attachments.autoOcr` setting elsewhere), and a caller
  // can opt out per upload with ?autoOcr=0.
  // A repeated parameter (?autoOcr=0&autoOcr=1) arrives as an array: the
  // first value counts, so an opt-out is never lost to the array shape.
  const autoOcrRaw: unknown = Array.isArray(req.query['autoOcr']) ? req.query['autoOcr'][0] : req.query['autoOcr'];
  const autoOcrQuery = typeof autoOcrRaw === 'string' ? autoOcrRaw.trim().toLowerCase() : undefined;
  const autoOcr = autoOcrQuery !== '0' && autoOcrQuery !== 'false'
    && await attachmentService.autoOcrOnUploadAllowed();

  // Review M3: the record the file is filed on must be one this company may
  // use, the same check as POST /:id/link (404, nothing stored).
  await attachmentService.assertAttachTarget(req.tenantId, attachableType, attachableId, req.companyId);

  const attachment = await attachmentService.upload(
    req.tenantId, req.file, attachableType, attachableId,
    { skipAutoClassify: !autoOcr, companyId: req.companyId },
  );

  await auditLog(
    req.tenantId,
    'create',
    'attachment',
    attachment?.id ?? null,
    null,
    { attachableType, attachableId, fileName: attachment?.fileName, mimeType: attachment?.mimeType, fileSize: attachment?.fileSize },
    req.userId,
  );

  // Auto-trigger OCR for receipt images. Fire-and-forget by design (the
  // upload response must not block on OCR), but a swallowed empty catch hid
  // failures in processReceipt's pre-try DB writes entirely — log them.
  if (autoOcr && req.file.mimetype.startsWith('image/')) {
    ocrService.processReceipt(req.tenantId, attachment!.id).catch((err) => {
      log.error({
        component: 'attachments',
        event: 'ocr_dispatch_failed',
        attachmentId: attachment!.id,
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }

  res.status(201).json({ attachment });
});

attachmentsRouter.get('/', async (req, res) => {
  const result = await attachmentService.list(req.tenantId, {
    attachableType: req.query['attachable_type'] as string,
    attachableId: req.query['attachable_id'] as string,
    limit: parseLimit(req.query['limit']),
    offset: parseOffset(req.query['offset']),
    companyId: req.companyId,
  });
  res.json(result);
});

attachmentsRouter.get('/unlinked', async (req, res) => {
  const data = await attachmentService.listUnlinked(req.tenantId, req.companyId);
  res.json({ data });
});

// companyContext (review M2, now router-wide since U-90): an accountant
// excluded from a company can't move its files.
attachmentsRouter.post('/:id/link', async (req, res) => {
  const { attachableType, attachableId } = req.body;
  if (!attachableType || !attachableId) {
    res.status(400).json({ error: { message: 'attachableType and attachableId required' } });
    return;
  }
  const attachmentId = req.params['id']!;
  // The attachment itself must be one this company may see (companyScope:
  // its own company, else the company of the record it is filed on).
  await attachmentService.getById(req.tenantId, attachmentId, req.companyId);
  // The target must be one this company may use: a transaction of that type
  // in this tenant (and company), or a record with no other company.
  await attachmentService.assertAttachTarget(req.tenantId, attachableType, attachableId, req.companyId);
  await attachmentService.linkAttachment(req.tenantId, attachmentId, attachableType, attachableId, req.companyId);
  await auditLog(
    req.tenantId,
    'update',
    'attachment',
    attachmentId,
    null,
    { attachableType, attachableId },
    req.userId,
  );
  res.json({ linked: true });
});

// Enriched library endpoint — joins attachments with transactions + contacts.
// Paginated per CLAUDE.md rule #16: returns { data, total, limit, offset }.
attachmentsRouter.get('/library', async (req, res) => {
  const limit = parseLimit(req.query['limit'], 100, 500);
  const offset = parseOffset(req.query['offset']);

  const where = and(eq(attachments.tenantId, req.tenantId), attachmentService.companyScope(req.companyId));

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: attachments.id,
        fileName: attachments.fileName,
        fileSize: attachments.fileSize,
        mimeType: attachments.mimeType,
        attachableType: attachments.attachableType,
        attachableId: attachments.attachableId,
        ocrStatus: attachments.ocrStatus,
        ocrTotal: attachments.ocrTotal,
        createdAt: attachments.createdAt,
        txnDate: transactions.txnDate,
        txnType: transactions.txnType,
        txnMemo: transactions.memo,
        contactId: transactions.contactId,
        contactName: contacts.displayName,
      })
      .from(attachments)
      // Review M3: join only a transaction (and its contact) this company
      // may see, so a row's txn/contact columns never come from another
      // company's records.
      .leftJoin(transactions, and(
        eq(attachments.attachableId, transactions.id),
        eq(attachments.tenantId, transactions.tenantId),
        or(isNull(transactions.companyId), eq(transactions.companyId, req.companyId)),
      ))
      .leftJoin(contacts, and(
        eq(transactions.contactId, contacts.id),
        eq(transactions.tenantId, contacts.tenantId),
        or(isNull(contacts.companyId), eq(contacts.companyId, req.companyId)),
      ))
      .where(where)
      .orderBy(sql`${attachments.createdAt} desc`)
      .limit(limit)
      .offset(offset),
    db.select({ count: count() }).from(attachments).where(where),
  ]);

  res.json({ data: rows, total: totalRows[0]?.count ?? 0, limit, offset });
});

attachmentsRouter.get('/:id', async (req, res) => {
  const attachment = await attachmentService.getById(req.tenantId, req.params['id']!, req.companyId);
  res.json({ attachment });
});


attachmentsRouter.delete('/:id', async (req, res) => {
  const attachmentId = req.params['id']!;
  const before = await attachmentService.getById(req.tenantId, attachmentId, req.companyId).catch(() => null);
  await attachmentService.remove(req.tenantId, attachmentId, req.companyId);
  await auditLog(
    req.tenantId,
    'delete',
    'attachment',
    attachmentId,
    before,
    null,
    req.userId,
  );
  res.json({ message: 'Attachment deleted' });
});

const OCR_GATE_MESSAGES: Record<BillOcrUnavailableReason, string> = {
  ai_disabled: 'AI is turned off. Turn it on in AI settings before reading documents.',
  ai_function_disabled: 'Document reading is turned off in AI settings.',
  ai_consent_blocked: 'AI document reading is not allowed for this company (consent).',
};

// An explicit request to read one attachment. In desktop mode it is held to
// the same AI on / function / consent gates as
// POST /bills/extract-from-attachment (U-89): 400 with code
// ai_disabled | ai_function_disabled | ai_consent_blocked, nothing changed.
attachmentsRouter.post('/:id/ocr', async (req, res) => {
  // U-90: 404 for a file the request's company may not see, before any AI.
  const target = await attachmentService.getById(req.tenantId, req.params['id']!, req.companyId);
  if (isDesktop()) {
    const gate = await billOcrAvailability(req.tenantId, target.companyId ?? null);
    if (!gate.ok) throw AppError.badRequest(OCR_GATE_MESSAGES[gate.reason], gate.reason);
  }
  await ocrService.processReceipt(req.tenantId, target.id);
  const attachment = await attachmentService.getById(req.tenantId, target.id, req.companyId);
  res.json({ attachment });
});
