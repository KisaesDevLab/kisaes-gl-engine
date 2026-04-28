-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 9 — magic-link auth +
-- session storage for the portal. Three tables.

CREATE TABLE portal_magic_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  email_sent_to VARCHAR(320) NOT NULL,
  ip_address VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uq_portal_magic_links_hash ON portal_magic_links (token_hash);
CREATE INDEX idx_portal_magic_links_contact ON portal_magic_links (contact_id, created_at DESC);

CREATE TABLE portal_contact_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address VARCHAR(64),
  user_agent TEXT
);
CREATE UNIQUE INDEX uq_portal_sessions_hash ON portal_contact_sessions (token_hash);
CREATE INDEX idx_portal_sessions_contact ON portal_contact_sessions (contact_id, last_activity_at DESC);

CREATE TABLE portal_passwords (
  contact_id UUID PRIMARY KEY REFERENCES portal_contacts(id) ON DELETE CASCADE,
  bcrypt_hash VARCHAR(80) NOT NULL,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active BOOLEAN NOT NULL DEFAULT TRUE
);
