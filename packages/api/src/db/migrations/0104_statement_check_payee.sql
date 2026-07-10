-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- STATEMENT_CHECK_PAYEE_V1: carry a payee read from a check-image thumbnail
-- on a bank statement through the import → categorize path. The parsed check
-- number lets us correlate the thumbnail to its "CHECK ####" transaction row;
-- the read payee is stamped onto the posted transaction (transactions already
-- has check_number / payee_name_on_check, written today only by write-check)
-- so vendor/GL reports show the real payee instead of "Check".
-- Additive per CLAUDE.md rule 13.
ALTER TABLE bank_feed_items
  ADD COLUMN IF NOT EXISTS check_number integer;
ALTER TABLE bank_feed_items
  ADD COLUMN IF NOT EXISTS payee_name_on_check varchar(255);
