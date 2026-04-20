// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import multer from 'multer';
import {
  bankFeedFiltersSchema, categorizeSchema, matchSchema,
  startReconciliationSchema, updateReconciliationLinesSchema, bankImportSchema,
  bulkApproveSchema, bulkCategorizeSchema, bulkExcludeSchema, bulkRecleanseSchema,
  createManualConnectionSchema, updateFeedItemSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as bankConnectionService from '../services/bank-connection.service.js';
import * as bankFeedService from '../services/bank-feed.service.js';
import * as reconciliationService from '../services/reconciliation.service.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

export const bankingRouter = Router();
bankingRouter.use(authenticate);
bankingRouter.use(companyContext);

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

  let items;
  if (ext.endsWith('.ofx') || ext.endsWith('.qfx')) {
    items = await bankFeedService.importFromOfx(req.tenantId, conn.id, content);
  } else {
    items = await bankFeedService.importFromCsv(req.tenantId, conn.id, content, parsedMapping);
  }

  // Cleansing + categorization pipelines are now handled inside the service

  res.status(201).json({ imported: items.length, items });
});

// ─── Reconciliation ──────────────────────────────────────────────

bankingRouter.get('/reconciliations', async (req, res) => {
  const history = await reconciliationService.getHistory(req.tenantId, req.query['account_id'] as string);
  res.json({ reconciliations: history });
});

bankingRouter.post('/reconciliations', validate(startReconciliationSchema), async (req, res) => {
  const recon = await reconciliationService.start(req.tenantId, req.body.accountId, req.body.statementDate, req.body.statementEndingBalance);
  res.status(201).json({ reconciliation: recon });
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
