-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- Track how each bank feed item's suggested account was determined.
-- Consumers: bank feed list UI (per-item AI badge), transaction
-- register (permanent AI badge via source join).
ALTER TABLE bank_feed_items
  ADD COLUMN IF NOT EXISTS match_type VARCHAR(20);
