// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { applyMatchSchema, notAMatchSchema } from '@kis-books/shared';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/audit.js';
import { requirePracticeAccess } from '../middleware/practice-access.js';
import { AppError } from '../utils/errors.js';
import * as matchApplyService from '../services/match-apply.service.js';
import * as classificationService from '../services/practice-classification.service.js';
import * as potentialMatchService from '../services/potential-match.service.js';
import { db } from '../db/index.js';
import { bankFeedItems } from '../db/schema/index.js';
import { and, eq } from 'drizzle-orm';

export const matchActionsRouter = Router();

matchActionsRouter.use(authenticate);
matchActionsRouter.use(requirePracticeAccess('AI_BUCKET_WORKFLOW_V1'));

// POST /:stateId/apply
matchActionsRouter.post(
  '/:stateId/apply',
  validate(applyMatchSchema),
  async (req, res) => {
    const stateId = req.params['stateId']!;
    const result = await matchApplyService.applyMatch(
      req.tenantId,
      stateId,
      req.body.candidateIndex,
      req.userId,
    );
    await auditLog(
      req.tenantId,
      'update',
      'classification_state_apply_match',
      stateId,
      null,
      result,
      req.userId,
    );
    res.json(result);
  },
);

// POST /:stateId/not-a-match
matchActionsRouter.post(
  '/:stateId/not-a-match',
  validate(notAMatchSchema),
  async (req, res) => {
    const stateId = req.params['stateId']!;
    const result = await matchApplyService.dropCandidate(
      req.tenantId,
      stateId,
      req.body.candidateIndex,
    );
    await auditLog(
      req.tenantId,
      'update',
      'classification_state_drop_candidate',
      stateId,
      { candidateIndex: req.body.candidateIndex },
      result,
      req.userId,
    );
    res.json(result);
  },
);

// POST /:stateId/rematch — re-run the matcher for a single state
// row. Useful when a bookkeeper has just created an invoice/bill
// they expect to match an existing pending feed item.
matchActionsRouter.post('/:stateId/rematch', async (req, res) => {
  const stateId = req.params['stateId']!;
  const state = await classificationService.getById(req.tenantId, stateId);
  if (!state) throw AppError.notFound('Classification state not found');
  const candidates = await potentialMatchService.findMatches(req.tenantId, state.bankFeedItemId);
  await classificationService.upsertStateForFeedItem(req.tenantId, state.bankFeedItemId, {
    matchCandidates: candidates,
  });
  res.json({ candidateCount: candidates.length, candidates });
});

// POST /admin/rematch-all-pending — tenant-scoped sweep.
// Mounted under the same router but as a super-admin-only path.
// Bounded by the caller's tenant so this can't fan out across
// tenants in shared-host setups.
matchActionsRouter.post(
  '/admin/rematch-all-pending',
  requireSuperAdmin,
  async (req, res) => {
    const items = await db
      .select({ id: bankFeedItems.id })
      .from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, req.tenantId), eq(bankFeedItems.status, 'pending')));

    let processed = 0;
    let failed = 0;
    for (const row of items) {
      try {
        const candidates = await potentialMatchService.findMatches(req.tenantId, row.id);
        await classificationService.upsertStateForFeedItem(req.tenantId, row.id, {
          matchCandidates: candidates,
        });
        processed++;
      } catch (err) {
        failed++;
        console.warn(
          `[rematch-all-pending] failed for ${row.id}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    await auditLog(
      req.tenantId,
      'update',
      'classification_state_rematch_all',
      null,
      { totalCandidates: items.length },
      { processed, failed },
      req.userId,
    );
    res.json({ processed, failed, total: items.length });
  },
);
