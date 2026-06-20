-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Per-function prompt customization (Mechanism B wiring).
-- Distinguishes admin-authored prompt templates from system-seeded
-- defaults so the runtime only ever consumes prompts an admin
-- explicitly customized — the task services fall back to their built-in
-- hardcoded prompt otherwise. This guarantees zero behaviour change on
-- upgrade: any pre-existing seeded rows default to is_custom=false and
-- are ignored by the consumption path. Additive per CLAUDE.md rule 13.
ALTER TABLE ai_prompt_templates
  ADD COLUMN IF NOT EXISTS is_custom boolean NOT NULL DEFAULT false;
