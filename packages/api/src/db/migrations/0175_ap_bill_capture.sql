-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- AP Bill Capture (bill.com-style intake). One row per uploaded vendor bill:
-- staff (or a portal contact with bill_upload_access) drops files, a worker
-- runs the existing bill-OCR pipeline, and the row moves
--   received -> processing -> ready -> entered
-- with side exits to failed (OCR error, still enterable by hand) and
-- discarded. When AI is off or consent is missing the row goes straight to
-- ready with extraction_skipped_reason set, so the queue also works as a
-- plain manual-keying surface with the image beside the form.
--
-- The uploaded file lives in `attachments` under attachable_type
-- 'bill_capture' / attachable_id = bill_captures.id and is re-linked to the
-- posted bill on enter. ON DELETE RESTRICT keeps a capture from silently
-- losing its document.
--
-- Also: contacts.bill_lines_mode remembers the vendor's last Detailed/Single
-- choice; portal_contact_companies.bill_upload_access is the per-contact
-- portal toggle; AP_BILL_CAPTURE_V1 is seeded OFF for every tenant.

CREATE TABLE IF NOT EXISTS bill_captures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE RESTRICT,
  ai_job_id uuid REFERENCES ai_jobs(id) ON DELETE SET NULL,
  source varchar(10) NOT NULL,
  uploaded_by_user_id uuid,
  uploaded_by_contact_id uuid REFERENCES portal_contacts(id) ON DELETE SET NULL,
  status varchar(20) NOT NULL DEFAULT 'received',
  extraction jsonb,
  extraction_error text,
  extraction_skipped_reason varchar(40),
  process_attempts integer NOT NULL DEFAULT 0,
  suggested_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  duplicate_of_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  duplicate_match varchar(20),
  bill_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  content_sha256 char(64) NOT NULL,
  file_name varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  entered_at timestamptz,
  CONSTRAINT bill_captures_source_ck CHECK (source IN ('staff', 'portal')),
  CONSTRAINT bill_captures_status_ck CHECK (status IN ('received', 'processing', 'ready', 'failed', 'entered', 'discarded')),
  CONSTRAINT bill_captures_uploader_ck CHECK (
    (source = 'staff' AND uploaded_by_user_id IS NOT NULL)
    OR (source = 'portal' AND uploaded_by_contact_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bill_captures_queue
  ON bill_captures (tenant_id, company_id, status, created_at DESC);
--> statement-breakpoint
-- Tenant-wide by status: the future Practice roll-up drops the company predicate.
CREATE INDEX IF NOT EXISTS idx_bill_captures_tenant_status
  ON bill_captures (tenant_id, status, created_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_bill_captures_attachment
  ON bill_captures (attachment_id);
--> statement-breakpoint
-- Same-file re-upload returns the existing capture; a discarded one no longer counts.
CREATE INDEX IF NOT EXISTS idx_bill_captures_sha
  ON bill_captures (tenant_id, company_id, content_sha256)
  WHERE status <> 'discarded';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bill_captures_contact
  ON bill_captures (uploaded_by_contact_id, created_at DESC)
  WHERE uploaded_by_contact_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bill_captures_bill
  ON bill_captures (bill_id)
  WHERE bill_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS bill_lines_mode varchar(10);
--> statement-breakpoint
ALTER TABLE portal_contact_companies ADD COLUMN IF NOT EXISTS bill_upload_access boolean NOT NULL DEFAULT false;
--> statement-breakpoint
INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'AP_BILL_CAPTURE_V1', FALSE FROM tenants t
ON CONFLICT DO NOTHING;
