-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- migration-policy: non-additive-exception — reminder_schedules_trigger_type_check
-- is dropped and re-created as a strict superset of its former condition.
--
-- Chasing a client about transactions only they can explain becomes a
-- cadence rather than a button someone has to remember: a reminder_schedules
-- row with trigger_type 'categorize_reminder'. The engine that reads it is
-- categorize-help-request.service (scan/dispatch), so nothing about the
-- existing five triggers changes; the CHECK just has to allow the sixth.
--
-- Every existing row still satisfies the new constraint.

ALTER TABLE reminder_schedules DROP CONSTRAINT IF EXISTS reminder_schedules_trigger_type_check;
--> statement-breakpoint
ALTER TABLE reminder_schedules ADD CONSTRAINT reminder_schedules_trigger_type_check
  CHECK (trigger_type IN (
    'unanswered_question',
    'w9_pending',
    'doc_request',
    'recurring_non_transaction',
    'magic_link_expiring',
    'categorize_reminder'
  ));
