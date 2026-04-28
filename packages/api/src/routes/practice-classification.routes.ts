// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import {
  approveSelectedSchema,
  approveAllSchema,
  reclassifySchema,
  bucketQuerySchema,
  summaryQuerySchema,
  classificationBucketSchema,
} from '@kis-books/shared';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/audit.js';
import { requirePracticeAccess } from '../middleware/practice-access.js';
import { AppError } from '../utils/errors.js';
import * as classificationService from '../services/practice-classification.service.js';
import * as vendorEnrichmentService from '../services/vendor-enrichment.service.js';
import * as portalQuestionService from '../services/portal-question.service.js';
import * as featureFlags from '../services/feature-flags.service.js';
import { db } from '../db/index.js';
import { bankFeedItems } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';

export const practiceClassificationRouter = Router();

practiceClassificationRouter.use(authenticate);
practiceClassificationRouter.use(requirePracticeAccess('AI_BUCKET_WORKFLOW_V1'));

// GET /summary?companyId&periodStart&periodEnd
practiceClassificationRouter.get('/summary', async (req, res) => {
  const parsed = summaryQuerySchema.parse({
    companyId: req.query['companyId'],
    periodStart: req.query['periodStart'],
    periodEnd: req.query['periodEnd'],
  });
  const summary = await classificationService.summarizeForPeriod(
    req.tenantId,
    parsed.companyId ?? null,
    parsed.periodStart,
    parsed.periodEnd,
  );
  res.json(summary);
});

// GET /bucket/:bucket
practiceClassificationRouter.get('/bucket/:bucket', async (req, res) => {
  const bucket = classificationBucketSchema.parse(req.params['bucket']);
  const parsed = bucketQuerySchema.parse({
    companyId: req.query['companyId'],
    periodStart: req.query['periodStart'],
    periodEnd: req.query['periodEnd'],
    cursor: req.query['cursor'],
    limit: req.query['limit'],
  });
  const result = await classificationService.listByBucket(req.tenantId, bucket, {
    companyId: parsed.companyId ?? null,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    cursor: parsed.cursor,
    limit: parsed.limit,
  });
  res.json(result);
});

// POST /approve — bulk approve selected state ids
practiceClassificationRouter.post(
  '/approve',
  validate(approveSelectedSchema),
  async (req, res) => {
    const result = await classificationService.approveSelected(
      req.tenantId,
      req.body.stateIds,
      req.userId,
    );
    await auditLog(
      req.tenantId,
      'update',
      'classification_state_approve',
      null,
      null,
      { approved: result.approved, failed: result.failed },
      req.userId,
    );
    res.json(result);
  },
);

// POST /approve-all — approve every row in a bucket for the given period.
// Must include confirm=true for auto_high to avoid a slip.
practiceClassificationRouter.post(
  '/approve-all',
  validate(approveAllSchema),
  async (req, res) => {
    const { bucket, companyId, periodStart, periodEnd, confirm } = req.body;
    if (bucket === 'auto_high' && confirm !== true) {
      throw AppError.badRequest(
        'Approve-all on auto_high bucket requires confirm=true',
        'CONFIRM_REQUIRED',
      );
    }
    // Iterate the bucket in pages so we don't materialize a huge
    // array in memory on a large close period.
    let approved: string[] = [];
    let failed: Array<{ stateId: string; reason: string }> = [];
    let cursor: string | undefined;
    const LIMIT = 200;
    // Bound loops at ~20k rows per call to stop abuse; realistic
    // close-period sizes are well under this.
    for (let i = 0; i < 100; i++) {
      const page = await classificationService.listByBucket(req.tenantId, bucket, {
        companyId: companyId ?? null,
        periodStart,
        periodEnd,
        cursor,
        limit: LIMIT,
      });
      if (page.rows.length === 0) break;
      const ids = page.rows.map((r) => r.stateId);
      const result = await classificationService.approveSelected(req.tenantId, ids, req.userId);
      approved = approved.concat(result.approved);
      failed = failed.concat(result.failed);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    await auditLog(
      req.tenantId,
      'update',
      'classification_state_approve_all',
      null,
      { bucket, periodStart, periodEnd },
      { approved: approved.length, failed: failed.length },
      req.userId,
    );
    res.json({ approved, failed });
  },
);

// POST /:stateId/reclassify
practiceClassificationRouter.post(
  '/:stateId/reclassify',
  validate(reclassifySchema),
  async (req, res) => {
    const stateId = req.params['stateId']!;
    const before = await classificationService.getById(req.tenantId, stateId);
    if (!before) throw AppError.notFound('Classification state not found');
    const after = await classificationService.reclassify(req.tenantId, stateId, req.body.bucket);
    await auditLog(
      req.tenantId,
      'update',
      'classification_state',
      stateId,
      { bucket: before.bucket },
      { bucket: after.bucket },
      req.userId,
    );
    res.json(after);
  },
);

// POST /:stateId/ask-client — bookkeeper opens a question against
// the unposted bank-feed item. Routes through the portal-question
// service so the same question surface used elsewhere (Phase 10
// Question System Core) shows it. assignedContactId is optional —
// when omitted, the question lives in the practice's open-questions
// queue until a contact is picked. Body required; per build plan
// §2.5 we include the bank-feed context (date, description, amount)
// inline so the bookkeeper doesn't have to retype it.
const askClientSchema = z.object({
  body: z.string().min(1).max(2000),
  assignedContactId: z.string().uuid().nullable().optional(),
});
practiceClassificationRouter.post(
  '/:stateId/ask-client',
  validate(askClientSchema),
  async (req, res) => {
    const stateId = req.params['stateId']!;
    const state = await classificationService.getById(req.tenantId, stateId);
    if (!state) throw AppError.notFound('Classification state not found');
    if (!state.companyId) {
      throw AppError.badRequest(
        'Bank feed item is not linked to a company; assign a company before asking the client.',
        'COMPANY_REQUIRED',
      );
    }

    // Pull the feed item so the question body can reference its
    // canonical date/description/amount even if the bookkeeper's
    // typed body doesn't repeat them.
    const item = await db.query.bankFeedItems.findFirst({
      where: and(
        eq(bankFeedItems.tenantId, req.tenantId),
        eq(bankFeedItems.id, state.bankFeedItemId),
      ),
    });
    if (!item) throw AppError.notFound('Bank feed item not found');

    const fmt = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
    });
    const contextLine = `Re: ${item.feedDate} · ${item.description ?? '(no description)'} · ${fmt.format(parseFloat(item.amount))}`;
    const fullBody = `${contextLine}\n\n${req.body.body}`;

    if (!req.userId) throw AppError.forbidden('Authentication required');
    const created = await portalQuestionService.createQuestion(req.tenantId, req.userId, {
      companyId: state.companyId,
      body: fullBody,
      assignedContactId: req.body.assignedContactId ?? null,
    });
    await auditLog(
      req.tenantId,
      'create',
      'classification_state_ask_client',
      stateId,
      null,
      { questionId: created.id, companyId: state.companyId },
      req.userId,
    );
    res.status(201).json({ questionId: created.id });
  },
);

// GET /manual-queue — items the system could not auto-classify
// (orphans + state rows in needs_review with no suggestion).
// Period scoping is by bank-feed feed_date.
practiceClassificationRouter.get('/manual-queue', async (req, res) => {
  const companyId = typeof req.query['companyId'] === 'string' ? req.query['companyId'] : null;
  const periodStart = typeof req.query['periodStart'] === 'string' ? req.query['periodStart'] : undefined;
  const periodEnd = typeof req.query['periodEnd'] === 'string' ? req.query['periodEnd'] : undefined;
  const limitRaw = typeof req.query['limit'] === 'string' ? Number(req.query['limit']) : undefined;
  const limit = Number.isFinite(limitRaw) && limitRaw! > 0 ? Math.min(limitRaw!, 500) : 100;
  const result = await classificationService.listManualQueue(req.tenantId, {
    companyId,
    periodStart,
    periodEnd,
    limit,
  });
  res.json(result);
});

// GET /:stateId/vendor-enrichment — cache-first lookup. The AI
// fallback is gated on AI_VENDOR_ENRICHMENT_V1; when the flag is
// off we still return cached rows so a prior tenant rollout that
// already populated the cache continues to surface, but no new AI
// calls fire.
practiceClassificationRouter.get('/:stateId/vendor-enrichment', async (req, res) => {
  const stateId = req.params['stateId']!;
  const state = await classificationService.getById(req.tenantId, stateId);
  if (!state) throw AppError.notFound('Classification state not found');

  const item = await db.query.bankFeedItems.findFirst({
    where: and(
      eq(bankFeedItems.tenantId, req.tenantId),
      eq(bankFeedItems.id, state.bankFeedItemId),
    ),
  });
  if (!item) throw AppError.notFound('Bank feed item not found');

  const description = item.originalDescription || item.description || '';
  const aiEnabled = await featureFlags.isEnabled(req.tenantId, 'AI_VENDOR_ENRICHMENT_V1');
  if (aiEnabled) {
    const { enrichment, source } = await vendorEnrichmentService.lookup(req.tenantId, description);
    res.json({ enrichment, source });
    return;
  }
  // Flag off: cache-only path. No AI call.
  const cached = await vendorEnrichmentService.readCache(req.tenantId, description);
  res.json({
    enrichment: cached,
    source: cached ? 'cache' : 'none',
  });
});
