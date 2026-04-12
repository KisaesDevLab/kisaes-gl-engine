import { pgTable, uuid, varchar, text, boolean, integer, decimal, timestamp, index, uniqueIndex, jsonb, bigserial } from 'drizzle-orm/pg-core';

// System-wide AI configuration (singleton)
export const aiConfig = pgTable('ai_config', {
  id: uuid('id').primaryKey().defaultRandom(),
  isEnabled: boolean('is_enabled').default(false),
  // Provider selection per task
  categorizationProvider: varchar('categorization_provider', { length: 30 }),
  categorizationModel: varchar('categorization_model', { length: 100 }),
  ocrProvider: varchar('ocr_provider', { length: 30 }),
  ocrModel: varchar('ocr_model', { length: 100 }),
  documentClassificationProvider: varchar('document_classification_provider', { length: 30 }),
  documentClassificationModel: varchar('document_classification_model', { length: 100 }),
  // Fallback chain
  fallbackChain: jsonb('fallback_chain').default('["anthropic","openai","gemini","ollama"]'),
  // Provider credentials (encrypted)
  anthropicApiKeyEncrypted: text('anthropic_api_key_encrypted'),
  openaiApiKeyEncrypted: text('openai_api_key_encrypted'),
  geminiApiKeyEncrypted: text('gemini_api_key_encrypted'),
  ollamaBaseUrl: varchar('ollama_base_url', { length: 500 }),
  glmOcrApiKeyEncrypted: text('glm_ocr_api_key_encrypted'),
  glmOcrBaseUrl: varchar('glm_ocr_base_url', { length: 500 }),
  // Processing settings
  autoCategorizeOnImport: boolean('auto_categorize_on_import').default(true),
  autoOcrOnUpload: boolean('auto_ocr_on_upload').default(true),
  categorizationConfidenceThreshold: decimal('categorization_confidence_threshold', { precision: 3, scale: 2 }).default('0.70'),
  maxConcurrentJobs: integer('max_concurrent_jobs').default(5),
  // Cost tracking
  trackUsage: boolean('track_usage').default(true),
  monthlyBudgetLimit: decimal('monthly_budget_limit', { precision: 19, scale: 4 }),
  // Chat support feature (see AI_CHAT_SUPPORT_PLAN.md §2.1)
  chatSupportEnabled: boolean('chat_support_enabled').default(false),
  chatProvider: varchar('chat_provider', { length: 30 }),
  chatModel: varchar('chat_model', { length: 100 }),
  chatMaxHistory: integer('chat_max_history').default(50),
  chatDataAccessLevel: varchar('chat_data_access_level', { length: 20 }).default('contextual'),
  // Metadata
  configuredBy: uuid('configured_by'),
  configuredAt: timestamp('configured_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Chat Conversations — one row per conversation thread between a user
// and the assistant. Soft-delete via status='archived'. Auto-titled
// from the first user message by chat.service.
export const chatConversations = pgTable('chat_conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  userId: uuid('user_id').notNull(),
  title: varchar('title', { length: 255 }),
  status: varchar('status', { length: 20 }).default('active'),
  messageCount: integer('message_count').default(0),
  lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  userIdx: index('idx_cc_user').on(table.userId, table.status),
  tenantIdx: index('idx_cc_tenant').on(table.tenantId),
}));

// Chat Messages — individual user/assistant turns within a conversation.
// `screen_context` and `entity_context` capture what the user was looking
// at when they sent the message, so the assistant can give specific
// answers without re-querying. Provider/model/tokens are recorded for
// cost tracking via ai_usage_log.
export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  conversationId: uuid('conversation_id').notNull().references(() => chatConversations.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull(),
  role: varchar('role', { length: 20 }).notNull(), // 'user' | 'assistant' | 'system'
  content: text('content').notNull(),
  // Context at time of message
  screenContext: varchar('screen_context', { length: 100 }),
  entityContext: jsonb('entity_context'),
  // AI metadata (only set on assistant messages)
  provider: varchar('provider', { length: 30 }),
  model: varchar('model', { length: 100 }),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  durationMs: integer('duration_ms'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  conversationIdx: index('idx_cm_conversation').on(table.conversationId, table.createdAt),
  tenantIdx: index('idx_cm_tenant').on(table.tenantId),
}));

// AI processing jobs
export const aiJobs = pgTable('ai_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  jobType: varchar('job_type', { length: 50 }).notNull(), // categorize | ocr_receipt | ocr_statement | ocr_invoice | classify_document
  status: varchar('status', { length: 20 }).default('pending'), // pending | processing | complete | failed | cancelled
  // Provider used
  provider: varchar('provider', { length: 30 }),
  model: varchar('model', { length: 100 }),
  // Input reference
  inputType: varchar('input_type', { length: 30 }), // bank_feed_item | attachment | text
  inputId: uuid('input_id'),
  inputData: jsonb('input_data'),
  // Output
  outputData: jsonb('output_data'),
  confidenceScore: decimal('confidence_score', { precision: 3, scale: 2 }),
  // User action
  userAccepted: boolean('user_accepted'),
  userModified: boolean('user_modified'),
  userActionAt: timestamp('user_action_at', { withTimezone: true }),
  // Cost tracking
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  estimatedCost: decimal('estimated_cost', { precision: 10, scale: 6 }),
  // Timing
  processingStartedAt: timestamp('processing_started_at', { withTimezone: true }),
  processingCompletedAt: timestamp('processing_completed_at', { withTimezone: true }),
  processingDurationMs: integer('processing_duration_ms'),
  // Error
  errorMessage: text('error_message'),
  retryCount: integer('retry_count').default(0),
  maxRetries: integer('max_retries').default(3),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantIdx: index('idx_aij_tenant').on(table.tenantId),
  statusIdx: index('idx_aij_status').on(table.tenantId, table.status),
  typeIdx: index('idx_aij_type').on(table.tenantId, table.jobType),
  inputIdx: index('idx_aij_input').on(table.inputType, table.inputId),
}));

// AI usage tracking
export const aiUsageLog = pgTable('ai_usage_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  provider: varchar('provider', { length: 30 }).notNull(),
  model: varchar('model', { length: 100 }).notNull(),
  jobType: varchar('job_type', { length: 50 }).notNull(),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  estimatedCost: decimal('estimated_cost', { precision: 10, scale: 6 }).default('0'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantMonthIdx: index('idx_aul_tenant_month').on(table.tenantId, table.createdAt),
  providerIdx: index('idx_aul_provider').on(table.provider, table.createdAt),
}));

// Prompt templates
export const aiPromptTemplates = pgTable('ai_prompt_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  taskType: varchar('task_type', { length: 50 }).notNull(),
  provider: varchar('provider', { length: 30 }),
  version: integer('version').notNull().default(1),
  systemPrompt: text('system_prompt').notNull(),
  userPromptTemplate: text('user_prompt_template').notNull(),
  outputSchema: jsonb('output_schema'),
  isActive: boolean('is_active').default(true),
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

// Categorization learning cache
export const categorizationHistory = pgTable('categorization_history', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  payeePattern: varchar('payee_pattern', { length: 255 }).notNull(),
  amountRangeMin: decimal('amount_range_min', { precision: 19, scale: 4 }),
  amountRangeMax: decimal('amount_range_max', { precision: 19, scale: 4 }),
  accountId: uuid('account_id').notNull(),
  contactId: uuid('contact_id'),
  timesConfirmed: integer('times_confirmed').default(1),
  timesOverridden: integer('times_overridden').default(0),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  tenantPayeeIdx: index('idx_ch_tenant_payee').on(table.tenantId, table.payeePattern),
}));
