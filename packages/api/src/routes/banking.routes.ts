// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import {
  bankFeedFiltersSchema, categorizeSchema, matchSchema,
  startReconciliationSchema, updateReconciliationLinesSchema, bankImportSchema,
  bulkApproveSchema, bulkCategorizeSchema, bulkExcludeSchema, bulkRecleanseSchema,
  createManualConnectionSchema, updateFeedItemSchema, bankStatementFiltersSchema,
  confirmStatementLineSchema, createFromStatementLineSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource } from '../middleware/permission.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as bankConnectionService from '../services/bank-connection.service.js';
import * as bankFeedService from '../services/bank-feed.service.js';
import * as reconciliationService from '../services/reconciliation.service.js';
import * as bankStatementsService from '../services/bank-statements.service.js';
import * as statementMatchService from '../services/statement-match.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const bankingRouter = Router();
bankingRouter.use(authenticate);
bankingRouter.use(companyContext);
bankingRouter.use(requireResource('banking'));

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

bankingRouter.get('/feed/:id/payroll-overlap', async (req, res) => {
  const item = await bankFeedService.getFeedItem(req.tenantId, req.params['id']!);
  if (!item) { res.json({ overlaps: [] }); return; }
  const conn = await bankFeedService.getConnectionForItem(req.tenantId, item.bankConnectionId);
  if (!conn) { res.json({ overlaps: [] }); return; }
  const overlaps = await bankFeedService.checkPayrollOverlap(
    req.tenantId, item.feedDate, Math.abs(parseFloat(item.amount)), conn.accountId,
  );
  res.json({ overlaps });
});

bankingRouter.put('/feed/:id/categorize', validate(categorizeSchema), async (req, res) => {
  const txn = await bankFeedService.categorize(req.tenantId, req.params['id']!, req.body, req.userId, req.companyId);
  res.json({ transaction: txn });
});

bankingRouter.put('/feed/:id/match', validate(matchSchema), async (req, res) => {
  await bankFeedService.match(req.tenantId, req.params['id']!, req.body.transactionId);
  res.json({ message: 'Matched' });
});

bankingRouter.get('/feed/:id/match-candidates', async (req, res) => {
  const candidates = await bankFeedService.findMatchCandidates(req.tenantId, req.params['id']!);
  res.json({ candidates });
});

bankingRouter.put('/feed/:id/exclude', async (req, res) => {
  await bankFeedService.exclude(req.tenantId, req.params['id']!);
  res.json({ message: 'Excluded' });
});

bankingRouter.post('/feed/bulk-approve', validate(bulkApproveSchema), async (req, res) => {
  const result = await bankFeedService.bulkApprove(req.tenantId, req.body.feedItemIds);
  res.json(result);
});

bankingRouter.post('/feed/bulk-categorize', validate(bulkCategorizeSchema), async (req, res) => {
  const { feedItemIds, accountId, contactId, memo, tagId } = req.body;
  const result = await bankFeedService.bulkCategorize(req.tenantId, feedItemIds, accountId, contactId, memo, tagId, req.userId, req.companyId);
  res.json(result);
});

// Bank Feed bulk "set name": overwrite the displayed description for selected items.
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

bankingRouter.post('/feed/bulk-exclude', validate(bulkExcludeSchema), async (req, res) => {
  const result = await bankFeedService.bulkExclude(req.tenantId, req.body.feedItemIds);
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

// Explicit backfill trigger (the statements list also runs it lazily).
bankingRouter.post('/statements/backfill', async (req, res) => {
  const result = await bankStatementsService.backfillBankStatements(req.tenantId);
  res.json(result);
});

// ─── Reconciliation ──────────────────────────────────────────────

bankingRouter.get('/reconciliations', async (req, res) => {
  const history = await reconciliationService.getHistory(req.tenantId, req.query['account_id'] as string);
  res.json({ reconciliations: history });
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

// Auto-clear the linked statement's transactions on the worksheet.
bankingRouter.post('/reconciliations/:id/auto-clear-statement', async (req, res) => {
  const result = await reconciliationService.autoClearStatement(req.tenantId, req.params['id']!, req.userId);
  res.json(result);
});

bankingRouter.get('/reconciliations/:id', async (req, res) => {
  const recon = await reconciliationService.getReconciliation(req.tenantId, req.params['id']!);
  res.json({ reconciliation: recon });
});

bankingRouter.put('/reconciliations/:id/lines', validate(updateReconciliationLinesSchema), async (req, res) => {
  const recon = await reconciliationService.updateLines(req.tenantId, req.params['id']!, req.body.lines);
  res.json({ reconciliation: recon });
});

bankingRouter.post('/reconciliations/:id/complete', async (req, res) => {
  await reconciliationService.complete(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Reconciliation complete' });
});

bankingRouter.post('/reconciliations/:id/undo', async (req, res) => {
  await reconciliationService.undo(req.tenantId, req.params['id']!);
  res.json({ message: 'Reconciliation undone' });
});
