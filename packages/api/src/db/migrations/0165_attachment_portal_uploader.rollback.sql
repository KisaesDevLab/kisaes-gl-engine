-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Drops the portal uploader attribution. The FILES stay: they are ordinary
-- attachments keyed to their transaction or bank line, and the staff screens
-- never read this column. Only the portal's "your uploads" filter is lost.

DROP INDEX IF EXISTS idx_attach_portal_uploader;
--> statement-breakpoint
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_uploaded_by_contact_id_fkey;
--> statement-breakpoint
ALTER TABLE attachments DROP COLUMN IF EXISTS uploaded_by_contact_id;
