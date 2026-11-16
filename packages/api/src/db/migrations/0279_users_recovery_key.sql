-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Desktop recovery key (U-23) and temporary passwords (U-230), ClientLedger
-- P29. Additive: two columns on users.
--   recovery_key_hash         SHA-256 (hex) of the normalised recovery key;
--                             null = no key. Written only in desktop mode.
--   password_change_required  set by a desktop invite or an Admin's
--                             temporary password; the user must choose a new
--                             password before anything else. Default false,
--                             so the server is unaffected.
ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_key_hash varchar(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_change_required boolean NOT NULL DEFAULT false;
