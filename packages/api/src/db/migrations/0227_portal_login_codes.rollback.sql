-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0227 (portal sign-in codes and SMS delivery). The code that
-- reads these columns must be rolled back with it. Outstanding sign-in links
-- keep working; outstanding codes stop working.

DROP INDEX IF EXISTS idx_portal_magic_links_login_identifier;
ALTER TABLE portal_magic_links DROP COLUMN IF EXISTS login_identifier;
ALTER TABLE portal_magic_links DROP COLUMN IF EXISTS sent_via;
ALTER TABLE portal_magic_links DROP COLUMN IF EXISTS code_attempts;
ALTER TABLE portal_magic_links DROP COLUMN IF EXISTS code_hash;
