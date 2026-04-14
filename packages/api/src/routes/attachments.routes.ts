import { Router } from 'express';
import multer from 'multer';
import jwt from 'jsonwebtoken';
import { eq, and, sql } from 'drizzle-orm';
import type { JwtPayload } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { env } from '../config/env.js';
import { db } from '../db/index.js';
import { users, attachments, transactions, contacts } from '../db/schema/index.js';
import * as attachmentService from '../services/attachment.service.js';
import * as ocrService from '../services/ocr.service.js';

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

export const attachmentsRouter = Router();

// Download route supports ?token= query param for <img>/<iframe> inline preview.
// The token may be in the query string (browsers can't send custom headers on
// <a>/<img>/<iframe> requests) or in the Authorization header.
attachmentsRouter.get('/:id/download', async (req, res) => {
  const token = (req.query['token'] as string) || req.headers.authorization?.slice(7);
  if (!token) {
    res.status(401).json({ error: { message: 'Authentication required' } });
    return;
  }

  // Only the JWT verify step produces a 401. Any other failure (DB, missing
  // attachment, stream error) must propagate to the global error handler so
  // the client sees the real status code — not a bogus "invalid token".
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
  } catch (err) {
    const isExpired = err instanceof Error && err.name === 'TokenExpiredError';
    res.status(401).json({
      error: { message: isExpired ? 'Token expired' : 'Invalid token' },
    });
    return;
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, payload.userId) });
  if (!user || !user.isActive) {
    res.status(401).json({ error: { message: 'Account is deactivated' } });
    return;
  }

  const { stream, attachment } = await attachmentService.download(payload.tenantId, req.params['id']!);
  res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
  const disposition = req.query['inline'] === '1' ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disposition}; filename="${attachment.fileName}"`);
  stream.pipe(res);
});

attachmentsRouter.use(authenticate);

attachmentsRouter.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: { message: 'No file uploaded' } }); return; }

  const { attachableType, attachableId } = req.body;
  if (!attachableType || !attachableId) {
    res.status(400).json({ error: { message: 'attachableType and attachableId required' } });
    return;
  }

  const attachment = await attachmentService.upload(req.tenantId, req.file, attachableType, attachableId);

  // Auto-trigger OCR for receipt images
  if (req.file.mimetype.startsWith('image/')) {
    ocrService.processReceipt(req.tenantId, attachment!.id).catch(() => {});
  }

  res.status(201).json({ attachment });
});

attachmentsRouter.get('/', async (req, res) => {
  const result = await attachmentService.list(req.tenantId, {
    attachableType: req.query['attachable_type'] as string,
    attachableId: req.query['attachable_id'] as string,
    limit: parseInt(req.query['limit'] as string) || 50,
    offset: parseInt(req.query['offset'] as string) || 0,
  });
  res.json(result);
});

attachmentsRouter.get('/unlinked', async (req, res) => {
  const data = await attachmentService.listUnlinked(req.tenantId);
  res.json({ data });
});

attachmentsRouter.post('/:id/link', async (req, res) => {
  const { attachableType, attachableId } = req.body;
  if (!attachableType || !attachableId) {
    res.status(400).json({ error: { message: 'attachableType and attachableId required' } });
    return;
  }
  await attachmentService.linkAttachment(req.tenantId, req.params['id']!, attachableType, attachableId);
  res.json({ linked: true });
});

// Enriched library endpoint — joins attachments with transactions + contacts
attachmentsRouter.get('/library', async (req, res) => {
  const rows = await db
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
    .leftJoin(transactions, and(
      eq(attachments.attachableId, transactions.id),
      eq(attachments.tenantId, transactions.tenantId),
    ))
    .leftJoin(contacts, and(
      eq(transactions.contactId, contacts.id),
      eq(transactions.tenantId, contacts.tenantId),
    ))
    .where(eq(attachments.tenantId, req.tenantId))
    .orderBy(sql`${attachments.createdAt} desc`)
    .limit(500);

  res.json({ data: rows });
});

attachmentsRouter.get('/:id', async (req, res) => {
  const attachment = await attachmentService.getById(req.tenantId, req.params['id']!);
  res.json({ attachment });
});


attachmentsRouter.delete('/:id', async (req, res) => {
  await attachmentService.remove(req.tenantId, req.params['id']!);
  res.json({ message: 'Attachment deleted' });
});

attachmentsRouter.post('/:id/ocr', async (req, res) => {
  await ocrService.processReceipt(req.tenantId, req.params['id']!);
  const attachment = await attachmentService.getById(req.tenantId, req.params['id']!);
  res.json({ attachment });
});
