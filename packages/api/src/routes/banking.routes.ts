// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  bankFeedFiltersSchema, categorizeSchema, matchSchema, assignSchema, bulkAssignSchema, bulkSetContactSchema,
  startReconciliationSchema, updateReconciliationLinesSchema, updateReconciliationSchema, bankImportSchema,
  bulkApproveSchema, bulkCategorizeSchema, bulkExcludeSchema, bulkRecleanseSchema,
  bulkPostToSuspenseSchema,
  bulkReprocessRulesSchema,
  createManualConnectionSchema, updateFeedItemSchema, bankStatementFiltersSchema,
  confirmStatementLineSchema, createFromStatementLineSchema, importOfxStatementSchema,
  feedDuplicateDecisionSchema, bankFeedCountsQuerySchema,
  can,
} from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission, requireResource, resolvePermissionsForRequest } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import * as importBatchService from '../services/bank-import/import-batch.service.js';
import { bankIdentityOf, IDENTITY_FIELD_MAX, type RawBankIdentity } from '../services/bank-import/link-key.js';
import { db as bankImportDb } from '../db/index.js';
import type { Request as ExpressRequest, Response as ExpressResponse, NextFunction as ExpressNext } from 'express';
import * as bankConnectionService from '../services/bank-connection.service.js';
import * as bankFeedService from '../services/bank-feed.service.js';
import * as ledgerService from '../services/ledger.service.js';
import * as depositSuggestions from '../services/deposit-suggestions.service.js';
import * as suspenseService from '../services/suspense.service.js';
import * as reconciliationService from '../services/reconciliation.service.js';
import * as reconciliationSignoffService from '../services/reconciliation-signoff.service.js';
import { buildReconciliationProof } from '../services/reconciliation-proof.service.js';
import * as bankStatementsService from '../services/bank-statements.service.js';
import * as statementMatchService from '../services/statement-match.service.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware, getLockContext } from '../services/lock-context.js';
import { precheckClosingPassword } from '../services/closing-password.service.js';
import { backfillCheckPayees, backfillFeedItemCheckPayees } from '../services/check-payee-backfill.service.js';
// Reuses the batch categorizer's contact→account resolver (contact default
// → most-recently-used category account) so the feed and batch entry share
// one source of truth. Exposed under /banking so it rides the 'banking'
// permission the feed already requires (batch's route needs 'batch_entry').
import { suggestAccountForContact } from '../services/batch.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const bankingRouter = Router();
bankingRouter.use(authenticate);
bankingRouter.use(companyContext);
// Banking permission from the method (requireResource), except two POSTs
// that only read (owner Q-P25ab): a bank file import dry run (dryRun: true
// exactly; a commit is a write) and the connection lookup, which take raw
// account numbers in the body rather than the query string (Q-P25u).
const bankingWrite = requireResource('banking');
const bankingRead = requirePermission('banking', 'read');
bankingRouter.use((req, res, next) => {
  const body = req.body as { dryRun?: unknown } | undefined;
  const readOnlyPost = req.method === 'POST'
    && (req.path === '/connections/lookup' || (req.path === '/feed/import-batch' && body?.dryRun === true));
  return (readOnlyPost ? bankingRead : bankingWrite)(req, res, next);
});

// ─── Bank Connections ────────────────────────────────────────────

bankingRouter.get('/connections', async (req, res) => {
  const connections = await bankConnectionService.list(req.tenantId);
  res.json({ connections });
});

bankingRouter.post('/connections/link-token', async (req, res) => {
  const result = await bankConnectionService.createLinkToken(req.tenantId);
  res.json(result);
});

bankingRouter.post('/connections', validate(createManualConnectionSchema), async (req, res) => {
  const conn = await bankConnectionService.createManualConnection(
    req.tenantId, req.body.accountId, req.body.institutionName || 'Manual Import',
  );
  res.status(201).json({ connection: conn });
});

bankingRouter.delete('/connections/:id', async (req, res) => {
  await bankConnectionService.disconnect(req.tenantId, req.params['id']!);
  res.json({ message: 'Disconnected' });
});

bankingRouter.post('/connections/:id/sync', async (req, res) => {
  const result = await bankConnectionService.sync(req.tenantId, req.params['id']!);
  res.json(result);
});

// ─── Bank Feed ───────────────────────────────────────────────────

bankingRouter.get('/feed', async (req, res) => {
  const filters = bankFeedFiltersSchema.parse(req.query);
  const result = await bankFeedService.list(req.tenantId, filters);
  res.json(result);
});

bankingRouter.put('/feed/:id', validate(updateFeedItemSchema), async (req, res) => {
  const item = await bankFeedService.updateFeedItem(req.tenantId, req.params['id']!, req.body);
  res.json({ item });
});

// Prefill the category account when a name (contact) is picked in the feed's
// expanded editor: the contact's configured default expense account, else the
// most-recently-used category account from a prior transaction with that
// contact. Returns { accountId, source } — accountId null when neither exists.
bankingRouter.get('/feed/suggest-account', async (req, res) => {
  const contactId = typeof req.query['contact_id'] === 'string' ? req.query['contact_id'] : '';
  if (!contactId) { res.status(400).json({ error: { message: 'contact_id is required' } }); return; }
  const result = await suggestAccountForContact(req.tenantId, contactId);
  res.json(result);
});

// U-174 (feed-review-v1): counts per review bucket and state, the same
// predicates as the list filters (one SQL builder), so they always agree.
bankingRouter.get('/feed/counts', describe({
  summary: 'Bank feed counts per review bucket and state (feed-review-v1)',
  description: 'Response {waiting, ready, review, matches, possibleDuplicate, accepted, entryVoided, excluded, inProgress}. '
    + 'waiting = ready + review + matches (pending and assigned rows), each equal to the total of GET /banking/feed?bucket=<b>. '
    + 'Buckets, first match wins: a possible duplicate is review; any match signal (a candidate journal line on the bank account, '
    + 'payroll lines included, or one Payments Clearing item for exactly a money-in amount within 10 days) is matches; no account, '
    + 'a non-rule suggestion under 0.80 confidence, a rule mark_for_review, or a staged split that cannot post is review; the rest '
    + 'is ready. accepted = categorized and matched rows (entryVoided included: Accepted, Entry voided, never waiting); inProgress = '
    + 'rows being posted. Scope: bankConnectionId, startDate, endDate.',
  query: bankFeedCountsQuerySchema,
}), async (req, res) => {
  const q = bankFeedCountsQuerySchema.parse(req.query);
  res.json(await bankFeedService.counts(req.tenantId, q));
});

// U-172: payroll entries this money-out line may already be, one row per
// bank line of the entry (exact, the U-166 line predicate).
bankingRouter.get('/feed/:id/payroll-overlap', describe({
  summary: 'Payroll bank lines a money-out feed item may already be (feed-match-v2)',
  description: 'Response {overlaps: [{txnId, journalLineId, memo, date, amount}]}: posted payroll-import entries within 5 days with a '
    + 'credit line on the bank account for exactly the amount (feed sign; money in has none), not held by another feed item. Each '
    + 'bank line of an entry (net pay, taxes) is its own row; match it with PUT /banking/feed/:id/match {transactionId, journalLineId}.',
}), async (req, res) => {
  const item = await bankFeedService.getFeedItem(req.tenantId, req.params['id']!);
  if (!item) { res.json({ overlaps: [] }); return; }
  const conn = await bankFeedService.getConnectionForItem(req.tenantId, item.bankConnectionId);
  if (!conn) { res.json({ overlaps: [] }); return; }
  const overlaps = await bankFeedService.checkPayrollOverlap(req.tenantId, item, conn.accountId);
  res.json({ overlaps });
});

// Closed period (U-165, feed-closing-date-v1): the routes that post a feed
// item take the same `closingPassword` (or a staff `overrideConfirmed`) as
// POST /transactions. closingPasswordLimiter runs before lockContextMiddleware
// takes the password out of the body. The bulk routes check the password
// once up front (a wrong one is 403 before anything posts, so the limiter
// counts it) and report a closed-period item as a failure with its code.
const FEED_CLOSED_PERIOD_NOTE = 'An item dated on or before the closing date needs `closingPassword` in the body (or a staff '
  + '`overrideConfirmed: true` when the company has no closing-date password): 423 TB_PERIOD_LOCKED (details: lockDate, '
  + 'canOverride, closingPasswordRequired), 403 CLOSING_PASSWORD_INVALID, 429 CLOSING_PASSWORD_RATE_LIMIT; an allowed one writes a '
  + 'closing_date_override audit row (feed-closing-date-v1).';
const FEED_BULK_CLOSED_PERIOD_NOTE = 'Closed period (feed-closing-date-v1): optional `closingPassword` (or a staff `overrideConfirmed: true`). '
  + 'A wrong password is 403 CLOSING_PASSWORD_INVALID before any item posts (429 CLOSING_PASSWORD_RATE_LIMIT after repeated failures). '
  + 'An item dated on or before the closing date without it is reported in `failures` as {id, error, code: "TB_PERIOD_LOCKED"}; '
  + 'every failure carries the error `code` when there is one.';

async function bulkClosingPasswordPrecheck(req: Request, _res: Response, next: NextFunction) {
  await precheckClosingPassword(req.tenantId, req.companyId, getLockContext());
  next();
}

// Exact splits (U-164, feed-exact-v1).
const FEED_SPLITS_NOTE = 'Optional `splits`: 2-50 lines {accountId, amount (^\\d{1,12}(\\.\\d{1,2})?$, more than 0), tagId?|null, memo? '
  + '(at most 500)} that must add up exactly to the item amount (absolute value), else 400 SPLITS_DONT_BALANCE (details {kind: '
  + '"fixed", difference, splitTotal, amount}; difference = |amount| - the lines). An item amount with more than 2 decimals cannot '
  + 'be split: 400 AMOUNT_NOT_CENTS. Sending accountId without `splits` means one line on accountId: a split a rule staged on the '
  + 'item is not used. A staged rule percentage split (used by bulk approve) must total exactly 100 (else 400 SPLITS_DONT_BALANCE {kind: '
  + '"percentage", percentTotal}) and is allocated in cents by largest remainder, equal remainders settled by line order '
  + '(100.00 at 33.334 / 33.333 / 33.333% = 33.34 / 33.33 / 33.33; 0.03 at 50 / 50% = 0.02 / 0.01); a staged fixed split is rounded to cents half away from zero and must '
  + 'add up exactly. Amounts post exactly as stored (no floating point).';

// Idempotency-Key (feed-idempotency-v1, U-173): optional on the single-item
// posting and matching routes, required on the review decisions. Each route
// claims the key in its one database transaction; a retry with the key
// replays the stored response. Not on the bulk routes (the desktop doesn't
// post through them).
const FEED_NOT_PENDING_NOTE = 'An item that is not waiting for this action is 409 FEED_ITEM_NOT_PENDING {status} (feed-idempotency-v1; '
  + 'was 400).';
const feedKeyedTxn = idempotent({
  successStatus: 200,
  replay: async (req, entity) => ({
    transaction: entity ? await ledgerService.getTransaction(req.tenantId, entity.id, req.companyId) : null,
  }),
});
const feedKeyed = idempotent({ successStatus: 200 });

/** The review decisions take an Idempotency-Key always (400 IDEMPOTENCY_KEY_REQUIRED). */
function requireIdempotencyKey(req: Request, _res: Response, next: NextFunction) {
  if (req.get('Idempotency-Key') === undefined) {
    throw AppError.badRequest('This action needs an Idempotency-Key header.', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  next();
}

bankingRouter.put('/feed/:id/categorize', closingPasswordLimiter, lockContextMiddleware, feedKeyedTxn, validate(categorizeSchema), describe({
  summary: 'Categorize (post) a bank feed item',
  description: 'Response {transaction}. Takes a pending or assigned item (feed-idempotency-v1); the claim, the posting and the '
    + 'status change are one database transaction. ' + FEED_NOT_PENDING_NOTE + ' ' + FEED_SPLITS_NOTE + ' ' + FEED_CLOSED_PERIOD_NOTE,
}), async (req, res) => {
  const txn = await bankFeedService.categorize(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId, { ownerChoice: true });
  res.json({ transaction: txn });
});

// Two-phase workflow: ASSIGN stages a category (no ledger post); APPROVE
// posts the staged assignment.
bankingRouter.put('/feed/:id/assign', validate(assignSchema), describe({
  summary: 'Stage a category (and optional split) on a bank feed item without posting',
  description: 'Response {item}. Approve posts what is staged. ' + FEED_SPLITS_NOTE
    + ' Without `splits`, any staged split is cleared. ' + FEED_NOT_PENDING_NOTE,
}), async (req, res) => {
  const item = await bankFeedService.assign(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ item });
});

bankingRouter.post('/feed/:id/approve', closingPasswordLimiter, lockContextMiddleware, feedKeyedTxn, describe({
  summary: 'Approve (post) a bank feed item\'s assigned category',
  description: 'Response {transaction}. Takes an assigned item; the claim, the posting and the status change are one database '
    + 'transaction. ' + FEED_NOT_PENDING_NOTE + ' ' + FEED_CLOSED_PERIOD_NOTE,
}), async (req, res) => {
  const txn = await bankFeedService.approve(req.tenantId, req.params['id']!, req.userId, req.companyId);
  res.json({ transaction: txn });
});

bankingRouter.put('/feed/:id/match', feedKeyed, validate(matchSchema), describe({
  summary: 'Match a bank feed item to a line of a posted entry (feed-match-v2)',
  description: 'Body {transactionId, journalLineId?}. Response {message, item}. The item is pending or assigned; it matches one '
    + 'journal line of the posted entry: on the item\'s bank account, a credit for money out (feed amount > 0) or a debit for money '
    + 'in (< 0), for exactly the amount. journalLineId may be left out when only one line fits (else 400 LINE_REQUIRED '
    + '{journalLineIds}). 400 MATCH_MISMATCH {field: transactionId | journalLineId | account | amount}; 409 LINE_ALREADY_MATCHED '
    + '{journalLineId} when another item holds the line; ' + FEED_NOT_PENDING_NOTE + ' Audited.',
  body: matchSchema,
}), async (req, res) => {
  const item = await bankFeedService.match(req.tenantId, req.params['id']!, req.body.transactionId, {
    journalLineId: req.body.journalLineId, userId: req.userId, companyId: req.companyId,
  });
  res.json({ message: 'Matched', item });
});

// U-174 (feed-review-v1): Keep both / Remove this one on a possible duplicate.
bankingRouter.post('/feed/:id/duplicate', requireIdempotencyKey, feedKeyed, validate(feedDuplicateDecisionSchema), describe({
  summary: 'Decide a possible duplicate: keep both or remove this one (feed-review-v1)',
  description: 'Body {decision: keep | remove}. Response {item, decision}. keep clears the possible-duplicate flag (the row waits for '
    + 'review as usual); remove excludes the row with exclusionReason "duplicate" (the flag stays; Restore brings it back undecided). '
    + 'An import Undo counts a row removed as a duplicate as untouched. Only a waiting (pending or assigned) row flagged as a possible '
    + 'duplicate: else 409 NOT_A_POSSIBLE_DUPLICATE {status, possibleDuplicate}. Needs an Idempotency-Key (400 '
    + 'IDEMPOTENCY_KEY_REQUIRED). Audited.',
  body: feedDuplicateDecisionSchema,
}), async (req, res) => {
  res.json(await bankFeedService.decideDuplicate(req.tenantId, req.params['id']!, req.body.decision, req.userId, req.companyId));
});

// Q-P26u (feed-match-v2): a row whose entry was voided goes back to waiting.
bankingRouter.post('/feed/:id/review-again', requireIdempotencyKey, feedKeyed, describe({
  summary: 'Review again a bank feed item whose entry was voided (feed-match-v2)',
  description: 'Response {item}. Voiding an entry a feed item points at is allowed: the item keeps its status and link and is flagged '
    + 'entryVoided (list filter entryVoided=true, /counts entryVoided, audit row). This unlinks it (clears the entry, its line and the '
    + 'flag) and puts it back to pending with its suggestion and without staged values, audited. The void entry stays void. 409 '
    + 'ENTRY_NOT_VOIDED {status} on any other row. Needs an Idempotency-Key (400 IDEMPOTENCY_KEY_REQUIRED). No closing-date password '
    + '(nothing in the books changes).',
}), async (req, res) => {
  const item = await bankFeedService.reviewAgain(req.tenantId, req.params['id']!, req.userId, req.companyId);
  res.json({ item });
});

// Deposit suggestions (U-56, feed-deposit-groupings-v1): sets of items
// waiting in Payments Clearing (±10 days) that add up to this feed
// deposit exactly. Read-only; company-scoped; bounded search. The sets
// list customer payments, so the caller also needs receive_payment (read),
// the resource that guards the pending-deposits list itself.
bankingRouter.get('/feed/:id/deposit-groupings', requirePermission('receive_payment', 'read'), describe({
  summary: 'Payments Clearing sets that add up to a bank-feed deposit (feed-deposit-groupings-v1)',
  description: 'Permissions: banking and receive_payment (read).',
  params: z.object({ id: z.string().uuid() }),
  query: z.object({ limit: z.coerce.number().int().min(1).max(20).optional() }),
}), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params['id']);
  if (!id.success) throw AppError.badRequest('Invalid feed item id', 'VALIDATION_ERROR');
  const limit = z.coerce.number().int().min(1).max(20).optional().safeParse(req.query['limit']);
  if (!limit.success) throw AppError.badRequest('limit must be 1 to 20', 'VALIDATION_ERROR');
  res.json(await depositSuggestions.findDepositGroupings(req.tenantId, req.companyId, id.data, { limit: limit.data }));
});

bankingRouter.get('/feed/:id/match-candidates', describe({
  summary: 'Journal lines a bank feed item may match (feed-match-v2)',
  description: 'Response {candidates: [{id (the entry), journalLineId, txnType, txnNumber, txnDate, total, amount (feed sign), memo, '
    + 'lineDescription, checkNumber, printStatus, source, contactName}]}: lines on the item\'s bank account, a credit for money out '
    + 'or a debit for money in, for exactly the amount, on posted entries within 15 days, not held by another feed item. One row per '
    + 'line (a payroll entry with two bank lines is two rows). Bill payments first, then by date distance.',
}), async (req, res) => {
  const candidates = await bankFeedService.findMatchCandidates(req.tenantId, req.params['id']!);
  res.json({ candidates });
});

bankingRouter.put('/feed/:id/exclude', describe({
  summary: 'Exclude a bank feed item',
  description: 'A pending or assigned item only: ' + FEED_NOT_PENDING_NOTE + ' Audited.',
}), async (req, res) => {
  await bankFeedService.exclude(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Excluded' });
});

// Undo an exclusion. The confirm dialog has always promised this was possible;
// until now nothing implemented it.
bankingRouter.put('/feed/:id/unexclude', describe({
  summary: 'Restore an excluded bank feed item',
  description: 'An excluded item goes back to pending (a row removed as a duplicate comes back still flagged). Any other item: '
    + FEED_NOT_PENDING_NOTE + ' Audited.',
}), async (req, res) => {
  await bankFeedService.unexclude(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Restored' });
});


bankingRouter.post('/feed/bulk-unexclude', validate(bulkExcludeSchema), async (req, res) => {
  const result = await bankFeedService.bulkUnexclude(req.tenantId, req.body.feedItemIds, req.userId);
  res.json(result);
});

bankingRouter.post('/feed/bulk-approve', closingPasswordLimiter, lockContextMiddleware, validate(bulkApproveSchema), describe({
  summary: 'Approve (post) many bank feed items',
  description: 'Response {approved, skipped, failed, failures: [{id, error, code?}]}. ' + FEED_BULK_CLOSED_PERIOD_NOTE,
}), bulkClosingPasswordPrecheck, async (req, res) => {
  // Now posts STAGED ('assigned') items (two-phase workflow); items not yet
  // assigned are skipped, never posted.
  const result = await bankFeedService.bulkApprove(req.tenantId, req.body.feedItemIds, req.userId, req.companyId);
  res.json(result);
});

// Bulk ASSIGN — stage the same category across many pending/assigned items.
bankingRouter.post('/feed/bulk-assign', validate(bulkAssignSchema), async (req, res) => {
  const { feedItemIds, accountId, contactId, tagId, memo } = req.body;
  const result = await bankFeedService.bulkAssign(
    req.tenantId, feedItemIds, { accountId, contactId, tagId, memo }, req.userId,
  );
  res.json(result);
});

bankingRouter.post('/feed/bulk-categorize', closingPasswordLimiter, lockContextMiddleware, validate(bulkCategorizeSchema), describe({
  summary: 'Categorize (post) many bank feed items to one account',
  description: 'Response {categorized, failures: [{id, error, code?}]}. ' + FEED_BULK_CLOSED_PERIOD_NOTE,
}), bulkClosingPasswordPrecheck, async (req, res) => {
  const { feedItemIds, accountId, contactId, memo, tagId } = req.body;
  const result = await bankFeedService.bulkCategorize(req.tenantId, feedItemIds, accountId, contactId, memo, tagId, req.userId, req.companyId);
  res.json(result);
});

// Post selected PENDING rows to the suspense account. The books stay
// complete (the bank reconciles) while the classification work moves to
// Practice -> Uncategorized. The destination account is resolved by role
// server-side; the request carries no account id.
bankingRouter.post('/feed/bulk-post-to-suspense', closingPasswordLimiter, lockContextMiddleware, validate(bulkPostToSuspenseSchema), describe({
  summary: 'Post many pending bank feed items to the suspense account',
  description: 'Response {suspenseAccountId, posted, skipped, failures: [{id, error, code?}]}. ' + FEED_BULK_CLOSED_PERIOD_NOTE,
}), bulkClosingPasswordPrecheck, async (req, res) => {
  const result = await suspenseService.postFeedItemsToSuspense(
    req.tenantId, req.body.feedItemIds, req.userId, req.companyId,
  );
  res.json(result);
});

// Bank Feed bulk "set name": overwrite the displayed description for selected items.
// Bulk "Set payee" from the Uncategorized page: one contact onto many
// still-pending lines, without staging them (see bankFeedService.bulkSetContact).
bankingRouter.post('/feed/bulk-set-contact', validate(bulkSetContactSchema), async (req, res) => {
  const { feedItemIds, contactId } = req.body as { feedItemIds: string[]; contactId: string | null };
  const result = await bankFeedService.bulkSetContact(req.tenantId, feedItemIds, contactId);
  res.json(result);
});

bankingRouter.post('/feed/bulk-set-name', async (req, res) => {
  const { feedItemIds, name } = req.body as { feedItemIds?: string[]; name?: string };
  if (!Array.isArray(feedItemIds) || feedItemIds.length === 0) {
    res.status(400).json({ error: { message: 'feedItemIds array required' } });
    return;
  }
  if (typeof name !== 'string' || !name.trim()) {
    res.status(400).json({ error: { message: 'name required' } });
    return;
  }
  const result = await bankFeedService.bulkSetName(req.tenantId, feedItemIds, name);
  res.json(result);
});

// ADR 0XX §7 — Bank Feed bulk "set tag" on already-categorized feed items.
bankingRouter.post('/feed/bulk-set-tag', async (req, res) => {
  const { feedItemIds, tagId } = req.body as { feedItemIds?: string[]; tagId?: string | null };
  if (!Array.isArray(feedItemIds) || feedItemIds.length === 0) {
    res.status(400).json({ error: { message: 'feedItemIds array required' } });
    return;
  }
  const result = await bankFeedService.bulkSetTag(req.tenantId, feedItemIds, tagId ?? null);
  res.json(result);
});

bankingRouter.post('/feed/bulk-recleanse', validate(bulkRecleanseSchema), async (req, res) => {
  const result = await bankFeedService.bulkRecleanse(req.tenantId, req.body.feedItemIds);
  res.json(result);
});

// "Reprocess Rules" — re-run the rules stages (conditional + legacy bank
// rules; NOT the AI or potential-match stages) over pending feed items so
// a rule created after import applies to the backlog.
bankingRouter.post('/feed/bulk-reprocess-rules', validate(bulkReprocessRulesSchema), async (req, res) => {
  const { feedItemIds, allPending, bankConnectionId } = req.body;
  const result = await bankFeedService.reprocessRules(
    req.tenantId,
    { feedItemIds, allPending, bankConnectionId },
    req.userId,
    req.companyId,
  );
  res.json(result);
});

bankingRouter.post('/feed/bulk-exclude', validate(bulkExcludeSchema), async (req, res) => {
  const result = await bankFeedService.bulkExclude(req.tenantId, req.body.feedItemIds, req.userId);
  res.json(result);
});

bankingRouter.post('/feed/import', upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: { message: 'No file' } }); return; }

  // Validate the multipart form body. Multer parses into req.body as plain
  // strings/Buffers, so we run a Zod check here rather than via the route
  // middleware (which assumes application/json bodies).
  const { accountId, mapping } = req.body as { accountId?: unknown; mapping?: unknown };
  if (typeof accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
    res.status(400).json({ error: { message: 'accountId must be a UUID', code: 'VALIDATION_ERROR' } });
    return;
  }

  // mapping may arrive as a JSON string (when the form encodes it), as an
  // object (rare — depends on client), or absent. A bad JSON payload used to
  // crash the handler with an unhandled SyntaxError → generic 500.
  let parsedMapping: { date: number; description: number; amount: number } = { date: 0, description: 1, amount: 2 };
  if (mapping !== undefined) {
    try {
      const raw = typeof mapping === 'string' ? JSON.parse(mapping) : mapping;
      const d = Number(raw?.date);
      const desc = Number(raw?.description);
      const amt = Number(raw?.amount);
      if (!Number.isInteger(d) || !Number.isInteger(desc) || !Number.isInteger(amt) || d < 0 || desc < 0 || amt < 0) {
        throw new Error('mapping must have integer date/description/amount columns');
      }
      parsedMapping = { date: d, description: desc, amount: amt };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid mapping';
      res.status(400).json({ error: { message: `Invalid mapping: ${msg}`, code: 'VALIDATION_ERROR' } });
      return;
    }
  }

  // Ensure we have a bank connection for this account
  let connections = await bankConnectionService.list(req.tenantId);
  let conn = connections.find((c) => c.accountId === accountId);
  if (!conn) {
    const created = await bankConnectionService.createManualConnection(req.tenantId, accountId, 'CSV Import');
    if (!created) { res.status(500).json({ error: { message: 'Failed to create connection' } }); return; }
    connections = await bankConnectionService.list(req.tenantId);
    conn = connections.find((c) => c.accountId === accountId);
  }
  if (!conn) { res.status(500).json({ error: { message: 'Failed to create connection' } }); return; }

  const content = req.file.buffer.toString('utf-8');
  const ext = req.file.originalname.toLowerCase();

  // Optional import date range (YYYY-MM-DD). Rows outside [startDate, endDate]
  // are skipped. Either bound may be omitted; a bad format is rejected.
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  const { startDate, endDate } = req.body as { startDate?: unknown; endDate?: unknown };
  for (const [k, v] of [['startDate', startDate], ['endDate', endDate]] as const) {
    if (v !== undefined && v !== '' && !(typeof v === 'string' && dateRe.test(v))) {
      res.status(400).json({ error: { message: `${k} must be YYYY-MM-DD`, code: 'VALIDATION_ERROR' } });
      return;
    }
  }
  const dateRange = {
    start: typeof startDate === 'string' && startDate ? startDate : null,
    end: typeof endDate === 'string' && endDate ? endDate : null,
  };

  const result = (ext.endsWith('.ofx') || ext.endsWith('.qfx'))
    ? await bankFeedService.importFromOfx(req.tenantId, conn.id, content, dateRange)
    : await bankFeedService.importFromCsv(req.tenantId, conn.id, content, parsedMapping, dateRange);

  // Cleansing + categorization pipelines are handled inside the service;
  // `cleansing` (additive) reports whether the AI cleanup step degraded.
  res.status(201).json({ imported: result.items.length, items: result.items, cleansing: result.cleansing });
});

// ─── Bank file import batches (U-06, bank-import-batch-v1) ───────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const CSV_MAPPING_MAX = 16_384;
const identityField = z.string().max(IDENTITY_FIELD_MAX);
const rawBankIdentitySchema = z.object({
  bankId: identityField.nullish().describe('OFX BANKID (routing number); optional'),
  acctId: identityField.refine((s) => s.trim() !== '', 'acctId is empty').describe('OFX ACCTID (account number)'),
}).strict();

/**
 * Takes the raw BANKID / ACCTID out of the request body before anything
 * else reads it (Q-P25u): the Idempotency-Key request hash, validation
 * errors and logs never see them. They wait in res.locals for the handler;
 * the body keeps an HMAC under the company's link key (when the company
 * has one) so a retry with another account is still a different request.
 */
async function takeBankIdentity(req: ExpressRequest, res: ExpressResponse, next: ExpressNext): Promise<void> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object' || !('bankIdentity' in body)) { next(); return; }
  const raw = body['bankIdentity'];
  delete body['bankIdentity'];
  if (raw == null) { next(); return; }
  const parsed = rawBankIdentitySchema.safeParse(raw);
  if (!parsed.success) {
    // No input values in the message or details.
    throw AppError.badRequest('bankIdentity needs acctId (and optionally bankId), each at most 64 characters.', 'VALIDATION_ERROR', {
      field: 'bankIdentity',
    });
  }
  res.locals['bankIdentity'] = parsed.data;
  if (body['dryRun'] === false && req.companyId) {
    const ident = await bankIdentityOf(bankImportDb, req.tenantId, req.companyId, parsed.data, true);
    body['bankIdentityRef'] = ident.accountKeyHash;
  }
  next();
}
const importBatchRowSchema = z.object({
  line: z.number().int().min(1).describe('line (or entry) number in the source file, echoed in results and errors'),
  date: isoDate,
  amount: z.string().describe('decimal string, feed sign (positive = money out), at most 12 integer digits and 2 decimals, not zero'),
  description: z.string().describe('bank description (OFX/QFX: NAME only; MEMO goes in memo, dedupe_v1.json), at most 500 characters'),
  memo: z.string().nullish().describe('at most 1,000 characters; not part of any key'),
  checkNumber: z.number().int().min(0).max(999_999_999).nullish(),
  fitid: z.string().max(255).nullish().describe('the bank transaction id (OFX FITID)'),
  include: z.boolean().optional().describe('false skips a new or possible_duplicate row (both are inserted by default)'),
  changedAction: z.enum(['replace', 'add']).optional().describe('for a changed row: replace the existing pending item, or add the row as new'),
});
const importBatchSchema = z.object({
  accountId: z.string().uuid(),
  format: z.enum(['ofx', 'qfx', 'qif', 'csv']),
  fileName: z.string().min(1).max(255).describe('base file name only'),
  sourceFileSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sectionIndex: z.number().int().min(0),
  sectionStart: isoDate.nullish(),
  sectionEnd: isoDate.nullish(),
  amountsFlipped: z.boolean(),
  csvMapping: z.record(z.unknown()).nullish()
    .refine((m) => m == null || JSON.stringify(m).length <= CSV_MAPPING_MAX, `at most ${CSV_MAPPING_MAX} characters as JSON`)
    .describe(`the CSV column mapping, kept with the batch; at most ${CSV_MAPPING_MAX} characters as JSON`),
  dryRun: z.boolean(),
  relinkIdentity: z.boolean().optional(),
  bankIdentity: rawBankIdentitySchema.nullish().describe(
    'the file\'s raw OFX BANKID and ACCTID (loopback only, Q-P25u). The engine keeps only the last 4 characters of ACCTID '
    + 'and an HMAC of "v1|" + trim(bankId or "") + "|" + trim(acctId) under the company\'s link key; the raw values are never '
    + 'stored, logged, audited or kept with an Idempotency-Key',
  ),
  fileEndingBalance: z.string().regex(importBatchService.AMOUNT_RE, 'at most 12 digits before and 2 after the decimal point').nullish()
    .describe("decimal string in the holder's sign (after any flip)"),
  fileEndingDate: isoDate.nullish(),
  rows: z.array(importBatchRowSchema),
});

const importRowResultSchema = z.object({
  line: z.number().int(),
  status: z.enum(['new', 'duplicate', 'possible_duplicate', 'changed']),
  reason: z.enum(['same_bank_id', 'same_row', 'repeated_bank_id', 'bank_id_reused', 'similar_existing']).optional(),
  existingItemId: z.string().uuid().optional(),
  existingImportedAt: z.string().optional(),
  existingPending: z.boolean().optional(),
  existingAmount: z.string().optional()
    .describe('changed rows only (Q-P25af): the existing item\'s amount before this batch, decimal string in the feed sign, at least 2 decimals'),
  existingDate: z.string().optional().describe('changed rows only (Q-P25af): the existing item\'s date (YYYY-MM-DD) before this batch'),
  closedPeriod: z.boolean(),
  inserted: z.boolean(),
  replaced: z.boolean().optional(),
});
const importBatchResponseSchema = z.object({
  batchId: z.string().uuid().optional().describe('commit only'),
  sameFileImportedAt: z.string().optional(),
  identityLinkedElsewhere: z.object({ accountName: z.string(), mask: z.string() }).optional().describe('dry run only'),
  insertedItemIds: z.array(z.string().uuid()),
  postProcessing: z.enum(['scheduled', 'done', 'failed', 'cancelled']).optional(),
  rows: z.array(importRowResultSchema),
  counts: z.object({
    inFile: z.number().int(), new: z.number().int(), duplicate: z.number().int(), possibleDuplicate: z.number().int(),
    changed: z.number().int(), closedPeriod: z.number().int(), inserted: z.number().int(),
  }),
  insertedTotal: z.string(),
  balanceCheck: z.object({
    fileBalance: z.string(), fileDate: z.string(), booksAtDate: z.string(), pendingTotal: z.string(), newTotal: z.string(),
    likelyInBooks: z.object({ count: z.number().int(), total: z.string() }), projected: z.string(), difference: z.string(),
  }).optional(),
});

const IMPORT_BATCH_DESCRIPTION = 'bank-import-batch-v1 (U-06). One account section of a parsed bank file. The engine computes the '
  + 'dedupe keys v1 (dedupe_v1.json), every row\'s status, the closed-period flag and the balance check; it never posts and never '
  + 'calls AI. dryRun:true previews and changes nothing (an Idempotency-Key is 400 IDEMPOTENCY_KEY_NOT_ALLOWED); dryRun:false commits '
  + 'and requires an Idempotency-Key (400 IDEMPOTENCY_KEY_REQUIRED). A commit always records a batch, inserts the new rows, the '
  + 'possible duplicates (flagged possibleDuplicate with possibleDuplicateOf on the feed item; include:false skips a row) and changed '
  + 'rows with changedAction "add" into the account\'s manual bank connection (exact duplicates are never inserted), and schedules '
  + 'post-processing (cleansing without AI; a matching rule is staged as a suggestion, never posted). Errors: 422 account_not_bank_or_card, '
  + 'account_not_in_company, invalid_row (details {line, field}), too_many_rows (over 20,000), batch_total_too_large; 409 '
  + 'identity_linked_elsewhere (details {accountName, mask}) unless relinkIdentity; 400 VALIDATION_ERROR; 413 over the 10 MB body '
  + 'limit; Idempotency-Key: 422 IDEMPOTENCY_KEY_REUSED, 409 IDEMPOTENCY_IN_PROGRESS, 400 IDEMPOTENCY_KEY_INVALID. Balance check '
  + '(when fileEndingBalance and fileEndingDate are sent): bank projected = booksAtDate - pendingTotal - newTotal; card (amounts owed) '
  + 'projected = booksAtDate + pendingTotal + newTotal, difference = -fileBalance - projected. Permission: a dry run needs read on '
  + 'banking, a commit needs write (Q-P25ab). bankIdentity {bankId?, acctId} is raw (loopback only, Q-P25u): the engine links '
  + 'the account by an HMAC under the company link key (made on the first commit) and the last 4 characters of acctId, and keeps '
  + 'neither raw value. A replay (Idempotency-Key) shows the live postProcessing state (scheduled, done, failed, or cancelled when '
  + 'an undo stopped it); GET /feed/import-batches shows its progress (processed of total). A changed row carries the existing item\'s '
  + 'amount and date before this batch (existingAmount, existingDate; dry run and commit) so old and new can be shown side by side.';

const importBatchListSchema = z.object({
  batches: z.array(z.object({
    id: z.string().uuid(), accountId: z.string().uuid(), bankConnectionId: z.string().uuid(), format: z.enum(['ofx', 'qfx', 'qif', 'csv']),
    fileName: z.string(), sourceFileSha256: z.string(), sectionIndex: z.number().int(), sectionStart: z.string().nullable(),
    sectionEnd: z.string().nullable(), amountsFlipped: z.boolean(), csvMapping: z.record(z.unknown()).nullable(),
    fileEndingBalance: z.string().nullable(), fileEndingDate: z.string().nullable(),
    counts: z.object({
      inFile: z.number().int(), new: z.number().int(), duplicate: z.number().int(), possibleDuplicate: z.number().int(),
      changed: z.number().int(), closedPeriod: z.number().int(), inserted: z.number().int(),
    }),
    insertedTotal: z.string(),
    postProcessing: z.enum(['scheduled', 'done', 'failed', 'cancelled'])
      .describe('scheduled while suggestions are prepared; cancelled when an undo stopped it'),
    processed: z.number().int().describe('items post-processed so far (Q-P25ad)'),
    total: z.number().int().nullable().describe('items to post-process; null until post-processing starts'),
    undoneAt: z.string().nullable(), createdAt: z.string(),
  })),
});

bankingRouter.post('/feed/import-batch', takeBankIdentity, idempotent({
  successStatus: 200,
  liveReplay: true,
  replay: async (req, entity) => importBatchService.readBatchResult(req.tenantId, entity!.id),
}), validate(importBatchSchema), describe({
  summary: 'Import a bank file section: preview (dry run) or commit',
  description: IMPORT_BATCH_DESCRIPTION,
  body: importBatchSchema,
  response: importBatchResponseSchema,
}), async (req, res) => {
  const input: importBatchService.BatchInput = {
    ...(req.body as importBatchService.BatchInput),
    bankIdentity: (res.locals['bankIdentity'] as RawBankIdentity | undefined) ?? null,
  };
  const hasKey = req.get('Idempotency-Key') !== undefined;
  if (input.dryRun && hasKey) {
    throw AppError.badRequest('A dry run takes no Idempotency-Key.', 'IDEMPOTENCY_KEY_NOT_ALLOWED');
  }
  if (!input.dryRun && !hasKey) {
    throw AppError.badRequest('Committing an import needs an Idempotency-Key header.', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  const actor = { tenantId: req.tenantId, companyId: req.companyId, userId: req.userId };
  if (input.dryRun) {
    res.json(await importBatchService.previewBatch(actor, input));
    return;
  }
  const result = await importBatchService.commitBatch(actor, input);
  res.json(result);
  if (result.batchId && result.postProcessing === 'scheduled') {
    importBatchService.schedulePostProcessing(req.tenantId, result.batchId);
  }
});

bankingRouter.get('/feed/import-batches', describe({
  summary: 'List bank file import batches, newest first (bank-import-batch-v1)',
  description: 'Response {batches: [{id, accountId, bankConnectionId, format, fileName, sourceFileSha256, sectionIndex, sectionStart, '
    + 'sectionEnd, amountsFlipped, csvMapping, fileEndingBalance, fileEndingDate, counts, insertedTotal, postProcessing, processed, total, '
    + 'undoneAt, createdAt}]}. Amounts are decimal strings. processed of total is the post-processing progress, raised after each chunk '
    + '(total is null until it starts); postProcessing is scheduled, done, failed or cancelled (an undo stopped it).',
  query: z.object({
    accountId: z.string().uuid().optional(),
    format: z.enum(['ofx', 'qfx', 'qif', 'csv']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }),
  response: importBatchListSchema,
}), async (req, res) => {
  const q = z.object({
    accountId: z.string().uuid().optional(),
    format: z.enum(['ofx', 'qfx', 'qif', 'csv']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  }).safeParse(req.query);
  if (!q.success) throw AppError.badRequest('Invalid query', 'VALIDATION_ERROR');
  res.json({ batches: await importBatchService.listBatches({ tenantId: req.tenantId, companyId: req.companyId }, q.data) });
});

bankingRouter.delete('/feed/import-batches/:id', idempotent({ successStatus: 200 }), describe({
  summary: 'Undo a bank file import batch (bank-import-batch-v1)',
  description: 'Removes the batch\'s untouched pending rows (never assigned, matched or posted) and gives the items its changed rows '
    + 'replaced their values back while they are pending, untouched and as the batch left them. Response {batchId, removed, restored, '
    + 'kept, undoneAt}. A replaced item already used counts as used (its line in this batch\'s file). '
    + '409 rows_already_used (details {lines}) when some rows were already used, unless ?pendingOnly=true (then only the untouched rows '
    + 'go); 409 already_undone; 404 NOT_FOUND. Audited. Idempotency-Key optional. While post-processing runs, the undo stops it after '
    + 'its current chunk and then undoes (postProcessing becomes cancelled); when the undo does not go through, post-processing goes '
    + 'on. 409 still_preparing only when post-processing did not stop within 20 s: nothing was undone, try again.',
  params: z.object({ id: z.string().uuid() }),
  query: z.object({ pendingOnly: z.enum(['true', 'false']).optional() }),
}), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params['id']);
  if (!id.success) throw AppError.badRequest('Invalid batch id', 'VALIDATION_ERROR');
  const pendingOnly = req.query['pendingOnly'] === 'true';
  res.json(await importBatchService.undoBatch({ tenantId: req.tenantId, companyId: req.companyId, userId: req.userId }, id.data, pendingOnly));
});

const connectionLookupSchema = z.object({
  bankId: identityField.nullish().describe('OFX BANKID; optional'),
  acctId: identityField.optional().describe('OFX ACCTID: matched through the company link key; never kept'),
  mask: z.string().min(1).max(10).optional().describe('a masked number (at most 4 digits); default: the last 4 of acctId'),
}).strict();

bankingRouter.post('/connections/lookup', describe({
  summary: 'Find the bank connection a bank file belongs to (bank-import-batch-v1)',
  description: 'Body {bankId?, acctId?, mask?} (raw numbers travel in the body, never the query string; Q-P25u). First the '
    + 'connections whose identity saved by an earlier import matches bankId/acctId (an HMAC under the company link key; never '
    + 'creates the key), else the connections with the mask (default: the last 4 characters of acctId). Company-scoped. Needs '
    + 'read permission on banking (Q-P25ab). Response {matches: [{connectionId, accountId, accountName, mask, via: "hash"|"mask"}]}. '
    + '400 VALIDATION_ERROR when neither acctId nor mask is given, or the mask shows more than 4 digits. Nothing is stored.',
  body: connectionLookupSchema,
}), async (req, res) => {
  const q = connectionLookupSchema.safeParse(req.body ?? {});
  if (!q.success || (!q.data.acctId?.trim() && !q.data.mask)) {
    throw AppError.badRequest('Give acctId or mask', 'VALIDATION_ERROR');
  }
  res.json({ matches: await importBatchService.lookupConnections({ tenantId: req.tenantId, companyId: req.companyId }, q.data) });
});

// ─── Bank Statements (statement-driven reconciliation) ───────────

bankingRouter.get('/statements', async (req, res) => {
  const filters = bankStatementFiltersSchema.parse({
    accountId: req.query['account_id'] || undefined,
    limit: req.query['limit'] || undefined,
    offset: req.query['offset'] || undefined,
  });
  // Lazy, idempotent backfill of statement records from historical
  // completed parse jobs (at most one scan per tenant per process).
  await bankStatementsService.ensureBackfill(req.tenantId);
  const result = await bankStatementsService.listStatements(req.tenantId, filters);
  res.json(result);
});

// Account auto-suggest for the statement upload flow: given the parsed
// masked account number, return the account the most recent statement with
// the same masked number was imported into.
bankingRouter.get('/statements/suggest-account', async (req, res) => {
  const masked = String(req.query['masked'] ?? '');
  const suggestion = masked ? await bankStatementsService.suggestAccountForMasked(req.tenantId, masked) : null;
  res.json({ suggestion });
});

// Reconcile-only import of an OFX/QFX/QBO bank download: parses the file
// synchronously (no OCR/AI) into a bank_statements row + statement lines
// for the match engine. Nothing lands in the bank feed. When accountId is
// omitted and the file's masked account number has no prior statement to
// infer from, responds { needsAccount: true, summary } and the client
// re-posts with the user's account choice.
bankingRouter.post('/statements/import-ofx', validate(importOfxStatementSchema), async (req, res) => {
  const result = await bankStatementsService.importStatementFromOfx(req.tenantId, {
    content: req.body.content,
    accountId: req.body.accountId,
    fileName: req.body.fileName,
    userId: req.userId,
  });
  res.status('needsAccount' in result && result.needsAccount ? 200 : 201).json(result);
});

// Dismiss / restore "no statement on file for YYYY-MM" gap warnings.
const statementGapsSchema = z.object({
  accountId: z.string().uuid(),
  months: z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)).max(240).optional(),
});
bankingRouter.post('/statements/gaps/dismiss', validate(statementGapsSchema), async (req, res) => {
  const result = await bankStatementsService.dismissStatementGaps(
    req.tenantId, req.userId, req.body.accountId, req.body.months ?? [],
  );
  res.json(result);
});
bankingRouter.post('/statements/gaps/restore', validate(statementGapsSchema), async (req, res) => {
  const result = await bankStatementsService.restoreStatementGaps(
    req.tenantId, req.userId, req.body.accountId, req.body.months,
  );
  res.json(result);
});

// Explicit backfill trigger (the statements list also runs it lazily).
bankingRouter.post('/statements/backfill', async (req, res) => {
  const result = await bankStatementsService.backfillBankStatements(req.tenantId);
  res.json(result);
});

// ─── Reconciliation ──────────────────────────────────────────────

bankingRouter.get('/reconciliations', async (req, res) => {
  const history = await reconciliationService.getHistory(req.tenantId, req.query['account_id'] as string);
  // Electronic sign-off badges (migration 0214); staleness evaluated here.
  const signoffs = await reconciliationSignoffService.getReconSignoffsForMany(
    req.tenantId, history.map((r) => ({ id: r.id, status: r.status })),
  );
  res.json({ reconciliations: history.map((r) => ({ ...r, signoffs: signoffs.get(r.id) })) });
});

bankingRouter.post('/reconciliations', validate(startReconciliationSchema), async (req, res) => {
  const recon = await reconciliationService.start(
    req.tenantId, req.body.accountId, req.body.statementDate, req.body.statementEndingBalance,
    { statementId: req.body.statementId },
  );
  res.status(201).json({ reconciliation: recon });
});

// ─── Statement Match Engine (wave 1) ─────────────────────────────

// Run the scored matcher against the linked statement's lines and apply:
// AUTO matches clear their worksheet lines; SUGGEST matches persist for the
// picker; the response carries suggestions / unmatched / outstanding.
bankingRouter.post('/reconciliations/:id/match-statement', async (req, res) => {
  const result = await statementMatchService.matchStatement(
    req.tenantId, req.params['id']!, { apply: true, userId: req.userId },
  );
  res.json(result);
});

// Persisted match state for the worksheet (render after reload).
bankingRouter.get('/reconciliations/:id/statement-matches', async (req, res) => {
  const result = await statementMatchService.getStatementMatches(req.tenantId, req.params['id']!);
  res.json(result);
});

// Confirm a suggested (or explicitly chosen) worksheet journal line for a
// statement line — clears the worksheet line. Wave 2 grouped forms:
// journalLineIds (2..5) confirms a one-statement-line ↔ many-worksheet-lines
// set; journalLineId + memberStatementLineIds confirms a many-statement-
// lines ↔ one-worksheet-line set from the primary line.
bankingRouter.post('/statement-lines/:lineId/confirm', validate(confirmStatementLineSchema), async (req, res) => {
  const { journalLineId, journalLineIds, memberStatementLineIds } = req.body as {
    journalLineId?: string; journalLineIds?: string[]; memberStatementLineIds?: string[];
  };
  let line;
  if (journalLineIds) {
    line = await statementMatchService.confirmStatementLineGroup(
      req.tenantId, req.params['lineId']!, journalLineIds, req.userId,
    );
  } else if (memberStatementLineIds) {
    line = await statementMatchService.confirmStatementLineManyToOne(
      req.tenantId, req.params['lineId']!, journalLineId!, memberStatementLineIds, req.userId,
    );
  } else {
    line = await statementMatchService.confirmStatementLine(
      req.tenantId, req.params['lineId']!, journalLineId!, req.userId,
    );
  }
  res.json({ line });
});

// Wave 2 Feature B: create a posted transaction from an unmatched statement
// line ("Add to books"), clear it on the worksheet, and confirm the line.
bankingRouter.post('/statement-lines/:lineId/create-transaction', validate(createFromStatementLineSchema), async (req, res) => {
  const result = await statementMatchService.createTransactionFromStatementLine(
    req.tenantId, req.params['lineId']!, req.body, req.userId, req.companyId,
  );
  res.status(201).json(result);
});

// Reject a suggestion (worksheet line untouched).
bankingRouter.post('/statement-lines/:lineId/reject', async (req, res) => {
  const line = await statementMatchService.rejectStatementLine(req.tenantId, req.params['lineId']!, req.userId);
  res.json({ line });
});

// Exclude an OCR-error / non-transaction statement line (hides it from the
// "not in your books" list and from re-matching). Restore = /unexclude.
bankingRouter.post('/statement-lines/:lineId/exclude', async (req, res) => {
  const line = await statementMatchService.setStatementLineExcluded(req.tenantId, req.params['lineId']!, true, req.userId);
  res.json({ line });
});
bankingRouter.post('/statement-lines/:lineId/unexclude', async (req, res) => {
  const line = await statementMatchService.setStatementLineExcluded(req.tenantId, req.params['lineId']!, false, req.userId);
  res.json({ line });
});

// Auto-clear the linked statement's transactions on the worksheet.
bankingRouter.post('/reconciliations/:id/auto-clear-statement', async (req, res) => {
  const result = await reconciliationService.autoClearStatement(req.tenantId, req.params['id']!, req.userId);
  res.json(result);
});

// STATEMENT_CHECK_PAYEE_V2: manually resolve the payee on a statement line
// (reconcile's "missing checks with no payee"). Also stamps the payee onto
// the matched transaction when one is linked and still payee-less.
bankingRouter.patch('/statement-lines/:lineId/payee', async (req, res) => {
  const payee = String(req.body?.payee ?? '').trim().slice(0, 255);
  if (!payee) {
    res.status(400).json({ error: { message: 'payee is required', code: 'VALIDATION_ERROR' } });
    return;
  }
  const result = await statementMatchService.setStatementLinePayee(
    req.tenantId, req.params['lineId']!, payee, req.userId,
  );
  res.json(result);
});

// Correct a misread amount on an unmatched statement line (signed: money in
// positive, money out negative — the line's stored orientation).
bankingRouter.patch('/statement-lines/:lineId/amount', async (req, res) => {
  const amount = String(req.body?.amount ?? '').trim();
  if (!amount) {
    res.status(400).json({ error: { message: 'amount is required', code: 'VALIDATION_ERROR' } });
    return;
  }
  const result = await statementMatchService.setStatementLineAmount(
    req.tenantId, req.params['lineId']!, amount, req.userId,
  );
  res.json(result);
});

// STATEMENT_CHECK_PAYEE_V2: backfill payees onto existing posted check
// transactions (from statement lines + the payroll check register), with an
// optional re-scan of stored statement PDFs through the check-image pass.
bankingRouter.post('/check-payees/backfill', async (req, res) => {
  const report = await backfillCheckPayees(
    req.tenantId,
    // Company-scoped like every sibling banking endpoint: check numbers
    // restart at ~1001 per account, so an unscoped run can stamp one
    // company's payees onto another company's checks.
    { rescan: req.body?.rescan === true, companyId: req.companyId ?? null },
    req.userId,
  );
  res.json(report);
});

// STATEMENT_CHECK_PAYEE_FEED: fill payee (and, where prior coding is
// unambiguous, the category) on UNPOSTED check rows in the bank feed, using
// statement lines already on file. The sibling /check-payees/backfill above
// repairs posted transactions; this repairs the feed rows that never got a
// payee because the statement was parsed after they arrived.
//
// Defaults to a dry run: the write path can auto-create vendor contacts, so
// the caller sees the proposed matches before anything is written.
bankingRouter.post('/feed/backfill-check-payees', async (req, res) => {
  const report = await backfillFeedItemCheckPayees(
    req.tenantId,
    {
      dryRun: req.body?.dryRun !== false,
      createMissingContacts: req.body?.createMissingContacts !== false,
      // Company-scoped like every sibling banking endpoint — check numbers
      // restart per account, so an unscoped run could cross companies.
      companyId: req.companyId ?? null,
    },
    req.userId,
  );
  res.json(report);
});

// Professional bank-to-books reconciliation (statement → adjusted bank
// balance → balance per books → unreconciled difference, schedules, book-side
// proof). The Reconcile screen polls this alongside the worksheet so the
// panel updates live while items are cleared.
bankingRouter.get('/reconciliations/:id/proof', async (req, res) => {
  const proof = await buildReconciliationProof(req.tenantId, req.params['id']!);
  res.json({ proof });
});

// Electronic sign-off (migration 0214): Preparer, then a different firm-staff
// Reviewer, on a completed reconciliation. GET is a read (banking:read via the
// router guard); POST / DELETE need banking write. The service enforces the
// order / different-person / firm-staff / own-signature rules.
const reconSignoffRoleSchema = z.object({ role: z.enum(['preparer', 'reviewer']) });

bankingRouter.get('/reconciliations/:id/signoffs', async (req, res) => {
  const canWrite = can(await resolvePermissionsForRequest(req), 'banking', 'update');
  const view = await reconciliationSignoffService.getReconSignoffView(req.tenantId, req.params['id']!, {
    userId: req.userId, isSuperAdmin: !!req.isSuperAdmin, canWrite,
  });
  res.json(view);
});

bankingRouter.post('/reconciliations/:id/signoffs', validate(reconSignoffRoleSchema), async (req, res) => {
  const signoffs = await reconciliationSignoffService.signReconciliation(
    req.tenantId, req.params['id']!, req.body.role, { userId: req.userId, isSuperAdmin: !!req.isSuperAdmin },
  );
  res.status(201).json({ signoffs });
});

bankingRouter.delete('/reconciliations/:id/signoffs/:role', async (req, res) => {
  const parsed = reconSignoffRoleSchema.safeParse({ role: req.params['role'] });
  if (!parsed.success) throw AppError.badRequest('role must be preparer or reviewer', 'VALIDATION_ERROR');
  const signoffs = await reconciliationSignoffService.removeReconSignoff(
    req.tenantId, req.params['id']!, parsed.data.role, { userId: req.userId, isSuperAdmin: !!req.isSuperAdmin },
  );
  res.json({ signoffs });
});

bankingRouter.get('/reconciliations/:id', async (req, res) => {
  const recon = await reconciliationService.getReconciliation(req.tenantId, req.params['id']!);
  res.json({ reconciliation: recon });
});

// Edit header fields (statement ending balance) on an in-progress rec.
bankingRouter.patch('/reconciliations/:id', validate(updateReconciliationSchema), async (req, res) => {
  const recon = await reconciliationService.updateHeader(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ reconciliation: recon });
});

bankingRouter.put('/reconciliations/:id/lines', validate(updateReconciliationLinesSchema), async (req, res) => {
  const recon = await reconciliationService.updateLines(req.tenantId, req.params['id']!, req.body.lines);
  res.json({ reconciliation: recon });
});

// Cancel (discard) an in-progress rec so the account can start fresh.
bankingRouter.post('/reconciliations/:id/cancel', async (req, res) => {
  await reconciliationService.cancel(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Reconciliation canceled' });
});

// Pull transactions added after start into the worksheet.
bankingRouter.post('/reconciliations/:id/refresh', async (req, res) => {
  const result = await reconciliationService.refreshLines(req.tenantId, req.params['id']!);
  res.json(result);
});

bankingRouter.post('/reconciliations/:id/complete', async (req, res) => {
  await reconciliationService.complete(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Reconciliation complete' });
});

bankingRouter.post('/reconciliations/:id/undo', async (req, res) => {
  await reconciliationService.undo(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Reconciliation undone' });
});
