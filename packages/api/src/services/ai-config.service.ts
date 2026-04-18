// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiConfig } from '../db/schema/index.js';
import { encrypt } from '../utils/encryption.js';
import { assertExternalUrlSafe } from '../utils/url-safety.js';
import { AppError } from '../utils/errors.js';
import * as aiConsent from './ai-consent.service.js';

async function getOrCreateConfig() {
  let config = await db.query.aiConfig.findFirst();
  if (!config) {
    const [created] = await db.insert(aiConfig).values({
      piiProtectionLevel: 'strict',
      cloudVisionEnabled: false,
      disclosureVersion: 1,
    }).returning();
    config = created!;
    // Seed default prompt templates on first config creation
    try {
      const { seedDefaultPrompts } = await import('./ai-prompt.service.js');
      await seedDefaultPrompts();
    } catch { /* seed is best-effort */ }
  }
  return config;
}

export async function getConfig() {
  const config = await getOrCreateConfig();
  return {
    isEnabled: config.isEnabled || false,
    categorizationProvider: config.categorizationProvider,
    categorizationModel: config.categorizationModel,
    ocrProvider: config.ocrProvider,
    ocrModel: config.ocrModel,
    documentClassificationProvider: config.documentClassificationProvider,
    documentClassificationModel: config.documentClassificationModel,
    fallbackChain: (config.fallbackChain as string[]) || ['anthropic', 'openai', 'gemini', 'ollama'],
    hasAnthropicKey: !!config.anthropicApiKeyEncrypted,
    hasOpenaiKey: !!config.openaiApiKeyEncrypted,
    hasGeminiKey: !!config.geminiApiKeyEncrypted,
    ollamaBaseUrl: config.ollamaBaseUrl,
    hasGlmOcrKey: !!config.glmOcrApiKeyEncrypted,
    glmOcrBaseUrl: config.glmOcrBaseUrl,
    // Generic OpenAI-compatible server — Ollama /v1, llama.cpp, LM
    // Studio, vLLM, etc. Key returned as a boolean flag; plaintext
    // round-trips via the write path only.
    openaiCompatBaseUrl: config.openaiCompatBaseUrl,
    openaiCompatModel: config.openaiCompatModel,
    hasOpenaiCompatKey: !!config.openaiCompatApiKeyEncrypted,
    autoCategorizeOnImport: config.autoCategorizeOnImport ?? true,
    autoOcrOnUpload: config.autoOcrOnUpload ?? true,
    categorizationConfidenceThreshold: parseFloat(config.categorizationConfidenceThreshold || '0.70'),
    maxConcurrentJobs: config.maxConcurrentJobs || 5,
    trackUsage: config.trackUsage ?? true,
    monthlyBudgetLimit: config.monthlyBudgetLimit ? parseFloat(config.monthlyBudgetLimit) : null,
    // Chat support (see AI_CHAT_SUPPORT_PLAN.md §2.1)
    chatSupportEnabled: config.chatSupportEnabled ?? false,
    chatProvider: config.chatProvider,
    chatModel: config.chatModel,
    chatMaxHistory: config.chatMaxHistory ?? 50,
    chatDataAccessLevel: (config.chatDataAccessLevel as 'none' | 'contextual' | 'full') || 'contextual',
    // PII protection
    piiProtectionLevel: config.piiProtectionLevel ?? 'strict',
    cloudVisionEnabled: !!config.cloudVisionEnabled,
    adminDisclosureAcceptedAt: config.adminDisclosureAcceptedAt ?? null,
    adminDisclosureAcceptedBy: config.adminDisclosureAcceptedBy ?? null,
    disclosureVersion: config.disclosureVersion ?? 1,
  };
}

export async function getRawConfig() {
  return getOrCreateConfig();
}

export async function updateConfig(input: any, userId?: string) {
  const config = await getOrCreateConfig();
  const updates: any = { updatedAt: new Date() };

  // Snapshot the data-flow-relevant fields BEFORE applying updates so
  // we can detect loosening changes and bump disclosure_version.
  // See ai-consent.service changeRequiresReconsent() for the rules.
  const before = await aiConsent.snapshotDataFlow();

  if (input.isEnabled !== undefined) {
    // Gate: cannot enable AI until the super admin has accepted the
    // system disclosure. Acceptance is recorded separately via
    // ai-consent.acceptSystemDisclosure.
    if (input.isEnabled === true && !(config as any).adminDisclosureAcceptedAt) {
      throw AppError.badRequest('Accept the AI processing disclosure before enabling AI. See System Settings → AI → Disclosure.');
    }
    updates.isEnabled = input.isEnabled;
  }
  if (input.categorizationProvider !== undefined) updates.categorizationProvider = input.categorizationProvider;
  if (input.categorizationModel !== undefined) updates.categorizationModel = input.categorizationModel;
  if (input.ocrProvider !== undefined) updates.ocrProvider = input.ocrProvider;
  if (input.ocrModel !== undefined) updates.ocrModel = input.ocrModel;
  if (input.documentClassificationProvider !== undefined) updates.documentClassificationProvider = input.documentClassificationProvider;
  if (input.documentClassificationModel !== undefined) updates.documentClassificationModel = input.documentClassificationModel;
  if (input.fallbackChain) updates.fallbackChain = input.fallbackChain;
  if (input.anthropicApiKey !== undefined) updates.anthropicApiKeyEncrypted = input.anthropicApiKey ? encrypt(input.anthropicApiKey) : null;
  if (input.openaiApiKey !== undefined) updates.openaiApiKeyEncrypted = input.openaiApiKey ? encrypt(input.openaiApiKey) : null;
  if (input.geminiApiKey !== undefined) updates.geminiApiKeyEncrypted = input.geminiApiKey ? encrypt(input.geminiApiKey) : null;
  if (input.ollamaBaseUrl !== undefined) {
    if (input.ollamaBaseUrl) assertExternalUrlSafe(input.ollamaBaseUrl, 'Ollama base URL');
    updates.ollamaBaseUrl = input.ollamaBaseUrl || null;
  }
  if (input.glmOcrApiKey !== undefined) updates.glmOcrApiKeyEncrypted = input.glmOcrApiKey ? encrypt(input.glmOcrApiKey) : null;
  if (input.glmOcrBaseUrl !== undefined) {
    if (input.glmOcrBaseUrl) assertExternalUrlSafe(input.glmOcrBaseUrl, 'GLM-OCR base URL');
    updates.glmOcrBaseUrl = input.glmOcrBaseUrl || null;
  }
  // Generic OpenAI-compatible provider. assertExternalUrlSafe blocks
  // SSRF (link-local, metadata endpoints) the same way it does for the
  // Ollama / GLM-OCR URLs.
  if (input.openaiCompatApiKey !== undefined) updates.openaiCompatApiKeyEncrypted = input.openaiCompatApiKey ? encrypt(input.openaiCompatApiKey) : null;
  if (input.openaiCompatBaseUrl !== undefined) {
    if (input.openaiCompatBaseUrl) assertExternalUrlSafe(input.openaiCompatBaseUrl, 'OpenAI-compat base URL');
    updates.openaiCompatBaseUrl = input.openaiCompatBaseUrl || null;
  }
  if (input.openaiCompatModel !== undefined) updates.openaiCompatModel = input.openaiCompatModel || null;
  if (input.autoCategorizeOnImport !== undefined) updates.autoCategorizeOnImport = input.autoCategorizeOnImport;
  if (input.autoOcrOnUpload !== undefined) updates.autoOcrOnUpload = input.autoOcrOnUpload;
  if (input.categorizationConfidenceThreshold !== undefined) updates.categorizationConfidenceThreshold = String(input.categorizationConfidenceThreshold);
  if (input.maxConcurrentJobs !== undefined) updates.maxConcurrentJobs = input.maxConcurrentJobs;
  if (input.trackUsage !== undefined) updates.trackUsage = input.trackUsage;
  if (input.monthlyBudgetLimit !== undefined) updates.monthlyBudgetLimit = input.monthlyBudgetLimit != null ? String(input.monthlyBudgetLimit) : null;
  // Chat support
  if (input.chatSupportEnabled !== undefined) updates.chatSupportEnabled = input.chatSupportEnabled;
  if (input.chatProvider !== undefined) updates.chatProvider = input.chatProvider || null;
  if (input.chatModel !== undefined) updates.chatModel = input.chatModel || null;
  if (input.chatMaxHistory !== undefined) updates.chatMaxHistory = input.chatMaxHistory;
  if (input.chatDataAccessLevel !== undefined) updates.chatDataAccessLevel = input.chatDataAccessLevel;
  // PII protection fields. Changes here are the primary trigger for
  // company-consent invalidation, checked after the update commits.
  if (input.piiProtectionLevel !== undefined) {
    const lvl = String(input.piiProtectionLevel);
    if (!['strict', 'standard', 'permissive'].includes(lvl)) {
      throw AppError.badRequest('piiProtectionLevel must be strict, standard, or permissive');
    }
    updates.piiProtectionLevel = lvl;
  }
  if (input.cloudVisionEnabled !== undefined) updates.cloudVisionEnabled = !!input.cloudVisionEnabled;
  if (userId) { updates.configuredBy = userId; updates.configuredAt = new Date(); }

  await db.update(aiConfig).set(updates).where(eq(aiConfig.id, config.id));

  // Compare post-update data flow against the snapshot. If the change
  // loosens data handling, bump ai_config.disclosure_version so every
  // company with stale consent is paused until re-acceptance.
  const after = await aiConsent.snapshotDataFlow();
  const reason = aiConsent.changeRequiresReconsent(before, after);
  if (reason) await aiConsent.invalidateCompanyConsent(reason, userId);

  return getConfig();
}

export async function testProvider(providerName: string) {
  const config = await getRawConfig();
  const { getProvider } = await import('./ai-providers/index.js');
  const provider = getProvider(providerName, config);
  return provider.testConnection();
}
