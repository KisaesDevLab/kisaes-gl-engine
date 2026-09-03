// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Practice -> Uncategorized: one screen for everything not yet classified.
//
//   1. "Not posted"      bank-feed rows still at status='pending'
//   2. "In suspense"     posted transactions with a line on the suspense account
//   3. "Client suggested" categories portal contacts proposed (Phase C)
//
// A row travels 1 -> 2 when staff post it to suspense, and leaves 2 when
// staff pick a real category. Nothing here posts on its own.
//
// Guard stack is the practice-router convention plus one extra step:
// requireResource('banking'). The flag gate alone would let a bookkeeper
// whose permission matrix denies banking move money from this page, and
// every action here writes to the general ledger.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { requirePracticeAccess } from '../middleware/practice-access.js';
import { requireResource } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import { auditLog } from '../middleware/audit.js';
import * as suspenseService from '../services/suspense.service.js';
import * as bankFeedService from '../services/bank-feed.service.js';
import * as suggestionReview from '../services/client-suggestion-review.service.js';

export const uncategorizedRouter = Router();
uncategorizedRouter.use(authenticate);
uncategorizedRouter.use(companyContext);
uncategorizedRouter.use(requirePracticeAccess('UNCATEGORIZED_REVIEW_V1'));
uncategorizedRouter.use(requireResource('banking'));

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function optionalInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

// GET /summary — the header strip: suspense balance + both backlog counts.
// Deliberately read-only; opening the page must never mint the account.
uncategorizedRouter.get('/summary', async (req, res) => {
  const summary = await suspenseService.getSuspenseSummary(req.tenantId, req.companyId);
  res.json(summary);
});

// GET /unposted — tab 1. Bank-feed rows nobody has dealt with yet.
// Reuses the bank feed's own list query so this page and /banking/feed can
// never disagree about what "actionable" means.
uncategorizedRouter.get('/unposted', async (req, res) => {
  const result = await bankFeedService.list(req.tenantId, {
    status: 'pending',
    actionableOnly: true,
    bankConnectionId: optionalString(req.query['bankConnectionId']),
    startDate: optionalString(req.query['startDate']),
    endDate: optionalString(req.query['endDate']),
    search: optionalString(req.query['search']),
    limit: Math.min(Math.max(optionalInt(req.query['limit'], 50), 1), 500),
    offset: optionalInt(req.query['offset'], 0),
    ruleOnly: false,
  });
  res.json(result);
});

// GET /in-suspense — tab 2. Posted transactions still sitting in suspense.
uncategorizedRouter.get('/in-suspense', async (req, res) => {
  const result = await suspenseService.listInSuspense(req.tenantId, {
    companyId: req.companyId,
    startDate: optionalString(req.query['startDate']),
    endDate: optionalString(req.query['endDate']),
    search: optionalString(req.query['search']),
    limit: Math.min(optionalInt(req.query['limit'], 50), 500),
    offset: optionalInt(req.query['offset'], 0),
  });
  res.json(result);
});

// POST /post-to-suspense — move tab 1 rows into tab 2 so the bank
// reconciles. The destination is resolved by role server-side.
const postToSuspenseSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500),
});
uncategorizedRouter.post('/post-to-suspense', validate(postToSuspenseSchema), async (req, res) => {
  const result = await suspenseService.postFeedItemsToSuspense(
    req.tenantId, req.body.feedItemIds, req.userId, req.companyId,
  );
  await auditLog(
    req.tenantId, 'update', 'bank_feed_post_to_suspense', null, null,
    { posted: result.posted, skipped: result.skipped.length, failed: result.failures.length },
    req.userId,
  );
  res.json(result);
});

// POST /clear — tab 2's bulk action. Moves every suspense line on each
// transaction onto a real category account.
const clearSchema = z.object({
  transactionIds: z.array(z.string().uuid()).min(1).max(500),
  accountId: z.string().uuid(),
});
uncategorizedRouter.post('/clear', validate(clearSchema), async (req, res) => {
  const result = await suspenseService.clearSuspense(
    req.tenantId, req.body.transactionIds, req.body.accountId, req.userId, req.companyId,
  );
  await auditLog(
    req.tenantId, 'update', 'suspense_clear', null, null,
    { updated: result.updated, skipped: result.skipped.length, accountId: req.body.accountId },
    req.userId,
  );
  res.json(result);
});

// ── Tab 3: categories clients suggested ─────────────────────────
// Nothing here posted on its own. Approving runs the same primitives the
// rest of the app uses, so lock dates and reconciliation safety apply.

// GET /suggestions?companyId&status&unread=true&limit&offset
// `unread=true` is the same param name and predicate as
// /practice/document-requests, so the deep links match.
uncategorizedRouter.get('/suggestions', async (req, res) => {
  const result = await suggestionReview.listSuggestions(req.tenantId, {
    companyId: req.companyId,
    status: optionalString(req.query['status']),
    unread: req.query['unread'] === 'true',
    limit: Math.min(optionalInt(req.query['limit'], 50), 500),
    offset: optionalInt(req.query['offset'], 0),
  });
  res.json(result);
});

// POST /suggestions/approve — accept the client's pick, or override it.
// A row whose amount or date moved since the client answered comes back in
// `failed` as 'drifted' unless confirmDrift is set, so a bulk approve can
// never quietly post an amount nobody reviewed.
const approveSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  overrideAccountId: z.string().uuid().optional(),
  confirmDrift: z.boolean().optional(),
});
uncategorizedRouter.post('/suggestions/approve', validate(approveSchema), async (req, res) => {
  const result = await suggestionReview.approveSuggestions(
    req.tenantId, req.body.ids,
    { overrideAccountId: req.body.overrideAccountId, confirmDrift: req.body.confirmDrift },
    req.userId,
  );
  res.json(result);
});

const rejectSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  reason: z.string().min(1).max(1000),
});
uncategorizedRouter.post('/suggestions/reject', validate(rejectSchema), async (req, res) => {
  const result = await suggestionReview.rejectSuggestions(
    req.tenantId, req.body.ids, req.body.reason, req.userId,
  );
  res.json(result);
});

// POST /suggestions/mark-reviewed — clear the unread badge without posting.
const markReviewedSchema = z.object({
  ids: z.array(z.string().uuid()).max(500).optional(),
});
uncategorizedRouter.post('/suggestions/mark-reviewed', validate(markReviewedSchema), async (req, res) => {
  const result = await suggestionReview.markReviewed(
    req.tenantId, req.body.ids ?? null, req.companyId ?? null, req.userId,
  );
  res.json(result);
});
