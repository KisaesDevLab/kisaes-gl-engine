-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- TOTP replay guard (RFC 6238 §5.2): remember the last time-step whose code
-- was accepted so the same 30-second code cannot be replayed within the
-- ±1-step tolerance window.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tfa_totp_last_step bigint;
