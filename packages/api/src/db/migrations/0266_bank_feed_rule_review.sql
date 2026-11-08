-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Bank feed rule attribution and review decisions (U-168, U-174). Additive.
--
--   bank_feed_items.suggested_rule_id    the rule that staged the item's
--   bank_feed_items.suggested_rule_kind  suggestion: 'conditional'
--                                        (conditional_rules) or 'legacy'
--                                        (bank_rules). Written in the same
--                                        UPDATE as the suggestion.
--   bank_feed_items.exclusion_reason     why an excluded item was excluded:
--                                        'duplicate' (Remove this one on a
--                                        possible duplicate) or NULL.
--   transaction_classification_state.matched_bank_rule_id
--                                        the legacy bank rule a row was
--                                        attributed to (matched_rule_id holds
--                                        conditional rules only, 0160).
--
-- Backfill (no posting): waiting items a conditional rule staged get the
-- rule of their earliest recorded fire, else the conditional rule of their
-- classification row. Items a legacy rule staged have no per-item record;
-- the next Reprocess Rules attributes them (it never posts in desktop mode).
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS suggested_rule_id UUID;
--> statement-breakpoint
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS suggested_rule_kind VARCHAR(12);
--> statement-breakpoint
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS exclusion_reason VARCHAR(20);
--> statement-breakpoint
ALTER TABLE transaction_classification_state ADD COLUMN IF NOT EXISTS matched_bank_rule_id UUID;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfi_suggested_rule
  ON bank_feed_items (tenant_id, suggested_rule_kind, suggested_rule_id)
  WHERE suggested_rule_id IS NOT NULL;
--> statement-breakpoint
UPDATE bank_feed_items b SET suggested_rule_id = f.rule_id, suggested_rule_kind = 'conditional'
  FROM (
    SELECT DISTINCT ON (a.bank_feed_item_id) a.bank_feed_item_id, a.rule_id
    FROM conditional_rule_audit a
    WHERE a.bank_feed_item_id IS NOT NULL
    ORDER BY a.bank_feed_item_id, a.matched_at, a.id
  ) f
  WHERE b.id = f.bank_feed_item_id AND b.suggested_rule_id IS NULL
    AND b.status IN ('pending', 'assigned') AND b.suggested_account_id IS NOT NULL;
--> statement-breakpoint
UPDATE bank_feed_items b SET suggested_rule_id = s.matched_rule_id, suggested_rule_kind = 'conditional'
  FROM transaction_classification_state s
  WHERE s.bank_feed_item_id = b.id AND s.matched_rule_id IS NOT NULL AND b.suggested_rule_id IS NULL
    AND b.status IN ('pending', 'assigned') AND b.suggested_account_id IS NOT NULL;
