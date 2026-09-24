-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Reverse of 0180. Schedules using the new trigger are deleted first —
-- they would violate the restored CHECK, and a schedule the old code cannot
-- read is dead weight rather than data worth keeping. Sends already made
-- through them stay in reminder_sends.

DELETE FROM reminder_schedules WHERE trigger_type = 'categorize_reminder';
--> statement-breakpoint
ALTER TABLE reminder_schedules DROP CONSTRAINT IF EXISTS reminder_schedules_trigger_type_check;
--> statement-breakpoint
ALTER TABLE reminder_schedules ADD CONSTRAINT reminder_schedules_trigger_type_check
  CHECK (trigger_type IN (
    'unanswered_question',
    'w9_pending',
    'doc_request',
    'recurring_non_transaction',
    'magic_link_expiring'
  ));
