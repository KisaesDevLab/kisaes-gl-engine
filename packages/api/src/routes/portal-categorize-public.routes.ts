// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PORTAL_CATEGORIZE_V1 — the client-facing surface, mounted at
// /api/portal/categorize. Cookie auth, no JWT, no /api/v1 access.
//
// Guard stack, in this order, on every route:
//   1. portalAuthenticate            (router level)
//   2. refuseDuringPreview           (router level, every non-GET)
//   3. requireCompanyId              pins a preview session to its company
//   4. feature flag                  GETs self-hide; writes are refused
//   5. assertCategorizeAccess        the per-contact grant + tenant join
//   6. the NULL-company rule         inside every service query
//
// Step 2 is belt-and-braces: it is also called as the first statement of
// each write handler, so a route added later cannot silently forget it.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { portalAuthenticate, refuseDuringPreview } from '../middleware/portal-auth.js';
import { AppError } from '../utils/errors.js';
import { getRateLimitStore } from '../utils/rate-limit-store.js';
import * as flags from '../services/feature-flags.service.js';
import * as categorization from '../services/portal-categorization.service.js';
import { notifyStaffOfSuggestions } from '../services/client-suggestion-review.service.js';

export const portalCategorizePublicRouter = Router();
portalCategorizePublicRouter.use(portalAuthenticate);

// Router-level preview guard for every mutating verb.
portalCategorizePublicRouter.use((req, _res, next) => {
  if (req.method !== 'GET') refuseDuringPreview(req);
  next();
});

const submitLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: getRateLimitStore('portal-categorize-submit'),
  message: { error: { message: 'Too many requests. Try again later.' } },
  // The suite would trip its own limit; production unaffected.
  skip: () => process.env['NODE_ENV'] === 'test',
});

function requireCompanyId(req: import('express').Request, companyId: string | undefined): string {
  if (!req.portalContact) throw AppError.unauthorized('No portal session');
  if (!companyId) throw AppError.badRequest('companyId required');
  const pc = req.portalContact;
  if (pc.isPreview && pc.previewCompanyId && pc.previewCompanyId !== companyId) {
    throw AppError.forbidden('Preview is scoped to one company');
  }
  return companyId;
}

function parseInt0(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// GET /api/portal/categorize/queue?companyId=
// Reads self-hide when the flag is off so the dashboard tile disappears
// rather than erroring — the posture every other portal panel takes.
portalCategorizePublicRouter.get('/queue', async (req, res) => {
  const companyId = requireCompanyId(req, req.query['companyId'] as string | undefined);
  const { tenantId, contactId } = req.portalContact!;

  if (!(await flags.isEnabled(tenantId, 'PORTAL_CATEGORIZE_V1'))) {
    res.json({ featureEnabled: false, items: [], total: 0 });
    return;
  }
  await categorization.assertCategorizeAccess(tenantId, contactId, companyId);

  const result = await categorization.listPortalQueue(tenantId, companyId, {
    limit: parseInt0(req.query['limit'], 50),
    offset: parseInt0(req.query['offset'], 0),
  });
  res.json({ featureEnabled: true, ...result });
});

// GET /api/portal/categorize/categories?companyId=
portalCategorizePublicRouter.get('/categories', async (req, res) => {
  const companyId = requireCompanyId(req, req.query['companyId'] as string | undefined);
  const { tenantId, contactId } = req.portalContact!;

  if (!(await flags.isEnabled(tenantId, 'PORTAL_CATEGORIZE_V1'))) {
    res.json({ featureEnabled: false, categories: [] });
    return;
  }
  await categorization.assertCategorizeAccess(tenantId, contactId, companyId);

  const categories = await categorization.listPortalCategories(tenantId, companyId);
  res.set('Cache-Control', 'private, max-age=60');
  res.json({ featureEnabled: true, categories });
});

// GET /api/portal/categorize/history?companyId=
portalCategorizePublicRouter.get('/history', async (req, res) => {
  const companyId = requireCompanyId(req, req.query['companyId'] as string | undefined);
  const { tenantId, contactId } = req.portalContact!;

  if (!(await flags.isEnabled(tenantId, 'PORTAL_CATEGORIZE_V1'))) {
    res.json({ featureEnabled: false, rows: [], total: 0 });
    return;
  }
  await categorization.assertCategorizeAccess(tenantId, contactId, companyId);

  const result = await categorization.listPortalHistory(tenantId, companyId, {
    limit: parseInt0(req.query['limit'], 50),
    offset: parseInt0(req.query['offset'], 0),
  });
  res.json({ featureEnabled: true, ...result });
});

// POST /api/portal/categorize/suggestions
// The portal batches client-side ("Send 12 answers"), so this is one request
// and one staff notification per sitting.
const submitSchema = z.object({
  companyId: z.string().uuid(),
  items: z.array(z.object({
    targetKind: z.enum(['bank_feed_item', 'transaction']),
    targetId: z.string().uuid(),
    categoryId: z.union([z.string().uuid(), z.literal('personal'), z.literal('not_sure')]),
    note: z.string().max(2000).optional(),
  })).min(1).max(100),
});

portalCategorizePublicRouter.post('/suggestions', submitLimiter, async (req, res) => {
  refuseDuringPreview(req);
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    throw AppError.badRequest('Invalid request body', 'VALIDATION_ERROR');
  }
  const companyId = requireCompanyId(req, parsed.data.companyId);
  const { tenantId, contactId } = req.portalContact!;

  // Writes are refused outright rather than self-hiding: a client mid-flow
  // deserves to know the answer did not land.
  if (!(await flags.isEnabled(tenantId, 'PORTAL_CATEGORIZE_V1'))) {
    throw AppError.forbidden('Feature not enabled', 'FEATURE_DISABLED');
  }
  await categorization.assertCategorizeAccess(tenantId, contactId, companyId);

  const result = await categorization.submitSuggestions(
    tenantId, companyId, contactId, parsed.data.items,
  );

  // Fire and forget: an SMTP outage must never fail the client's submission.
  if (result.accepted.length > 0) {
    void notifyStaffOfSuggestions(tenantId, companyId, contactId, result.accepted.length)
      .catch(() => { /* the notifier logs; never surfaces to the client */ });
  }

  res.status(201).json(result);
});

// DELETE /api/portal/categorize/suggestions/:id — withdraw a pending answer.
portalCategorizePublicRouter.delete('/suggestions/:id', async (req, res) => {
  refuseDuringPreview(req);
  const { tenantId, contactId } = req.portalContact!;
  await categorization.withdrawSuggestion(tenantId, contactId, req.params['id']!);
  res.json({ withdrawn: true });
});
