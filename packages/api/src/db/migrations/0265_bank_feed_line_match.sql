-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Bank feed line-level matches and voided entries (U-166, feed-match-v2).
-- Additive.
--
--   matched_journal_line_id  the journal line on the item's bank account
--                            that this item is (a credit for money out, a
--                            debit for money in). One item per line: a
--                            partial unique index. NULL for items matched
--                            before this migration (they hold the whole
--                            transaction, as before) and unmatched items.
--   entry_voided_at          set when the entry the item points at is
--                            voided (Q-P26u). The item keeps its status and
--                            its link; "Review again" clears both.
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS matched_journal_line_id UUID;
--> statement-breakpoint
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS entry_voided_at TIMESTAMPTZ;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_bfi_matched_journal_line
  ON bank_feed_items (tenant_id, matched_journal_line_id)
  WHERE matched_journal_line_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfi_matched_txn
  ON bank_feed_items (tenant_id, matched_transaction_id)
  WHERE matched_transaction_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfi_entry_voided
  ON bank_feed_items (tenant_id, entry_voided_at)
  WHERE entry_voided_at IS NOT NULL;
