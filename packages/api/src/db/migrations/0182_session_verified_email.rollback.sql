-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Dropping the column re-opens the cross-tenant switch described in 0182:
-- the code it belongs to falls back to refusing the email path, but older
-- code compares the mutable contact column again. Roll the application back
-- with it.

ALTER TABLE portal_contact_sessions DROP COLUMN IF EXISTS verified_email;
