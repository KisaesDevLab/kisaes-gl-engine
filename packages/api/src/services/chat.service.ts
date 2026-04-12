import { eq, and, sql, desc, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  chatConversations,
  chatMessages,
  companies,
  aiUsageLog,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as aiConfigService from './ai-config.service.js';
import { executeWithFallback, getProvider } from './ai-providers/index.js';
import type { CompletionParams, CompletionResult } from './ai-providers/index.js';
import { getKnowledgePrompt } from './chat-knowledge.service.js';

// ─── Types ─────────────────────────────────────────────────────

export interface ChatContext {
  current_screen?: string;
  current_path?: string;
  entity_type?: string;
  entity_id?: string;
  entity_summary?: string;
  form_fields?: Record<string, unknown>;
  form_errors?: string[];
  enabled_features?: string[];
}

export interface SendMessageInput {
  conversationId?: string | null;
  message: string;
  context?: ChatContext;
}

export interface SendMessageResult {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  assistantMessage: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

// ─── Two-tier consent guard ────────────────────────────────────

/**
 * Enforce the two-tier consent model from the plan §8.1:
 *   - System level: ai_config.is_enabled AND ai_config.chat_support_enabled
 *   - Company level: at least one company under this tenant has
 *     chat_support_enabled = true
 *
 * If either tier is off, the chat endpoint returns 403 (the frontend
 * uses this same check via /chat/status to decide whether to render
 * the floating button).
 *
 * The "any company in the tenant has it enabled" check is intentionally
 * permissive — Vibe MyBooks's tenants can have multiple companies, and a
 * user moving between them shouldn't lose chat access just because they
 * switched companies. Per-company enforcement happens via the active
 * company id passed in context.
 */
export async function isChatAvailable(tenantId: string): Promise<{
  enabled: boolean;
  systemEnabled: boolean;
  companyEnabled: boolean;
  reason?: string;
}> {
  const config = await aiConfigService.getConfig();
  const systemEnabled = !!config.isEnabled && !!config.chatSupportEnabled;

  if (!systemEnabled) {
    return {
      enabled: false,
      systemEnabled: false,
      companyEnabled: false,
      reason: !config.isEnabled
        ? 'AI processing is not enabled. Ask a system administrator to enable it.'
        : 'Chat support is not enabled at the system level. Ask a system administrator to enable it.',
    };
  }

  const enabledCompanies = await db.select({ id: companies.id }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.chatSupportEnabled, true)))
    .limit(1);
  const companyEnabled = enabledCompanies.length > 0;

  if (!companyEnabled) {
    return {
      enabled: false,
      systemEnabled: true,
      companyEnabled: false,
      reason: 'Chat support is not enabled for any company in this tenant. Enable it in Company Settings.',
    };
  }

  return { enabled: true, systemEnabled: true, companyEnabled: true };
}

async function requireChatEnabled(tenantId: string): Promise<void> {
  const status = await isChatAvailable(tenantId);
  if (!status.enabled) {
    throw AppError.forbidden(status.reason || 'Chat support is not available', 'CHAT_DISABLED');
  }
}

// ─── Conversation CRUD ─────────────────────────────────────────

export async function listConversations(tenantId: string, userId: string) {
  return db.select().from(chatConversations)
    .where(and(
      eq(chatConversations.tenantId, tenantId),
      eq(chatConversations.userId, userId),
      eq(chatConversations.status, 'active'),
    ))
    .orderBy(desc(chatConversations.lastMessageAt), desc(chatConversations.createdAt));
}

export async function getConversation(tenantId: string, userId: string, conversationId: string) {
  const conv = await db.query.chatConversations.findFirst({
    where: and(
      eq(chatConversations.tenantId, tenantId),
      eq(chatConversations.userId, userId),
      eq(chatConversations.id, conversationId),
    ),
  });
  if (!conv) throw AppError.notFound('Conversation not found');

  const messages = await db.select().from(chatMessages)
    .where(and(
      eq(chatMessages.tenantId, tenantId),
      eq(chatMessages.conversationId, conversationId),
    ))
    .orderBy(asc(chatMessages.createdAt));

  return { ...conv, messages };
}

export async function createConversation(tenantId: string, userId: string, title?: string) {
  await requireChatEnabled(tenantId);
  const [conv] = await db.insert(chatConversations).values({
    tenantId,
    userId,
    title: title || null,
    status: 'active',
  }).returning();
  if (!conv) throw AppError.internal('Failed to create conversation');
  return conv;
}

export async function deleteConversation(tenantId: string, userId: string, conversationId: string) {
  // Soft delete via status='archived'. The cascade on chat_messages
  // means a hard delete would also drop messages, but we want to
  // keep the audit trail accessible to admins.
  //
  // `.returning()` lets us distinguish a real soft-delete from a
  // no-op (row doesn't exist, or belongs to another user). Without
  // this, the endpoint silently returned `{ deleted: true }` even
  // for bad UUIDs — users would think the delete worked.
  const rows = await db.update(chatConversations)
    .set({ status: 'archived', updatedAt: new Date() })
    .where(and(
      eq(chatConversations.tenantId, tenantId),
      eq(chatConversations.userId, userId),
      eq(chatConversations.id, conversationId),
    ))
    .returning({ id: chatConversations.id });
  if (rows.length === 0) throw AppError.notFound('Conversation not found');
}

// ─── Send message ──────────────────────────────────────────────

/**
 * Send a user message and get an assistant response. The flow:
 *
 *   1. Verify two-tier consent.
 *   2. Load or create the conversation.
 *   3. Build the system prompt: role + knowledge base + behavioural rules
 *      + the chat data-access policy currently in effect.
 *   4. Build the user prompt: the conversation history + screen context +
 *      the new user message.
 *   5. Call the configured chat AI provider (with fallback chain).
 *   6. Persist BOTH the user message and the assistant response in
 *      one transaction so a crash mid-flight doesn't leave a hanging
 *      user message with no reply.
 *   7. Update the conversation's message_count + last_message_at.
 *   8. Log the call to ai_usage_log so it shows up in cost reports.
 */
export async function sendMessage(
  tenantId: string,
  userId: string,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  await requireChatEnabled(tenantId);

  if (!input.message || !input.message.trim()) {
    throw AppError.badRequest('Message content is required');
  }

  const config = await aiConfigService.getConfig();
  const rawConfig = await aiConfigService.getRawConfig();

  // Provider selection: chatProvider takes precedence, falling back
  // to the categorization provider so chat works "out of the box"
  // for any tenant that already has AI configured for other tasks.
  const preferredProvider = config.chatProvider || config.categorizationProvider || undefined;
  const preferredModel = config.chatModel || undefined;
  if (!preferredProvider) {
    throw AppError.badRequest(
      'No chat AI provider is configured. Ask an administrator to set one in Admin → AI Processing → Chat.',
    );
  }

  // 1. Conversation
  let conversationId = input.conversationId || null;
  if (conversationId) {
    const existing = await db.query.chatConversations.findFirst({
      where: and(
        eq(chatConversations.tenantId, tenantId),
        eq(chatConversations.userId, userId),
        eq(chatConversations.id, conversationId),
      ),
    });
    if (!existing) throw AppError.notFound('Conversation not found');
  } else {
    const conv = await createConversation(tenantId, userId, deriveTitle(input.message));
    conversationId = conv.id;
  }

  // 2. Build the system prompt
  const systemPrompt = buildSystemPrompt(config.chatDataAccessLevel);

  // 3. Build the user-side prompt: history + screen context + new message
  const history = await loadHistory(tenantId, conversationId, config.chatMaxHistory);
  const userPrompt = buildUserPrompt(history, input.context, input.message);

  // 4. Call the AI provider
  const params: CompletionParams = {
    systemPrompt,
    userPrompt,
    temperature: 0.4,
    maxTokens: 1024,
    responseFormat: 'text',
  };

  let result: CompletionResult;
  try {
    result = await executeWithFallback(
      params,
      rawConfig,
      config.fallbackChain,
      preferredProvider,
      preferredModel,
    );
  } catch (err: any) {
    throw AppError.internal(`Chat AI request failed: ${err.message || 'unknown error'}`);
  }

  // 5. Persist user + assistant messages atomically + update counters
  const userMessageId = await db.transaction(async (tx) => {
    const [userMsg] = await tx.insert(chatMessages).values({
      conversationId: conversationId!,
      tenantId,
      role: 'user',
      content: input.message,
      screenContext: input.context?.current_screen || null,
      entityContext: input.context
        ? {
            entity_type: input.context.entity_type ?? null,
            entity_id: input.context.entity_id ?? null,
            entity_summary: input.context.entity_summary ?? null,
            current_path: input.context.current_path ?? null,
            form_errors: input.context.form_errors ?? null,
          }
        : null,
    }).returning();

    const [assistantMsg] = await tx.insert(chatMessages).values({
      conversationId: conversationId!,
      tenantId,
      role: 'assistant',
      content: result.text,
      screenContext: input.context?.current_screen || null,
      provider: result.provider,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
    }).returning();

    await tx.update(chatConversations)
      .set({
        messageCount: sql`${chatConversations.messageCount} + 2`,
        lastMessageAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(chatConversations.tenantId, tenantId),
        eq(chatConversations.id, conversationId!),
      ));

    return { userMessageId: userMsg!.id, assistantMessageId: assistantMsg!.id };
  });

  // 6. Cost tracking — outside the tx so a logging hiccup can't roll
  // back the conversation state.
  try {
    let cost = 0;
    try {
      const provider = getProvider(result.provider, rawConfig, result.model);
      cost = provider.estimateCost(result.inputTokens, result.outputTokens);
    } catch {
      // estimateCost failure is non-fatal
    }
    await db.insert(aiUsageLog).values({
      tenantId,
      provider: result.provider,
      model: result.model,
      jobType: 'chat',
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      estimatedCost: String(cost),
    });
  } catch (err) {
    console.error('[chat] Failed to log usage:', err);
  }

  return {
    conversationId: conversationId!,
    userMessageId: userMessageId.userMessageId,
    assistantMessageId: userMessageId.assistantMessageId,
    assistantMessage: result.text,
    provider: result.provider,
    model: result.model,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: result.durationMs,
  };
}

// ─── Prompt construction helpers ───────────────────────────────

function buildSystemPrompt(dataAccessLevel: 'none' | 'contextual' | 'full'): string {
  const knowledge = getKnowledgePrompt();

  const accessPolicy = (() => {
    switch (dataAccessLevel) {
      case 'none':
        return 'Data access policy: NONE. You cannot reference the user\'s actual financial data (balances, transactions, contacts). If they ask for data, explain that you don\'t have access and direct them to the relevant report or screen instead.';
      case 'full':
        return 'Data access policy: FULL. You can reference data the user explicitly shares with you in their message or that appears in the screen context. (Read-only function calling for arbitrary lookups is not yet wired in this build — coming soon.)';
      case 'contextual':
      default:
        return 'Data access policy: CONTEXTUAL. You can reference data that appears in the screen context block of the user message (entity summaries, form values, validation errors). You cannot query for data the user hasn\'t shared. If they ask about something not in context, direct them to the relevant report or screen.';
    }
  })();

  return `${knowledge}\n\n---\n\n${accessPolicy}`;
}

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

async function loadHistory(
  tenantId: string,
  conversationId: string,
  maxHistory: number,
): Promise<HistoryMessage[]> {
  // Load the last `maxHistory` messages, ordered chronologically.
  // We pull the last N from the database (sorted desc + limit) then
  // reverse to get the natural conversation order.
  const recent = await db.select({
    role: chatMessages.role,
    content: chatMessages.content,
  }).from(chatMessages)
    .where(and(
      eq(chatMessages.tenantId, tenantId),
      eq(chatMessages.conversationId, conversationId),
    ))
    .orderBy(desc(chatMessages.createdAt))
    .limit(Math.max(2, maxHistory));

  return recent
    .reverse()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
}

function buildUserPrompt(
  history: HistoryMessage[],
  context: ChatContext | undefined,
  newMessage: string,
): string {
  const parts: string[] = [];

  if (context) {
    parts.push('## Current screen context');
    if (context.current_screen) parts.push(`- Screen: ${context.current_screen}`);
    if (context.current_path) parts.push(`- Path: ${context.current_path}`);
    if (context.entity_type) {
      parts.push(`- Viewing: ${context.entity_type}${context.entity_id ? ` (${context.entity_id})` : ''}`);
    }
    if (context.entity_summary) parts.push(`- Summary: ${context.entity_summary}`);
    if (context.form_errors && context.form_errors.length > 0) {
      parts.push(`- Validation errors on the form: ${context.form_errors.join('; ')}`);
    }
    if (context.form_fields && Object.keys(context.form_fields).length > 0) {
      const fieldLines = Object.entries(context.form_fields)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .slice(0, 20)
        .map(([k, v]) => `  - ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
      if (fieldLines.length > 0) {
        parts.push('- Current form values:');
        parts.push(...fieldLines);
      }
    }
    parts.push('');
  }

  if (history.length > 0) {
    parts.push('## Conversation so far');
    for (const msg of history) {
      parts.push(`${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`);
    }
    parts.push('');
  }

  parts.push('## New user message');
  parts.push(newMessage);

  return parts.join('\n');
}

function deriveTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= 60) return trimmed;
  return trimmed.slice(0, 57) + '…';
}

// ─── Quick suggestions ─────────────────────────────────────────

const SUGGESTIONS_BY_SCREEN: Record<string, string[]> = {
  dashboard: [
    'What should I focus on today?',
    'Explain my cash position',
    'What is overdue?',
  ],
  'enter-bill': [
    'How do payment terms work?',
    'What\'s the difference between a bill and an expense?',
    'Why can\'t I save this bill?',
  ],
  bills: [
    'How do I edit a paid bill?',
    'What does "partial" status mean?',
  ],
  'pay-bills': [
    'How do I apply a vendor credit?',
    'Can I make a partial payment?',
    'What is the difference between check and ACH?',
  ],
  'bank-feed': [
    'How do I categorize these transactions?',
    'What are bank rules?',
    'When should I match instead of categorize?',
  ],
  reports: [
    'Explain this report',
    'What does a negative balance mean?',
    'Which report shows what I owe?',
  ],
  reconciliation: [
    'How does reconciliation work?',
    'My balance is off by $0.01',
    'Can I undo a completed reconciliation?',
  ],
  invoices: [
    'How do I write off a bad debt?',
    'What does "Payments Clearing" mean?',
  ],
};

const DEFAULT_SUGGESTIONS = [
  'How does double-entry bookkeeping work in Vibe MyBooks?',
  'What is the difference between cash and accrual accounting?',
  'Walk me through a typical month-end close',
];

export function getSuggestions(screenId?: string): string[] {
  if (!screenId) return DEFAULT_SUGGESTIONS;
  const key = screenId.toLowerCase();
  return SUGGESTIONS_BY_SCREEN[key] || DEFAULT_SUGGESTIONS;
}

// ─── Admin: stats ──────────────────────────────────────────────

/**
 * System-wide chat usage stats. INTENTIONALLY NOT tenant-scoped —
 * this returns counts across every tenant in the database and is
 * only meant to be called from super-admin routes. Do NOT expose
 * this to tenant-scoped endpoints.
 */
export async function getSystemStats() {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const result = await db.execute(sql`
    SELECT
      (SELECT COUNT(*) FROM chat_conversations WHERE created_at >= ${monthStart.toISOString()}) AS conversations_this_month,
      (SELECT COUNT(*) FROM chat_messages WHERE created_at >= ${monthStart.toISOString()}) AS messages_this_month,
      (SELECT COALESCE(SUM(estimated_cost::numeric), 0) FROM ai_usage_log WHERE job_type = 'chat' AND created_at >= ${monthStart.toISOString()}) AS estimated_cost_this_month
  `);
  const row = (result.rows as any[])[0] || {};
  return {
    conversationsThisMonth: parseInt(row.conversations_this_month || '0'),
    messagesThisMonth: parseInt(row.messages_this_month || '0'),
    estimatedCostThisMonth: parseFloat(row.estimated_cost_this_month || '0'),
  };
}
