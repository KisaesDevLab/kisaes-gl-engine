-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- AI Chat Support — schema additions
--
-- Adds the chat assistant feature: a tenant-scoped, two-tier-consent
-- chat panel that can answer questions about the app, accounting
-- concepts, and (with full data access enabled) the user's own data.
-- See AI_CHAT_SUPPORT_PLAN.md §2 for the full data model.

-- 1. ai_config: chat-specific columns
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS chat_support_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS chat_provider VARCHAR(30);
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS chat_model VARCHAR(100);
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS chat_max_history INTEGER DEFAULT 50;
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS chat_data_access_level VARCHAR(20) DEFAULT 'contextual';
  -- 'none'       — assistant cannot reference user data
  -- 'contextual' — assistant can reference data on the current screen
  -- 'full'       — assistant can call read-only data functions

--> statement-breakpoint

-- 2. companies: per-company chat opt-in (tier 2 of two-tier consent)
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS chat_support_enabled BOOLEAN DEFAULT FALSE;

--> statement-breakpoint

-- 3. chat_conversations: one row per conversation thread
CREATE TABLE IF NOT EXISTS chat_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  title VARCHAR(255),
  status VARCHAR(20) DEFAULT 'active',
  message_count INTEGER DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_user ON chat_conversations(user_id, status);
CREATE INDEX IF NOT EXISTS idx_cc_tenant ON chat_conversations(tenant_id);

--> statement-breakpoint

-- 4. chat_messages: individual user/assistant turns within a conversation
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  -- Context at time of message
  screen_context VARCHAR(100),
  entity_context JSONB,
  -- AI metadata
  provider VARCHAR(30),
  model VARCHAR(100),
  input_tokens INTEGER,
  output_tokens INTEGER,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cm_conversation ON chat_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cm_tenant ON chat_messages(tenant_id);
