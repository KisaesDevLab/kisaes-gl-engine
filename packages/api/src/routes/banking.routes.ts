import { Router } from 'express';
import multer from 'multer';
import { bankFeedFiltersSchema, categorizeSchema, matchSchema, startReconciliationSchema, updateReconciliationLinesSchema, bankImportSchema } from '@kis-books/shared';
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

bankingRouter.post('/connections', async (req, res) => {
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

bankingRouter.put('/feed/:id', async (req, res) => {
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

bankingRouter.post('/feed/bulk-approve', async (req, res) => {
  const result = await bankFeedService.bulkApprove(req.tenantId, req.body.feedItemIds);
  res.json(result);
});

bankingRouter.post('/feed/bulk-categorize', async (req, res) => {
  const { feedItemIds, accountId, contactId, memo } = req.body;
  if (!feedItemIds?.length || !accountId) {
    res.status(400).json({ error: { message: 'feedItemIds and accountId are required' } });
    return;
  }
  const result = await bankFeedService.bulkCategorize(req.tenantId, feedItemIds, accountId, contactId, memo, req.userId, req.companyId);
  res.json(result);
});

bankingRouter.post('/feed/bulk-recleanse', async (req, res) => {
  const { feedItemIds } = req.body;
  if (!feedItemIds?.length) {
    res.status(400).json({ error: { message: 'feedItemIds is required' } });
    return;
  }
  const result = await bankFeedService.bulkRecleanse(req.tenantId, feedItemIds);
  res.json(result);
});

bankingRouter.post('/feed/bulk-exclude', async (req, res) => {
  const { feedItemIds } = req.body;
  if (!feedItemIds?.length) {
    res.status(400).json({ error: { message: 'feedItemIds is required' } });
    return;
  }
  const result = await bankFeedService.bulkExclude(req.tenantId, feedItemIds);
  res.json(result);
});

bankingRouter.post('/feed/import', upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: { message: 'No file' } }); return; }

  const { accountId, mapping } = req.body;

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
    const parsedMapping = typeof mapping === 'string' ? JSON.parse(mapping) : (mapping || { date: 0, description: 1, amount: 2 });
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
