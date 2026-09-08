-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- "Invite my accountant": a tenant OWNER invites a firm staff member by
-- email. The email carries a one-click accept link (64-hex token) and an
-- 8-character code the staffer can type under Firm → Join a client. Only
-- SHA-256 hashes of both secrets are stored (bank_connect_invites pattern).
-- Accepting assigns the tenant to the acceptor's firm and grants them
-- accountant access; the acceptor's identity determines the firm, so the
-- invite never carries a firm id.

CREATE TABLE IF NOT EXISTS firm_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Normalised (trim + lower-case). Acceptance is bound to this address.
  recipient_email varchar(320) NOT NULL,
  token_hash varchar(64) NOT NULL,
  code_hash varchar(64) NOT NULL,
  -- sent | viewed | accepted | expired | revoked
  status varchar(20) NOT NULL DEFAULT 'sent',
  expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  resend_count integer NOT NULL DEFAULT 0,
  viewed_at timestamptz,
  accepted_at timestamptz,
  -- Loose ref: users is tenant-scoped and the acceptor lives elsewhere.
  accepted_by_user_id uuid,
  accepted_firm_id uuid REFERENCES firms(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  revoked_by uuid,
  created_by uuid NOT NULL,
  -- Snapshot at send time so the acceptance notification survives the
  -- inviter changing their address or being deleted.
  created_by_name varchar(255),
  created_by_email varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fi_token ON firm_invites (token_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fi_code ON firm_invites (code_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fi_tenant ON firm_invites (tenant_id, status);
