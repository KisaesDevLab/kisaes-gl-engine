import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  aiConfigUpdateSchema,
  aiCategorizeSchema,
  aiBatchCategorizeSchema,
  aiCategorizeAcceptSchema,
  aiOcrSchema,
  aiClassifySchema,
  aiParseStatementSchema,
  aiImportStatementSchema,
  aiPromptTemplateSchema,
  aiUpdatePromptTemplateSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireSuperAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as aiConfigService from '../services/ai-config.service.js';
import * as aiCategorization from '../services/ai-categorization.service.js';
import * as aiReceiptOcr from '../services/ai-receipt-ocr.service.js';
import * as aiStatementParser from '../services/ai-statement-parser.service.js';
import * as aiDocClassifier from '../services/ai-document-classifier.service.js';
import * as aiOrchestrator from '../services/ai-orchestrator.service.js';
import * as aiPrompt from '../services/ai-prompt.service.js';

export const aiRouter = Router();

// Per-user rate limit for AI processing endpoints. Each call hits a
// paid LLM, so uncapped access is a direct billing DoS. 60 requests
// per minute is generous for a human working through a bank feed but
// bounds the per-user cost ceiling.
const aiProcessingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).userId || req.ip || 'anonymous',
  message: {
    error: {
      message: 'Too many AI requests, please slow down',
      code: 'AI_RATE_LIMIT',
    },
  },
});

// ─── Admin — AI Configuration ──────────────────────────────────

aiRouter.get('/admin/config', authenticate, requireSuperAdmin, async (req, res) => {
  const config = await aiConfigService.getConfig();
  res.json(config);
});

aiRouter.put('/admin/config', authenticate, requireSuperAdmin, validate(aiConfigUpdateSchema), async (req, res) => {
  const config = await aiConfigService.updateConfig(req.body, req.userId);
  res.json(config);
});

aiRouter.post('/admin/test/:provider', authenticate, requireSuperAdmin, async (req, res) => {
  const result = await aiConfigService.testProvider(req.params['provider']!);
  res.json(result);
});

aiRouter.get('/admin/usage', authenticate, requireSuperAdmin, async (req, res) => {
  const months = parseInt(req.query['months'] as string) || 1;
  // Usage across all tenants
  const { sql } = await import('drizzle-orm');
  const { db } = await import('../db/index.js');
  // Sanitize months to a safe integer range to prevent SQL injection
  const safeMonths = Math.max(1, Math.min(months, 24));
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - safeMonths);
  const rows = await db.execute(sql`
    SELECT provider, job_type, COUNT(*) as calls, SUM(input_tokens) as input_tokens,
      SUM(output_tokens) as output_tokens, SUM(estimated_cost::numeric) as cost
    FROM ai_usage_log WHERE created_at >= ${cutoffDate.toISOString()}
    GROUP BY provider, job_type
  `);
  res.json({ rows: rows.rows });
});

// ─── Admin — Prompt Templates ──────────────────────────────────

aiRouter.get('/admin/prompts', authenticate, requireSuperAdmin, async (req, res) => {
  const prompts = await aiPrompt.listPrompts();
  res.json({ prompts });
});

aiRouter.post('/admin/prompts', authenticate, requireSuperAdmin, validate(aiPromptTemplateSchema), async (req, res) => {
  const prompt = await aiPrompt.createPrompt(req.body);
  res.status(201).json(prompt);
});

aiRouter.put('/admin/prompts/:id', authenticate, requireSuperAdmin, validate(aiUpdatePromptTemplateSchema), async (req, res) => {
  const prompt = await aiPrompt.updatePrompt(req.params['id']!, req.body);
  res.json(prompt);
});

aiRouter.delete('/admin/prompts/:id', authenticate, requireSuperAdmin, async (req, res) => {
  await aiPrompt.deletePrompt(req.params['id']!);
  res.json({ deleted: true });
});

// ─── Processing — Categorization ───────────────────────────────

aiRouter.post('/categorize', authenticate, aiProcessingLimiter, validate(aiCategorizeSchema), async (req, res) => {
  const result = await aiCategorization.categorize(req.tenantId, req.body.feedItemId);
  res.json(result || { error: 'Unable to categorize' });
});

aiRouter.post('/categorize/batch', authenticate, aiProcessingLimiter, validate(aiBatchCategorizeSchema), async (req, res) => {
  const results = await aiCategorization.batchCategorize(req.tenantId, req.body.feedItemIds);
  res.json({ results });
});

aiRouter.post('/categorize/accept', authenticate, validate(aiCategorizeAcceptSchema), async (req, res) => {
  await aiCategorization.recordUserDecision(
    req.tenantId, req.body.feedItemId, req.body.accountId,
    req.body.contactId ?? null, req.body.accepted, req.body.modified ?? false,
  );
  res.json({ recorded: true });
});

// ─── Processing — Receipt OCR ──────────────────────────────────

aiRouter.post('/ocr/receipt', authenticate, aiProcessingLimiter, validate(aiOcrSchema), async (req, res) => {
  const result = await aiReceiptOcr.processReceipt(req.tenantId, req.body.attachmentId);
  res.json(result);
});

// ─── Processing — Statement Parsing ────────────────────────────

aiRouter.post('/parse/statement', authenticate, aiProcessingLimiter, validate(aiParseStatementSchema), async (req, res) => {
  const result = await aiStatementParser.parseStatement(req.tenantId, req.body.attachmentId);
  res.json(result);
});

aiRouter.post('/parse/statement/import', authenticate, aiProcessingLimiter, validate(aiImportStatementSchema), async (req, res) => {
  const result = await aiStatementParser.importStatementTransactions(
    req.tenantId, req.body.bankConnectionId, req.body.transactions,
  );
  res.json(result);
});

// ─── Processing — Document Classification ──────────────────────

aiRouter.post('/classify', authenticate, aiProcessingLimiter, validate(aiClassifySchema), async (req, res) => {
  const result = await aiDocClassifier.classifyAndRoute(req.tenantId, req.body.attachmentId);
  res.json(result);
});

// ─── Feature availability (non-admin) ──────────────────────────
//
// A minimal, authenticated "can this user see AI features?" endpoint
// that every tenant user can hit — unlike /admin/config which is
// gated to super admins. Returns booleans only, no keys or provider
// details. The frontend uses this to decide whether to show the
// bill-OCR drop zone, receipt camera button, bank-statement AI
// importer, etc.
aiRouter.get('/status', authenticate, async (_req, res) => {
  const config = await aiConfigService.getConfig();
  const hasAnyProvider =
    !!config.categorizationProvider ||
    !!config.ocrProvider ||
    !!config.documentClassificationProvider;
  const hasAnyKey =
    config.hasAnthropicKey ||
    config.hasOpenaiKey ||
    config.hasGeminiKey ||
    !!config.ollamaBaseUrl;
  const ocrProvider = config.ocrProvider || config.categorizationProvider;
  res.json({
    isEnabled: config.isEnabled && hasAnyKey && hasAnyProvider,
    hasBillOcr: config.isEnabled && hasAnyKey && !!ocrProvider,
    hasReceiptOcr: config.isEnabled && hasAnyKey && !!ocrProvider,
    hasCategorization: config.isEnabled && hasAnyKey && !!config.categorizationProvider,
    hasStatementParser: config.isEnabled && hasAnyKey && !!ocrProvider,
    hasDocumentClassifier: config.isEnabled && hasAnyKey && !!config.documentClassificationProvider,
  });
});

// ─── Usage ─────────────────────────────────────────────────────

aiRouter.get('/usage', authenticate, async (req, res) => {
  const months = parseInt(req.query['months'] as string) || 1;
  const summary = await aiOrchestrator.getUsageSummary(req.tenantId, months);
  res.json(summary);
});
