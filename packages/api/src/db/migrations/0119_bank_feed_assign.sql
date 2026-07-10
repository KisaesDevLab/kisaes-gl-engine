-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Two-phase bank-feed workflow: ASSIGN (stage, no ledger post) then
-- APPROVE (post). Assigning a category no longer posts a transaction; it
-- stages the chosen account/contact/tag/memo on the feed item and flips the
-- status to 'assigned'. Approval reads these staged columns and posts.
--
-- Additive columns only. The staged assignment lives alongside the existing
-- suggested_* (AI) and matched_transaction_id (posted) columns:
--   - suggested_*  = AI/rule guess, never authoritative
--   - assigned_*   = human-staged choice, awaiting approval (this migration)
--   - matched_transaction_id = the posted ledger transaction (approval result)

ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS assigned_account_id uuid;
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS assigned_contact_id uuid;
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS assigned_tag_id uuid;
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS assigned_memo text;
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS assigned_by uuid;
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS assigned_at timestamptz;
