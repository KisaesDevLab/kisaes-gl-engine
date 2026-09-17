// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Client-portal side of AP Bill Capture. Cookie-authenticated (no JWT, no
// /v1), mounted at /api/portal/bill-captures beside /api/portal/bills. A
// contact needs the per-company `bill_upload_access` grant and the tenant
// flag AP_BILL_CAPTURE_V1. The list is deliberately coarse and amount-free.

import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { portalAuthenticate, refuseDuringPreview } from '../middleware/portal-auth.js';
import { scopedCompanyId, portalLimiterKey } from '../middleware/peer-auth.js';
import { AppError } from '../utils/errors.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as flags from '../services/feature-flags.service.js';
import * as captureService from '../services/bill-capture.service.js';

export const portalBillCapturesPublicRouter = Router();
portalBillCapturesPublicRouter.use(portalAuthenticate);

const MAX_FILES = 10;
const ALLOWED = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.has(file.mimetype)) cb(null, true);
    else cb(new Error('Please upload a PDF, JPG, PNG, WEBP or HEIC file.'));
  },
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('portal-bill-captures-upload'),
  keyGenerator: portalLimiterKey,
  message: { error: { message: 'Too many uploads. Try again in a minute.' } },
  skip: () => process.env['NODE_ENV'] === 'test',
});

function requireCompanyId(req: import('express').Request, supplied: string | undefined): string {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const companyId = scopedCompanyId(req, supplied);
  if (!companyId) throw AppError.badRequest('companyId required');
  const pc = req.portalContact;
  if (pc.isPreview && pc.previewCompanyId && pc.previewCompanyId !== companyId) {
    throw AppError.forbidden('Preview is scoped to one company');
  }
  return companyId;
}

function uploadFiles(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  upload.array('files', MAX_FILES)(req, res, (err: unknown) => {
    if (!err) return next();
    const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
    res.status(400).json({ error: { message: tooBig ? 'A file exceeds the 10 MB limit' : (err instanceof Error ? err.message : 'Upload failed') } });
  });
}

portalBillCapturesPublicRouter.get('/', async (req, res) => {
  const companyId = requireCompanyId(req, req.query['companyId'] as string | undefined);
  const { tenantId, contactId } = req.portalContact!;
  const enabled = await flags.isEnabled(tenantId, 'AP_BILL_CAPTURE_V1');
  if (!enabled) {
    res.json({ featureEnabled: false, captures: [] });
    return;
  }
  await captureService.assertBillUploadAccess(tenantId, contactId, companyId);
  const captures = await captureService.listForPortalContact(tenantId, companyId, contactId);
  res.json({ featureEnabled: true, captures });
});

portalBillCapturesPublicRouter.post('/upload', uploadLimiter, uploadFiles, async (req, res) => {
  refuseDuringPreview(req);
  const body = req.body as { companyId?: string };
  const companyId = requireCompanyId(req, body.companyId);
  const { tenantId, contactId } = req.portalContact!;

  const enabled = await flags.isEnabled(tenantId, 'AP_BILL_CAPTURE_V1');
  if (!enabled) throw AppError.forbidden('Feature not enabled', 'FEATURE_DISABLED');
  await captureService.assertBillUploadAccess(tenantId, contactId, companyId);

  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw AppError.badRequest('No files uploaded');

  const captures = await captureService.createCapturesFromUpload({
    tenantId, companyId, source: 'portal', contactId, files,
  });
  const fresh = captures.filter((c) => !c.duplicate).length;
  if (fresh > 0) {
    void captureService.notifyStaffOfPortalBillUpload({ tenantId, companyId, contactId, fileCount: fresh });
  }
  // The portal never sees internal statuses; report each as received.
  res.status(201).json({
    captures: captures.map((c) => ({ id: c.id, fileName: c.fileName, status: 'received' as const, duplicate: c.duplicate })),
  });
});
