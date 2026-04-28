-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- STATEMENT_AUTO_IMPORT_V1 — when a portal contact uploads in
-- response to a doc_request whose document_type is bank_statement
-- or cc_statement, route the file to the bank-feed import pipeline
-- instead of the receipts inbox.
--
-- Three additive changes:
--   1. recurring_document_requests gets an optional bank_connection_id
--      so the firm can pre-bind "this client's monthly statement →
--      this connection". Cleanest UX path.
--   2. portal_receipts.status check constraint is widened to include
--      'awaits_routing' (ambiguous bank connection — CPA picks) and
--      'statement_imported' (statement parsed + bank_feed_items
--      inserted, fulfilment recorded).
--   3. tenant_feature_flags backfills STATEMENT_AUTO_IMPORT_V1 = FALSE
--      for existing tenants.

ALTER TABLE recurring_document_requests
  ADD COLUMN bank_connection_id UUID
    REFERENCES bank_connections(id) ON DELETE SET NULL;
CREATE INDEX idx_recur_doc_req_bank_connection
  ON recurring_document_requests (bank_connection_id)
  WHERE bank_connection_id IS NOT NULL;

-- Widen portal_receipts.status. Postgres CHECK constraints are not
-- IF NOT EXISTS-friendly — drop + re-add with the new value set.
ALTER TABLE portal_receipts
  DROP CONSTRAINT IF EXISTS portal_receipts_status_check;
ALTER TABLE portal_receipts
  ADD CONSTRAINT portal_receipts_status_check
  CHECK (status IN (
    'pending_ocr', 'ocr_failed', 'unmatched',
    'auto_matched', 'manually_matched', 'dismissed',
    'awaits_routing', 'statement_imported'
  ));

INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'STATEMENT_AUTO_IMPORT_V1', FALSE
FROM tenants t
ON CONFLICT DO NOTHING;
