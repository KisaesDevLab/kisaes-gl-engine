-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- UI-configurable automatic Plaid sync interval (Admin → Plaid). NULL means
-- "not set in the UI" — the scheduler then falls back to the
-- PLAID_AUTO_SYNC_HOURS env var, then the built-in 6h default. 0 disables
-- automatic syncing.
ALTER TABLE plaid_config
  ADD COLUMN IF NOT EXISTS auto_sync_hours integer;
