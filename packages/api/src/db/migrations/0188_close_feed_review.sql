-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Close Review → Bank feed: a reviewer's "Looks right" mark on a bank-feed
-- item that was already categorized, matched or excluded. Lets the close
-- track "X of N reviewed" for the month even when the categorizing happened
-- on the Banking screen. Additive; NULL = not reviewed.

ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS close_reviewed_at TIMESTAMPTZ;
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS close_reviewed_by UUID;
