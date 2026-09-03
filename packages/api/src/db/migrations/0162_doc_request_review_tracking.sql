-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Unread-submission tracking + staff notification for document requests.
--
-- document_requests.reviewed_at / reviewed_by: stamped when a staff user
-- acknowledges a client submission ("Mark reviewed", or implicitly by
-- marking a request received / manually routing its statement). A row
-- with status='submitted' AND reviewed_at IS NULL is an UNREAD
-- submission — the count the dashboard banner, the Clients screen and
-- the Reminders page surface. A fresh portal upload against an already
-- submitted request clears reviewed_at again so a re-submission is not
-- silently swallowed by an earlier acknowledgement.
--
-- recurring_document_requests.notify_user_ids: staff user ids (JSON array
-- of uuid strings) emailed when the contact uploads against a request
-- issued by this rule. Read from the rule at submission time (not
-- denormalised) so editing the list applies to requests already out.

ALTER TABLE document_requests
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE document_requests
  ADD COLUMN IF NOT EXISTS reviewed_by UUID;

ALTER TABLE recurring_document_requests
  ADD COLUMN IF NOT EXISTS notify_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Backfill: requests staff closed by hand ("Mark received", no upload)
-- were obviously seen by staff — stamp them reviewed at the moment they
-- were closed. Portal-uploaded submissions stay unread so nothing that
-- may not have been looked at is hidden; "Mark all reviewed" clears them
-- in one click.
UPDATE document_requests
   SET reviewed_at = COALESCE(submitted_at, updated_at)
 WHERE status = 'submitted'
   AND reviewed_at IS NULL
   AND submitted_receipt_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_doc_req_tenant_unread
  ON document_requests (tenant_id)
  WHERE status = 'submitted' AND reviewed_at IS NULL;
