-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.

DROP INDEX IF EXISTS idx_doc_req_tenant_unread;
ALTER TABLE recurring_document_requests DROP COLUMN IF EXISTS notify_user_ids;
ALTER TABLE document_requests DROP COLUMN IF EXISTS reviewed_by;
ALTER TABLE document_requests DROP COLUMN IF EXISTS reviewed_at;
