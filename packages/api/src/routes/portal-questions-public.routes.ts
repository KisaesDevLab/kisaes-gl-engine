// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { portalAuthenticate, refuseDuringPreview } from '../middleware/portal-auth.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/portal-question.service.js';
import { verifyAttachmentContent } from './attachments.routes.js';

// Answer attachments: same document types the staff attachment surface
// accepts, 10 MB each, max 5 per answer. Client-supplied MIME is
// re-verified against magic bytes before storage.
const ANSWER_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic',
  'application/pdf',
  'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];
const answerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (!ANSWER_MIME_TYPES.includes(file.mimetype)) {
      cb(new Error(`File type ${file.mimetype} is not allowed`));
      return;
    }
    cb(null, true);
  },
});

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 10.5/10.6 — portal-side
// (signed-in contact) Question endpoints. Mounted at
// /api/portal/questions.

export const portalQuestionsPublicRouter = Router();
portalQuestionsPublicRouter.use(portalAuthenticate);

portalQuestionsPublicRouter.get('/', async (req, res) => {
  const companyId = (req.query['companyId'] as string | undefined) ?? '';
  if (!companyId) throw AppError.badRequest('companyId is required');
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const result = await svc.listForContact({
    tenantId: req.portalContact.tenantId,
    contactId: req.portalContact.contactId,
    companyId,
  });
  res.json(result);
});

portalQuestionsPublicRouter.get('/:id', async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const q = await svc.getQuestionForContact({
    tenantId: req.portalContact.tenantId,
    contactId: req.portalContact.contactId,
    questionId: req.params['id']!,
  });
  res.json({ question: q });
});

const answerSchema = z.object({ body: z.string().min(1).max(4000) });

// Multer failures (disallowed type, too many files, >10 MB) must reach
// the client as a 400 with the reason — not an unhandled 500.
function answerFiles(req: Parameters<ReturnType<typeof answerUpload.array>>[0], res: Parameters<ReturnType<typeof answerUpload.array>>[1], next: (err?: unknown) => void) {
  answerUpload.array('files', 5)(req, res, (err: unknown) => {
    if (err) {
      next(AppError.badRequest(err instanceof Error ? err.message : 'File upload rejected'));
      return;
    }
    next();
  });
}

// Accepts application/json (body only) or multipart/form-data with a
// `body` field plus up to 5 `files` — multer passes non-multipart
// requests through untouched.
portalQuestionsPublicRouter.post('/:id/answers', answerFiles, validate(answerSchema), async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  refuseDuringPreview(req);
  const uploads = (req.files as Express.Multer.File[] | undefined) ?? [];
  for (const f of uploads) {
    try {
      verifyAttachmentContent(f.mimetype, f.buffer);
    } catch {
      throw AppError.badRequest(`"${f.originalname}" does not match its declared file type`);
    }
  }
  const result = await svc.contactAnswer({
    tenantId: req.portalContact.tenantId,
    contactId: req.portalContact.contactId,
    questionId: req.params['id']!,
    body: req.body.body,
    files: uploads.map((f) => ({ filename: f.originalname, mimeType: f.mimetype, buffer: f.buffer })),
  });
  res.status(201).json(result);
});

// Attachment download — cookie-authed, so a plain <a href> works in the
// portal. Reads are allowed during staff preview (read-only).
portalQuestionsPublicRouter.get('/:id/attachments/:attachmentId/download', async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  const file = await svc.getQuestionAttachmentForContact({
    tenantId: req.portalContact.tenantId,
    contactId: req.portalContact.contactId,
    questionId: req.params['id']!,
    attachmentId: req.params['attachmentId']!,
  });
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/[\r\n"]/g, '_')}"`);
  res.send(file.buffer);
});

// 11.7 — Questions-for-Us (contact-initiated). Requires the contact's
// company to have questionsForUsAccess=true on portal_contact_companies.
const askSchema = z.object({
  companyId: z.string().uuid(),
  body: z.string().min(1).max(4000),
  transactionId: z.string().uuid().nullable().optional(),
});

portalQuestionsPublicRouter.post('/ask', validate(askSchema), async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  refuseDuringPreview(req);
  const result = await svc.contactAsk(req.portalContact.tenantId, req.portalContact.contactId, req.body);
  res.status(201).json(result);
});
