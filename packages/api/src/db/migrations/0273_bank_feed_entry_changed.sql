-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Bank feed rows whose entry was changed (U-199, feed-entry-changed-v1;
-- ClientLedger PR-5 B1, Q-PR5a). Additive.
--
--   entry_changed_at  set when an edit of the entry a feed row points at
--                     changed the row's line (its amount, or moved it to
--                     another account). The row keeps its status and its
--                     entry; "Review again" clears both and puts it back
--                     to waiting, as for a voided entry (entry_voided_at).
--
-- Backfill: before this, a full-replace edit that changed the amount of a
-- matched line left matched_journal_line_id naming a deleted line (no FK).
-- Such a row neither held the entry's new line nor the entry, so another
-- bank line could take it. Each one is cleared and flagged here, with one
-- audit row (bank_feed, entry_changed, reason backfill_0273).
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS entry_changed_at TIMESTAMPTZ;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfi_entry_changed
  ON bank_feed_items (tenant_id, entry_changed_at)
  WHERE entry_changed_at IS NOT NULL;
--> statement-breakpoint
WITH dangling AS (
  UPDATE bank_feed_items b
  SET entry_changed_at = now(), matched_journal_line_id = NULL, updated_at = now()
  FROM (
    SELECT x.id, x.matched_journal_line_id AS old_line FROM bank_feed_items x
    WHERE x.matched_journal_line_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.id = x.matched_journal_line_id)
  ) o
  WHERE b.id = o.id
  RETURNING b.id, b.tenant_id, b.company_id, b.status, b.matched_transaction_id, o.old_line
)
INSERT INTO audit_log (tenant_id, company_id, action, entity_type, entity_id, before_data, after_data)
SELECT d.tenant_id, d.company_id, 'update', 'bank_feed', d.id,
  jsonb_build_object('status', d.status, 'matchedTransactionId', d.matched_transaction_id, 'matchedJournalLineId', d.old_line),
  jsonb_build_object('action', 'entry_changed', 'status', d.status, 'matchedTransactionId', d.matched_transaction_id,
    'matchedJournalLineId', NULL, 'reason', 'backfill_0273')
FROM dangling d;
