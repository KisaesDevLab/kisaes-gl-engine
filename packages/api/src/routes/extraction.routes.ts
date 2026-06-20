// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// HTTP surface for the local document-extraction module. Mounted at
// /api/v1/extractions under authenticate + the per-appliance feature gate +
// a staff-only guard (clients use the separate /portal surface).
//
//   POST   /                       upload a document → 202 { job }
//   GET    /                       list jobs (paginated, total count)
//   GET    /:jobId                 job status + pages + records + review
//   GET    /:jobId/review          items needing human review
//   POST   /:jobId/review/:itemId  submit a correction (validate/post)

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import {
  extractUploadFieldsSchema,
  extractionListQuerySchema,
  reviewSubmitSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { auditLog } from '../middleware/audit.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import * as extractionService from '../services/extraction/extraction.service.js';

// Only the formats the render pipeline can handle (PDF + passthrough images).
const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

function startsWith(buf: Buffer, magic: Buffer): boolean {
  return buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);
}

// Magic-byte check — the fileFilter only sees the client-supplied MIME, so a
// renamed binary claiming application/pdf would otherwise reach the renderer.
function verifyExtractionContent(file: Express.Multer.File): void {
  const buf = file.buffer;
  const reject = () =>
    { throw AppError.badRequest('Uploaded file content does not match its declared type.', 'EXTRACT_INVALID_FORMAT'); };
  switch (file.mimetype) {
    case 'application/pdf':
      if (!startsWith(buf, Buffer.from('%PDF-'))) reject();
      return;
    case 'image/png':
      if (!startsWith(buf, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) reject();
      return;
    case 'image/jpeg':
      if (!(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)) reject();
      return;
    case 'image/webp':
      if (!(startsWith(buf, Buffer.from('RIFF')) && buf.length > 12 && buf.subarray(8, 12).equals(Buffer.from('WEBP')))) reject();
      return;
    default:
      reject();
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(AppError.badRequest(
        `File type not allowed: ${file.mimetype}. Accepted: PDF, PNG, JPEG, WEBP.`,
        'EXTRACT_INVALID_FORMAT',
      ));
    }
  },
});

// Per-appliance feature gate. 404 (not 403) when off so the surface is
// invisible on deployments that don't use local document extraction.
function requireExtractionEnabled(_req: Request, _res: Response, next: NextFunction): void {
  if (!env.DOCUMENT_EXTRACTION_V1) throw AppError.notFound('Feature not available');
  next();
}

// Staff-only — clients have a separate /portal API and must never reach here.
function requireStaff(req: Request, _res: Response, next: NextFunction): void {
  if (req.userType === 'client') throw AppError.notFound('Feature not available');
  next();
}

export const extractionRouter = Router();
extractionRouter.use(authenticate);
extractionRouter.use(requireExtractionEnabled);
extractionRouter.use(requireStaff);

extractionRouter.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) throw AppError.badRequest('No file uploaded.', 'EXTRACT_NO_FILE');
  verifyExtractionContent(req.file);

  const fields = extractUploadFieldsSchema.parse({
    docType: req.body['docType'],
    companyId: req.body['companyId'] || undefined,
  });

  const { job, duplicate } = await extractionService.createJob(req.tenantId, {
    docType: fields.docType,
    companyId: fields.companyId ?? null,
    file: { buffer: req.file.buffer, mimeType: req.file.mimetype, originalname: req.file.originalname },
  });

  await auditLog(
    req.tenantId,
    'create',
    'extraction_job',
    job.id,
    null,
    { docType: job.docType, status: job.status, duplicate },
    req.userId,
  );

  // 202 Accepted for a newly-queued job; 200 for an idempotent duplicate.
  res.status(duplicate ? 200 : 202).json({ job, duplicate });
});

extractionRouter.get('/', async (req, res) => {
  const q = extractionListQuerySchema.parse(req.query);
  const out = await extractionService.listJobs(req.tenantId, {
    status: q.status,
    docType: q.docType,
    limit: q.limit,
    offset: q.offset,
  });
  res.json(out);
});

extractionRouter.get('/:jobId', async (req, res) => {
  const out = await extractionService.getJob(req.tenantId, req.params['jobId']!);
  res.json(out);
});

extractionRouter.get('/:jobId/review', async (req, res) => {
  const out = await extractionService.getReviewItems(req.tenantId, req.params['jobId']!);
  res.json(out);
});

extractionRouter.post('/:jobId/review/:itemId', async (req, res) => {
  const input = reviewSubmitSchema.parse(req.body ?? {});
  const { before, after } = await extractionService.submitReview(
    req.tenantId,
    req.params['jobId']!,
    req.params['itemId']!,
    { correction: input.correction, post: input.post, note: input.note },
    req.userId,
  );

  await auditLog(req.tenantId, 'update', 'extracted_record', after.id, before, after, req.userId);
  res.json({ record: after });
});
