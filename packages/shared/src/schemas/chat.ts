import { z } from 'zod';

// ─── Chat context (attached to each /chat/message call) ───────

export const chatContextSchema = z.object({
  current_screen: z.string().max(100).optional(),
  current_path: z.string().max(500).optional(),
  entity_type: z.string().max(50).optional(),
  entity_id: z.string().max(100).optional(),
  entity_summary: z.string().max(1000).optional(),
  // Arbitrary form fields keyed by name. Capped to prevent a huge
  // payload being forwarded into the LLM prompt.
  form_fields: z.record(z.unknown()).optional(),
  form_errors: z.array(z.string().max(500)).max(50).optional(),
  enabled_features: z.array(z.string().max(50)).max(50).optional(),
}).passthrough();
export type ChatContextInput = z.infer<typeof chatContextSchema>;

// ─── Send message ──────────────────────────────────────────────

/**
 * Send a user message to the assistant. `message` is capped at 4000
 * chars to bound LLM token cost; `conversationId` must be a UUID so
 * the service can look it up without triggering a DB parser error.
 */
export const chatSendMessageSchema = z.object({
  conversationId: z.string().uuid().nullish(),
  message: z.string().trim().min(1, 'Message is required').max(4000, 'Message is too long (max 4000 characters)'),
  context: chatContextSchema.optional(),
});
export type ChatSendMessageInput = z.infer<typeof chatSendMessageSchema>;

// ─── Conversation CRUD ────────────────────────────────────────

export const chatCreateConversationSchema = z.object({
  title: z.string().max(200).optional(),
});
export type ChatCreateConversationInput = z.infer<typeof chatCreateConversationSchema>;

// ─── Admin config ──────────────────────────────────────────────

export const chatAdminConfigSchema = z.object({
  chatSupportEnabled: z.boolean().optional(),
  chatProvider: z.string().max(50).nullish(),
  chatModel: z.string().max(100).nullish(),
  chatMaxHistory: z.number().int().min(2).max(200).optional(),
  chatDataAccessLevel: z.enum(['none', 'contextual', 'full']).optional(),
});
export type ChatAdminConfigInput = z.infer<typeof chatAdminConfigSchema>;
