-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rows a team member submitted cannot survive the NOT NULL going back on.
-- They never posted anything themselves (an approved one already became a
-- ledger move), so deleting them loses only the suggestion audit trail.

DELETE FROM client_category_suggestions WHERE submitted_by_user_id IS NOT NULL;
DROP INDEX IF EXISTS idx_ccs_user;
ALTER TABLE client_category_suggestions DROP CONSTRAINT IF EXISTS ccs_submitter_exclusive;
ALTER TABLE client_category_suggestions DROP COLUMN IF EXISTS submitted_by_user_id;
ALTER TABLE client_category_suggestions ALTER COLUMN submitted_by_contact_id SET NOT NULL;
