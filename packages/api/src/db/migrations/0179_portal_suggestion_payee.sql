-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
-- migration-policy: non-additive-exception — ccs_has_answer is dropped and
-- re-created below with a strict superset of its former condition.
--
-- A client answering "What was this?" can now say WHO it was paid to or
-- came from, not only which category. Two columns carry that answer:
--
--   suggested_contact_id    the contact picked from the sanitized portal
--                           payee list (FK, SET NULL if the contact is later
--                           merged or deleted — the client's row must
--                           survive as an audit record)
--   suggested_contact_label the name as the client SAW or TYPED it — always
--                           set when there is any payee answer, so a rename
--                           or a free-text "Joe the plumber" is never lost
--                           (the same idea as suggested_label).
--
-- resolved_contact_id records the payee staff actually applied on approval
-- (loose reference, like resolved_account_id).
--
-- A payee on its own is a complete answer — "paid to Home Depot" is exactly
-- the fact the bookkeeper is missing — so ccs_has_answer widens to accept
-- it. It is re-created in this file, strictly wider: every existing row
-- still satisfies it.

ALTER TABLE client_category_suggestions
  ADD COLUMN IF NOT EXISTS suggested_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE client_category_suggestions
  ADD COLUMN IF NOT EXISTS suggested_contact_label varchar(120);
--> statement-breakpoint
ALTER TABLE client_category_suggestions
  ADD COLUMN IF NOT EXISTS resolved_contact_id uuid;
--> statement-breakpoint
ALTER TABLE client_category_suggestions DROP CONSTRAINT IF EXISTS ccs_has_answer;
--> statement-breakpoint
ALTER TABLE client_category_suggestions ADD CONSTRAINT ccs_has_answer CHECK (
  suggested_account_id IS NOT NULL
  OR is_personal = true
  OR client_note IS NOT NULL
  OR suggested_contact_id IS NOT NULL
  OR suggested_contact_label IS NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_ccs_suggested_contact
  ON client_category_suggestions (suggested_contact_id)
  WHERE suggested_contact_id IS NOT NULL;
