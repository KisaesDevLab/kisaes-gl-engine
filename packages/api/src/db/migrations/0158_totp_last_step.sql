-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- TOTP replay guard (RFC 6238 §5.2): remember the last time-step whose code
-- was accepted so the same 30-second code cannot be replayed within the
-- ±1-step tolerance window.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS tfa_totp_last_step bigint;
