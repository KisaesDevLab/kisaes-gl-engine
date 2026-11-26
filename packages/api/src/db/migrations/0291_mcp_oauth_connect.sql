-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- MCP connectors: OAuth 2.1 for public clients (Claude custom connectors,
-- mcp-remote). PKCE on the authorization code, the resource (RFC 8707) a
-- code and a token were issued for, and clients that registered themselves
-- (RFC 7591) with no secret. Install-wide (no tenant). Additive only.

ALTER TABLE oauth_clients
  ADD COLUMN IF NOT EXISTS token_endpoint_auth_method varchar(40) NOT NULL DEFAULT 'client_secret_post',
  ADD COLUMN IF NOT EXISTS is_dynamic boolean NOT NULL DEFAULT false;

ALTER TABLE oauth_authorization_codes
  ADD COLUMN IF NOT EXISTS code_challenge varchar(128),
  ADD COLUMN IF NOT EXISTS code_challenge_method varchar(10),
  ADD COLUMN IF NOT EXISTS resource text;

ALTER TABLE oauth_tokens
  ADD COLUMN IF NOT EXISTS resource text;

-- Finds the clients a registration sweep may remove (self-registered, never used).
CREATE INDEX IF NOT EXISTS idx_oauth_clients_dynamic ON oauth_clients (is_dynamic, created_at);
CREATE INDEX IF NOT EXISTS idx_ot_client ON oauth_tokens (client_id);
