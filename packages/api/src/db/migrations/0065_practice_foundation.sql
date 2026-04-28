-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 1 foundation.
--
-- Two additive changes:
--   1. `tenant_feature_flags` table — composite PK so every tenant's
--      state is isolated and every read is a single index probe.
--      ON DELETE CASCADE from tenants avoids orphaned rows.
--   2. `users.user_type` column — orthogonal to `role`. Default
--      'staff' means existing rows remain staff users; 'client' is
--      reserved for the Practice commercial-gate work.
--
-- Eight Practice flags are seeded disabled for every existing tenant
-- so the sidebar group is a no-op until the operator (or a new
-- tenant registration path) enables them. New-tenant registration
-- inserts these same rows with enabled=TRUE from application code;
-- the ON CONFLICT DO NOTHING on the seed matches both directions
-- cleanly.

CREATE TABLE tenant_feature_flags (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  flag_key VARCHAR(64) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  rollout_percent INTEGER NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  activated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, flag_key)
);

-- Partial index narrows the common read path (sidebar visibility
-- query) to only the small rowset of enabled flags per tenant.
CREATE INDEX idx_tenant_feature_flags_enabled
  ON tenant_feature_flags (tenant_id)
  WHERE enabled = TRUE;

ALTER TABLE users
  ADD COLUMN user_type VARCHAR(20) NOT NULL DEFAULT 'staff'
    CHECK (user_type IN ('staff', 'client'));

-- Backfill: every existing tenant gets the eight Practice flags as
-- disabled rows. Safe to re-run thanks to the PK + ON CONFLICT.
INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, f.flag_key, FALSE
FROM tenants t
CROSS JOIN (VALUES
  ('CLOSE_REVIEW_V1'),
  ('AI_BUCKET_WORKFLOW_V1'),
  ('CONDITIONAL_RULES_V1'),
  ('CLIENT_PORTAL_V1'),
  ('REMINDERS_V1'),
  ('TAX_1099_V1'),
  ('REPORT_BUILDER_V1'),
  ('RECEIPT_PWA_V1')
) AS f(flag_key)
ON CONFLICT DO NOTHING;
