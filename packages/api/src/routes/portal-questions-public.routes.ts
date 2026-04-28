// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { portalAuthenticate, refuseDuringPreview } from '../middleware/portal-auth.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/portal-question.service.js';

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

portalQuestionsPublicRouter.post('/:id/answers', validate(answerSchema), async (req, res) => {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  refuseDuringPreview(req);
  const result = await svc.contactAnswer({
    tenantId: req.portalContact.tenantId,
    contactId: req.portalContact.contactId,
    questionId: req.params['id']!,
    body: req.body.body,
  });
  res.status(201).json(result);
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
