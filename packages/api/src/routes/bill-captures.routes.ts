// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Staff side of AP Bill Capture (AP_BILL_CAPTURE_V1). Mounted at
// /api/v1/bill-captures — its own prefix rather than /bills/captures so it
// can never collide with billsRouter's GET /:id. Gated on the `bills`
// permission resource (GETs read, POSTs update) plus the tenant flag.

import { Router } from 'express';
import multer from 'multer';
import { billCaptureListQuerySchema, enterBillCaptureSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { requireResource } from '../middleware/permission.js';
import { requireFeatureFlag } from '../middleware/feature-flag.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import * as captureService from '../services/bill-capture.service.js';

export const BILL_CAPTURE_MAX_FILES = 20;
export const BILL_CAPTURE_ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/tiff', 'application/pdf',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: BILL_CAPTURE_MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (BILL_CAPTURE_ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error(`Unsupported file type: ${file.mimetype}. Upload a PDF or image.`));
  },
});

export const billCapturesRouter = Router();
billCapturesRouter.use(authenticate);
billCapturesRouter.use(companyContext);
billCapturesRouter.use(requireResource('bills'));
billCapturesRouter.use(requireFeatureFlag('AP_BILL_CAPTURE_V1'));

function requireCompany(req: import('express').Request): string {
  if (!req.companyId) throw AppError.badRequest('No active company. Send X-Company-Id.');
  return req.companyId;
}

// Multer's fileFilter errors are plain Errors; turn them into a 400 with
// the message instead of a generic 500.
function uploadFiles(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  upload.array('files', BILL_CAPTURE_MAX_FILES)(req, res, (err: unknown) => {
    if (!err) return next();
    const message = err instanceof Error ? err.message : 'Upload failed';
    const tooBig = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE';
    res.status(400).json({ error: { message: tooBig ? 'A file exceeds the 10 MB limit' : message } });
  });
}

billCapturesRouter.post('/', uploadFiles, async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (files.length === 0) throw AppError.badRequest('No files uploaded');
  const captures = await captureService.createCapturesFromUpload({
    tenantId: req.tenantId,
    companyId: requireCompany(req),
    source: 'staff',
    userId: req.userId,
    files,
  });
  res.status(201).json({ captures });
});

billCapturesRouter.get('/', async (req, res) => {
  const q = billCaptureListQuerySchema.parse(req.query);
  const result = await captureService.list(req.tenantId, requireCompany(req), q);
  res.json(result);
});

billCapturesRouter.get('/:id', async (req, res) => {
  const result = await captureService.get(req.tenantId, requireCompany(req), req.params['id']!);
  res.json(result);
});

// Inline stream of the captured document for the review pane. Scoped through
// the capture so a user with only the `bills` resource can view it.
billCapturesRouter.get('/:id/file', async (req, res) => {
  const { stream, attachment } = await captureService.file(req.tenantId, requireCompany(req), req.params['id']!);
  res.setHeader('Content-Type', attachment.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(attachment.fileName)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  stream.pipe(res);
});

billCapturesRouter.post('/:id/enter', validate(enterBillCaptureSchema), async (req, res) => {
  const result = await captureService.enterBill(req.tenantId, requireCompany(req), req.params['id']!, req.body, req.userId);
  res.status(201).json(result);
});

billCapturesRouter.post('/:id/discard', async (req, res) => {
  const capture = await captureService.discard(req.tenantId, requireCompany(req), req.params['id']!, req.userId);
  res.json({ capture });
});

billCapturesRouter.post('/:id/reprocess', async (req, res) => {
  const capture = await captureService.reprocess(req.tenantId, requireCompany(req), req.params['id']!, req.userId);
  res.status(202).json({ capture });
});
