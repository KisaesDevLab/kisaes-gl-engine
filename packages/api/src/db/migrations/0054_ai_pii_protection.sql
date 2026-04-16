-- AI PII Protection — system-level settings.
--
-- See Build Plans/AI_PII_PROTECTION_ADDENDUM.md §Tier 1: System-Level
-- Admin Controls. Adds the PII protection level selector, the cloud-
-- vision opt-in, and the admin disclosure acceptance fields. These
-- columns gate the sanitizer behaviour and the orchestrator's refusal
-- to send raw images to cloud providers.

ALTER TABLE ai_config
  ADD COLUMN IF NOT EXISTS pii_protection_level VARCHAR(20) NOT NULL DEFAULT 'strict',
  ADD COLUMN IF NOT EXISTS cloud_vision_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_disclosure_accepted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_disclosure_accepted_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS disclosure_version INTEGER NOT NULL DEFAULT 1;
