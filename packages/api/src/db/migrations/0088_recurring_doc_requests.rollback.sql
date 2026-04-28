-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Rollback for 0088_recurring_doc_requests.

ALTER TABLE document_requests DROP CONSTRAINT IF EXISTS fk_doc_req_submitted_receipt;
DROP INDEX IF EXISTS idx_portal_receipts_doc_request;
ALTER TABLE portal_receipts DROP COLUMN IF EXISTS document_request_id;

DROP TABLE IF EXISTS document_requests;
DROP TABLE IF EXISTS recurring_document_requests;

DELETE FROM tenant_feature_flags WHERE flag_key = 'RECURRING_DOC_REQUESTS_V1';
