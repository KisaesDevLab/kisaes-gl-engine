-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Admin-editable overrides for the local document-extraction pipeline
-- (Ollama/Qwen). Previously these were env-only (EXTRACTION_*). This JSONB
-- column lets a super-admin tune them in System Settings → AI; each key is
-- optional and falls back to the corresponding env default when absent, so
-- the empty default '{}' preserves current behaviour. Additive per
-- CLAUDE.md rule 13. Keys: maxTokens, numCtx, thinking ('on'|'off'),
-- ollamaNative (bool), modelTag, renderDpi, grayscale (bool),
-- confidenceThreshold.
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS extraction_options jsonb NOT NULL DEFAULT '{}'::jsonb;
