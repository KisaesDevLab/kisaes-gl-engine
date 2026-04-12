import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { aiConfig } from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';

async function getOrCreateConfig() {
  let config = await db.query.aiConfig.findFirst();
  if (!config) {
    const [created] = await db.insert(aiConfig).values({}).returning();
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
  };
}

export async function getRawConfig() {
  return getOrCreateConfig();
}

export async function updateConfig(input: any, userId?: string) {
  const config = await getOrCreateConfig();
  const updates: any = { updatedAt: new Date() };

  if (input.isEnabled !== undefined) updates.isEnabled = input.isEnabled;
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
  if (input.ollamaBaseUrl !== undefined) updates.ollamaBaseUrl = input.ollamaBaseUrl || null;
  if (input.glmOcrApiKey !== undefined) updates.glmOcrApiKeyEncrypted = input.glmOcrApiKey ? encrypt(input.glmOcrApiKey) : null;
  if (input.glmOcrBaseUrl !== undefined) updates.glmOcrBaseUrl = input.glmOcrBaseUrl || null;
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
  if (userId) { updates.configuredBy = userId; updates.configuredAt = new Date(); }

  await db.update(aiConfig).set(updates).where(eq(aiConfig.id, config.id));
  return getConfig();
}

export async function testProvider(providerName: string) {
  const config = await getRawConfig();
  const { getProvider } = await import('./ai-providers/index.js');
  const provider = getProvider(providerName, config);
  return provider.testConnection();
}
