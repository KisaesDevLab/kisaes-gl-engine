-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Remember which tenant (and role) a refresh-token session is operating
-- under. Previously the session row held only the user, so token refresh
-- re-minted the access token against the user's HOME tenant — silently
-- reverting a mid-session tenant switch and wiping the switched-tenant
-- context. Both columns are nullable; existing sessions fall back to the
-- user's home tenant/role at refresh time.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS tenant_id uuid,
  ADD COLUMN IF NOT EXISTS role varchar(20);
