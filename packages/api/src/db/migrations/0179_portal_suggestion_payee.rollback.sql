-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rolls back 0179. Payee-only answers cannot satisfy the original 3-way
-- ccs_has_answer, so they are removed first; they never posted anything.

DROP INDEX IF EXISTS idx_ccs_suggested_contact;
--> statement-breakpoint
ALTER TABLE client_category_suggestions DROP CONSTRAINT IF EXISTS ccs_has_answer;
--> statement-breakpoint
DELETE FROM client_category_suggestions
 WHERE suggested_account_id IS NULL AND is_personal = false AND client_note IS NULL;
--> statement-breakpoint
ALTER TABLE client_category_suggestions ADD CONSTRAINT ccs_has_answer CHECK (
  suggested_account_id IS NOT NULL OR is_personal = true OR client_note IS NOT NULL
);
--> statement-breakpoint
ALTER TABLE client_category_suggestions DROP COLUMN IF EXISTS resolved_contact_id;
--> statement-breakpoint
ALTER TABLE client_category_suggestions DROP COLUMN IF EXISTS suggested_contact_label;
--> statement-breakpoint
ALTER TABLE client_category_suggestions DROP COLUMN IF EXISTS suggested_contact_id;
