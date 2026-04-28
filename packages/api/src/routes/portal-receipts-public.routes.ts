// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import { portalAuthenticate, refuseDuringPreview } from '../middleware/portal-auth.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/portal-receipts.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 18.6 — contact-mode upload.
// Mounted at /api/portal/receipts (signed-in portal contacts only).

const ALLOWED = ['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type ${file.mimetype}`));
  },
});

export const portalReceiptsPublicRouter = Router();
portalReceiptsPublicRouter.use(portalAuthenticate);

portalReceiptsPublicRouter.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  refuseDuringPreview(req);
  const file = req.file;
  const companyId = (req.body?.companyId ?? '') as string;
  if (!file) throw AppError.badRequest('file required');
  if (!companyId) throw AppError.badRequest('companyId required');

  // RECURRING_DOC_REQUESTS_V1 — optional documentRequestId tells the
  // service which standing request this upload fulfils. UUID validated
  // here to fail fast with a clear message before the service queries
  // the document_requests table.
  const rawDocReqId = req.body?.documentRequestId;
  const documentRequestId = typeof rawDocReqId === 'string' && rawDocReqId.length > 0 ? rawDocReqId : undefined;
  if (documentRequestId && !/^[0-9a-fA-F-]{36}$/.test(documentRequestId)) {
    throw AppError.badRequest('documentRequestId must be a UUID');
  }

  const result = await svc.uploadReceipt({
    tenantId: req.portalContact.tenantId,
    companyId,
    uploadedBy: req.portalContact.contactId,
    uploadedByType: 'contact',
    captureSource: 'portal',
    filename: file.originalname,
    mimeType: file.mimetype,
    buffer: file.buffer,
    documentRequestId,
  });
  res.status(201).json(result);
});

// Lightweight contact-side list — only their own uploads, last 30 days.
portalReceiptsPublicRouter.get('/', async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const companyId = req.query['companyId'] as string | undefined;
  if (!companyId) throw AppError.badRequest('companyId required');

  const list = await svc.listInbox(req.portalContact.tenantId, { companyId });
  // Filter to this contact's uploads only — the bookkeeper inbox is not
  // visible to portal contacts.
  const own = list.filter((r) => r.uploadedBy === req.portalContact!.contactId);
  res.json({ receipts: own });
});
