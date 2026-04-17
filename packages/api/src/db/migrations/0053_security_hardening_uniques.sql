-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- Add UNIQUE constraints to token / key / code hash columns. Collisions on
-- these columns would be authentication identity confusion — findFirst()
-- returning the wrong row on lookup-by-hash would authenticate the caller
-- as someone else. SHA-256 makes random collisions practically impossible,
-- but the constraint is defense-in-depth and catches bugs that would
-- otherwise reuse a hash by mistake.
--
-- Also add NOT NULL to stripe_webhook_log.tenant_id: the column was
-- created nullable but the insert path always sets it, so the nullable
-- state is only reachable via a bug or raw SQL.

-- api_keys.key_hash: defensively drop the non-unique index first
DROP INDEX IF EXISTS idx_api_keys_hash;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- magic_links.token_hash: same pattern
DROP INDEX IF EXISTS idx_ml_token;
CREATE UNIQUE INDEX IF NOT EXISTS idx_ml_token ON magic_links(token_hash);

-- sessions.refresh_token_hash
ALTER TABLE sessions
  ADD CONSTRAINT sessions_refresh_token_hash_key UNIQUE (refresh_token_hash);

-- password_reset_tokens.token_hash
ALTER TABLE password_reset_tokens
  ADD CONSTRAINT password_reset_tokens_token_hash_key UNIQUE (token_hash);

-- oauth_tokens hashes
ALTER TABLE oauth_tokens
  ADD CONSTRAINT oauth_tokens_access_token_hash_key UNIQUE (access_token_hash);
ALTER TABLE oauth_tokens
  ADD CONSTRAINT oauth_tokens_refresh_token_hash_key UNIQUE (refresh_token_hash);

-- oauth_authorization_codes.code_hash
ALTER TABLE oauth_authorization_codes
  ADD CONSTRAINT oauth_authorization_codes_code_hash_key UNIQUE (code_hash);

-- transactions.public_token: bearer credential for the /pay/:token public
-- route. With 160-bit randomness collision is practically impossible, but
-- the lookup code (public-invoice.service, stripe.service) scans by token
-- alone — a collision would route a customer's payment to the wrong
-- invoice. Uniqueness makes that impossible at the database layer.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_public_token_key
  ON transactions(public_token)
  WHERE public_token IS NOT NULL;

-- stripe_webhook_log: tighten tenant_id. The insert path always supplies
-- a value; this makes the schema match the code contract so any future
-- write that skips tenantId fails loudly instead of producing untenanted
-- log rows. Any pre-existing untenanted rows are orphans and are deleted
-- so the NOT NULL constraint can be added.
DELETE FROM stripe_webhook_log WHERE tenant_id IS NULL;
ALTER TABLE stripe_webhook_log ALTER COLUMN tenant_id SET NOT NULL;
