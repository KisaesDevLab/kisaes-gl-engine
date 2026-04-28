// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
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
  const list = await svc.listInbox(req.tenantId, {
    status: req.query['status'] as string | undefined,
    companyId: req.query['companyId'] as string | undefined,
  });
  res.json({ receipts: list });
});

portalReceiptsRouter.get('/:id', async (req, res) => {
  const r = await svc.getReceipt(req.tenantId, req.params['id']!);
  res.json({ receipt: r });
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
