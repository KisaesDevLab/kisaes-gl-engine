-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0242 (invoice core: U-123, U-126). The code that reads the
-- columns and the table must be rolled back with it. Lost: line service
-- dates, invoice PO numbers, customer messages, the hide-$0-lines choice and
-- the send history (the audit rows of each send stay).

DROP TABLE IF EXISTS document_send_events;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS hide_zero_lines;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS customer_message;
--> statement-breakpoint
ALTER TABLE transactions DROP COLUMN IF EXISTS po_number;
--> statement-breakpoint
ALTER TABLE journal_lines DROP COLUMN IF EXISTS service_date;
