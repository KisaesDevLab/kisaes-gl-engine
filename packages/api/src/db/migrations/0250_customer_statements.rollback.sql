-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0250 (customer statements, U-112 / U-140). The code that
-- reads the tables must be rolled back with it. LOST: every issued
-- statement snapshot, the statement send history (printed / emailed / PDF)
-- and statement messages waiting in the Outbox. No GL data is touched.
-- Children are dropped before their parents.

DROP TABLE IF EXISTS customer_statement_email_queue;
--> statement-breakpoint
DROP TABLE IF EXISTS customer_statement_send_events;
--> statement-breakpoint
DROP TABLE IF EXISTS customer_statements;
--> statement-breakpoint
DROP TABLE IF EXISTS customer_statement_runs;
