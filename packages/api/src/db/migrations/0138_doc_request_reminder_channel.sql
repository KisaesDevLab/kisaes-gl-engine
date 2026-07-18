-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Per-rule notification channel for standing document requests. The
-- opener (issuance notice) previously always sent email; this lets a
-- practice choose email / sms / both when the DOC_REQUEST_SMS_V1 +
-- tenant SMS-outbound settings allow it. Denormalised onto
-- document_requests so the opener reads it without re-joining the rule
-- (same pattern as document_type / description), and so cancelling the
-- rule doesn't retro-change already-issued rows.

ALTER TABLE recurring_document_requests
  ADD COLUMN IF NOT EXISTS reminder_channel VARCHAR(10) NOT NULL DEFAULT 'email';
ALTER TABLE recurring_document_requests
  DROP CONSTRAINT IF EXISTS recurring_document_requests_reminder_channel_check;
ALTER TABLE recurring_document_requests
  ADD CONSTRAINT recurring_document_requests_reminder_channel_check
  CHECK (reminder_channel IN ('email', 'sms', 'both'));

ALTER TABLE document_requests
  ADD COLUMN IF NOT EXISTS reminder_channel VARCHAR(10) NOT NULL DEFAULT 'email';
ALTER TABLE document_requests
  DROP CONSTRAINT IF EXISTS document_requests_reminder_channel_check;
ALTER TABLE document_requests
  ADD CONSTRAINT document_requests_reminder_channel_check
  CHECK (reminder_channel IN ('email', 'sms', 'both'));

-- reminder_sends.question_id is polymorphic: the questions reminder path
-- stores a portal_questions id, the doc-request path stores a
-- document_requests id. The original FK to portal_questions(id) would
-- reject EVERY doc-request send (opener + nudge) with a 23503 violation
-- once any request is actually issued — a latent break that only stayed
-- hidden while no document_requests existed. Drop the FK; the column
-- stays a bare uuid subject-id. (ON DELETE SET NULL is lost, but a
-- deleted portal_question no longer needs to null its send-history rows —
-- reminder_sends is an audit trail.)
ALTER TABLE reminder_sends
  DROP CONSTRAINT IF EXISTS reminder_sends_question_id_fkey;
