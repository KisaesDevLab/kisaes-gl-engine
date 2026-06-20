-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Per-function AI settings (AI_FUNCTION_SETTINGS_PLAN.md).
-- One additive JSONB column keyed by function name
-- (categorization | ocr | document_classification | chat). Each value
-- holds optional overrides: maxTokens, temperature, thinking ('on'|'off'),
-- timeoutMs, fallbackChain, enabled, threshold, autoTrigger, promptOverride,
-- piiLevel. Every key is optional; an absent/null value means "use the
-- existing built-in behaviour", so the default '{}' is a no-op for all
-- existing installs (no backfill required). Additive per CLAUDE.md rule 13.
ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS task_options jsonb NOT NULL DEFAULT '{}'::jsonb;
