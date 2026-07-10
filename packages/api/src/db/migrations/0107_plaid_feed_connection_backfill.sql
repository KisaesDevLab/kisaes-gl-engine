-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Backfill: legacy Plaid-synced bank-feed items stored a plaid_items id in
-- bank_connection_id (and jammed the mapped BANK account into
-- suggested_account_id). That broke the feed display, categorization, and
-- posting, all of which resolve the bank account through bank_connections.
-- This repoints those items at a real plaid-provider bank_connections row (one
-- per tenant + GL account, matching getOrCreatePlaidConnection) and clears the
-- bank-account "suggestion" so the CATEGORY column stops showing it. Data-only;
-- additive bank_connections inserts + a feed-item UPDATE.

-- 1. Create the plaid-backed connection per (tenant, GL account) for accounts
--    referenced by legacy Plaid feed items.
INSERT INTO bank_connections (tenant_id, account_id, provider, institution_name, sync_status)
SELECT DISTINCT bfi.tenant_id, bfi.suggested_account_id, 'plaid', 'Plaid', 'active'
FROM bank_feed_items bfi
WHERE bfi.bank_connection_id IN (SELECT id FROM plaid_items)
  AND bfi.suggested_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM bank_connections bc
    WHERE bc.tenant_id = bfi.tenant_id
      AND bc.account_id = bfi.suggested_account_id
      AND bc.provider = 'plaid'
  );

-- 2. Repoint the legacy items to the new connection and clear suggested_account_id
--    (it held the bank account, which polluted the category column).
UPDATE bank_feed_items bfi
SET bank_connection_id = bc.id,
    suggested_account_id = NULL,
    updated_at = NOW()
FROM bank_connections bc
WHERE bfi.bank_connection_id IN (SELECT id FROM plaid_items)
  AND bc.tenant_id = bfi.tenant_id
  AND bc.provider = 'plaid'
  AND bc.account_id = bfi.suggested_account_id;
