-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Explicit statement-routing mode for recurring document requests:
--   'inbox'                — park the upload in the receipts inbox for a
--                            manual connection pick (no auto-import)
--   'auto_import'          — pick a bank connection (rule-bound or unique
--                            company match) and import to bank_feed_items
--   'statement_processing' — parse immediately and surface the job on the
--                            Statement Processing page for staff review &
--                            import (no connection binding needed)
--
-- Backfill: rules pre-bound to a connection were auto-importing — keep
-- them on 'auto_import'. Unbound rules were LABELED "Don't auto-import
-- (route to receipts inbox)" in the UI but could still silently
-- auto-import via the unique-company-match heuristic; backfilling them
-- to 'inbox' makes behavior match the label the operator chose.

ALTER TABLE recurring_document_requests
  ADD COLUMN IF NOT EXISTS statement_routing VARCHAR(30) NOT NULL DEFAULT 'inbox';

UPDATE recurring_document_requests
  SET statement_routing = 'auto_import'
  WHERE bank_connection_id IS NOT NULL;

-- New requestable document types (Sales tax report, A/R, Inventory,
-- A/P, Loan balance). The 0088 CHECK pinned the original five; swap it
-- for the extended list. document_requests.document_type (denormalised
-- copy) never had a CHECK, so only this table needs the swap.
ALTER TABLE recurring_document_requests
  DROP CONSTRAINT IF EXISTS recurring_document_requests_document_type_check;
ALTER TABLE recurring_document_requests
  ADD CONSTRAINT recurring_document_requests_document_type_check CHECK (document_type IN (
    'bank_statement', 'cc_statement', 'payroll_report', 'receipt_batch',
    'sales_tax_report', 'accounts_receivable', 'inventory', 'accounts_payable', 'loan_balance',
    'other'
  ));

ALTER TABLE recurring_document_requests
  ADD CONSTRAINT recurring_document_requests_statement_routing_check CHECK (statement_routing IN (
    'inbox', 'auto_import', 'statement_processing'
  ));

-- New receipt status for the 'statement_processing' route: parsed on
-- arrival, sitting on the Statement Processing page for staff review.
ALTER TABLE portal_receipts
  DROP CONSTRAINT IF EXISTS portal_receipts_status_check;
ALTER TABLE portal_receipts
  ADD CONSTRAINT portal_receipts_status_check CHECK (status IN (
    'pending_ocr', 'ocr_failed', 'unmatched', 'auto_matched', 'manually_matched',
    'dismissed', 'awaits_routing', 'statement_imported', 'statement_review'
  ));
