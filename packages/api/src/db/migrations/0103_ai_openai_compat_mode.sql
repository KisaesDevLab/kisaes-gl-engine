-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Controls how the "OpenAI-compatible" AI provider talks to its endpoint:
--   'auto'   (default) — use Ollama's native /api/chat when the endpoint
--                        looks like Ollama (:11434 / "ollama" host), else /v1
--   'native' — always use Ollama's native /api/chat
--   'compat' — always use the OpenAI-compatible /v1 endpoint
-- Native is the correct method for Ollama-served models, especially thinking
-- models (Qwen3.5) which return empty content on /v1, and it unlocks
-- num_ctx / keep_alive / think. Additive per CLAUDE.md rule 13; default
-- 'auto' preserves the right behaviour for existing Ollama installs without
-- any reconfiguration.
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS openai_compat_mode varchar(20) NOT NULL DEFAULT 'auto';
