-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- Immutable audit trail for Tailscale admin actions.
-- Separate from audit_log because Tailscale is a platform-level concern
-- (no tenant scoping) and audit_log.tenant_id is NOT NULL.
CREATE TABLE IF NOT EXISTS tailscale_audit_log (
  id BIGSERIAL PRIMARY KEY,
  action VARCHAR(50) NOT NULL,
  actor_user_id UUID,
  target VARCHAR(255),
  details JSONB DEFAULT '{}'::jsonb,
  ip_address VARCHAR(45),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ts_audit_created ON tailscale_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ts_audit_action ON tailscale_audit_log (action);
