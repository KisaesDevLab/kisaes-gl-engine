-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Record when a session chain was ORIGINALLY authenticated so refresh
-- rotation can carry it forward (JWT auth_time). Lets requireSuperAdmin
-- enforce an absolute admin session age in addition to the per-token
-- idle bound, which a background token refresh otherwise defeats.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS auth_time timestamptz;
