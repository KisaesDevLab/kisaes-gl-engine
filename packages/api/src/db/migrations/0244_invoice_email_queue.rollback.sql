-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0244 (invoice email Outbox, U-127). The code that reads the
-- table must be rolled back with it. Lost: messages waiting in the Outbox
-- (their audit rows stay; sent emails stay in document_send_events).

DROP TABLE IF EXISTS form_email_queue;
