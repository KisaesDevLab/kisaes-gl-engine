-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- One-off document requests (Practice → Reminders → Open requests →
-- New request): a document_requests row with recurring_id NULL, created
-- and sent immediately. The per-request settings a standing rule would
-- otherwise carry live on the row itself: who is emailed when the client
-- uploads, and where an uploaded bank/card statement is routed.
-- Additive. NULL statement_routing on a rule-less row keeps the historical
-- behavior (rows whose rule was deleted).

ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS notify_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS statement_routing VARCHAR(30);
ALTER TABLE document_requests ADD COLUMN IF NOT EXISTS bank_connection_id UUID;
