-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0291. LOST: which clients registered themselves, and the
-- PKCE challenge and resource of codes and tokens (connectors sign in again).
DROP INDEX IF EXISTS idx_ot_client;
DROP INDEX IF EXISTS idx_oauth_clients_dynamic;
ALTER TABLE oauth_tokens DROP COLUMN IF EXISTS resource;
ALTER TABLE oauth_authorization_codes
  DROP COLUMN IF EXISTS resource,
  DROP COLUMN IF EXISTS code_challenge_method,
  DROP COLUMN IF EXISTS code_challenge;
ALTER TABLE oauth_clients
  DROP COLUMN IF EXISTS is_dynamic,
  DROP COLUMN IF EXISTS token_endpoint_auth_method;
