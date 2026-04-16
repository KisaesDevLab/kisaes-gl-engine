-- AI Consent — company-level opt-in.
--
-- See Build Plans/AI_PII_PROTECTION_ADDENDUM.md §Tier 2: Company-Level
-- AI Consent. Adds the four-task opt-in flags, disclosure acceptance,
-- and the version pointer back to ai_config.disclosure_version so the
-- orchestrator can detect stale consent and pause AI for a company
-- until the owner re-accepts.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS ai_enabled_tasks JSONB NOT NULL DEFAULT '{"categorization":false,"receipt_ocr":false,"statement_parsing":false,"document_classification":false}'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_disclosure_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_disclosure_accepted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS ai_disclosure_version INTEGER;
