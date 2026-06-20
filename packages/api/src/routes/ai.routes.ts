// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
  aiTaskTogglesSchema,
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
import * as aiConsent from '../services/ai-consent.service.js';
import { AppError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { db } from '../db/index.js';
import { companies } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';

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

// Tighter rate limit for the admin test endpoint. testProvider hits
// real upstream APIs (Anthropic, OpenAI, etc.) with a "ping" message —
// a hostile or compromised super-admin session could otherwise exhaust
// the per-key quota on the configured upstream. 10/minute per user is
// enough for an admin manually checking provider status while bounding
// the worst case.
//
// Keyed on userId (not tenant) per the plan's risk callout — super
// admin actions are global, and tenants don't apply here.
const aiAdminTestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).userId || req.ip || 'anonymous',
  message: {
    error: {
      message: 'Too many provider test requests — wait a moment before retrying',
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

// Read-only self-test action: runs testConnection for every task that
// has a provider configured. Reuses aiAdminTestLimiter so a stuck admin
// browser hitting "Run self-test" 11 times in a minute can't burn
// upstream quotas; each call internally does up to 4 testProvider runs.
aiRouter.post('/admin/test-all', authenticate, requireSuperAdmin, aiAdminTestLimiter, async (req, res) => {
  const result = await aiConfigService.testAll();
  log.warn({
    component: 'ai',
    event: 'ai_self_test_all',
    userId: req.userId, ip: req.ip, at: result.runAt,
    summary: result.rows.map((r) => ({ task: r.task, provider: r.provider, success: r.success, skipped: r.skipped })),
  });
  res.json(result);
});

aiRouter.post('/admin/test/:provider', authenticate, requireSuperAdmin, aiAdminTestLimiter, async (req, res) => {
  const provider = req.params['provider']!;
  const result = await aiConfigService.testProvider(provider);
  // audit_log is tenant-scoped and doesn't fit a super-admin action;
  // a structured warn keeps the trail grep-able from operator logs.
  log.warn({
    component: 'ai',
    event: 'ai_provider_test',
    provider, success: result.success, error: result.error,
    userId: req.userId, ip: req.ip,
  });
  res.json(result);
});

// Real end-to-end test for a single function ("task"). Runs an actual
// JSON completion through the function's resolved provider + options +
// thinking + timeout + fallback chain, unlike test/:provider which only
// checks reachability. Surfaces the per-provider error detail.
const AI_FUNCTION_KEYS = ['categorization', 'ocr', 'document_classification', 'chat'] as const;
aiRouter.post('/admin/test-function/:fn', authenticate, requireSuperAdmin, aiAdminTestLimiter, async (req, res) => {
  const fn = req.params['fn'] as (typeof AI_FUNCTION_KEYS)[number];
  if (!AI_FUNCTION_KEYS.includes(fn)) {
    return res.status(400).json({ error: `Unknown function. Expected one of: ${AI_FUNCTION_KEYS.join(', ')}` });
  }
  const result = await aiConfigService.testFunction(fn);
  log.warn({
    component: 'ai',
    event: 'ai_function_test',
    fn, provider: result.provider, success: result.success, error: result.error,
    userId: req.userId, ip: req.ip,
  });
  return res.json(result);
});

// ─── Admin — System AI Disclosure (Tier 1) ─────────────────────
//
// The super admin must accept this before ai_config.is_enabled can
// flip to true (enforced inside updateConfig). Version bumps happen
// via invalidateCompanyConsent when data-flow config changes.

aiRouter.get('/admin/disclosure', authenticate, requireSuperAdmin, async (_req, res) => {
  const d = await aiConsent.getSystemDisclosure();
  res.json(d);
});

aiRouter.post('/admin/disclosure/accept', authenticate, requireSuperAdmin, async (req, res) => {
  await aiConsent.acceptSystemDisclosure(req.userId!);
  const d = await aiConsent.getSystemDisclosure();
  res.json(d);
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
  // categorize() throws AppError on AI failure; null is reserved for
  // the "no description, nothing to categorize" case.
  const result = await aiCategorization.categorize(req.tenantId, req.body.feedItemId);
  if (result) {
    res.json(result);
    return;
  }
  res.json({ accountId: null, reason: 'no_description' });
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
// Non-admin diagnostics view. Returns the latest cached test result
// per task→provider so a company owner can self-diagnose ("which AI
// features will work for me right now?") without contacting the super
// admin. Read-only — does NOT ping upstream. The admin can refresh the
// matrix with `POST /admin/test-all` from System Settings.
//
// Non-super-admins get a sanitized view (no `error` / `modelInfo`)
// because upstream error messages can leak keys, IPs, or other internal
// detail.
aiRouter.get('/diagnostics', authenticate, async (req, res) => {
  const result = await aiConfigService.getDiagnostics();
  if (req.isSuperAdmin) {
    res.json(result);
    return;
  }
  const sanitized = {
    ...result,
    rows: result.rows.map((row) => {
      // Keep status/task/provider/lastVerifiedAt — those are informational.
      // Drop `error` and `modelInfo` which can leak provider-internal data.
      const { error: _error, modelInfo: _modelInfo, ...safe } = row;
      return safe;
    }),
  };
  res.json(sanitized);
});

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
    !!config.ollamaBaseUrl ||
    // openai_compat is configured by URL — its base URL being set is
    // equivalent to "credentials present" for readiness purposes. (An
    // optional bearer key may also be configured.)
    !!config.openaiCompatBaseUrl;
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

// ─── Company AI Consent (Tier 2) ───────────────────────────────
//
// Per-tenant endpoints for the company owner. Disclosure text is
// generated dynamically from the current system config so the owner
// always sees which providers will handle their data when they accept.

aiRouter.get('/consent', authenticate, async (req, res) => {
  const status = await aiConsent.getTenantConsentStatus(req.tenantId);
  res.json(status);
});

// Verify a companyId belongs to the authenticated tenant before
// proceeding. Without this, a member of tenant A could accept consent
// on behalf of a company owned by tenant B.
async function assertCompanyInTenant(tenantId: string, companyId: string): Promise<void> {
  const [row] = await db.select({ id: companies.id }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  if (!row) {
    throw AppError.notFound('Company not found in this tenant');
  }
}

aiRouter.get('/consent/:companyId/disclosure', authenticate, async (req, res) => {
  const companyId = req.params['companyId']!;
  await assertCompanyInTenant(req.tenantId, companyId);
  const d = await aiConsent.getCompanyDisclosure(req.tenantId, companyId);
  res.json(d);
});

aiRouter.post('/consent/:companyId/accept', authenticate, async (req, res) => {
  const companyId = req.params['companyId']!;
  await assertCompanyInTenant(req.tenantId, companyId);
  const d = await aiConsent.acceptCompanyDisclosure(req.tenantId, companyId, req.userId!);
  res.json(d);
});

aiRouter.post('/consent/:companyId/revoke', authenticate, async (req, res) => {
  const companyId = req.params['companyId']!;
  await assertCompanyInTenant(req.tenantId, companyId);
  await aiConsent.revokeCompanyConsent(req.tenantId, companyId, req.userId!);
  res.json({ revoked: true });
});

aiRouter.patch('/consent/:companyId/tasks', authenticate, validate(aiTaskTogglesSchema), async (req, res) => {
  const companyId = req.params['companyId']!;
  await assertCompanyInTenant(req.tenantId, companyId);
  const toggles = req.body as Partial<Record<aiConsent.AiTaskKey, boolean>>;
  const next = await aiConsent.setCompanyTaskToggles(req.tenantId, companyId, toggles, req.userId!);
  res.json({ tasks: next });
});

// ─── Usage ─────────────────────────────────────────────────────

aiRouter.get('/usage', authenticate, async (req, res) => {
  const months = parseInt(req.query['months'] as string) || 1;
  const summary = await aiOrchestrator.getUsageSummary(req.tenantId, months);
  res.json(summary);
});
