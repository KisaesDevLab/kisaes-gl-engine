-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Statement-import redesign: revive GLM-OCR as a dedicated, admin-configurable
-- OCR engine for the detect -> OCR -> extract -> reconcile pipeline. The
-- glm_ocr_base_url / glm_ocr_api_key_encrypted columns already exist (added,
-- then deprecated when GLM-OCR was previously removed); we re-use them and add
-- the remaining engine settings. Additive per CLAUDE.md rule 13.
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS glm_ocr_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS glm_ocr_model varchar(100),
  ADD COLUMN IF NOT EXISTS glm_ocr_prompt varchar(200),
  ADD COLUMN IF NOT EXISTS glm_ocr_timeout_ms integer,
  ADD COLUMN IF NOT EXISTS glm_ocr_concurrency integer,
  -- Pipeline knobs exposed in the admin UI (env STATEMENT_FORCE_OCR /
  -- EXTRACTION_RENDER_DPI remain the fallback when these are null).
  ADD COLUMN IF NOT EXISTS glm_ocr_force_ocr boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS glm_ocr_render_dpi integer,
  -- Stage-2 extraction LLM (OCR markdown -> structured JSON): 'local' (the
  -- configured self-hosted text model) or 'anthropic' (cloud, sanitized text
  -- only). Optional model override for whichever is selected.
  ADD COLUMN IF NOT EXISTS statement_extraction_provider varchar(20) NOT NULL DEFAULT 'local',
  ADD COLUMN IF NOT EXISTS statement_extraction_model varchar(100);
