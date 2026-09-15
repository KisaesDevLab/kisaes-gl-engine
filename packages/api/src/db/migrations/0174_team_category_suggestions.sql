-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
-- migration-policy: non-additive-exception
--
-- Non-additive on purpose: submitted_by_contact_id loses NOT NULL so a row
-- can be attributed to a tenant USER instead of a portal contact. No column
-- is dropped or retyped, every existing row keeps its contact, and the new
-- CHECK constraint keeps "exactly one submitter" as strong as the old NOT
-- NULL was. The alternative (a second table) would have split one review
-- queue in two.
--
-- Team members (tenant users who are not firm staff) may SUGGEST a category
-- for an amount sitting in suspense, exactly like a portal contact does from
-- the client portal. Same table, same pending-only write path; the submitter
-- is now EITHER a portal contact OR a user. submitted_by_user_id is a loose
-- reference (users is tenant-scoped; same posture as firm_users.user_id).

ALTER TABLE client_category_suggestions
  ALTER COLUMN submitted_by_contact_id DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE client_category_suggestions
  ADD COLUMN IF NOT EXISTS submitted_by_user_id uuid;
--> statement-breakpoint
-- Exactly one submitter. Every existing row has a contact, so this validates.
ALTER TABLE client_category_suggestions
  ADD CONSTRAINT ccs_submitter_exclusive CHECK (
    (submitted_by_contact_id IS NOT NULL AND submitted_by_user_id IS NULL)
    OR (submitted_by_contact_id IS NULL AND submitted_by_user_id IS NOT NULL)
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ccs_user
  ON client_category_suggestions (submitted_by_user_id, submitted_at DESC)
  WHERE submitted_by_user_id IS NOT NULL;
