-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

DROP INDEX IF EXISTS idx_portal_sessions_identity;
ALTER TABLE portal_contact_sessions DROP COLUMN IF EXISTS identity_id;

DROP INDEX IF EXISTS idx_portal_contacts_identity;
ALTER TABLE portal_contacts DROP COLUMN IF EXISTS identity_id;

DROP TABLE IF EXISTS portal_identities;
