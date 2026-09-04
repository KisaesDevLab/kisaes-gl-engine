-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- PORTAL_CATEGORIZE_V1, attachments half — a portal contact may attach a
-- receipt or photo to a transaction it is being asked to categorize.
--
-- The file lands in `attachments` under the SAME key the staff Uncategorized
-- screen already reads (a posted row's own txn_type, or 'bank_feed_items' for
-- an unposted bank line), so the paperclip there picks it up with no second
-- store and no relinking step.
--
-- This column exists so the portal can list back only what the CLIENT sent.
-- `attachments` carries no uploader attribution at all, so without it the
-- portal would have to either show the client every file on the row --
-- including anything the firm attached, whose FILENAME alone can disclose
-- more than the client should see -- or show nothing and forget its own
-- uploads between visits. NULL means "uploaded by staff", which is every
-- existing row.
--
-- Nullable, no default, no backfill: additive per CLAUDE.md rule 13, and
-- every staff read ignores it.

ALTER TABLE attachments
  ADD COLUMN IF NOT EXISTS uploaded_by_contact_id uuid;
--> statement-breakpoint

-- SET NULL rather than CASCADE: deleting a portal contact must never delete
-- the client's receipt out from under the books it supports.
ALTER TABLE attachments
  ADD CONSTRAINT attachments_uploaded_by_contact_id_fkey
  FOREIGN KEY (uploaded_by_contact_id) REFERENCES portal_contacts(id) ON DELETE SET NULL;
--> statement-breakpoint

-- The portal's only query shape: "this contact's files on this row".
CREATE INDEX IF NOT EXISTS idx_attach_portal_uploader
  ON attachments (uploaded_by_contact_id, attachable_type, attachable_id)
  WHERE uploaded_by_contact_id IS NOT NULL;
