// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import { parseLimit, parseOffset } from '../utils/pagination.js';
import * as svc from '../services/portal-receipts.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 18 — bookkeeper-side
// Receipts Inbox + receipt review actions.

const ALLOWED = ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB cap matches attachments
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type ${file.mimetype}`));
  },
});

export const portalReceiptsRouter = Router();
portalReceiptsRouter.use(authenticate);

portalReceiptsRouter.use((req, _res, next) => {
  if (req.userType === 'client') throw AppError.notFound('Feature not available');
  if (req.userRole === 'readonly' && req.method !== 'GET') {
    throw AppError.forbidden('Read-only role cannot manage receipts');
  }
  next();
});

portalReceiptsRouter.get('/', async (req, res) => {
  const limit = parseLimit(req.query['limit'], 200);
  const offset = parseOffset(req.query['offset']);
  const { receipts, total } = await svc.listInbox(req.tenantId, {
    status: req.query['status'] as string | undefined,
    companyId: req.query['companyId'] as string | undefined,
    limit,
    offset,
  });
  res.json({ receipts, total, limit, offset });
});

portalReceiptsRouter.get('/:id', async (req, res) => {
  const r = await svc.getReceipt(req.tenantId, req.params['id']!);
  res.json({ receipt: r });
});

// Inline view / download of the stored file. Serves the Open document
// requests grid ("view what the client actually sent") and the receipts
// inbox. Accepts a ?_dl= single-use token via `authenticate`, so an
// <iframe>/<img>/new-tab can load it without custom headers; ?inline=1
// renders in place instead of prompting a save, matching the attachments
// download route.
portalReceiptsRouter.get('/:id/file', async (req, res) => {
  const file = await svc.getReceiptFile(req.tenantId, req.params['id']!);
  res.setHeader('Content-Type', file.mimeType);
  const disposition = req.query['inline'] === '1' ? 'inline' : 'attachment';
  // Strip CR/LF/quote so a stored filename can't break out of the header.
  const safeName = file.filename.replace(/[\r\n"]/g, '_');
  res.setHeader('Content-Disposition', `${disposition}; filename="${safeName}"`);
  // Client documents must never be cached by a shared proxy.
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(file.buffer);
});

portalReceiptsRouter.get('/:id/matches', async (req, res) => {
  const matches = await svc.suggestMatches(req.tenantId, req.params['id']!);
  res.json({ matches });
});

const attachSchema = z.object({ transactionId: z.string().uuid() });
portalReceiptsRouter.post('/:id/attach', validate(attachSchema), async (req, res) => {
  await svc.attachToTransaction(req.tenantId, req.userId, req.params['id']!, req.body.transactionId);
  res.json({ ok: true });
});

portalReceiptsRouter.post('/:id/dismiss', async (req, res) => {
  await svc.dismissReceipt(req.tenantId, req.userId, req.params['id']!);
  res.json({ ok: true });
});

portalReceiptsRouter.post('/upload', upload.single('file'), async (req, res) => {
  const file = req.file;
  const companyId = (req.body?.companyId ?? '') as string;
  if (!file) throw AppError.badRequest('file required');
  if (!companyId) throw AppError.badRequest('companyId required');

  const result = await svc.uploadReceipt({
    tenantId: req.tenantId,
    companyId,
    uploadedBy: req.userId,
    uploadedByType: 'bookkeeper',
    captureSource: 'practice',
    filename: file.originalname,
    mimeType: file.mimetype,
    buffer: file.buffer,
  });
  res.status(201).json(result);
});

const ocrPatchSchema = z.object({
  vendor: z.string().max(255).nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  total: z.union([z.string(), z.number()]).nullable().optional(),
  tax: z.union([z.string(), z.number()]).nullable().optional(),
  lineItems: z.unknown().optional(),
  raw: z.unknown().optional(),
  failed: z.boolean().optional(),
});

portalReceiptsRouter.post('/:id/ocr', validate(ocrPatchSchema), async (req, res) => {
  const result = await svc.applyOcrResult(req.tenantId, req.params['id']!, req.body);
  res.json(result);
});
