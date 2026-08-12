// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Check signature library + step-up re-auth. Tenant-scoped (no
// companyContext) and deliberately NOT behind requireResource('checks'):
// management is owner-only by role, and /mine, /step-up answer for any
// authenticated user — the print routes themselves stay behind the
// 'checks' resource.

import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { createCheckSignatureSchema, updateCheckSignatureSchema, setSignatureUsersSchema, stepUpSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as signatureService from '../services/check-signature.service.js';

export const checkSignaturesRouter = Router();
checkSignaturesRouter.use(authenticate);

function assertOwner(req: import('express').Request) {
  if (req.userRole !== 'owner' && !req.isSuperAdmin) throw AppError.forbidden('Only owners can manage check signatures');
}

// memoryStorage on purpose (unlike the logo route's diskStorage): the
// plaintext image must never touch disk — it is encrypted from the buffer.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, file.mimetype === 'image/png' || file.mimetype === 'image/jpeg');
  },
});

// Step-up is a credential-guessing surface — throttle like login.
const stepUpLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('check-sig-stepup'),
});

checkSignaturesRouter.get('/', async (req, res) => {
  assertOwner(req);
  const signatures = await signatureService.listSignatures(req.tenantId);
  res.json({ signatures });
});

checkSignaturesRouter.post('/', upload.single('image'), async (req, res) => {
  assertOwner(req);
  if (!req.file) throw AppError.badRequest('Signature image file is required');
  const input = createCheckSignatureSchema.parse({
    label: req.body.label,
    maxAmount: req.body.maxAmount ? String(req.body.maxAmount) : null,
  });
  const signature = await signatureService.createSignature(req.tenantId, req.userId, input, req.file);
  res.status(201).json({ signature });
});

// /mine before /:id-shaped params so it can't be swallowed by them.
checkSignaturesRouter.get('/mine', async (req, res) => {
  const signatures = await signatureService.listMySignatures(
    req.tenantId, req.userId, req.userRole === 'owner' || !!req.isSuperAdmin,
  );
  res.json({ signatures });
});

// Which credential the step-up modal should ask this user for.
checkSignaturesRouter.get('/step-up/method', async (req, res) => {
  const method = await signatureService.stepUpMethodForUser(req.userId);
  res.json({ method });
});

checkSignaturesRouter.post('/step-up', stepUpLimiter, validate(stepUpSchema), async (req, res) => {
  const result = await signatureService.verifySignerCredential(req.tenantId, req.userId, req.body);
  if (!result.ok) {
    throw AppError.unauthorized(result.reason || 'Verification failed', 'STEP_UP_FAILED');
  }
  res.json(signatureService.issueStepUpToken(req.userId, req.tenantId));
});

checkSignaturesRouter.put('/:id', validate(updateCheckSignatureSchema), async (req, res) => {
  assertOwner(req);
  await signatureService.updateSignature(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ success: true });
});

checkSignaturesRouter.put('/:id/image', upload.single('image'), async (req, res) => {
  assertOwner(req);
  if (!req.file) throw AppError.badRequest('Signature image file is required');
  await signatureService.replaceImage(req.tenantId, req.params['id']!, req.file, req.userId);
  res.json({ success: true });
});

checkSignaturesRouter.put('/:id/users', validate(setSignatureUsersSchema), async (req, res) => {
  assertOwner(req);
  await signatureService.setSignatureUsers(req.tenantId, req.params['id']!, req.body.userIds, req.userId);
  res.json({ success: true });
});

checkSignaturesRouter.delete('/:id', async (req, res) => {
  assertOwner(req);
  await signatureService.deleteSignature(req.tenantId, req.params['id']!, req.userId);
  res.json({ success: true });
});

// Authenticated preview — owner or a user the signature is assigned to.
// Decrypted in memory; explicitly never cacheable, never a static URL.
checkSignaturesRouter.get('/:id/image', async (req, res) => {
  const isOwner = req.userRole === 'owner' || !!req.isSuperAdmin;
  const allowed = await signatureService.userCanUseSignature(req.tenantId, req.params['id']!, req.userId, isOwner);
  if (!allowed) throw AppError.forbidden('You are not authorized to view this signature');
  const sig = await signatureService.loadSignatureImage(req.tenantId, req.params['id']!);
  res.setHeader('Content-Type', sig.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'no-store');
  res.send(sig.bytes);
});
