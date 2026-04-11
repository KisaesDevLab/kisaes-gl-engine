import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import {
  chatSendMessageSchema,
  chatCreateConversationSchema,
  chatAdminConfigSchema,
} from '@kis-books/shared';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as chatService from '../services/chat.service.js';
import * as aiConfigService from '../services/ai-config.service.js';
import { getKnowledgeStats, reloadKnowledge } from '../services/chat-knowledge.service.js';
import { generateKnowledge } from '../services/chat-knowledge-generator.js';

export const chatRouter = Router();
chatRouter.use(authenticate);

// Per-user rate limit for chat messages. Chat hits a paid LLM with
// each call, so uncapped access is a direct billing attack vector.
// 30 messages / minute is enough for a very active user but bounds
// the per-user cost ceiling. Keyed by userId (set by authenticate
// middleware) so shared-IP NAT doesn't starve individual users.
const chatMessageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as any).userId || req.ip || 'anonymous',
  message: {
    error: {
      message: 'Too many chat messages, please slow down',
      code: 'CHAT_RATE_LIMIT',
    },
  },
});

// UUID guard for path-parameter conversation IDs so Drizzle doesn't
// throw an opaque 500 on malformed input.
const conversationIdSchema = z.string().uuid();

// ─── User-facing endpoints (§6.1) ───────────────────────────────

/**
 * Lightweight availability check the frontend hits before rendering
 * the floating action button. Returns booleans only — no AI keys or
 * provider details — so this is safe for any authenticated user.
 */
chatRouter.get('/status', async (req, res) => {
  const status = await chatService.isChatAvailable(req.tenantId);
  res.json(status);
});

/**
 * Send a chat message and get the assistant's reply.
 *
 * Body:
 *   { conversationId?: string, message: string, context?: ChatContext }
 *
 * If `conversationId` is omitted, a new conversation is created
 * (auto-titled from the first message).
 */
chatRouter.post('/message', chatMessageLimiter, validate(chatSendMessageSchema), async (req, res) => {
  const result = await chatService.sendMessage(req.tenantId, req.userId, {
    conversationId: req.body.conversationId || null,
    message: req.body.message,
    context: req.body.context,
  });
  res.json(result);
});

chatRouter.get('/conversations', async (req, res) => {
  const conversations = await chatService.listConversations(req.tenantId, req.userId);
  res.json({ conversations });
});

chatRouter.post('/conversations', validate(chatCreateConversationSchema), async (req, res) => {
  const conversation = await chatService.createConversation(req.tenantId, req.userId, req.body.title);
  res.status(201).json({ conversation });
});

chatRouter.get('/conversations/:id', async (req, res) => {
  const id = conversationIdSchema.parse(req.params['id']);
  const conversation = await chatService.getConversation(req.tenantId, req.userId, id);
  res.json({ conversation });
});

chatRouter.delete('/conversations/:id', async (req, res) => {
  const id = conversationIdSchema.parse(req.params['id']);
  await chatService.deleteConversation(req.tenantId, req.userId, id);
  res.json({ deleted: true });
});

/**
 * Contextual quick-action suggestions for the current screen.
 * Returns 3-4 prompts tailored to where the user is. The frontend
 * shows them as chips above the message input.
 */
chatRouter.get('/suggestions', async (req, res) => {
  const screenId = (req.query['screen'] as string) || undefined;
  res.json({ suggestions: chatService.getSuggestions(screenId) });
});

// ─── Admin endpoints (§6.2) ────────────────────────────────────
//
// Mounted under /chat/admin so all chat-related routes share a
// prefix. Super-admin only.

chatRouter.get('/admin/config', requireSuperAdmin, async (_req, res) => {
  const config = await aiConfigService.getConfig();
  res.json({
    chatSupportEnabled: config.chatSupportEnabled,
    chatProvider: config.chatProvider,
    chatModel: config.chatModel,
    chatMaxHistory: config.chatMaxHistory,
    chatDataAccessLevel: config.chatDataAccessLevel,
    // Helpful read-only fields so the admin UI doesn't have to
    // fetch /ai/admin/config separately just to populate the
    // provider dropdown.
    isEnabled: config.isEnabled,
    fallbackChain: config.fallbackChain,
    hasAnthropicKey: config.hasAnthropicKey,
    hasOpenaiKey: config.hasOpenaiKey,
    hasGeminiKey: config.hasGeminiKey,
    ollamaBaseUrl: config.ollamaBaseUrl,
  });
});

chatRouter.put('/admin/config', requireSuperAdmin, validate(chatAdminConfigSchema), async (req, res) => {
  const updated = await aiConfigService.updateConfig({
    chatSupportEnabled: req.body.chatSupportEnabled,
    chatProvider: req.body.chatProvider,
    chatModel: req.body.chatModel,
    chatMaxHistory: req.body.chatMaxHistory,
    chatDataAccessLevel: req.body.chatDataAccessLevel,
  }, req.userId);
  res.json({
    chatSupportEnabled: updated.chatSupportEnabled,
    chatProvider: updated.chatProvider,
    chatModel: updated.chatModel,
    chatMaxHistory: updated.chatMaxHistory,
    chatDataAccessLevel: updated.chatDataAccessLevel,
  });
});

chatRouter.get('/admin/stats', requireSuperAdmin, async (_req, res) => {
  const stats = await chatService.getSystemStats();
  res.json(stats);
});

chatRouter.get('/admin/knowledge-status', requireSuperAdmin, async (_req, res) => {
  res.json(getKnowledgeStats());
});

chatRouter.post('/admin/regenerate-knowledge', requireSuperAdmin, async (_req, res) => {
  // Run the generator end-to-end: re-scan App.tsx for the screen
  // catalog, re-load the curated markdown files, write the merged
  // app-knowledge.json + app-knowledge-prompt.md, then drop the
  // in-memory cache so the next chat completion picks up the new
  // files immediately.
  const result = await generateKnowledge();
  reloadKnowledge();
  res.json({
    ...getKnowledgeStats(),
    regenerated: true,
    screensFound: result.data.screens.length,
    workflowsFound: result.data.workflows.length,
    termsFound: result.data.glossaryTerms.length,
  });
});
