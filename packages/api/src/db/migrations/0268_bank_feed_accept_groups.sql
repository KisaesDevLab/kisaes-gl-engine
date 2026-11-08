-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Bank feed accept records, for Undo (U-169, feed-undo-v1; review B5).
-- Additive: two new tables and an index.
--
--   idx_bfi_waiting_amount        waiting feed items by amount: the
--                                 transfer-twin match signal (has_match).
--   bank_feed_accept_groups       one row per accept request (POST
--                                 /banking/feed/accept, /:id/transfer,
--                                 /:id/deposit, a match, a received payment
--                                 for a bank line). `result` is the accept
--                                 response, served by GET
--                                 /banking/feed/accept-groups/:id (a replay
--                                 over the 512 KB idempotency cap).
--   bank_feed_accept_group_items  one row per feed item the request linked:
--                                 kind post | match | transfer | deposit |
--                                 payment, the entry and its bank line, the
--                                 entry's fingerprint at commit (date,
--                                 contact, memo, lines) and the item's
--                                 review state before the accept
--                                 (prior_state). Undo acts only on rows whose
--                                 item still points at transaction_id and
--                                 that are not undone (undone_at).
CREATE INDEX IF NOT EXISTS idx_bfi_waiting_amount ON bank_feed_items (tenant_id, amount)
  WHERE status IN ('pending', 'assigned');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bank_feed_accept_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID,
  user_id UUID,
  source VARCHAR(20) NOT NULL,
  rule_id UUID,
  rule_kind VARCHAR(12),
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfag_tenant_created ON bank_feed_accept_groups (tenant_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bank_feed_accept_group_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID,
  group_id UUID NOT NULL REFERENCES bank_feed_accept_groups(id) ON DELETE CASCADE,
  feed_item_id UUID NOT NULL,
  kind VARCHAR(12) NOT NULL,
  transaction_id UUID NOT NULL,
  journal_line_id UUID,
  txn_fingerprint CHAR(64),
  prior_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at TIMESTAMPTZ,
  undone_by UUID,
  CONSTRAINT chk_bfagi_kind CHECK (kind IN ('post', 'match', 'transfer', 'deposit', 'payment'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfagi_group ON bank_feed_accept_group_items (tenant_id, group_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfagi_item_live ON bank_feed_accept_group_items (tenant_id, feed_item_id, created_at)
  WHERE undone_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfagi_txn ON bank_feed_accept_group_items (tenant_id, transaction_id);
