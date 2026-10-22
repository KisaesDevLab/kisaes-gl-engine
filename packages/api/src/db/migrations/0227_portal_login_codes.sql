-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Portal sign-in by email OR mobile number, with a 6-digit code beside the
-- link. Each sign-in row (portal_magic_links) now records:
--   code_hash         SHA-256 of the row's token hash + the code (never the code)
--   code_attempts     wrong codes entered against this row (refused at 5)
--   sent_via          'email' | 'sms' — which channel delivered it; an SMS
--                     sign-in does not prove the email address, so its
--                     session carries no verified_email (0182)
--   login_identifier  what the person typed, normalized (lower-case email
--                     or phone digits) — the key the code is checked under
-- Existing rows keep working as links (no code). Additive only.

ALTER TABLE portal_magic_links ADD COLUMN IF NOT EXISTS code_hash varchar(64);
ALTER TABLE portal_magic_links ADD COLUMN IF NOT EXISTS code_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE portal_magic_links ADD COLUMN IF NOT EXISTS sent_via varchar(10) NOT NULL DEFAULT 'email';
ALTER TABLE portal_magic_links ADD COLUMN IF NOT EXISTS login_identifier varchar(320);

CREATE INDEX IF NOT EXISTS idx_portal_magic_links_login_identifier
  ON portal_magic_links (login_identifier)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;
