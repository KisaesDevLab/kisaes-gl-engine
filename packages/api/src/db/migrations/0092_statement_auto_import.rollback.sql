-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

DROP INDEX IF EXISTS idx_recur_doc_req_bank_connection;
ALTER TABLE recurring_document_requests
  DROP COLUMN IF EXISTS bank_connection_id;

ALTER TABLE portal_receipts
  DROP CONSTRAINT IF EXISTS portal_receipts_status_check;
ALTER TABLE portal_receipts
  ADD CONSTRAINT portal_receipts_status_check
  CHECK (status IN (
    'pending_ocr', 'ocr_failed', 'unmatched',
    'auto_matched', 'manually_matched', 'dismissed'
  ));

DELETE FROM tenant_feature_flags WHERE flag_key = 'STATEMENT_AUTO_IMPORT_V1';
