-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

ALTER TABLE document_requests DROP COLUMN IF EXISTS bank_connection_id;
ALTER TABLE document_requests DROP COLUMN IF EXISTS statement_routing;
ALTER TABLE document_requests DROP COLUMN IF EXISTS notify_user_ids;
