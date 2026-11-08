-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.

ALTER TABLE document_requests DROP COLUMN IF EXISTS bank_connection_id;
ALTER TABLE document_requests DROP COLUMN IF EXISTS statement_routing;
ALTER TABLE document_requests DROP COLUMN IF EXISTS notify_user_ids;
