-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- PORTAL_IDENTITY_LINKING_V1 — master-identity layer above
-- per-tenant portal_contacts so one human (same email) can be a
-- portal client of multiple firms with a single login + in-portal
-- firm switcher. Additive only:
--   * new portal_identities table
--   * nullable identity_id FK on portal_contacts (auto-linked on invite)
--   * nullable identity_id FK on portal_contact_sessions (gates switch)
--
-- All new columns are nullable; legacy unlinked accounts continue to
-- authenticate via portal_passwords unchanged. Behavior is gated by
-- the PORTAL_IDENTITY_LINKING_V1 env flag — schema lands first so the
-- flag can be flipped per appliance without a redeploy.

CREATE TABLE portal_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(320) NOT NULL,
  password_hash VARCHAR(80) NOT NULL,
  email_verified_at TIMESTAMPTZ,
  failed_login_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lowercase, case-insensitive uniqueness. We normalize at insert in
-- the service layer, but enforce here too so a future direct-SQL path
-- can't bypass it.
CREATE UNIQUE INDEX uq_portal_identities_email ON portal_identities (LOWER(email));

ALTER TABLE portal_contacts
  ADD COLUMN identity_id UUID REFERENCES portal_identities(id) ON DELETE SET NULL;
CREATE INDEX idx_portal_contacts_identity ON portal_contacts (identity_id);

-- Sessions carry the identity so /switch can verify a target contact
-- belongs to the same identity without re-authenticating. NULL on
-- legacy sessions (no identity) — the switcher hides itself in that
-- case rather than treating null as a match.
ALTER TABLE portal_contact_sessions
  ADD COLUMN identity_id UUID REFERENCES portal_identities(id) ON DELETE CASCADE;
CREATE INDEX idx_portal_sessions_identity ON portal_contact_sessions (identity_id);
